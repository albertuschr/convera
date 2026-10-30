import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../lib/http.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import * as v from '../lib/schemas.js';

const idParam = z.object({ id: v.uuid });
const keyParam = z.object({ id: v.uuid, keyId: v.uuid });

export default async function apiKeyRoutes(app: FastifyInstance) {
  const { db } = app;
  const auth = { preHandler: app.requireAuth };

  app.get('/workspaces/:id/api-keys', auth, async (req) => {
    const { id } = idParam.parse(req.params);
    await app.memberRole(req, id, ['owner']);
    const { rows } = await db.query<{ id: string; name: string; prefix: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null }>(
      'SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE workspace_id = $1 ORDER BY created_at DESC', [id]);
    return { data: rows.map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at })) };
  });

  // Key asli hanya dikembalikan sekali di response ini; di database hanya tersimpan hash-nya.
  app.post('/workspaces/:id/api-keys', auth, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    await app.memberRole(req, id, ['owner']);
    const key = `cvk_live_${randomToken(32)}`;
    const row = (await db.query<{ id: string }>(
      'INSERT INTO api_keys (workspace_id, name, prefix, key_hash, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [id, name, key.slice(0, 13), sha256(key), req.auth!.userId])).rows[0]!;
    await audit(db, { workspaceId: id, userId: req.auth!.userId, action: 'api_key.create', target: row.id, meta: { name }, ip: req.ip });
    return reply.code(201).send({ data: { id: row.id, name, prefix: key.slice(0, 13), key }, message: 'Simpan key ini sekarang; tidak bisa ditampilkan lagi.' });
  });

  app.delete('/workspaces/:id/api-keys/:keyId', auth, async (req) => {
    const { id, keyId } = keyParam.parse(req.params);
    await app.memberRole(req, id, ['owner']);
    const r = await db.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL', [keyId, id]);
    if (!r.rowCount) throw new HttpError(404, 'API key tidak ditemukan');
    await audit(db, { workspaceId: id, userId: req.auth!.userId, action: 'api_key.revoke', target: keyId, ip: req.ip });
    return { message: 'API key dicabut' };
  });
}
