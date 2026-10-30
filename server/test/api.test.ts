import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { createPool, type Db } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { decrypt, encrypt, hmacSha256Hex, hashPassword, verifyPassword } from '../src/lib/crypto.js';
import { isBlockedAddress, safePost } from '../src/lib/ssrf.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/convera_test';
if (!/test/.test(new URL(DB_URL).pathname)) throw new Error('TEST_DATABASE_URL harus menunjuk database yang namanya memuat "test" (tes menghapus semua tabel)');

const ORIGIN = 'http://localhost:5173';
const TOKEN = 'EAAGm0PX4ZCpsBO' + 'x'.repeat(40);
const hex64 = (c: string) => c.repeat(64);
const createHashHex = (s: string) => createHash('sha256').update(s).digest('hex');

let app: FastifyInstance, db: Db;
let ipN = 0;
const graphCalls: { url: string; init: RequestInit }[] = [];
const hookCalls: { url: string; body: string; headers: Record<string, string> }[] = [];
let graphReply: () => { status: number; body: unknown } = () => ({ status: 200, body: { id: '1', name: 'Dataset Uji', events_received: 1 } });

const fakeFetch = (async (url: string | URL, init: RequestInit = {}) => {
  graphCalls.push({ url: String(url), init });
  const r = graphReply();
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

async function call(method: string, url: string, o: { body?: unknown; cookie?: string; origin?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  if (o.cookie) headers.cookie = o.cookie;
  const res = await app.inject({ method: method as 'GET', url, headers, payload: o.body as object | undefined, remoteAddress: `10.9.${Math.floor(++ipN / 250)}.${ipN % 250}` });
  const cookie = res.cookies.find((c) => c.name === 'convera_sid');
  return { res, status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, cookie: cookie ? `${cookie.name}=${cookie.value}` : undefined, setCookie: cookie };
}
async function register(email: string, extra: Record<string, unknown> = {}) {
  const r = await call('POST', '/api/v1/auth/register', { body: { name: 'User ' + email, email, password: 'Rahasia123', ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return { cookie: r.cookie!, userId: r.json.data.user.id as string, wsId: r.json.data.workspaces[0].id as string };
}

before(async () => {
  const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, ENCRYPTION_KEY: randomBytes(32).toString('base64'), CORS_ORIGINS: ORIGIN } as NodeJS.ProcessEnv);
  db = createPool(DB_URL);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  app = await buildApp(cfg, db, {
    fetch: fakeFetch,
    safePost: async (url, body, headers) => { hookCalls.push({ url, body, headers }); return { ok: true, status: 204, error: '' }; },
  });
});
after(async () => { await app.close(); await db.end(); });

describe('crypto', () => {
  it('hash password benar/salah', async () => {
    const h = await hashPassword('Rahasia123');
    assert.ok(await verifyPassword('Rahasia123', h));
    assert.ok(!(await verifyPassword('rahasia123', h)));
    assert.ok(!h.includes('Rahasia123'));
  });
  it('AES-GCM: round trip, dan ciphertext terikat ke AAD (tidak bisa ditukar antar workspace)', () => {
    const key = randomBytes(32);
    const c = encrypt(key, 'token-rahasia', 'ws:A:meta_token');
    assert.equal(decrypt(key, c, 'ws:A:meta_token'), 'token-rahasia');
    assert.throws(() => decrypt(key, c, 'ws:B:meta_token'));
    const parts = c.split('.'); parts[3] = Buffer.from('x' + parts[3]!).toString('base64url');
    assert.throws(() => decrypt(key, parts.join('.'), 'ws:A:meta_token'));
  });
});

describe('ssrf', () => {
  it('memblokir alamat privat/loopback/metadata, mengizinkan publik', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.5.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0']) assert.ok(isBlockedAddress(a), a);
    for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.ok(!isBlockedAddress(a), a);
  });
  it('safePost menolak tujuan internal tanpa melakukan koneksi', async () => {
    for (const u of ['https://127.0.0.1/hook', 'https://169.254.169.254/latest/meta-data', 'https://localhost/x', 'https://[::1]/x', 'http://example.com/x', 'https://user:pw@example.com/x']) {
      const r = await safePost(u, '{}', {});
      assert.equal(r.ok, false, u);
    }
  });
});

describe('auth & sesi', () => {
  it('register: cookie HttpOnly, password tidak bocor, session pulih', async () => {
    const r = await call('POST', '/api/v1/auth/register', { body: { name: 'Axl', email: 'Axl@Example.com', password: 'Rahasia123' } });
    assert.equal(r.status, 201);
    assert.ok(r.setCookie?.httpOnly); assert.equal(r.setCookie?.sameSite, 'Lax');
    assert.equal(r.json.data.user.email, 'axl@example.com');
    assert.ok(!JSON.stringify(r.json).match(/password_hash|scrypt|Rahasia123/));
    assert.equal(r.json.data.workspaces[0].role, 'owner');
    const s = await call('GET', '/api/v1/auth/session', { cookie: r.cookie });
    assert.equal(s.status, 200); assert.equal(s.json.data.user.name, 'Axl');
    const row = (await db.query("SELECT password_hash FROM users WHERE email='axl@example.com'")).rows[0];
    assert.ok(row.password_hash.startsWith('scrypt$'));
  });
  it('token sesi tidak disimpan polos di database', async () => {
    const u = await register('hash@example.com');
    const token = u.cookie.split('=')[1]!;
    const rows = (await db.query('SELECT token_hash FROM sessions')).rows;
    assert.ok(rows.every((r) => r.token_hash.toString('hex') !== Buffer.from(token).toString('hex')));
    assert.equal((await db.query("SELECT count(*)::int n FROM sessions WHERE encode(token_hash,'escape') = $1", [token])).rows[0].n, 0);
  });
  it('password lemah, email duplikat, dan input aneh ditolak', async () => {
    assert.equal((await call('POST', '/api/v1/auth/register', { body: { name: 'x', email: 'a@b.co', password: 'abcdefgh' } })).status, 422);
    assert.equal((await call('POST', '/api/v1/auth/register', { body: { name: 'x', email: 'a@b.co', password: 'short1' } })).status, 422);
    assert.equal((await call('POST', '/api/v1/auth/register', { body: { name: 'x', email: 'AXL@example.com', password: 'Rahasia123' } })).status, 409);
    assert.equal((await call('POST', '/api/v1/auth/login', { body: { email: { $ne: 1 }, password: 'x' } })).status, 422);
  });
  it('login: pesan error sama untuk email tak dikenal & password salah', async () => {
    const a = await call('POST', '/api/v1/auth/login', { body: { email: 'axl@example.com', password: 'Salah12345' } });
    const b = await call('POST', '/api/v1/auth/login', { body: { email: 'nobody@example.com', password: 'Salah12345' } });
    assert.equal(a.status, 401); assert.equal(b.status, 401);
    assert.deepEqual(a.json, b.json);
    const ok = await call('POST', '/api/v1/auth/login', { body: { email: 'axl@example.com', password: 'Rahasia123' } });
    assert.equal(ok.status, 200); assert.ok(ok.cookie);
  });
  it('tanpa cookie -> 401; logout mencabut sesi di server', async () => {
    assert.equal((await call('GET', '/api/v1/auth/session')).status, 401);
    assert.equal((await call('GET', '/api/v1/workspaces')).status, 401);
    const u = await register('logout@example.com');
    assert.equal((await call('POST', '/api/v1/auth/logout', { cookie: u.cookie })).status, 200);
    assert.equal((await call('GET', '/api/v1/auth/session', { cookie: u.cookie })).status, 401); // cookie lama tak berlaku lagi
  });
  it('sesi idle melewati batas ditolak', async () => {
    const u = await register('idle@example.com');
    await db.query("UPDATE sessions SET last_seen_at = now() - interval '8 days' WHERE user_id = $1", [u.userId]);
    assert.equal((await call('GET', '/api/v1/auth/session', { cookie: u.cookie })).status, 401);
  });
});

describe('CSRF / CORS', () => {
  it('request pengubah data tanpa/dengan Origin asing ditolak, GET tetap boleh', async () => {
    const u = await register('csrf@example.com');
    assert.equal((await call('POST', '/api/v1/workspaces', { cookie: u.cookie, origin: null, body: { name: 'x' } })).status, 403);
    assert.equal((await call('POST', '/api/v1/workspaces', { cookie: u.cookie, origin: 'https://evil.example', body: { name: 'x' } })).status, 403);
    assert.equal((await call('POST', '/api/v1/workspaces', { cookie: u.cookie, body: { name: 'ok' } })).status, 201);
    assert.equal((await call('GET', '/api/v1/workspaces', { cookie: u.cookie, origin: null })).status, 200);
  });
  it('Content-Type non-JSON ditolak (cegah form/text-plain CSRF)', async () => {
    const u = await register('ct@example.com');
    const res = await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers: { origin: ORIGIN, cookie: u.cookie, 'content-type': 'text/plain' }, payload: '{"name":"x"}' });
    assert.equal(res.statusCode, 415);
  });
  it('preflight dari origin asing tidak mendapat izin', async () => {
    const res = await app.inject({ method: 'OPTIONS', url: '/api/v1/auth/session', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    assert.ok(!res.headers['access-control-allow-origin']);
    const ok = await app.inject({ method: 'OPTIONS', url: '/api/v1/auth/session', headers: { origin: ORIGIN, 'access-control-request-method': 'GET' } });
    assert.equal(ok.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(ok.headers['access-control-allow-credentials'], 'true');
  });
});

describe('profil', () => {
  it('ubah nama/telepon tanpa password; email & password butuh password saat ini', async () => {
    const u = await register('profil@example.com');
    const p1 = await call('PATCH', '/api/v1/me/profile', { cookie: u.cookie, body: { name: 'Nama Baru', phone: '081234567890' } });
    assert.equal(p1.status, 200); assert.equal(p1.json.data.name, 'Nama Baru'); assert.equal(p1.json.data.phone, '081234567890');
    assert.equal((await call('PATCH', '/api/v1/me/profile', { cookie: u.cookie, body: { phone: 'abc' } })).status, 422);
    assert.equal((await call('PATCH', '/api/v1/me/profile', { cookie: u.cookie, body: { email: 'baru@example.com' } })).status, 422);
    assert.equal((await call('PATCH', '/api/v1/me/profile', { cookie: u.cookie, body: { email: 'baru@example.com', currentPassword: 'Salah12345' } })).status, 403);
    assert.equal((await call('PATCH', '/api/v1/me/profile', { cookie: u.cookie, body: { email: 'baru@example.com', currentPassword: 'Rahasia123' } })).status, 200);
    assert.equal((await call('PATCH', '/api/v1/me/profile', { cookie: u.cookie, body: { email: 'axl@example.com', currentPassword: 'Rahasia123' } })).status, 409);
  });
  it('ganti password: sesi lain dicabut, sesi ini tetap, password lama tak berlaku', async () => {
    const u = await register('pw@example.com');
    const other = await call('POST', '/api/v1/auth/login', { body: { email: 'pw@example.com', password: 'Rahasia123' } });
    assert.equal((await call('PATCH', '/api/v1/me/profile', { cookie: u.cookie, body: { currentPassword: 'Rahasia123', newPassword: 'Rahasia123' } })).status, 422);
    const ch = await call('PATCH', '/api/v1/me/profile', { cookie: u.cookie, body: { currentPassword: 'Rahasia123', newPassword: 'BaruAman456' } });
    assert.equal(ch.status, 200);
    assert.equal((await call('GET', '/api/v1/auth/session', { cookie: u.cookie })).status, 200);
    assert.equal((await call('GET', '/api/v1/auth/session', { cookie: other.cookie })).status, 401);
    assert.equal((await call('POST', '/api/v1/auth/login', { body: { email: 'pw@example.com', password: 'Rahasia123' } })).status, 401);
    assert.equal((await call('POST', '/api/v1/auth/login', { body: { email: 'pw@example.com', password: 'BaruAman456' } })).status, 200);
  });
});

describe('RBAC workspace', () => {
  it('owner/cs/agency & non-anggota', async () => {
    const owner = await register('own@example.com');
    const cs = await register('cs@example.com');
    const ag = await register('ag@example.com');
    const outsider = await register('out@example.com');
    const W = owner.wsId;
    assert.equal((await call('POST', `/api/v1/workspaces/${W}/members`, { cookie: owner.cookie, body: { email: 'cs@example.com', role: 'cs' } })).status, 201);
    assert.equal((await call('POST', `/api/v1/workspaces/${W}/members`, { cookie: owner.cookie, body: { email: 'ag@example.com', role: 'agency' } })).status, 201);
    assert.equal((await call('POST', `/api/v1/workspaces/${W}/members`, { cookie: owner.cookie, body: { email: 'nope@example.com', role: 'cs' } })).status, 404);
    // non-anggota: 404 (tidak membocorkan keberadaan)
    for (const [m, p] of [['GET', ''], ['GET', '/integrations'], ['GET', '/api-keys'], ['GET', '/members'], ['GET', '/audit-logs']] as const)
      assert.equal((await call(m, `/api/v1/workspaces/${W}${p}`, { cookie: outsider.cookie })).status, 404, p);
    // cs & agency tidak boleh kelola kredensial / anggota / api key
    for (const who of [cs, ag]) {
      assert.equal((await call('PUT', `/api/v1/workspaces/${W}/integrations/meta`, { cookie: who.cookie, body: { datasetId: '123456789012345', accessToken: TOKEN } })).status, 403);
      assert.equal((await call('POST', `/api/v1/workspaces/${W}/api-keys`, { cookie: who.cookie, body: { name: 'k' } })).status, 403);
      assert.equal((await call('GET', `/api/v1/workspaces/${W}/members`, { cookie: who.cookie })).status, 403);
      assert.equal((await call('POST', `/api/v1/workspaces/${W}/members`, { cookie: who.cookie, body: { email: 'out@example.com', role: 'owner' } })).status, 403);
    }
    // semua anggota boleh lihat ringkasan integrasi (tersamar)
    assert.equal((await call('GET', `/api/v1/workspaces/${W}/integrations`, { cookie: ag.cookie })).status, 200);
    // owner terakhir tidak bisa dihapus
    assert.equal((await call('DELETE', `/api/v1/workspaces/${W}/members/${owner.userId}`, { cookie: owner.cookie })).status, 409);
    assert.equal((await call('DELETE', `/api/v1/workspaces/${W}/members/${cs.userId}`, { cookie: owner.cookie })).status, 200);
    assert.equal((await call('GET', `/api/v1/workspaces/${W}`, { cookie: cs.cookie })).status, 404); // sudah dikeluarkan
    assert.equal((await call('GET', `/api/v1/workspaces/bukan-uuid`, { cookie: owner.cookie })).status, 422);
  });
});

describe('item 5: token Meta & secret webhook hanya di server', () => {
  let o: Awaited<ReturnType<typeof register>>, cs: Awaited<ReturnType<typeof register>>;
  before(async () => {
    o = await register('meta-owner@example.com');
    cs = await register('meta-cs@example.com');
    await call('POST', `/api/v1/workspaces/${o.wsId}/members`, { cookie: o.cookie, body: { email: 'meta-cs@example.com', role: 'cs' } });
  });

  it('token dienkripsi di DB, tidak pernah dikembalikan, tidak muncul di audit log', async () => {
    const put = await call('PUT', `/api/v1/workspaces/${o.wsId}/integrations/meta`, { cookie: o.cookie, body: { datasetId: '123456789012345', accessToken: TOKEN } });
    assert.equal(put.status, 200);
    assert.ok(!JSON.stringify(put.json).includes(TOKEN));
    const raw = (await db.query('SELECT * FROM workspace_integrations WHERE workspace_id=$1', [o.wsId])).rows[0];
    assert.ok(raw.meta_token_enc.startsWith('v1.')); assert.ok(!JSON.stringify(raw).includes(TOKEN));
    const get = await call('GET', `/api/v1/workspaces/${o.wsId}/integrations`, { cookie: o.cookie });
    assert.equal(get.json.data.meta.connected, true);
    assert.ok(get.json.data.meta.tokenMasked.endsWith(TOKEN.slice(-4)) && !get.json.data.meta.tokenMasked.includes(TOKEN.slice(0, 10)));
    assert.ok(!JSON.stringify(get.json).includes(TOKEN));
    const logs = await call('GET', `/api/v1/workspaces/${o.wsId}/audit-logs`, { cookie: o.cookie });
    assert.ok(!JSON.stringify(logs.json).includes(TOKEN));
    assert.ok(logs.json.data.some((l: { action: string }) => l.action === 'meta.save'));
    // ciphertext tidak bisa dipindah ke workspace lain
    const other = await register('meta-other@example.com');
    await db.query('INSERT INTO workspace_integrations (workspace_id, meta_dataset_id, meta_token_enc) VALUES ($1,$2,$3)', [other.wsId, '123456789012345', raw.meta_token_enc]);
    const t = await call('POST', `/api/v1/workspaces/${other.wsId}/integrations/meta/test`, { cookie: other.cookie, body: {} });
    assert.equal(t.status, 500); // gagal dekripsi karena AAD berbeda
  });

  it('validasi input: dataset id & token', async () => {
    assert.equal((await call('PUT', `/api/v1/workspaces/${o.wsId}/integrations/meta`, { cookie: o.cookie, body: { datasetId: '12', accessToken: TOKEN } })).status, 422);
    assert.equal((await call('PUT', `/api/v1/workspaces/${o.wsId}/integrations/meta`, { cookie: o.cookie, body: { datasetId: '123456789012345', accessToken: 'pendek' } })).status, 422);
  });

  it('tes koneksi: token dari DB, dikirim via header Authorization (bukan URL), cs boleh', async () => {
    graphCalls.length = 0;
    const r = await call('POST', `/api/v1/workspaces/${o.wsId}/integrations/meta/test`, { cookie: cs.cookie, body: {} });
    assert.equal(r.status, 200); assert.equal(r.json.data.ok, true); assert.equal(r.json.data.name, 'Dataset Uji');
    const c = graphCalls[0]!;
    assert.ok(c.url.startsWith('https://graph.facebook.com/v26.0/123456789012345'));
    assert.ok(!c.url.includes(TOKEN), 'token tidak boleh ada di URL');
    assert.equal((c.init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
    graphReply = () => ({ status: 400, body: { error: { code: 190, message: 'Invalid OAuth access token' } } });
    const bad = await call('POST', `/api/v1/workspaces/${o.wsId}/integrations/meta/test`, { cookie: o.cookie, body: {} });
    assert.deepEqual([bad.json.data.ok, bad.json.data.code], [false, 190]);
    graphReply = () => ({ status: 200, body: { id: '1', name: 'Dataset Uji', events_received: 1 } });
  });

  const ev = (over: Record<string, unknown> = {}, cd: unknown = undefined) => ({
    payload: { data: [{ event_name: 'Lead', event_time: Math.floor(Date.now() / 1000), event_id: 'ev-' + Math.random().toString(36).slice(2), action_source: 'business_messaging', messaging_channel: 'whatsapp', user_data: { ctwa_clid: 'ARAk', ph: [hex64('b')] }, ...(cd ? { custom_data: cd } : {}), ...over }] },
  });
  it('kirim event: validasi PII ter-hash, 7 hari, value; idempoten per event_id', async () => {
    const url = `/api/v1/workspaces/${o.wsId}/meta/events`;
    const bad = (b: unknown) => call('POST', url, { cookie: o.cookie, body: b });
    assert.equal((await bad(ev({ user_data: { ctwa_clid: 'x', ph: ['628123456789'] } }))).status, 422); // nomor polos
    assert.equal((await bad(ev({ user_data: { ctwa_clid: 'x', phone: '0812' } }))).status, 422);        // field tak dikenal
    assert.equal((await bad(ev({ event_time: Math.floor(Date.now() / 1000) - 8 * 86400 }))).status, 422);
    assert.equal((await bad(ev({ event_name: 'Purchase' }, { value: 0, currency: 'IDR' }))).status, 422);
    assert.equal((await call('POST', url, { cookie: ag(), body: ev() })).status, 401);
    graphCalls.length = 0;
    const good = ev({ event_name: 'Purchase', event_id: 'dup-1' }, { value: 150000, currency: 'IDR' });
    const r1 = await bad(good);
    assert.equal(r1.status, 200); assert.equal(r1.json.data.ok, true); assert.equal(graphCalls.length, 1);
    const sent = JSON.parse(String(graphCalls[0]!.init.body));
    assert.equal(sent.data[0].user_data.ph[0], hex64('b'));
    const r2 = await bad(good);
    assert.equal(r2.json.data.duplicate, true); assert.equal(graphCalls.length, 1); // tidak dikirim dua kali
    const row = (await db.query("SELECT status, attempts FROM events WHERE event_id='dup-1'")).rows[0];
    assert.deepEqual([row.status, row.attempts], ['sent', 1]);
    // gagal -> tercatat failed, kirim ulang diizinkan
    graphReply = () => ({ status: 400, body: { error: { code: 100, message: 'Invalid parameter' } } });
    const fail = await bad(ev({ event_id: 'fail-1' }));
    assert.deepEqual([fail.json.data.ok, fail.json.data.code], [false, 100]);
    assert.equal((await db.query("SELECT status FROM events WHERE event_id='fail-1'")).rows[0].status, 'failed');
    graphReply = () => ({ status: 200, body: { events_received: 1 } });
    const retry = await bad({ payload: { data: [{ ...ev().payload.data[0], event_id: 'fail-1' }] } });
    assert.equal(retry.json.data.ok, true);
    assert.deepEqual((await db.query("SELECT status, attempts FROM events WHERE event_id='fail-1'")).rows[0], { status: 'sent', attempts: 2 });
    function ag() { return 'convera_sid=bukan-sesi'; }
  });

  it('webhook: tolak http/internal, secret tampil sekali, tersimpan terenkripsi, tes ber-HMAC', async () => {
    const put = (url: string, extra: object = {}) => call('PUT', `/api/v1/workspaces/${o.wsId}/integrations/webhook`, { cookie: o.cookie, body: { url, events: ['event.sent'], ...extra } });
    for (const u of ['http://hook.example.com/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://10.0.0.5/x', 'https://169.254.169.254/x', 'https://[::1]/x', 'https://u:p@hook.example.com/x', 'bukan url'])
      assert.equal((await put(u)).status, 422, u);
    const a = await put('https://hook.example.com/convera');
    assert.equal(a.status, 200); assert.match(a.json.data.secret, /^whsec_/);
    const secret = a.json.data.secret as string;
    const raw = (await db.query('SELECT webhook_secret_enc FROM workspace_integrations WHERE workspace_id=$1', [o.wsId])).rows[0].webhook_secret_enc;
    assert.ok(!raw.includes(secret));
    const b = await put('https://hook.example.com/convera2'); // simpan ulang: secret tidak diulang
    assert.equal(b.json.data.secret, undefined);
    const g = await call('GET', `/api/v1/workspaces/${o.wsId}/integrations`, { cookie: o.cookie });
    assert.ok(!JSON.stringify(g.json).includes(secret));
    hookCalls.length = 0;
    assert.equal((await call('POST', `/api/v1/workspaces/${o.wsId}/integrations/webhook/test`, { cookie: cs.cookie })).json.data.ok, true);
    const h = hookCalls[0]!;
    assert.equal(h.url, 'https://hook.example.com/convera2');
    assert.equal(h.headers['X-Convera-Signature'], 'sha256=' + hmacSha256Hex(secret, h.body));
    const c = await put('https://hook.example.com/convera2', { regenerateSecret: true });
    assert.notEqual(c.json.data.secret, secret);
  });

  it('putuskan Meta menghapus token', async () => {
    assert.equal((await call('DELETE', `/api/v1/workspaces/${o.wsId}/integrations/meta`, { cookie: o.cookie })).status, 200);
    assert.equal((await db.query('SELECT meta_token_enc FROM workspace_integrations WHERE workspace_id=$1', [o.wsId])).rows[0].meta_token_enc, null);
    assert.equal((await call('POST', `/api/v1/workspaces/${o.wsId}/integrations/meta/test`, { cookie: o.cookie, body: {} })).status, 409);
  });
});

describe('API key', () => {
  it('key tampil sekali, hanya hash di DB, bisa dicabut', async () => {
    const o = await register('keys@example.com');
    const c = await call('POST', `/api/v1/workspaces/${o.wsId}/api-keys`, { cookie: o.cookie, body: { name: 'Zapier' } });
    assert.equal(c.status, 201); const key = c.json.data.key as string; assert.match(key, /^cvk_live_/);
    const list = await call('GET', `/api/v1/workspaces/${o.wsId}/api-keys`, { cookie: o.cookie });
    assert.ok(!JSON.stringify(list.json).includes(key));
    assert.equal((await db.query('SELECT count(*)::int n FROM api_keys WHERE encode(key_hash,\'hex\') = $1', [key])).rows[0].n, 0);
    assert.equal((await call('DELETE', `/api/v1/workspaces/${o.wsId}/api-keys/${c.json.data.id}`, { cookie: o.cookie })).status, 200);
    assert.equal((await call('DELETE', `/api/v1/workspaces/${o.wsId}/api-keys/${c.json.data.id}`, { cookie: o.cookie })).status, 404);
  });
});

describe('fase 1: leads, event, dashboard', () => {
  let o: Awaited<ReturnType<typeof register>>, ag: Awaited<ReturnType<typeof register>>;
  const base = () => `/api/v1/workspaces/${o.wsId}`;
  const clickedAt = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const lead = async (phone: string, extra: Record<string, unknown> = {}) => {
    const r = await call('POST', `${base()}/leads`, { cookie: o.cookie, body: { name: 'Pelanggan ' + phone, phone, firstMessage: 'Halo kak', ctwaClid: 'ARclid' + phone, campaign: 'Promo', adSet: 'Jaksel', ad: 'Iklan A', clickedAt: clickedAt(1), ...extra } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r.json.data as { id: string; phone: string };
  };
  before(async () => {
    o = await register('f1-owner@example.com');
    ag = await register('f1-agency@example.com');
    await call('POST', `${base()}/members`, { cookie: o.cookie, body: { email: 'f1-agency@example.com', role: 'agency' } });
    await call('PUT', `${base()}/integrations/meta`, { cookie: o.cookie, body: { datasetId: '123456789012345', accessToken: TOKEN } });
  });

  it('lead: buat, validasi, filter, nomor disamarkan untuk agency, terisolasi antar workspace', async () => {
    const a = await lead('081234567001');
    assert.equal(a.phone, '6281234567001'); // dinormalisasi
    assert.equal((await call('POST', `${base()}/leads`, { cookie: o.cookie, body: { phone: '0812-3456-7001' } })).status, 409);
    assert.equal((await call('POST', `${base()}/leads`, { cookie: o.cookie, body: { phone: 'abc' } })).status, 422);
    assert.equal((await call('POST', `${base()}/leads`, { cookie: ag.cookie, body: { phone: '081234567099' } })).status, 403);
    await lead('081234567002', { ctwaClid: undefined, campaign: undefined, adSet: undefined, ad: undefined });
    const all = await call('GET', `${base()}/leads`, { cookie: o.cookie });
    assert.equal(all.json.data.length, 2);
    assert.equal((await call('GET', `${base()}/leads?campaign=__organic`, { cookie: o.cookie })).json.data.length, 1);
    assert.equal((await call('GET', `${base()}/leads?q=7001`, { cookie: o.cookie })).json.data.length, 1);
    const asAgency = await call('GET', `${base()}/leads`, { cookie: ag.cookie });
    assert.ok(asAgency.json.data.every((l: { phone: string }) => l.phone.includes('•••')));
    assert.equal((await call('GET', `/api/v1/workspaces/${ag.wsId}/leads/${a.id}`, { cookie: ag.cookie })).status, 404);
  });

  it('tandai Purchase: nomor di-hash di server, status lead naik, event tercatat dengan riwayat; klik ganda tidak dobel', async () => {
    const a = await lead('081234567010');
    graphCalls.length = 0;
    const r = await call('POST', `${base()}/leads/${a.id}/events`, { cookie: o.cookie, body: { eventName: 'Purchase', value: 250000, eventId: 'klik-1' } });
    assert.equal(r.status, 201, JSON.stringify(r.json)); assert.equal(r.json.data.ok, true); assert.equal(r.json.data.leadStatus, 'purchase');
    const sent = String(graphCalls[0]!.init.body);
    assert.ok(!sent.includes('6281234567010') && sent.includes(createHashHex('6281234567010')));
    assert.equal((await call('POST', `${base()}/leads/${a.id}/events`, { cookie: o.cookie, body: { eventName: 'Purchase', value: 250000, eventId: 'klik-1' } })).json.data.duplicate, true);
    assert.equal(graphCalls.length, 1);
    assert.equal((await call('POST', `${base()}/leads/${a.id}/events`, { cookie: o.cookie, body: { eventName: 'Purchase', value: 0 } })).status, 422);
    // event dengan status lebih rendah tidak menurunkan status lead
    assert.equal((await call('POST', `${base()}/leads/${a.id}/events`, { cookie: o.cookie, body: { eventName: 'ViewContent' } })).json.data.leadStatus, 'purchase');
    const d = await call('GET', `${base()}/leads/${a.id}`, { cookie: o.cookie });
    assert.deepEqual([d.json.data.status, d.json.data.value, d.json.data.events.length], ['purchase', 250000, 2]);
    const list = await call('GET', `${base()}/events?source=manual`, { cookie: o.cookie });
    const ev = list.json.data.find((e: { eventId: string }) => e.eventId === 'klik-1');
    assert.equal(ev.status, 'sent'); assert.equal(ev.by, 'User f1-owner@example.com');
    const det = await call('GET', `${base()}/events/${ev.id}`, { cookie: o.cookie });
    assert.equal(det.json.data.history.length, 1); assert.equal(det.json.data.payload.data[0].event_id, 'klik-1');
  });

  it('organik ditolak; lewat 7 hari dicatat expired tanpa dikirim; gagal bisa dikirim ulang', async () => {
    const org = await lead('081234567020', { ctwaClid: undefined });
    assert.equal((await call('POST', `${base()}/leads/${org.id}/events`, { cookie: o.cookie, body: { eventName: 'LeadSubmitted' } })).status, 422);
    const old = await lead('081234567021', { clickedAt: clickedAt(8) });
    graphCalls.length = 0;
    const ex = await call('POST', `${base()}/leads/${old.id}/events`, { cookie: o.cookie, body: { eventName: 'Purchase', value: 1000 } });
    assert.equal(ex.json.data.expired, true); assert.equal(graphCalls.length, 0);
    assert.equal((await call('GET', `${base()}/events?status=expired`, { cookie: o.cookie })).json.data.length, 1);

    const b = await lead('081234567022');
    graphReply = () => ({ status: 400, body: { error: { code: 100, message: 'Invalid parameter' } } });
    const f = await call('POST', `${base()}/leads/${b.id}/events`, { cookie: o.cookie, body: { eventName: 'LeadSubmitted' } });
    assert.deepEqual([f.json.data.ok, f.json.data.code], [false, 100]);
    graphReply = () => ({ status: 200, body: { events_received: 1 } });
    const rowId = f.json.data.eventRowId;
    assert.equal((await call('POST', `${base()}/events/${rowId}/resend`, { cookie: ag.cookie })).status, 403);
    const re = await call('POST', `${base()}/events/${rowId}/resend`, { cookie: o.cookie });
    assert.equal(re.json.data.ok, true);
    assert.equal((await call('POST', `${base()}/events/${rowId}/resend`, { cookie: o.cookie })).status, 409); // sudah terkirim
    const det = await call('GET', `${base()}/events/${rowId}`, { cookie: o.cookie });
    assert.deepEqual([det.json.data.status, det.json.data.attempts, det.json.data.history.length], ['sent', 2, 2]);
  });

  it('Meta belum terhubung: event dicatat gagal dengan alasan jelas', async () => {
    const x = await register('f1-nometa@example.com');
    const l = (await call('POST', `/api/v1/workspaces/${x.wsId}/leads`, { cookie: x.cookie, body: { phone: '081234567030', ctwaClid: 'ARx', clickedAt: clickedAt(1) } })).json.data;
    const r = await call('POST', `/api/v1/workspaces/${x.wsId}/leads/${l.id}/events`, { cookie: x.cookie, body: { eventName: 'LeadSubmitted' } });
    assert.deepEqual([r.json.data.ok, r.json.data.error], [false, 'Meta belum terhubung']);
  });

  it('bulk status, hapus lead, dan hapus kontak (beserta event-nya)', async () => {
    const a = await lead('081234567040'), b = await lead('081234567041');
    assert.equal((await call('POST', `${base()}/leads/bulk-status`, { cookie: o.cookie, body: { ids: [a.id, b.id], status: 'lost' } })).json.data.updated, 2);
    assert.equal((await call('DELETE', `${base()}/leads/${a.id}`, { cookie: o.cookie })).status, 200);
    assert.equal((await call('GET', `${base()}/leads/${a.id}`, { cookie: o.cookie })).status, 404);
    await call('POST', `${base()}/leads/${b.id}/events`, { cookie: o.cookie, body: { eventName: 'LeadSubmitted' } });
    assert.equal((await call('POST', `${base()}/contacts/forget`, { cookie: o.cookie, body: { phone: '0812 3456 7041' } })).json.data.deleted, 1);
    assert.equal((await db.query('SELECT count(*)::int n FROM events e JOIN leads l ON l.id = e.lead_id WHERE l.phone = $1', ['6281234567041'])).rows[0].n, 0);
    const logs = await call('GET', `${base()}/audit-logs`, { cookie: o.cookie });
    assert.ok(!JSON.stringify(logs.json).includes('6281234567041'));
  });

  it('dashboard: KPI, harian, dan performa per iklan dari data asli', async () => {
    const x = await register('f1-dash@example.com');
    const b = `/api/v1/workspaces/${x.wsId}`;
    await call('PUT', `${b}/integrations/meta`, { cookie: x.cookie, body: { datasetId: '123456789012345', accessToken: TOKEN } });
    const mk = async (phone: string) => (await call('POST', `${b}/leads`, { cookie: x.cookie, body: { phone, ctwaClid: 'AR' + phone, campaign: 'Promo', adSet: 'Jaksel', ad: 'Iklan A', clickedAt: clickedAt(0) } })).json.data;
    const l1 = await mk('081234567050'); await mk('081234567051');
    await call('POST', `${b}/leads/${l1.id}/events`, { cookie: x.cookie, body: { eventName: 'Purchase', value: 300000 } });
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
    await db.query("INSERT INTO ad_insights (workspace_id, date, campaign, ad_set, ad, spend, clicks) VALUES ($1,$2,'Promo','Jaksel','Iklan A',100000,40)", [x.wsId, today]);
    const from = new Date(Date.now() - 6 * 86_400_000).toISOString(), to = new Date(Date.now() + 86_400_000).toISOString();
    const r = await call('GET', `${b}/dashboard?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { cookie: x.cookie });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const c = r.json.data.current;
    assert.deepEqual([c.chats, c.purchases, c.value, c.spend, c.clicks, c.with_clid], [2, 1, 300000, 100000, 40, 2]);
    assert.deepEqual(r.json.data.ads, [{ campaign: 'Promo', adSet: 'Jaksel', ad: 'Iklan A', spend: 100000, clicks: 40, chats: 2, leads: 1, purchases: 1, value: 300000 }]);
    assert.ok(r.json.data.daily.length >= 7);
    assert.equal(r.json.data.meta.connected, true);
    assert.equal((await call('GET', `${b}/dashboard?from=${encodeURIComponent(to)}&to=${encodeURIComponent(from)}`, { cookie: x.cookie })).status, 422);
  });

  it('META_MOCK ditolak di production', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'x', ENCRYPTION_KEY: randomBytes(32).toString('base64'), META_MOCK: 'true' } as NodeJS.ProcessEnv), /META_MOCK/);
  });
});

describe('rate limit', () => {
  it('login dibatasi per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 17; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN }, remoteAddress: '10.77.0.1', payload: { email: 'axl@example.com', password: 'Salah12345' } });
      statuses.push(res.statusCode);
    }
    assert.equal(statuses[14], 401); assert.equal(statuses[15], 429);
    const last = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN }, remoteAddress: '10.77.0.1', payload: { email: 'axl@example.com', password: 'Salah12345' } });
    assert.equal(JSON.parse(last.body).message, 'Terlalu banyak permintaan, coba lagi sebentar');
  });
  it('healthz & 404 JSON', async () => {
    assert.equal((await call('GET', '/healthz')).status, 200);
    assert.equal((await call('GET', '/api/v1/tidak-ada')).status, 404);
  });
});
