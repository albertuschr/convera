import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { HttpError } from './http.js';

const blocked = new net.BlockList();
for (const [a, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) blocked.addSubnet(a, bits, 'ipv4');
for (const [a, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32]] as const) blocked.addSubnet(a, bits, 'ipv6');

export function isBlockedAddress(addr: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr); // IPv4-mapped IPv6
  const ip = mapped?.[1] ?? addr;
  const fam = net.isIP(ip);
  if (!fam) return true;
  return blocked.check(ip, fam === 4 ? 'ipv4' : 'ipv6');
}

/** Validasi statis: https, tanpa kredensial, dan bukan IP privat (literal). Cek DNS dilakukan saat koneksi. */
export function assertWebhookUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new HttpError(422, 'URL webhook tidak valid'); }
  if (u.protocol !== 'https:') throw new HttpError(422, 'URL harus diawali https://');
  if (u.username || u.password) throw new HttpError(422, 'URL tidak boleh memuat username/password');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedAddress(host)) throw new HttpError(422, 'Alamat tujuan tidak diizinkan');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) throw new HttpError(422, 'Alamat tujuan tidak diizinkan');
  return u;
}

export interface PostResult { ok: boolean; status?: number; error?: string }
export type SafePost = (url: string, body: string, headers: Record<string, string>, timeoutMs?: number) => Promise<PostResult>;

/**
 * POST JSON ke URL pengguna dengan perlindungan SSRF: alamat hasil DNS diperiksa di dalam `lookup`
 * (jadi tidak bisa dibelokkan lewat DNS rebinding), redirect tidak diikuti, respons tidak dibaca.
 */
export const safePost: SafePost = (rawUrl, body, headers, timeoutMs = 7000) =>
  new Promise((resolve) => {
    let u: URL;
    try { u = assertWebhookUrl(rawUrl); } catch (e) { return resolve({ ok: false, error: (e as Error).message }); }
    const lookup = (hostname: string, options: dns.LookupOptions, cb: (...a: unknown[]) => void) => {
      dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
        if (err) return cb(err);
        const list = addrs as dns.LookupAddress[];
        if (!list.length || list.some((a) => isBlockedAddress(a.address))) return cb(new Error('Alamat tujuan tidak diizinkan'));
        if (options.all) return cb(null, list);
        const first = list[0]!;
        cb(null, first.address, first.family);
      });
    };
    const req = https.request(
      { protocol: 'https:', hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || 443, path: u.pathname + u.search, method: 'POST', lookup: lookup as never, timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Convera-Webhook/1.0', ...headers } },
      (res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        res.destroy();
        resolve({ ok: status >= 200 && status < 300, status, error: status >= 200 && status < 300 ? '' : `HTTP ${status}` });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: `Timeout ${timeoutMs / 1000} detik` }); });
    req.on('error', (e) => resolve({ ok: false, error: /tidak diizinkan/.test(e.message) ? e.message : 'Tidak terjangkau' }));
    req.end(body);
  });
