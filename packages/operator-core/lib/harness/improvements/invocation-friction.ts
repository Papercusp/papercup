/** R-7 delivery reuses invocation metadata and the existing watchdog cadence.
 * The row is the durable pending record; memory only bounds the fast path. */
import { getOrgPg } from '@papercusp/db-org';
import { runWithWorkspace } from '../../workspace-als';
import { captureToolInvocationFriction, type ToolInvocationFriction } from './capture-core';

type Sql = ReturnType<typeof getOrgPg>['sql'];
const PENDING_RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PENDING_RECOVERY_BATCH_SIZE = 100;
export interface InvocationFrictionRef { id: string; workspaceId: string }
interface InvocationRow {
  id: string;
  workspace_id: string;
  harness_slug: string;
  coord_owner_id: string;
  invoked_at: string | Date;
  tool_name: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  serving_build_sha: string | null;
  metadata_json: Record<string, unknown>;
}

/** Lock only this telemetry row, so the fast path and recovery cannot deliver
 * it concurrently. Capture failure rolls back the marker; process death also
 * releases the lock. A crash after capture but before marking may replay an
 * occurrence, but the original reporter cannot become independent evidence. */
export async function captureInvocationFriction(
  ref: InvocationFrictionRef,
  deps: { sql?: Sql; capture?: typeof captureToolInvocationFriction } = {},
): Promise<boolean> {
  const sql = deps.sql ?? getOrgPg().sql;
  return await sql.begin(async tx => {
    await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [ref.workspaceId]);
    const rows = await tx.unsafe<InvocationRow[]>(`
      SELECT id::text, workspace_id, harness_slug, coord_owner_id, invoked_at,
             tool_name, status, error_code, error_message, serving_build_sha, metadata_json
        FROM harness_shared.tool_invocations
       WHERE workspace_id = $1 AND id = $2::bigint
         AND metadata_json->>'frictionCapture' = 'pending'
       FOR UPDATE SKIP LOCKED`, [ref.workspaceId, ref.id]);
    const row = rows[0];
    if (!row) return false;
    // Defence in depth for scope and exclusions even with an injected reader.
    if (row.workspace_id !== ref.workspaceId || !row.coord_owner_id ||
        !['error', 'invalid-input', 'timeout'].includes(row.status) ||
        /^(improvements:|system:improvement-)/.test(row.tool_name)) {
      throw new Error('Invalid pending invocation friction identity');
    }
    const invalidInput = row.metadata_json.invalidInput as Record<string, unknown> | undefined;
    const schemaRevision = invalidInput?.source === 'projected-tool-registry' &&
      invalidInput.toolName === row.tool_name && typeof invalidInput.registryRevision === 'string'
      ? invalidInput.registryRevision : undefined;
    const input: ToolInvocationFriction = {
      workspaceId: row.workspace_id, harnessSlug: row.harness_slug,
      ownerId: row.coord_owner_id, invokedAt: new Date(row.invoked_at).toISOString(),
      failure: { toolName: row.tool_name, status: row.status, errorCode: row.error_code ?? undefined,
        message: (row.error_message ?? '').split(String.fromCharCode(0)).join('').slice(0, 8192),
        schemaRevision, runtimeVersion: row.serving_build_sha ?? undefined },
    };
    const result = await runWithWorkspace(row.workspace_id,
      () => (deps.capture ?? captureToolInvocationFriction)(input));
    if (!result?.ok || !result.issue?.id) throw new Error('Invocation friction capture did not persist an issue');
    await tx.unsafe(`UPDATE harness_shared.tool_invocations
      SET metadata_json = jsonb_set(metadata_json, '{frictionCapture}', '"delivered"'::jsonb)
      WHERE workspace_id = $1 AND id = $2::bigint`, [ref.workspaceId, ref.id]);
    return true;
  });
}

/** One bounded recovery batch, including single invalid calls. Successful rows
 * leave the pending set; failures remain pending and are visible as a failed
 * watchdog collector, never mistaken for successful recovery. */
export async function recoverInvocationFriction(
  workspaceId: string,
  deps: { sql?: Sql; capture?: typeof captureToolInvocationFriction } = {},
): Promise<{ delivered: number; pending: number; expired: number }> {
  const sql = deps.sql ?? getOrgPg().sql;
  // Match the repeated-tool-error collector's 24-hour evidence horizon: once a pending
  // failure is older than that, replaying it can resurrect a signature after reviewers
  // already dropped its stale report. Expire in bounded batches so old rows cannot starve
  // recent recovery work.
  const staleBefore = new Date(Date.now() - PENDING_RECOVERY_MAX_AGE_MS).toISOString();
  const expiredRows = await sql.unsafe<{ id: string }[]>(`
    WITH stale AS (
      SELECT id FROM harness_shared.tool_invocations
       WHERE workspace_id = $1 AND metadata_json->>'frictionCapture' = 'pending'
         AND invoked_at < $2::timestamptz
       ORDER BY invoked_at, id LIMIT ${PENDING_RECOVERY_BATCH_SIZE}
       FOR UPDATE SKIP LOCKED
    )
    UPDATE harness_shared.tool_invocations AS invocation
       SET metadata_json = COALESCE(invocation.metadata_json, '{}'::jsonb) ||
         jsonb_build_object('frictionCapture', 'expired', 'frictionExpiredAt', now(),
           'frictionExpiredReason', 'older-than-24-hours')
      FROM stale
     WHERE invocation.workspace_id = $1 AND invocation.id = stale.id
       AND invocation.metadata_json->>'frictionCapture' = 'pending'
    RETURNING invocation.id::text AS id`, [workspaceId, staleBefore]);
  const refs = await sql.unsafe<{ id: string }[]>(`
    SELECT id::text FROM harness_shared.tool_invocations
     WHERE workspace_id = $1 AND metadata_json->>'frictionCapture' = 'pending'
        AND invoked_at >= $2::timestamptz
      ORDER BY COALESCE(metadata_json->>'frictionAttemptAt', ''), invoked_at, id
      LIMIT ${PENDING_RECOVERY_BATCH_SIZE}`, [workspaceId, staleBefore]);
  let delivered = 0;
  let failed = 0;
  for (const ref of refs) {
    try {
      if (await captureInvocationFriction({ ...ref, workspaceId }, { ...deps, sql })) delivered++;
    } catch {
      failed++;
      // Rotate a failed row behind unattempted work. A permanently failing
      // first batch must not starve every later report on every watchdog tick.
      await sql.unsafe(`UPDATE harness_shared.tool_invocations
        SET metadata_json = jsonb_set(metadata_json, '{frictionAttemptAt}', to_jsonb($3::text))
        WHERE workspace_id = $1 AND id = $2::bigint
          AND metadata_json->>'frictionCapture' = 'pending'`, [workspaceId, ref.id, new Date().toISOString()]);
    }
  }
  if (failed) throw new Error(`Invocation friction recovery: ${failed} failed, ${delivered} delivered, ${expiredRows.length} expired; failed rows remain pending`);
  return { delivered, pending: refs.length - delivered, expired: expiredRows.length };
}
