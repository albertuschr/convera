import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '../db.js';
import { HttpError, notFound } from '../lib/http.js';
import { randomToken } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { ATTRIBUTION_MS, NEEDS_VALUE, addAttempt, deliver, hashPhone, metaTarget } from '../lib/events.js';
import * as v from '../lib/schemas.js';

const idParam = z.object({ id: v.uuid });
const leadParam = z.object({ id: v.uuid, leadId: v.uuid });
export const LEAD_STATUS = ['new', 'lead', 'checkout', 'purchase', 'lost'] as const;
const leadStatus = z.enum(LEAD_STATUS);
export const EVENT_NAMES = ['Purchase', 'InitiateCheckout', 'AddToCart', 'LeadSubmitted', 'ViewContent'] as const;
// Status lead naik mengikuti event yang dikirim, tidak pernah turun (kecuali diubah manual).
const STATUS_OF: Record<string, (typeof LEAD_STATUS)[number]> = { Purchase: 'purchase', InitiateCheckout: 'checkout', AddToCart: 'checkout', LeadSubmitted: 'lead', ViewContent: 'lead' };
const RANK = { new: 0, lost: 0, lead: 1, checkout: 2, purchase: 3 };

const text = (max: number) => z.string().trim().max(max);
const phoneReq = v.phone.refine((p) => p !== '', 'Nomor telepon wajib diisi').transform(v.normPhone);
const createBody = z.object({
  name: text(120).default(''),
  phone: phoneReq,
  firstMessage: text(2000).default(''),
  ctwaClid: text(512).min(1).optional(),
  campaign: text(200).min(1).optional(),
  adSet: text(200).min(1).optional(),
  ad: text(200).min(1).optional(),
  adHeadline: text(500).optional(),
  adBody: text(1000).optional(),
  clickedAt: z.string().datetime({ offset: true }).optional(),
});
const listQuery = z.object({
  q: text(100).optional(),
  status: leadStatus.optional(),
  campaign: text(200).optional(), // '__organic' = lead tanpa iklan
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

interface LeadRow {
  id: string; name: string; phone: string; ctwa_clid: string | null; campaign: string | null; ad_set: string | null; ad: string | null;
  ad_headline: string | null; ad_body: string | null; first_message: string; status: string; value: string;
  clicked_at: Date | null; created_at: Date;
}
const COLS = 'id, name, phone, ctwa_clid, campaign, ad_set, ad, ad_headline, ad_body, first_message, status, value, clicked_at, created_at';
const maskPhone = (p: string) => (p.length > 7 ? p.slice(0, 3) + '•••' + p.slice(-4) : '•••');
// Agency hanya melihat; nomor pelanggan disamarkan.
const leadOut = (r: LeadRow, mask: boolean) => ({
  id: r.id, name: r.name, phone: mask ? maskPhone(r.phone) : r.phone, ctwaClid: r.ctwa_clid, campaign: r.campaign, adSet: r.ad_set, ad: r.ad,
  adHeadline: r.ad_headline, adBody: r.ad_body, firstMessage: r.first_message, status: r.status, value: Number(r.value),
  clickedAt: (r.clicked_at ?? r.created_at).toISOString(), createdAt: r.created_at.toISOString(),
});

export default async function leadRoutes(app: FastifyInstance) {
  const { db } = app;
  const auth = { preHandler: app.requireAuth };
  const outbound = { preHandler: app.requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const getLead = async (wsId: string, leadId: string) => {
    const row = (await db.query<LeadRow>(`SELECT ${COLS} FROM leads WHERE workspace_id = $1 AND id = $2`, [wsId, leadId])).rows[0];
    if (!row) throw notFound();
    return row;
  };

  app.get('/workspaces/:id/leads', auth, async (req) => {
    const { id } = idParam.parse(req.params);
    const q = listQuery.parse(req.query);
    const role = await app.memberRole(req, id);
    const where = ['workspace_id = $1'], args: unknown[] = [id];
    if (q.status) { args.push(q.status); where.push(`status = $${args.length}`); }
    if (q.campaign === '__organic') where.push('ad IS NULL');
    else if (q.campaign) { args.push(q.campaign); where.push(`campaign = $${args.length}`); }
    if (q.q) { args.push(`%${q.q.replace(/[\\%_]/g, '\\$&')}%`); where.push(`(name ILIKE $${args.length} OR phone ILIKE $${args.length} OR coalesce(ad, '') ILIKE $${args.length})`); }
    args.push(q.limit);
    const { rows } = await db.query<LeadRow>(`SELECT ${COLS} FROM leads WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${args.length}`, args);
    return { data: rows.map((r) => leadOut(r, role === 'agency')) };
  });

  app.get('/workspaces/:id/leads/:leadId', auth, async (req) => {
    const { id, leadId } = leadParam.parse(req.params);
    const role = await app.memberRole(req, id);
    const lead = await getLead(id, leadId);
    const { rows } = await db.query<{ id: string; event_name: string; value: string; status: string; source: string; created_at: Date }>(
      'SELECT id, event_name, value, status, source, created_at FROM events WHERE workspace_id = $1 AND lead_id = $2 ORDER BY created_at', [id, leadId]);
    return { data: { ...leadOut(lead, role === 'agency'), events: rows.map((e) => ({ id: e.id, eventName: e.event_name, value: Number(e.value), status: e.status, source: e.source, createdAt: e.created_at.toISOString() })) } };
  });

  // Tambah lead manual. Ingest otomatis dari WhatsApp menyusul di Fase 2.
  app.post('/workspaces/:id/leads', auth, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const b = createBody.parse(req.body);
    await app.memberRole(req, id, ['owner', 'cs']);
    try {
      const row = (await db.query<LeadRow>(
        `INSERT INTO leads (workspace_id, name, phone, first_message, ctwa_clid, campaign, ad_set, ad, ad_headline, ad_body, clicked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${COLS}`,
        [id, b.name, b.phone, b.firstMessage, b.ctwaClid ?? null, b.campaign ?? null, b.adSet ?? null, b.ad ?? null, b.adHeadline ?? null, b.adBody ?? null, b.clickedAt ?? null])).rows[0]!;
      await audit(db, { workspaceId: id, userId: req.auth!.userId, action: 'lead.create', target: row.id, ip: req.ip });
      return reply.code(201).send({ data: leadOut(row, false) });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'Lead dengan nomor ini sudah ada');
      throw e;
    }
  });

  app.patch('/workspaces/:id/leads/:leadId', auth, async (req) => {
    const { id, leadId } = leadParam.parse(req.params);
    const b = z.object({ name: text(120).optional(), status: leadStatus.optional(), value: z.number().nonnegative().max(1e12).optional() }).parse(req.body);
    await app.memberRole(req, id, ['owner', 'cs']);
    await getLead(id, leadId);
    const row = (await db.query<LeadRow>(
      `UPDATE leads SET name = COALESCE($3, name), status = COALESCE($4, status), value = COALESCE($5, value), updated_at = now()
        WHERE workspace_id = $1 AND id = $2 RETURNING ${COLS}`, [id, leadId, b.name ?? null, b.status ?? null, b.value ?? null])).rows[0]!;
    await audit(db, { workspaceId: id, userId: req.auth!.userId, action: 'lead.update', target: leadId, meta: { status: b.status, value: b.value }, ip: req.ip });
    return { data: leadOut(row, false) };
  });

  app.post('/workspaces/:id/leads/bulk-status', auth, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ ids: z.array(v.uuid).min(1).max(500), status: leadStatus }).parse(req.body);
    await app.memberRole(req, id, ['owner', 'cs']);
    const r = await db.query('UPDATE leads SET status = $3, updated_at = now() WHERE workspace_id = $1 AND id = ANY($2::uuid[])', [id, b.ids, b.status]);
    await audit(db, { workspaceId: id, userId: req.auth!.userId, action: 'lead.bulk_status', meta: { count: r.rowCount, status: b.status }, ip: req.ip });
    return { data: { updated: r.rowCount } };
  });

  app.delete('/workspaces/:id/leads/:leadId', auth, async (req) => {
    const { id, leadId } = leadParam.parse(req.params);
    await app.memberRole(req, id, ['owner', 'cs']);
    const r = await db.query('DELETE FROM leads WHERE workspace_id = $1 AND id = $2', [id, leadId]);
    if (!r.rowCount) throw notFound();
    await audit(db, { workspaceId: id, userId: req.auth!.userId, action: 'lead.delete', target: leadId, ip: req.ip });
    return { message: 'Lead dihapus' };
  });

  // Hak dihapus (permintaan pelanggan): lead dengan nomor ini beserta riwayat event-nya dihapus permanen.
  app.post('/workspaces/:id/contacts/forget', auth, async (req) => {
    const { id } = idParam.parse(req.params);
    const { phone } = z.object({ phone: phoneReq }).parse(req.body);
    await app.memberRole(req, id, ['owner']);
    const deleted = await tx(db, async (c) => {
      const ids = (await c.query<{ id: string }>('SELECT id FROM leads WHERE workspace_id = $1 AND phone = $2', [id, phone])).rows.map((r) => r.id);
      if (!ids.length) return 0;
      await c.query('DELETE FROM events WHERE workspace_id = $1 AND lead_id = ANY($2::uuid[])', [id, ids]);
      await c.query('DELETE FROM leads WHERE workspace_id = $1 AND id = ANY($2::uuid[])', [id, ids]);
      return ids.length;
    });
    if (!deleted) throw new HttpError(404, 'Tidak ada lead dengan nomor ini');
    // Nomor tidak dicatat polos di audit log.
    await audit(db, { workspaceId: id, userId: req.auth!.userId, action: 'contact.forget', meta: { leads: deleted, phoneSha256: hashPhone(phone) }, ip: req.ip });
    return { data: { deleted } };
  });

  // Tandai konversi dari halaman Leads: server menyusun payload CAPI (nomor di-hash di sini), mencatat, lalu mengirim ke Meta.
  app.post('/workspaces/:id/leads/:leadId/events', outbound, async (req, reply) => {
    const { id, leadId } = leadParam.parse(req.params);
    const b = z.object({
      eventName: z.enum(EVENT_NAMES),
      value: z.number().nonnegative().max(1e12).default(0),
      eventId: z.string().trim().regex(/^[\w.:-]{1,128}$/).optional(),
    }).parse(req.body);
    await app.memberRole(req, id, ['owner', 'cs']);
    const lead = await getLead(id, leadId);
    if (!lead.ctwa_clid) throw new HttpError(422, 'Lead organik (tanpa ctwa_clid) tidak bisa dikirim ke Meta');
    const needsValue = NEEDS_VALUE.includes(b.eventName);
    if (needsValue && !(b.value > 0)) throw new HttpError(422, `value wajib untuk ${b.eventName}`);

    const eventId = b.eventId ?? `cv_${randomToken(12)}`;
    const now = Math.floor(Date.now() / 1000);
    const expired = Date.now() - (lead.clicked_at ?? lead.created_at).getTime() > ATTRIBUTION_MS;
    const payload = { data: [{
      event_name: b.eventName, event_time: now, event_id: eventId, action_source: 'business_messaging', messaging_channel: 'whatsapp',
      user_data: { ctwa_clid: lead.ctwa_clid, ...(lead.phone ? { ph: [hashPhone(lead.phone)] } : {}) },
      ...(needsValue ? { custom_data: { value: b.value, currency: 'IDR' } } : {}),
    }] };
    const ins = await db.query<{ id: string }>(
      `INSERT INTO events (workspace_id, lead_id, event_id, event_name, value, source, status, payload, attempts, created_by, event_time, error)
       VALUES ($1,$2,$3,$4,$5,'manual',$6,$7,$8,$9, to_timestamp($10), $11)
       ON CONFLICT (workspace_id, event_id) DO NOTHING RETURNING id`,
      [id, leadId, eventId, b.eventName, needsValue ? b.value : 0, expired ? 'expired' : 'pending', JSON.stringify(payload), expired ? 0 : 1,
        req.auth!.userId, now, expired ? 'Lewat batas 7 hari sejak klik iklan' : null]);
    const rowId = ins.rows[0]?.id;
    if (!rowId) return { data: { ok: true, duplicate: true } }; // eventId yang sama dikirim dua kali (mis. klik ganda)

    const next = STATUS_OF[b.eventName]!;
    const status = RANK[next] >= RANK[lead.status as keyof typeof RANK] || lead.status === 'lost' ? next : lead.status;
    await db.query('UPDATE leads SET status = $3, value = CASE WHEN $4 > 0 THEN $4 ELSE value END, updated_at = now() WHERE workspace_id = $1 AND id = $2',
      [id, leadId, status, needsValue ? b.value : 0]);

    let result;
    if (expired) {
      await addAttempt(app, rowId, null, 'Tidak dikirim — lewat 7 hari sejak klik iklan');
      result = { ok: false, status: 0, expired: true, error: 'Lewat batas 7 hari sejak klik iklan' };
    } else {
      result = await deliver(app, rowId, await metaTarget(app, id), payload);
    }
    await audit(db, { workspaceId: id, userId: req.auth!.userId, action: result.ok ? 'meta.event_sent' : 'meta.event_failed', target: eventId, meta: { event: b.eventName, lead: leadId }, ip: req.ip });
    return reply.code(201).send({ data: { ...result, eventRowId: rowId, eventId, leadStatus: status } });
  });
}
