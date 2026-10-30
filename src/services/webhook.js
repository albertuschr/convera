import { hmacSha256Hex } from './crypto.js';
import { isHttps } from './validators.js';
import { appConfig } from './config.js';
import { webhookSave, webhookTest } from './backend.js';

const EVENT_NAMES = { sent: 'event.sent', failed: 'event.failed', lead: 'lead.created', quota: 'quota.warning' };
// Mode backend: URL, event, dan secret disimpan di server. Mengembalikan Promise, atau null di mode demo.
export function saveWebhook(url, whEv) {
  if (!appConfig.backendEnabled) return null;
  const picked = whEv || { sent: true, failed: true, quota: false, lead: false };
  return webhookSave({ url, events: Object.keys(EVENT_NAMES).filter((k) => picked[k]).map((k) => EVENT_NAMES[k]) });
}
// Kirim POST bertanda tangan HMAC-SHA256 ke URL webhook pengguna dan laporkan hasil sebenarnya.
export async function testWebhook(url, secret, event = 'event.sent') {
  if (appConfig.backendEnabled) { try { return await webhookTest(); } catch (e) { return { ok: false, error: e.message }; } }
  if (!isHttps(url)) return { ok: false, error: 'URL harus diawali https://' };
  const body = JSON.stringify({ type: event, test: true, sent_at: new Date().toISOString(), data: { event_name: 'Purchase', value: 150000, currency: 'IDR' } });
  const sig = await hmacSha256Hex(secret, body);
  const c = new AbortController(), t = setTimeout(() => c.abort(), 7000);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-Convera-Signature': 'sha256=' + sig } : {}) }, body, signal: c.signal });
    return { ok: r.ok, status: r.status, error: r.ok ? '' : 'HTTP ' + r.status };
  } catch (e) { return { ok: false, error: e.name === 'AbortError' ? 'Timeout 7 detik' : 'Tidak terjangkau (server mati atau CORS memblokir)' }; }
  finally { clearTimeout(t); }
}
