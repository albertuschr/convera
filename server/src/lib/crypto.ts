import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

type ScryptOpts = { N: number; r: number; p: number; maxmem: number };
const scrypt = (pw: string, salt: Buffer, len: number, opts: ScryptOpts) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(pw, salt, len, opts, (e, k) => (e ? reject(e) : resolve(k))));

const N = 2 ** 15, R = 8, P = 1, KEYLEN = 64, MAXMEM = 128 * N * R * 2;

/** Format: scrypt$N$r$p$salt(b64)$hash(b64) */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

let dummy: Promise<string> | undefined;
/** Dipakai agar waktu respons login sama baik email ada maupun tidak (anti user enumeration). */
export function verifyAgainstDummy(password: string): Promise<boolean> {
  dummy ??= hashPassword('dummy-password-for-timing');
  return dummy.then((h) => verifyPassword(password, h));
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest();
export const hmacSha256Hex = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');

/** AES-256-GCM. `aad` mengikat ciphertext ke konteksnya (mis. workspace id) sehingga tidak bisa ditukar antar baris. */
export function encrypt(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(key: Buffer, packed: string, aad: string): string {
  const [v, iv, tag, ct] = packed.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Format ciphertext tidak dikenal');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

export const maskSecret = (s: string) => (s.length <= 8 ? '••••' : `••••••••${s.slice(-4)}`);
