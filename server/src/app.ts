import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { HttpError, notFound } from './lib/http.js';
import { randomToken, sha256 } from './lib/crypto.js';
import { safePost, type SafePost } from './lib/ssrf.js';
import { metaClient, mockMetaClient, type MetaClient } from './lib/meta.js';
import type { Role } from './lib/schemas.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import workspaceRoutes from './routes/workspaces.js';
import integrationRoutes from './routes/integrations.js';
import apiKeyRoutes from './routes/apikeys.js';
import leadRoutes from './routes/leads.js';
import eventRoutes from './routes/events.js';

export interface Deps { fetch: typeof fetch; safePost: SafePost }

declare module 'fastify' {
  interface FastifyRequest { auth: { userId: string; sessionId: string } | null }
  interface FastifyInstance {
    cfg: Config;
    db: Db;
    deps: Deps;
    meta: MetaClient;
    cookieName: string;
    requireAuth: (req: FastifyRequest) => Promise<void>;
    memberRole: (req: FastifyRequest, workspaceId: string, allowed?: Role[]) => Promise<Role>;
    startSession: (req: FastifyRequest, reply: FastifyReply, userId: string) => Promise<void>;
    clearSession: (reply: FastifyReply) => void;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp(cfg: Config, db: Db, deps: Partial<Deps> = {}) {
  const app = Fastify({
    logger: cfg.env === 'test' ? false : { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: cfg.trustProxy,
    bodyLimit: 256 * 1024,
  });
  const cookieName = cfg.isProd ? '__Host-convera_sid' : 'convera_sid';
  const d: Deps = { fetch: deps.fetch ?? fetch, safePost: deps.safePost ?? safePost };

  // Hanya application/json yang diterima; parser text/plain bawaan Fastify dibuang agar form/text-plain CSRF tidak lolos ke handler.
  app.removeContentTypeParser('text/plain');

  app.decorate('cfg', cfg);
  app.decorate('db', db);
  app.decorate('deps', d);
  app.decorate('meta', cfg.metaMock ? mockMetaClient() : metaClient(d.fetch, cfg.metaGraphVersion));
  app.decorate('cookieName', cookieName);
  app.decorateRequest('auth', null);

  await app.register(helmet, { crossOriginResourcePolicy: { policy: 'same-site' } });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || cfg.corsOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Accept'],
    maxAge: 600,
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute', hook: 'preHandler' });

  // Perlindungan CSRF: semua request yang mengubah data wajib membawa Origin yang ada di allowlist.
  // (Ditambah cookie SameSite=Lax dan hanya menerima Content-Type: application/json.)
  app.addHook('onRequest', async (req) => {
    if (SAFE_METHODS.has(req.method)) return;
    const origin = req.headers.origin;
    if (!origin || !cfg.corsOrigins.includes(origin)) throw new HttpError(403, 'Origin tidak diizinkan');
  });

  app.decorate('requireAuth', async (req: FastifyRequest) => {
    const token = req.cookies[cookieName];
    if (!token) throw new HttpError(401, 'Belum login');
    const { rows } = await db.query<{ session_id: string; user_id: string; last_seen_at: Date }>(
      `SELECT s.id AS session_id, s.user_id, s.last_seen_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          AND s.last_seen_at > now() - make_interval(secs => $2::double precision)
          AND u.disabled_at IS NULL`,
      [sha256(token), cfg.sessionIdleMs / 1000],
    );
    const row = rows[0];
    if (!row) throw new HttpError(401, 'Sesi berakhir, silakan login lagi');
    if (Date.now() - row.last_seen_at.getTime() > 60_000) await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]);
    req.auth = { userId: row.user_id, sessionId: row.session_id };
  });

  // Mengembalikan role pengguna di workspace. Bukan anggota -> 404 (tidak membocorkan keberadaan workspace).
  app.decorate('memberRole', async (req: FastifyRequest, workspaceId: string, allowed?: Role[]) => {
    if (!req.auth) throw new HttpError(401, 'Belum login');
    const { rows } = await db.query<{ role: Role }>(
      `SELECT m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.workspace_id = $1 AND m.user_id = $2 AND w.deleted_at IS NULL`,
      [workspaceId, req.auth.userId],
    );
    const role = rows[0]?.role;
    if (!role) throw notFound();
    if (allowed && !allowed.includes(role)) throw new HttpError(403, 'Anda tidak punya izin untuk tindakan ini');
    return role;
  });

  app.decorate('startSession', async (req: FastifyRequest, reply: FastifyReply, userId: string) => {
    const token = randomToken(32);
    await db.query(
      'INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)',
      [userId, sha256(token), new Date(Date.now() + cfg.sessionTtlMs), req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300)],
    );
    reply.setCookie(cookieName, token, { httpOnly: true, secure: cfg.isProd, sameSite: 'lax', path: '/', maxAge: Math.floor(cfg.sessionTtlMs / 1000) });
  });
  app.decorate('clearSession', (reply: FastifyReply) => {
    reply.clearCookie(cookieName, { path: '/', httpOnly: true, secure: cfg.isProd, sameSite: 'lax' });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(422).send({ message: err.issues[0]?.message ?? 'Data tidak valid', errors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (err instanceof HttpError) return reply.code(err.status).send({ message: err.message });
    const e = err as { statusCode?: number; message: string };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      const message = e.statusCode === 429 ? 'Terlalu banyak permintaan, coba lagi sebentar'
        : e.statusCode === 415 ? 'Content-Type harus application/json'
        : e.statusCode === 413 ? 'Data terlalu besar' : 'Permintaan tidak valid';
      return reply.code(e.statusCode).send({ message });
    }
    req.log.error(err);
    return reply.code(500).send({ message: 'Terjadi kesalahan server' });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ message: 'Tidak ditemukan' }));

  app.get('/healthz', { config: { rateLimit: false } }, async () => {
    await db.query('SELECT 1');
    return { ok: true };
  });

  await app.register(authRoutes, { prefix: '/api/v1' });
  await app.register(meRoutes, { prefix: '/api/v1' });
  await app.register(workspaceRoutes, { prefix: '/api/v1' });
  await app.register(integrationRoutes, { prefix: '/api/v1' });
  await app.register(apiKeyRoutes, { prefix: '/api/v1' });
  await app.register(leadRoutes, { prefix: '/api/v1' });
  await app.register(eventRoutes, { prefix: '/api/v1' });
  return app;
}
