/** P-002 independent host enrollment source, separate from policy roots.
 * This is storage evidence, not authenticated enrollment or edit admission.
 * The host's enrollment writer is intentionally a separate, guarded operation;
 * legacy/unenrolled authorities stay unknown and no ownership is synthesized.
 */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { canonicalJson } from '../authority/authority-rpc-envelope';

export interface HostAuthorityBinding {
  kind: 'user' | 'platform';
  subjectId: string;
  humanOwnerId: string;
  requestPrincipalRevision: string;
  reason: string;
  recordedAt: string;
}

const exact = (value: unknown): value is string => typeof value === 'string' &&
  !!value.trim() && value === value.trim() && !/[\u0000-\u001f\uD800-\uDFFF]/u.test(value);

/** Complete registered source, never a caller-selected subset or a scan of
 * policy roots. An empty source is explicit and proves no required population
 * or human ownership. The admission caller must reconcile workspace claims and
 * every affected authority against these bindings; absence remains unresolved.
 *
 * A pinned read requires READ COMMITTED and locks insertion gaps through effect.
 * Resolve credentials before acquiring any outer auth lease; no credential or
 * pool-based provisioning calls belong inside the protected effect interval.
 */
export async function readHostAuthorityBindings(sql: Sql, workspaceId: string,
  options: { expectedRevision?: string; pinForEffect?: boolean } = {}) {
  options = { ...options };
  if (!exact(workspaceId) || workspaceId === '*' ||
      (options.expectedRevision !== undefined && !/^[a-f0-9]{64}$/.test(options.expectedRevision)))
    throw new Error('host authority bindings require an exact workspace and revision');
  const pinned = options.pinForEffect === true || options.expectedRevision !== undefined;
  const transaction = typeof (sql as unknown as Partial<TransactionSql>).savepoint === 'function';
  if (pinned && !transaction) throw new Error('pinned host authority bindings require an existing transaction');
  const read = async (tx: Sql) => {
    const [isolation] = await tx<Array<{ isolation: string }>>`SELECT current_setting('transaction_isolation') AS isolation`;
    if (pinned) {
      if (isolation?.isolation !== 'read committed') throw new Error('pinned host authority bindings require read committed isolation');
      await tx`LOCK TABLE harness_shared.governance_host_authority_bindings IN SHARE MODE`;
    } else if (!['repeatable read', 'serializable'].includes(isolation?.isolation ?? ''))
      throw new Error('host authority snapshot requires repeatable read or serializable isolation');
    const [visibility] = await tx<Array<{ restricted: boolean }>>`
      SELECT row_security_active('harness_shared.governance_host_authority_bindings') AS restricted`;
    if (!visibility || visibility.restricted) throw new Error('host authority bindings are not fully visible');
    const bindings = await tx<HostAuthorityBinding[]>`
      SELECT kind, subject_id AS "subjectId", human_owner_id AS "humanOwnerId",
        request_principal_revision AS "requestPrincipalRevision", reason,
        to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "recordedAt"
        FROM harness_shared.governance_host_authority_bindings
       WHERE workspace_id = ${workspaceId} ORDER BY kind, subject_id`;
    if (bindings.some(row => !['user', 'platform'].includes(row.kind) ||
        ![row.subjectId, row.humanOwnerId, row.reason, row.recordedAt].every(exact) ||
        !/^[a-f0-9]{64}$/.test(row.requestPrincipalRevision) ||
        (row.kind === 'user' && row.subjectId !== row.humanOwnerId)))
      throw new Error('host authority binding source is malformed');
    const revision = createHash('sha256').update(canonicalJson({ workspaceId, bindings })).digest('hex');
    return options.expectedRevision !== undefined && revision !== options.expectedRevision
      ? { status: 'stale' as const, revision }
      : { status: 'ok' as const, revision, bindings,
        // Required subjects come only from independent enrollment. Do not
        // derive them from the set of policy rows that happens to exist.
        requiredUserIds: bindings.filter(row => row.kind === 'user').map(row => row.subjectId).sort(),
        requiredPlatformIds: bindings.filter(row => row.kind === 'platform').map(row => row.subjectId).sort() };
  };
  return transaction ? read(sql) : sql.begin('isolation level repeatable read read only', tx => read(tx as unknown as Sql));
}
