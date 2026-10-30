import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '../db.js';
import { HttpError } from '../lib/http.js';
import { hashPassword, sha256, verifyAgainstDummy, verifyPassword } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { publicUser, type UserRow } from '../lib/users.js';
import * as v from '../lib/schemas.js';

const registerBody = z.object({ name: v.name, email: v.email, password: v.password, workspaceName: z.string().trim().min(1).max(120).optional() });
const loginBody = z.object({ email: v.email, password: z.string().min(1).max(128) });

export default async function authRoutes(app: FastifyInstance) {
  const { db, cfg } = app;

  app.post('/auth/register', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req, reply) => {
    if (!cfg.registrationOpen) throw new HttpError(403, 'Pendaftaran akun baru ditutup');
    const body = registerBody.parse(req.body);
    const passwordHash = await hashPassword(body.password);
    let userId = '', workspaceId = '';
    try {
      await tx(db, async (c) => {
        userId = (await c.query<{ id: string }>('INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id', [body.email, body.name, passwordHash])).rows[0]!.id;
        workspaceId = (await c.query<{ id: string }>('INSERT INTO workspaces (name, created_by) VALUES ($1,$2) RETURNING id', [body.workspaceName ?? 'Workspace Saya', userId])).rows[0]!.id;
        await c.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [workspaceId, userId]);
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'Email sudah terdaftar');
      throw e;
    }
    await app.startSession(req, reply, userId);
    await audit(db, { userId, workspaceId, action: 'auth.register', ip: req.ip });
    const user = (await db.query<UserRow>('SELECT id, name, email, phone, password_changed_at FROM users WHERE id = $1', [userId])).rows[0]!;
    return reply.code(201).send({ data: { user: publicUser(user), workspaces: [{ id: workspaceId, name: body.workspaceName ?? 'Workspace Saya', role: 'owner' }] } });
  });

  // Batas per IP (bukan per email) agar password spraying ke banyak akun tetap terhambat.
  app.post('/auth/login', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = loginBody.parse(req.body);
    const row = (await db.query<UserRow & { password_hash: string; disabled_at: Date | null }>(
      'SELECT id, name, email, phone, password_changed_at, password_hash, disabled_at FROM users WHERE lower(email) = $1', [body.email])).rows[0];
    const ok = row ? await verifyPassword(body.password, row.password_hash) : (await verifyAgainstDummy(body.password), false);
    if (!row || !ok || row.disabled_at) {
      await audit(db, { userId: row?.id ?? null, action: 'auth.login_failed', meta: { email: body.email }, ip: req.ip });
      throw new HttpError(401, 'Email atau password salah');
    }
    await app.startSession(req, reply, row.id);
    await audit(db, { userId: row.id, action: 'auth.login', ip: req.ip });
    return { data: { user: publicUser(row), workspaces: await listWorkspaces(app, row.id) } };
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[app.cookieName];
    if (token) {
      const { rows } = await db.query<{ user_id: string }>('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING user_id', [sha256(token)]);
      if (rows[0]) await audit(db, { userId: rows[0].user_id, action: 'auth.logout', ip: req.ip });
    }
    app.clearSession(reply);
    return { message: 'Berhasil keluar' };
  });

  app.get('/auth/session', async (req) => {
    await app.requireAuth(req);
    const user = (await db.query<UserRow>('SELECT id, name, email, phone, password_changed_at FROM users WHERE id = $1', [req.auth!.userId])).rows[0]!;
    return { data: { user: publicUser(user), workspaces: await listWorkspaces(app, user.id) } };
  });
}

export async function listWorkspaces(app: FastifyInstance, userId: string) {
  const { rows } = await app.db.query<{ id: string; name: string; role: v.Role }>(
    `SELECT w.id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = $1 AND w.deleted_at IS NULL ORDER BY w.created_at`, [userId]);
  return rows;
}
