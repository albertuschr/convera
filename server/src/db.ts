import pg from 'pg';

export type Db = pg.Pool;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
}

export async function tx<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
