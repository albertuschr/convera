import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL wajib diisi'),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY harus 32 byte base64 (npm run gen:key)'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  SESSION_IDLE_DAYS: z.coerce.number().int().positive().default(7),
  REGISTRATION_OPEN: bool.default('true'),
  TRUST_PROXY: bool.default('false'),
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/, 'Contoh: v19.0').default('v19.0'),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Konfigurasi environment tidak valid:\n${msg}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    isProd: e.NODE_ENV === 'production',
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    encryptionKey: Buffer.from(e.ENCRYPTION_KEY, 'base64'),
    corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
    sessionTtlMs: e.SESSION_TTL_DAYS * 86_400_000,
    sessionIdleMs: e.SESSION_IDLE_DAYS * 86_400_000,
    registrationOpen: e.REGISTRATION_OPEN,
    trustProxy: e.TRUST_PROXY,
    metaGraphVersion: e.META_GRAPH_VERSION,
  };
}
