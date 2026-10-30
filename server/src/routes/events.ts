import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, notFound } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { ATTRIBUTION_MS, addAttempt, deliver, metaConnected, metaTarget } from '../lib/events.js';
import * as v from '../lib/schemas.js';

const idParam = z.object({ id: v.uuid });
const eventParam = z.object({ id: v.uuid, eventId: v.uuid });
// Hari dashboard dihitung dalam WIB. Nanti bisa diambil dari pengaturan zona waktu workspace.
const TZ = 'Asia/Jakarta';
const listQuery = z.object({
  status: z.enum(['pending', 'sent', 'failed', 'expired', 'duplicate']).optional(), // duplicate = pernah dilewati karena event_id sama
  source: z.enum(['api', 'manual', 'auto']).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
const rangeQuery = z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) })
  .refine((r) => +new Date(r.to) > +new Date(r.from) && +new Date(r.to) - +new Date(r.from) <= 400 * 86_400_000, 'Rentang tanggal tidak valid (maks. 400 hari)');

interface EventRow {
  id: string; event_id: string; event_name: string; value: string; source: string; status: string; error: string | null;
  attempts: number; duplicates: number; created_at: Date; sent_at: Date | null; event_time: Date | null;
  lead_id: string | null; lead_name: string | null; lead_phone: string | null; ctwa_clid: string | null; by_name: string | null;
}
const eventOut = (r: EventRow, mask: boolean) => ({
  id: r.id, eventId: r.event_id, eventName: r.event_name, value: Number(r.value), source: r.source, status: r.status, error: r.error,
  attempts: r.attempts, duplicates: r.duplicates, createdAt: r.created_at.toISOString(), sentAt: r.sent_at?.toISOString() ?? null,
  eventTime: (r.event_time ?? r.created_at).toISOString(), leadId: r.lead_id, leadName: r.lead_name,
  leadPhone: r.lead_phone && mask ? r.lead_phone.slice(0, 3) + '•••' + r.lead_phone.slice(-4) : r.lead_phone, ctwaClid: r.ctwa_clid, by: r.by_name,
});
const SELECT = `SELECT e.id, e.event_id, e.event_name, e.value, e.source, e.status, e.error, e.attempts, e.duplicates, e.created_at, e.sent_at, e.event_time,
  e.lead_id, l.name AS lead_name, l.phone AS lead_phone, COALESCE(l.ctwa_clid, e.payload #>> '{data,0,user_data,ctwa_clid}') AS ctwa_clid, u.name AS by_name
  FROM events e LEFT JOIN leads l ON l.id = e.lead_id LEFT JOIN users u ON u.id = e.created_by`;

