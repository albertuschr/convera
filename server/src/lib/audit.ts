import type { Db } from '../db.js';

export interface AuditEntry {
  workspaceId?: string | null;
  userId?: string | null;
  action: string;
  target?: string | null;
  meta?: Record<string, unknown>;
  ip?: string | null;
}

/** Best-effort: kegagalan audit tidak boleh membatalkan operasi utama. Jangan pernah memasukkan secret ke `meta`. */
export async function audit(db: Db, e: AuditEntry): Promise<void> {
  try {
    await db.query('INSERT INTO audit_logs (workspace_id, user_id, action, target, meta, ip) VALUES ($1,$2,$3,$4,$5,$6)', [
      e.workspaceId ?? null, e.userId ?? null, e.action, e.target ?? null, JSON.stringify(e.meta ?? {}), e.ip ?? null,
    ]);
  } catch (err) {
    console.error('audit gagal', (err as Error).message);
  }
}
