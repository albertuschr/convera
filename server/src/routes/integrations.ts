import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../lib/http.js';
import { decrypt, encrypt, hmacSha256Hex, maskSecret, randomToken } from '../lib/crypto.js';
import { assertWebhookUrl } from '../lib/ssrf.js';
import { audit } from '../lib/audit.js';
import * as v from '../lib/schemas.js';

const idParam = z.object({ id: v.uuid });
const NEEDS_VALUE = ['Purchase', 'InitiateCheckout', 'AddToCart'];

interface IntegrationRow {
  meta_dataset_id: string | null; meta_token_enc: string | null; meta_token_saved_at: Date | null;
  webhook_url: string | null; webhook_events: string[]; webhook_secret_enc: string | null;
}

const eventRow = z.object({
  event_name: z.string().min(1).max(64),
  event_time: z.number().int().positive(),
  event_id: z.string().min(1).max(128),
  action_source: z.literal('business_messaging'),
  messaging_channel: z.literal('whatsapp'),
  // ph/em wajib berupa hash SHA-256 (hex) sehingga data pribadi tidak pernah dikirim/disimpan polos.
  user_data: z.object({
    ctwa_clid: z.string().min(1).max(512),
    ph: z.array(z.string().regex(/^[a-f0-9]{64}$/, 'Nomor telepon harus di-hash SHA-256')).max(5).optional(),
    em: z.array(z.string().regex(/^[a-f0-9]{64}$/, 'Email harus di-hash SHA-256')).max(5).optional(),
  }).strict(),
  custom_data: z.object({ value: z.number().nonnegative().max(1e12), currency: z.string().length(3) }).strict().optional(),
}).strict();
const eventsBody = z.object({
  payload: z.object({ data: z.array(eventRow).length(1), test_event_code: z.string().max(64).optional() }).strict(),
  source: z.enum(['api', 'manual', 'auto']).default('manual'),
});

