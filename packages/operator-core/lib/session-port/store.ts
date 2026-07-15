import { getOrgPg } from '@papercusp/db-org';
import type { SessionBackend } from './types';

export type SessionPortStatus = 'prepared' | 'pending' | 'delivered' | 'failed' | 'expired';

export interface SessionPortRow {
  id: string;
  workspaceId: string;
  idempotencyKey: string;
  protocolVersion: number;
  sourceAdvSessionId: number;
  targetAdvSessionId: number | null;
  sourceBackend: SessionBackend;
  targetBackend: SessionBackend;
  targetModel: string | null;
  status: SessionPortStatus;
  sourceHash: string;
  normalizedHash: string;
  renderedHash: string;
  tokenHash: string;
  artifactPath: string;
  metadata: Record<string, unknown>;
  error: string | null;
  preparedAt: string;
  pendingAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  expiresAt: string;
}

const TRANSITIONS: Record<SessionPortStatus, readonly SessionPortStatus[]> = {
  prepared: ['pending', 'failed', 'expired'],
  pending: ['delivered', 'failed', 'expired'],
  delivered: [],
  failed: [],
  expired: [],
};

export function canTransitionSessionPort(from: SessionPortStatus, to: SessionPortStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

const mapRow = (r: any): SessionPortRow => ({
  id: r.id,
  workspaceId: r.workspace_id,
  idempotencyKey: r.idempotency_key,
  protocolVersion: Number(r.protocol_version),
  sourceAdvSessionId: Number(r.source_adv_session_id),
  targetAdvSessionId: r.target_adv_session_id == null ? null : Number(r.target_adv_session_id),
  sourceBackend: r.source_backend,
  targetBackend: r.target_backend,
  targetModel: r.target_model,
  status: r.status,
  sourceHash: r.source_hash,
  normalizedHash: r.normalized_hash,
  renderedHash: r.rendered_hash,
  tokenHash: r.token_hash,
  artifactPath: r.artifact_path,
  metadata: r.metadata ?? {},
  error: r.error ?? null,
  preparedAt: new Date(r.prepared_at).toISOString(),
  pendingAt: r.pending_at == null ? null : new Date(r.pending_at).toISOString(),
  deliveredAt: r.delivered_at == null ? null : new Date(r.delivered_at).toISOString(),
  failedAt: r.failed_at == null ? null : new Date(r.failed_at).toISOString(),
  expiresAt: new Date(r.expires_at).toISOString(),
});

/** Explicit rollout handshake: inspect must fail before source acquisition or
 * preparation when migration 611 has not reached the serving operator. */
export async function assertSessionPortStorageReady(): Promise<void> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ table_ready: boolean; adv_columns: number }>>`
    SELECT to_regclass('harness_shared.session_ports') IS NOT NULL AS table_ready,
           (SELECT count(*)::int
              FROM pg_attribute
             WHERE attrelid = to_regclass('harness_shared.adv_sessions')
               AND attname IN ('port_id', 'port_source_adv_session_id', 'port_status', 'port_metadata')
               AND NOT attisdropped) AS adv_columns`;
  if (!rows[0]?.table_ready || Number(rows[0]?.adv_columns) !== 4) {
    throw new Error('session-port storage migration 611 is not installed; upgrade/migrate psu operator before porting');
  }
}

/** Atomically expire active rows whose token TTL elapsed, and also return any
 * previously-expired rows whose crash cleanup has not yet completed. */
export async function sessionPortsNeedingCleanup(workspaceId: string): Promise<SessionPortRow[]> {
  const { sql } = getOrgPg();
  const rows = await sql<any[]>`
    WITH newly_expired AS (
      UPDATE harness_shared.session_ports
         SET status = 'expired',
             error = COALESCE(error, 'preparation expired before native persistence'),
             failed_at = COALESCE(failed_at, now())
       WHERE workspace_id = ${workspaceId}
         AND status IN ('prepared', 'pending')
         AND expires_at <= now()
      RETURNING *
    )
    SELECT * FROM newly_expired
    UNION ALL
    SELECT p.* FROM harness_shared.session_ports p
     WHERE p.workspace_id = ${workspaceId}
       AND p.status = 'expired'
       AND COALESCE(p.metadata->>'cleanupComplete', 'false') <> 'true'
       AND NOT EXISTS (SELECT 1 FROM newly_expired n WHERE n.id = p.id)`;
  return rows.map(mapRow);
}

