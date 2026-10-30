import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../lib/http.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { publicUser, type UserRow } from '../lib/users.js';
import * as v from '../lib/schemas.js';

const body = z.object({
  name: v.name.optional(),
  email: v.email.optional(),
  phone: v.phone.optional(),
  currentPassword: z.string().max(128).optional(),
  newPassword: v.password.optional(),
});

export default async function meRoutes(app: FastifyInstance) {
  const { db } = app;

  // Kontrak frontend: PATCH /api/v1/me/profile -> { data: { name, email, phone, passwordUpdatedAt } }
  app.patch('/me/profile', { preHandler: app.requireAuth }, async (req) => {
    const input = body.parse(req.body);
    const userId = req.auth!.userId;
    const cur = (await db.query<UserRow & { password_hash: string }>(
      'SELECT id, name, email, phone, password_changed_at, password_hash FROM users WHERE id = $1', [userId])).rows[0]!;

    const emailChanged = input.email !== undefined && input.email !== cur.email.toLowerCase();
    // Ganti email atau password adalah tindakan sensitif: wajib konfirmasi password saat ini.
    if (emailChanged || input.newPassword) {
      if (!input.currentPassword) throw new HttpError(422, 'Isi password saat ini untuk mengubah email atau password');
      if (!(await verifyPassword(input.currentPassword, cur.password_hash))) throw new HttpError(403, 'Password saat ini salah');
    }
    if (input.newPassword && input.newPassword === input.currentPassword) throw new HttpError(422, 'Password baru tidak boleh sama dengan yang lama');

    const newHash = input.newPassword ? await hashPassword(input.newPassword) : null;
    try {
      await db.query(
        `UPDATE users SET name = COALESCE($2, name), email = COALESCE($3, email), phone = COALESCE($4, phone),
                password_hash = COALESCE($5, password_hash),
                password_changed_at = CASE WHEN $5::text IS NULL THEN password_changed_at ELSE now() END
          WHERE id = $1`,
        [userId, input.name ?? null, input.email ?? null, input.phone ?? null, newHash]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'Email sudah dipakai akun lain');
      throw e;
    }
    // Ganti password: cabut semua sesi lain agar sesi yang mungkin sudah dibobol ikut mati.
    if (newHash) await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [userId, req.auth!.sessionId]);

    await audit(db, { userId, action: newHash ? 'user.password_change' : 'user.profile_update', meta: { emailChanged }, ip: req.ip });
    const out = (await db.query<UserRow>('SELECT id, name, email, phone, password_changed_at FROM users WHERE id = $1', [userId])).rows[0]!;
    const { name, email, phone, passwordUpdatedAt } = publicUser(out);
    return { data: { name, email, phone, passwordUpdatedAt } };
  });
}