export default async function integrationRoutes(app: FastifyInstance) {
  const { db, cfg } = app;
  const auth = { preHandler: app.requireAuth };
  const aad = (wsId: string, what: string) => `ws:${wsId}:${what}`;
  // Endpoint yang memicu panggilan keluar dibatasi ketat per pengguna.
  const outbound = { preHandler: app.requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  const load = async (wsId: string) =>
    (await db.query<IntegrationRow>('SELECT meta_dataset_id, meta_token_enc, meta_token_saved_at, webhook_url, webhook_events, webhook_secret_enc FROM workspace_integrations WHERE workspace_id = $1', [wsId])).rows[0];
  const metaToken = (wsId: string, row?: IntegrationRow) => (row?.meta_token_enc ? decrypt(cfg.encryptionKey, row.meta_token_enc, aad(wsId, 'meta_token')) : null);

  // Hanya data tersamar yang dikembalikan; token dan secret asli tidak pernah dikirim balik ke browser.
  app.get('/workspaces/:id/integrations', auth, async (req) => {
    const { id } = idParam.parse(req.params);
    await app.memberRole(req, id);
    const row = await load(id);
    const token = metaToken(id, row);
    const secret = row?.webhook_secret_enc ? decrypt(cfg.encryptionKey, row.webhook_secret_enc, aad(id, 'webhook_secret')) : null;
    return { data: {
      meta: { connected: !!(row?.meta_dataset_id && token), datasetId: row?.meta_dataset_id ?? null, tokenMasked: token ? maskSecret(token) : null, tokenSavedAt: row?.meta_token_saved_at ?? null },
      webhook: { url: row?.webhook_url ?? null, events: row?.webhook_events ?? [], secretMasked: secret ? maskSecret(secret) : null },
    } };
  });

  // ---- Meta ----
  app.put('/workspaces/:id/integrations/meta', auth, async (req) => {
    const { id } = idParam.parse(req.params);
    const input = z.object({ datasetId: v.datasetId, accessToken: v.accessToken.optional() }).parse(req.body);
    await app.memberRole(req, id, ['owner']);
    const existing = await load(id);
    if (!input.accessToken && !existing?.meta_token_enc) throw new HttpError(422, 'Access token wajib diisi');
    const enc = input.accessToken ? encrypt(cfg.encryptionKey, input.accessToken, aad(id, 'meta_token')) : existing!.meta_token_enc;
    await db.query(
      `INSERT INTO workspace_integrations (workspace_id, meta_dataset_id, meta_token_enc, meta_token_saved_at)
       VALUES ($1,$2,$3, now())
       ON CONFLICT (workspace_id) DO UPDATE SET meta_dataset_id = EXCLUDED.meta_dataset_id, meta_token_enc = EXCLUDED.meta_token_enc,
         meta_token_saved_at = CASE WHEN $4 THEN now() ELSE workspace_integrations.meta_token_saved_at END, updated_at = now()`,
      [id, input.datasetId, enc, !!input.accessToken]);
    await audit(db, { workspaceId: id, userId: req.auth!.userId, action: 'meta.save', meta: { datasetId: input.datasetId, tokenReplaced: !!input.accessToken }, ip: req.ip });
    return { data: { connected: true, datasetId: input.datasetId, tokenMasked: maskSecret(input.accessToken ?? metaToken(id, existing)!) } };
  });

  app.delete('/workspaces/:id/integrations/meta', auth, async (req) => {
    const { id } = idParam.parse(req.params);
    await app.memberRole(req, id, ['owner']);
    await db.query('UPDATE workspace_integrations SET meta_dataset_id = NULL, meta_token_enc = NULL, meta_token_saved_at = NULL, updated_at = now() WHERE workspace_id = $1', [id]);
    await audit(db, { workspaceId: id, userId: req.auth!.userId, action: 'meta.disconnect', ip: req.ip });
    return { message: 'Koneksi Meta diputus' };
  });

  // Tes koneksi dilakukan di server. Boleh menguji kredensial baru (belum disimpan) lewat body.
  app.post('/workspaces/:id/integrations/meta/test', outbound, async (req) => {
    const { id } = idParam.parse(req.params);
    const input = z.object({ datasetId: v.datasetId.optional(), accessToken: v.accessToken.optional() }).default({}).parse(req.body ?? {});
    await app.memberRole(req, id, ['owner', 'cs']);
    const row = await load(id);
    const datasetId = input.datasetId ?? row?.meta_dataset_id;
    const token = input.accessToken ?? metaToken(id, row);
    if (!datasetId || !token) throw new HttpError(409, 'Meta belum terhubung');
    const r = await app.meta(`/${datasetId}?fields=id,name`, token);
    return { data: r.ok ? { ok: true, name: r.body?.name } : { ok: false, code: r.body?.error?.code, error: r.body?.error?.message ?? 'Ditolak Meta' } };
  });

  // Kirim event ke Meta Conversions API memakai token tersimpan. Payload dibuat frontend (PII sudah di-hash).
  app.post('/workspaces/:id/meta/events', outbound, async (req) => {
    const { id } = idParam.parse(req.params);
    const input = eventsBody.parse(req.body);
    await app.memberRole(req, id, ['owner', 'cs']);
    const e = input.payload.data[0]!;
    if (Date.now() / 1000 - e.event_time > 7 * 86400) throw new HttpError(422, 'event_time lebih dari 7 hari');
    if (e.event_time > Date.now() / 1000 + 3600) throw new HttpError(422, 'event_time berada di masa depan');
    if (NEEDS_VALUE.includes(e.event_name) && !((e.custom_data?.value ?? 0) > 0)) throw new HttpError(422, `value wajib untuk ${e.event_name}`);

    const row = await load(id);
    const token = metaToken(id, row);
    if (!row?.meta_dataset_id || !token) throw new HttpError(409, 'Meta belum terhubung');

    const up = await db.query<{ id: string }>(
      `INSERT INTO events (workspace_id, event_id, event_name, value, currency, source, status, payload, attempts)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,1)
       ON CONFLICT (workspace_id, event_id) DO UPDATE SET attempts = events.attempts + 1, payload = EXCLUDED.payload WHERE events.status <> 'sent'
       RETURNING id`,
      [id, e.event_id, e.event_name, e.custom_data?.value ?? 0, e.custom_data?.currency ?? 'IDR', input.source, JSON.stringify(input.payload)]);
    const eventRowId = up.rows[0]?.id;
    if (!eventRowId) return { data: { ok: true, duplicate: true, status: 200 } }; // event_id sama sudah terkirim (idempoten)

    const r = await app.meta(`/${row.meta_dataset_id}/events`, token, { method: 'POST', body: input.payload });
    const error = r.ok ? null : String(r.body?.error?.message ?? 'Gagal');
    await db.query("UPDATE events SET status = $2, response = $3, error = $4, sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE NULL END WHERE id = $1",
      [eventRowId, r.ok ? 'sent' : 'failed', JSON.stringify(r.body ?? {}), error]);
    await audit(db, { workspaceId: id, userId: req.auth!.userId, action: r.ok ? 'meta.event_sent' : 'meta.event_failed', target: e.event_id, meta: { event: e.event_name }, ip: req.ip });
    return { data: r.ok ? { ok: true, status: r.status, events_received: r.body?.events_received } : { ok: false, status: r.status, error, code: r.body?.error?.code } };
  });

  // ---- Webhook ----
  app.put('/workspaces/:id/integrations/webhook', auth, async (req) => {
    const { id } = idParam.parse(req.params);
    const input = z.object({
      url: z.string().trim().max(2048),
      events: z.array(z.string().regex(/^[a-z][a-z0-9_.]{0,62}$/)).max(20).default([]),
      regenerateSecret: z.boolean().default(false),
    }).parse(req.body);
    assertWebhookUrl(input.url);
    await app.memberRole(req, id, ['owner']);
    const existing = await load(id);
    const fresh = input.regenerateSecret || !existing?.webhook_secret_enc;
    const secret = fresh ? `whsec_${randomToken(24)}` : null;
    const enc = secret ? encrypt(cfg.encryptionKey, secret, aad(id, 'webhook_secret')) : existing!.webhook_secret_enc;
    await db.query(
      `INSERT INTO workspace_integrations (workspace_id, webhook_url, webhook_events, webhook_secret_enc) VALUES ($1,$2,$3,$4)
       ON CONFLICT (workspace_id) DO UPDATE SET webhook_url = EXCLUDED.webhook_url, webhook_events = EXCLUDED.webhook_events, webhook_secret_enc = EXCLUDED.webhook_secret_enc, updated_at = now()`,
      [id, input.url, input.events, enc]);
    await audit(db, { workspaceId: id, userId: req.auth!.userId, action: fresh ? 'webhook.save_new_secret' : 'webhook.save', meta: { host: new URL(input.url).host }, ip: req.ip });
    // Secret polos hanya ditampilkan sekali, saat dibuat/diganti.
    return { data: { url: input.url, events: input.events, ...(secret ? { secret } : {}), secretMasked: maskSecret(secret ?? decrypt(cfg.encryptionKey, enc!, aad(id, 'webhook_secret'))) } };
  });

  app.delete('/workspaces/:id/integrations/webhook', auth, async (req) => {
    const { id } = idParam.parse(req.params);
    await app.memberRole(req, id, ['owner']);
    await db.query("UPDATE workspace_integrations SET webhook_url = NULL, webhook_events = '{}', webhook_secret_enc = NULL, updated_at = now() WHERE workspace_id = $1", [id]);
    await audit(db, { workspaceId: id, userId: req.auth!.userId, action: 'webhook.delete', ip: req.ip });
    return { message: 'Webhook dihapus' };
  });

  app.post('/workspaces/:id/integrations/webhook/test', outbound, async (req) => {
    const { id } = idParam.parse(req.params);
    await app.memberRole(req, id, ['owner', 'cs']);
    const row = await load(id);
    if (!row?.webhook_url || !row.webhook_secret_enc) throw new HttpError(409, 'Webhook belum dikonfigurasi');
    const secret = decrypt(cfg.encryptionKey, row.webhook_secret_enc, aad(id, 'webhook_secret'));
    const body = JSON.stringify({ type: 'event.sent', test: true, sent_at: new Date().toISOString(), data: { event_name: 'Purchase', value: 150000, currency: 'IDR' } });
    const r = await app.deps.safePost(row.webhook_url, body, { 'X-Convera-Signature': `sha256=${hmacSha256Hex(secret, body)}` });
    await audit(db, { workspaceId: id, userId: req.auth!.userId, action: 'webhook.test', meta: { ok: r.ok, status: r.status ?? null }, ip: req.ip });
    return { data: { ok: r.ok, status: r.status, error: r.error ?? '' } };
  });
}
