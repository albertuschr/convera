import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '../db.js';
import { HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import * as v from '../lib/schemas.js';
import { listWorkspaces } from './auth.js';

const idParam = z.object({ id: v.uuid });
const idUserParam = z.object({ id: v.uuid, userId: v.uuid });

export default async function workspaceRoutes(app: FastifyInstance) {
  const { db } = app;
  const auth = { preHandler: app.requireAuth };

  app.get('/workspaces', auth, async (req) => ({ data: await listWorkspaces(app, req.auth!.userId) }));

  app.post('/workspaces', auth, async (req, reply) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(120) }).parse(req.body);
    const id = await tx(db, async (c) => {
      const wid = (await c.query<{ id: string }>('INSERT INTO workspaces (name, created_by) VALUES ($1,$2) RETURNING id', [name, req.auth!.userId])).rows[0]!.id;
      await c.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [wid, req.auth!.userId]);
      return wid;
    });
    await audit(db, { workspaceId: id, userId: req.auth!.userId, action: 'workspace.create', ip: req.ip });
    return reply.code(201).send({ data: { id, name, role: 'owner' } });
  });

  app.get('/workspaces/:id', auth, async (req) => {
    const { id } = idParam.parse(req.params);
    const role = await app.memberRole(req, id);
    const w = (await db.query<{ id: string; name: string; created_at: Date }>('SELECT id, name, created_at FROM workspaces WHERE id = $1', [id])).rows[0]!;
    return { data: { id: w.id, name: w.name, role, createdAt: w.created_at.toISOString() } };
  });

  app.get('/workspaces/:id/members', auth, async (req) => {
    const { id } = idParam.parse(req.params);
    await app.memberRole(req, id, ['owner']);
    const { rows } = await db.query<{ user_id: string; name: string; email: string; role: v.Role }>(
      'SELECT u.id AS user_id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY m.created_at', [id]);
    return { data: rows.map((r) => ({ userId: r.user_id, name: r.name, email: r.email, role: r.role })) };
  });

  // Menambah anggota yang sudah punya akun. Undangan via email menyusul setelah provider email tersedia.
  app.post('/workspaces/:id/members', auth, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const input = z.object({ email: v.email, role: v.role }).parse(req.body);
    await app.memberRole(req, id, ['owner']);
    const u = (await db.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = $1 AND disabled_at IS NULL', [input.email])).rows[0];
    if (!u) throw new HttpError(404, 'Pengguna belum terdaftar');
    await db.query('INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role', [id, u.id, input.role]);
    await audit(db, { workspaceId: id, userId: req.auth!.userId, action: 'member.set_role', target: u.id, meta: { role: input.role }, ip: req.ip });
    return reply.code(201).send({ data: { userId: u.id, role: input.role } });
  });

  app.delete('/workspaces/:id/members/:userId', auth, async (req) => {
    const { id, userId } = idUserParam.parse(req.params);
    await app.memberRole(req, id, ['owner']);
    await tx(db, async (c) => {
      const owners = (await c.query<{ user_id: string }>("SELECT user_id FROM memberships WHERE workspace_id = $1 AND role = 'owner' FOR UPDATE", [id])).rows;
      if (owners.length === 1 && owners[0]!.user_id === userId) throw new HttpError(409, 'Workspace harus punya minimal satu owner');
      const r = await c.query('DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2', [id, userId]);
      if (!r.rowCount) throw new HttpError(404, 'Anggota tidak ditemukan');
    });
    await audit(db, { workspaceId: id, userId: req.auth!.userId, action: 'member.remove', target: userId, ip: req.ip });
    return { message: 'Anggota dihapus' };
  });

  app.get('/workspaces/:id/audit-logs', auth, async (req) => {
    const { id } = idParam.parse(req.params);
    await app.memberRole(req, id, ['owner']);
    const { rows } = await db.query(
      'SELECT id, user_id, action, target, meta, created_at FROM audit_logs WHERE workspace_id = $1 ORDER BY id DESC LIMIT 100', [id]);
    return { data: rows };
  });
}
