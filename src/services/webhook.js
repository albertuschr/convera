import { hmacSha256Hex } from './crypto.js';
import { isHttps } from './validators.js';
// Kirim POST bertanda tangan HMAC-SHA256 ke URL webhook pengguna dan laporkan hasil sebenarnya.
export async function testWebhook(url, secret, event = 'event.sent') {
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
