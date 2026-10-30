export interface GraphResult { ok: boolean; status: number; body: any }

/** Klien Graph API. Token dikirim lewat header Authorization (bukan query string) agar tidak masuk log/URL. */
export function metaClient(fetchImpl: typeof fetch, version: string) {
  const base = `https://graph.facebook.com/${version}`;
  return async function graph(path: string, token: string, init: { method?: string; body?: unknown } = {}): Promise<GraphResult> {
    try {
      const r = await fetchImpl(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(9000),
      });
      const body = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, body };
    } catch (e) {
      const timeout = (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError';
      return { ok: false, status: 0, body: { error: { message: timeout ? 'Timeout' : 'Tidak bisa menjangkau graph.facebook.com' } } };
    }
  };
}
export type MetaClient = ReturnType<typeof metaClient>;