export async function findSessionPortByIdempotency(
  workspaceId: string,
  idempotencyKey: string,
): Promise<SessionPortRow | null> {
  const { sql } = getOrgPg();
  const rows = await sql<any[]>`
    SELECT * FROM harness_shared.session_ports
     WHERE workspace_id = ${workspaceId} AND idempotency_key = ${idempotencyKey}`;
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function createPreparedSessionPort(input: Omit<
  SessionPortRow,
  'status' | 'targetAdvSessionId' | 'error' | 'preparedAt' | 'pendingAt' | 'deliveredAt' | 'failedAt'
>): Promise<SessionPortRow> {
  const { sql } = getOrgPg();
  const rows = await sql<any[]>`
    INSERT INTO harness_shared.session_ports
      (id, workspace_id, idempotency_key, protocol_version, source_adv_session_id,
       source_backend, target_backend, target_model, source_hash, normalized_hash,
       rendered_hash, token_hash, artifact_path, metadata, expires_at)
    VALUES
      (${input.id}, ${input.workspaceId}, ${input.idempotencyKey}, ${input.protocolVersion}, ${input.sourceAdvSessionId},
       ${input.sourceBackend}, ${input.targetBackend}, ${input.targetModel}, ${input.sourceHash},
       ${input.normalizedHash}, ${input.renderedHash}, ${input.tokenHash}, ${input.artifactPath},
       ${JSON.stringify(input.metadata)}::jsonb, ${input.expiresAt})
    ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
    RETURNING *`;
  if (rows[0]) return mapRow(rows[0]);
  const existing = await findSessionPortByIdempotency(input.workspaceId, input.idempotencyKey);
  if (!existing) throw new Error('session-port idempotency conflict lost its row');
  return existing;
}

export async function getSessionPort(id: string, workspaceId: string): Promise<SessionPortRow | null> {
  const { sql } = getOrgPg();
  const rows = await sql<any[]>`
    SELECT * FROM harness_shared.session_ports WHERE id = ${id} AND workspace_id = ${workspaceId}`;
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function transitionSessionPort(
  id: string,
  workspaceId: string,
  to: SessionPortStatus,
  fields: { targetAdvSessionId?: number | null; error?: string | null; metadata?: Record<string, unknown> } = {},
): Promise<SessionPortRow> {
  const current = await getSessionPort(id, workspaceId);
  if (!current) throw new Error('session port not found');
  if (!canTransitionSessionPort(current.status, to)) throw new Error(`invalid session-port transition ${current.status} -> ${to}`);
  const { sql } = getOrgPg();
  const rows = await sql<any[]>`
    UPDATE harness_shared.session_ports
       SET status = ${to},
           target_adv_session_id = COALESCE(${fields.targetAdvSessionId ?? null}, target_adv_session_id),
           error = ${fields.error ?? null},
           metadata = metadata || ${JSON.stringify(fields.metadata ?? {})}::jsonb,
           pending_at = CASE WHEN ${to} = 'pending' THEN COALESCE(pending_at, now()) ELSE pending_at END,
           delivered_at = CASE WHEN ${to} = 'delivered' THEN COALESCE(delivered_at, now()) ELSE delivered_at END,
           failed_at = CASE WHEN ${to} IN ('failed', 'expired') THEN COALESCE(failed_at, now()) ELSE failed_at END
     WHERE id = ${id} AND workspace_id = ${workspaceId} AND status = ${current.status}
     RETURNING *`;
  if (!rows[0]) throw new Error('session-port state changed concurrently');
  return mapRow(rows[0]);
}
