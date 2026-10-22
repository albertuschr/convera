const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function sha256Hex(text) {
  if (globalThis.crypto?.subtle) return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  return softSha256(text);
}
export async function hmacSha256Hex(secret, text) {
  if (!globalThis.crypto?.subtle) return null;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}
export function randomToken(len = 24) {
  const a = new Uint8Array(len); (globalThis.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => (a[i] = Math.random() * 256));
  return [...a].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}
export const uid = () => 'ev_' + Date.now().toString(36) + randomToken(6);
// SHA-256 murni JS (cadangan bila WebCrypto tidak tersedia, mis. HTTP non-localhost)
function softSha256(s) {
  const K = new Uint32Array(64); let p = 2, n = 0;
  while (n < 64) { let ok = true; for (let d = 2; d * d <= p; d++) if (p % d === 0) { ok = false; break; } if (ok) { K[n++] = (Math.cbrt(p) % 1) * 2 ** 32; } p++; }
  const H = new Uint32Array(8); p = 2; n = 0;
  while (n < 8) { let ok = true; for (let d = 2; d * d <= p; d++) if (p % d === 0) { ok = false; break; } if (ok) { H[n++] = (Math.sqrt(p) % 1) * 2 ** 32; } p++; }
  const b = enc.encode(s), l = b.length, tot = (((l + 9 + 63) >> 6) << 6), m = new Uint8Array(tot); m.set(b); m[l] = 0x80;
  new DataView(m.buffer).setUint32(tot - 4, l * 8); const w = new Uint32Array(64), r = (x, k) => (x >>> k) | (x << (32 - k));
  for (let o = 0; o < tot; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = new DataView(m.buffer).getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) { const a = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3), c = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = (w[i - 16] + a + w[i - 7] + c) | 0; }
    let [a, bb, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) { const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0, t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0; h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0; }
    H[0] += a; H[1] += bb; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return [...H].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}
