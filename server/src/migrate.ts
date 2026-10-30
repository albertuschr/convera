import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPool, type Db } from './db.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(db: Db): Promise<string[]> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(join(dir, f), 'utf8');
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      await c.query('COMMIT');
      applied.push(f);
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw new Error(`Migrasi ${f} gagal: ${(e as Error).message}`);
    } finally {
      c.release();
    }
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL belum diisi');
  const db = createPool(url);
  migrate(db)
    .then((a) => console.log(a.length ? `Migrasi diterapkan: ${a.join(', ')}` : 'Database sudah up to date'))
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => db.end());
}