export default async function eventRoutes(app: FastifyInstance) {
  const { db } = app;
  const auth = { preHandler: app.requireAuth };
  const outbound = { preHandler: app.requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const getEvent = async (wsId: string, eventId: string) => {
    const row = (await db.query<EventRow & { payload: any; response: any }>(`${SELECT.replace('u.name AS by_name', 'u.name AS by_name, e.payload, e.response')} WHERE e.workspace_id = $1 AND e.id = $2`, [wsId, eventId])).rows[0];
    if (!row) throw notFound();
    return row;
  };

  app.get('/workspaces/:id/events', auth, async (req) => {
    const { id } = idParam.parse(req.params);
    const q = listQuery.parse(req.query);
    const role = await app.memberRole(req, id);
    const where = ['e.workspace_id = $1'], args: unknown[] = [id];
    if (q.status === 'duplicate') where.push('e.duplicates > 0');
    else if (q.status) { args.push(q.status); where.push(`e.status = $${args.length}`); }
    if (q.source) { args.push(q.source); where.push(`e.source = $${args.length}`); }
    if (q.from) { args.push(q.from); where.push(`e.created_at >= $${args.length}`); }
    if (q.to) { args.push(q.to); where.push(`e.created_at < $${args.length}`); }
    args.push(q.limit);
    const { rows } = await db.query<EventRow>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC LIMIT $${args.length}`, args);
    return { data: rows.map((r) => eventOut(r, role === 'agency')) };
  });

  app.get('/workspaces/:id/events/:eventId', auth, async (req) => {
    const { id, eventId } = eventParam.parse(req.params);
    const role = await app.memberRole(req, id);
    const row = await getEvent(id, eventId);
    const attempts = (await db.query<{ http_status: number | null; message: string; created_at: Date }>(
      'SELECT http_status, message, created_at FROM event_attempts WHERE event_id = $1 ORDER BY id', [eventId])).rows;
    return { data: { ...eventOut(row, role === 'agency'), payload: row.payload, response: row.response,
      history: attempts.map((a) => ({ status: a.http_status, message: a.message, at: a.created_at.toISOString() })) } };
  });

  // Kirim ulang event yang gagal memakai payload & event_id yang sama (Meta men-dedup per event_id).
  app.post('/workspaces/:id/events/:eventId/resend', outbound, async (req) => {
    const { id, eventId } = eventParam.parse(req.params);
    await app.memberRole(req, id, ['owner', 'cs']);
    const row = await getEvent(id, eventId);
    if (!['failed', 'pending'].includes(row.status)) throw new HttpError(409, row.status === 'sent' ? 'Event sudah terkirim' : 'Event ini tidak bisa dikirim ulang');
    const eventTime = Number(row.payload?.data?.[0]?.event_time ?? 0) * 1000;
    if (Date.now() - eventTime > ATTRIBUTION_MS) {
      await db.query("UPDATE events SET status = 'expired', error = 'Lewat batas 7 hari' WHERE id = $1", [eventId]);
      await addAttempt(app, eventId, null, 'Tidak dikirim — event_time lebih dari 7 hari');
      return { data: { ok: false, expired: true, error: 'Lewat batas 7 hari, event tidak bisa dikirim ulang' } };
    }
    await db.query('UPDATE events SET attempts = attempts + 1 WHERE id = $1', [eventId]);
    const r = await deliver(app, eventId, await metaTarget(app, id), row.payload);
    await audit(db, { workspaceId: id, userId: req.auth!.userId, action: r.ok ? 'meta.event_resent' : 'meta.event_failed', target: row.event_id, ip: req.ip });
    return { data: r };
  });

  // Angka Overview & Performa untuk rentang [from, to). Klien mengirim batas hari (00:00 WIB).
  app.get('/workspaces/:id/dashboard', auth, async (req) => {
    const { id } = idParam.parse(req.params);
    const { from, to } = rangeQuery.parse(req.query);
    await app.memberRole(req, id);
    const len = +new Date(to) - +new Date(from);
    const prevFrom = new Date(+new Date(from) - len).toISOString();
    const kpi = async (f: string, t: string) => (await db.query<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM leads WHERE workspace_id = $1 AND created_at >= $2 AND created_at < $3) AS chats,
         (SELECT count(*) FROM leads WHERE workspace_id = $1 AND created_at >= $2 AND created_at < $3 AND status IN ('lead','checkout','purchase')) AS leads,
         (SELECT count(*) FROM leads WHERE workspace_id = $1 AND created_at >= $2 AND created_at < $3 AND ctwa_clid IS NOT NULL) AS with_clid,
         (SELECT count(*) FROM events WHERE workspace_id = $1 AND created_at >= $2 AND created_at < $3 AND status = 'sent' AND event_name = 'Purchase') AS purchases,
         (SELECT COALESCE(sum(value), 0) FROM events WHERE workspace_id = $1 AND created_at >= $2 AND created_at < $3 AND status = 'sent' AND event_name = 'Purchase') AS value,
         (SELECT COALESCE(sum(spend), 0) FROM ad_insights WHERE workspace_id = $1 AND date >= ($2::timestamptz AT TIME ZONE $4)::date AND date < ($3::timestamptz AT TIME ZONE $4)::date) AS spend,
         (SELECT COALESCE(sum(clicks), 0) FROM ad_insights WHERE workspace_id = $1 AND date >= ($2::timestamptz AT TIME ZONE $4)::date AND date < ($3::timestamptz AT TIME ZONE $4)::date) AS clicks`,
      [id, f, t, TZ])).rows[0]!;
    const num = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, x]) => [k, Number(x)]));

    // Grafik selalu minimal 7 hari (berakhir di `to`) agar rentang "Hari ini" tetap punya garis.
    const daily = (await db.query<{ day: string; chats: string; purchases: string }>(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day,
         (SELECT count(*) FROM leads l WHERE l.workspace_id = $1 AND (l.created_at AT TIME ZONE $4)::date = d::date) AS chats,
         (SELECT count(*) FROM events e WHERE e.workspace_id = $1 AND e.status = 'sent' AND e.event_name = 'Purchase' AND (e.created_at AT TIME ZONE $4)::date = d::date) AS purchases
       FROM generate_series(LEAST(($2::timestamptz AT TIME ZONE $4)::date, ($3::timestamptz AT TIME ZONE $4)::date - 7), ($3::timestamptz AT TIME ZONE $4)::date - 1, interval '1 day') d`,
      [id, from, to, TZ])).rows;

    const ads = (await db.query<Record<string, string>>(
      `WITH l AS (
         SELECT COALESCE(campaign, '') AS campaign, COALESCE(ad_set, '') AS ad_set, ad, count(*) AS chats, count(*) FILTER (WHERE status IN ('lead','checkout','purchase')) AS leads
           FROM leads WHERE workspace_id = $1 AND created_at >= $2 AND created_at < $3 AND ad IS NOT NULL GROUP BY 1, 2, 3),
       p AS (
         SELECT COALESCE(l.campaign, '') AS campaign, COALESCE(l.ad_set, '') AS ad_set, l.ad, count(*) AS purchases, sum(e.value) AS value
           FROM events e JOIN leads l ON l.id = e.lead_id
          WHERE e.workspace_id = $1 AND e.created_at >= $2 AND e.created_at < $3 AND e.status = 'sent' AND e.event_name = 'Purchase' AND l.ad IS NOT NULL GROUP BY 1, 2, 3),
       s AS (
         SELECT campaign, ad_set, ad, sum(spend) AS spend, sum(clicks) AS clicks FROM ad_insights
          WHERE workspace_id = $1 AND date >= ($2::timestamptz AT TIME ZONE $4)::date AND date < ($3::timestamptz AT TIME ZONE $4)::date GROUP BY 1, 2, 3),
       k AS (SELECT campaign, ad_set, ad FROM l UNION SELECT campaign, ad_set, ad FROM p UNION SELECT campaign, ad_set, ad FROM s)
       SELECT COALESCE(NULLIF(k.campaign, ''), '(tanpa kampanye)') AS campaign, k.ad_set, k.ad, COALESCE(s.spend, 0) AS spend, COALESCE(s.clicks, 0) AS clicks,
              COALESCE(l.chats, 0) AS chats, COALESCE(l.leads, 0) AS leads, COALESCE(p.purchases, 0) AS purchases, COALESCE(p.value, 0) AS value
         FROM k LEFT JOIN l USING (campaign, ad_set, ad) LEFT JOIN p USING (campaign, ad_set, ad) LEFT JOIN s USING (campaign, ad_set, ad)`,
      [id, from, to, TZ])).rows;

    const counts = (await db.query<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM events WHERE workspace_id = $1 AND status = 'failed' AND created_at > now() - interval '24 hours') AS failed24h,
         (SELECT count(*) FROM leads WHERE workspace_id = $1 AND ctwa_clid IS NOT NULL AND status = 'checkout'
             AND COALESCE(clicked_at, created_at) BETWEEN now() - interval '7 days' AND now() - interval '6 days') AS expiring24h,
         (SELECT count(*) FROM leads WHERE workspace_id = $1) AS "totalLeads"`,
      [id])).rows[0]!;
    const connected = await metaConnected(app, id);

    return { data: {
      current: num(await kpi(from, to)), previous: num(await kpi(prevFrom, from)),
      daily: daily.map((d) => ({ day: d.day, chats: Number(d.chats), purchases: Number(d.purchases) })),
      ads: ads.map((a) => ({ campaign: a.campaign, adSet: a.ad_set, ad: a.ad, spend: Number(a.spend), clicks: Number(a.clicks), chats: Number(a.chats), leads: Number(a.leads), purchases: Number(a.purchases), value: Number(a.value) })),
      counts: num(counts), meta: { connected, mock: app.cfg.metaMock },
    } };
  });
}
