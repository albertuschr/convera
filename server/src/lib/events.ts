import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { decrypt } from './crypto.js';
import { normPhone } from './schemas.js';

export interface MetaTarget { datasetId: string; token: string }
export interface DeliverResult { ok: boolean; status: number; events_received?: number; error?: string | null; code?: number }

export const NEEDS_VALUE = ['Purchase', 'InitiateCheckout', 'AddToCart'];
export const ATTRIBUTION_MS = 7 * 86_400_000;
export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');
export const hashPhone = (p: string) => sha256Hex(normPhone(p));

/** Dataset + token tersimpan milik workspace. Mode mock: selalu ada target palsu agar alur bisa dicoba tanpa akses Meta. */
export async function metaTarget(app: FastifyInstance, wsId: string): Promise<MetaTarget | null> {
  const row = (await app.db.query<{ meta_dataset_id: string | null; meta_token_enc: string | null }>(
    'SELECT meta_dataset_id, meta_token_enc FROM workspace_integrations WHERE workspace_id = $1', [wsId])).rows[0];
  if (row?.meta_dataset_id && row.meta_token_enc) {
    return { datasetId: row.meta_dataset_id, token: decrypt(app.cfg.encryptionKey, row.meta_token_enc, `ws:${wsId}:meta_token`) };
  }
  return app.cfg.metaMock ? { datasetId: 'mock', token: 'mock' } : null;
}

/** Cukup cek tersambung atau tidak, tanpa membuka token (dipakai dashboard). */
export async function metaConnected(app: FastifyInstance, wsId: string): Promise<boolean> {
  const row = (await app.db.query('SELECT 1 FROM workspace_integrations WHERE workspace_id = $1 AND meta_dataset_id IS NOT NULL AND meta_token_enc IS NOT NULL', [wsId])).rows[0];
  return !!row || app.cfg.metaMock;
}

export async function addAttempt(app: FastifyInstance, eventRowId: string, httpStatus: number | null, message: string) {
  await app.db.query('INSERT INTO event_attempts (event_id, http_status, message) VALUES ($1,$2,$3)', [eventRowId, httpStatus, message]);
}

/** Kirim satu event tersimpan ke Meta, catat percobaannya, lalu perbarui status baris event. */
export async function deliver(app: FastifyInstance, eventRowId: string, target: MetaTarget | null, payload: unknown): Promise<DeliverResult> {
  if (!target) {
    const error = 'Meta belum terhubung';
    await app.db.query("UPDATE events SET status = 'failed', error = $2 WHERE id = $1", [eventRowId, error]);
    await addAttempt(app, eventRowId, null, error);
    return { ok: false, status: 0, error };
  }
  const r = await app.meta(`/${target.datasetId}/events`, target.token, { method: 'POST', body: payload });
  const error = r.ok ? null : String(r.body?.error?.message ?? 'Gagal');
  await app.db.query("UPDATE events SET status = $2, response = $3, error = $4, sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE NULL END WHERE id = $1",
    [eventRowId, r.ok ? 'sent' : 'failed', JSON.stringify(r.body ?? {}), error]);
  await addAttempt(app, eventRowId, r.status || null, r.ok ? `Diterima Meta · events_received: ${r.body?.events_received ?? 1}` : error!);
  return r.ok ? { ok: true, status: r.status, events_received: r.body?.events_received } : { ok: false, status: r.status, error, code: r.body?.error?.code };
}
