// Pembuatan & pengiriman event ke Meta Conversions API (WhatsApp / business messaging).
import { sha256Hex, uid } from './crypto.js';
import { normPhone, isDatasetId, isToken } from './validators.js';
import { appConfig } from './config.js';
export const LIVE = appConfig.liveMetaApi; // true = panggil Graph API sungguhan
const GRAPH = 'https://graph.facebook.com/v19.0';
const NEEDS_VALUE = ['Purchase', 'InitiateCheckout', 'AddToCart'];

export async function buildEvent({ event, value = 0, clid, phone, email, eventId, time, testCode }) {
  const user = { ctwa_clid: clid };
  if (phone) user.ph = [await sha256Hex(normPhone(phone))];
  if (email) user.em = [await sha256Hex(String(email).trim().toLowerCase())];
  const row = { event_name: event, event_time: Math.floor((time || Date.now()) / 1000), event_id: eventId || uid(), action_source: 'business_messaging', messaging_channel: 'whatsapp', user_data: user };
  if (NEEDS_VALUE.includes(event)) row.custom_data = { value: Number(value) || 0, currency: 'IDR' };
  const payload = { data: [row] };
  if (testCode) payload.test_event_code = testCode;
  return payload;
}
export function validateEvent(payload) {
  const e = payload.data[0], errs = [];
  if (!e.user_data.ctwa_clid) errs.push('ctwa_clid kosong — lead bukan dari iklan');
  if (Date.now() / 1000 - e.event_time > 7 * 86400) errs.push('event_time lebih dari 7 hari');
  if (NEEDS_VALUE.includes(e.event_name) && !(e.custom_data?.value > 0)) errs.push('value wajib untuk ' + e.event_name);
  return errs;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function graph(path, opt, token, ms = 9000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(`${GRAPH}${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`, { ...opt, signal: c.signal }); const body = await r.json().catch(() => ({})); return { ok: r.ok, status: r.status, body }; }
  catch (e) { return { ok: false, status: 0, network: true, body: { error: { message: e.name === 'AbortError' ? 'Timeout' : 'Tidak bisa menjangkau graph.facebook.com' } } }; }
  finally { clearTimeout(t); }
}
export async function sendEvent(payload, { datasetId, token } = {}) {
  const errs = validateEvent(payload); if (errs.length) return { ok: false, status: 400, error: errs.join('; ') };
  if (!LIVE) { await wait(700); return { ok: true, status: 200, demo: true, events_received: 1 }; }
  const r = await graph(`/${datasetId}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, token);
  return r.ok ? { ok: true, status: r.status, ...r.body } : { ok: false, status: r.status, error: r.body?.error?.message || 'Gagal', code: r.body?.error?.code };
}
export async function testConnection({ datasetId, token }) {
  if (!isDatasetId(datasetId)) return { ok: false, code: 100, error: 'Dataset ID harus 15–16 digit angka' };
  if (!isToken(token)) return { ok: false, code: 190, error: 'Access token tidak valid atau terlalu pendek' };
  if (!LIVE) { await wait(900); return { ok: true, demo: true }; }
  const r = await graph(`/${datasetId}?fields=id,name`, {}, token);
  return r.ok ? { ok: true, name: r.body.name } : { ok: false, code: r.body?.error?.code, error: r.body?.error?.message || 'Ditolak Meta' };
}
