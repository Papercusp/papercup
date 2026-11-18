/** P-002 independent host enrollment source, separate from policy roots.
 * Enrollment records explicit human ownership, never permission-edit admission.
 * Legacy/unenrolled authorities stay unknown; no ownership is synthesized.
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

export class HostAuthorityEnrollmentError extends Error {
  constructor(readonly code: 'invalid' | 'forbidden' | 'conflict', message: string) { super(message); }
}

export interface HostAuthorityEnrollment {
  kind: 'user' | 'platform';
  subjectId: string;
  reason: string;
}

/** Only the original browser cookie authenticates this explicit request. An
 * agent/system principal, caller-supplied owner, or default user cannot enroll.
 * Reuses the local-session source and org admin transaction, without calling
 * getSessionUser (and its pool last_seen_at write) behind any authorization lock.
 * This inserts ownership evidence only; it neither writes a policy nor replaces
 * an enrolled owner. Policy edits still need ordinary authority and the full
 * permission-change guard. No unauthenticated bootstrap/backfill is provided.
 */
export async function enrollHostAuthorityBinding(headers: Headers, workspaceId: string,
  input: HostAuthorityEnrollment, sql?: Sql) {
  const credentials = new Headers(headers);
  input = { ...input };
  if (!exact(workspaceId) || workspaceId === '*' || !input ||
      !['user', 'platform'].includes(input.kind) || !exact(input.subjectId) || input.subjectId === '*' ||
      !exact(input.reason) || Object.keys(input).some(key => !['kind', 'subjectId', 'reason'].includes(key)))
    throw new HostAuthorityEnrollmentError('invalid', 'exact enrollment subject and reason required');
  // Keep enrollment's auth graph out of read-only population scans.
  const [{ resolveSessionToken }, { refuseLegacyBootstrapPrincipal }] = await Promise.all([
    import('../auth'), import('../auth/require-principal'),
  ]);
  refuseLegacyBootstrapPrincipal(credentials);
  let token: string | undefined;
  try { token = await resolveSessionToken(credentials); }
  catch (error) {
    if (!(error instanceof URIError)) throw error;
    throw new HostAuthorityEnrollmentError('forbidden', 'malformed browser session cookie');
  }
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw new HostAuthorityEnrollmentError('forbidden', 'authenticated browser session required');
  sql ??= (await import('@papercusp/db-org')).getOrgPg().sql;
  if (typeof (sql as unknown as Partial<TransactionSql>).savepoint === 'function')
    throw new HostAuthorityEnrollmentError('invalid', 'enrollment owns its read committed transaction');

  // A content pin prevents a grant, reassignment or extended lifetime acquired
  // while waiting from widening what the original request actually possessed.
  // Secrets never leave SQL. UTC fixes the revision across connection settings.
  const authority = (tx: Sql) => tx<Array<{ userId: string; revision: string }>>`
    SELECT s.user_id::text AS "userId",
      encode(sha256(convert_to(jsonb_build_object(
        'purpose', 'host-authority-enrollment-v1', 'userId', s.user_id,
        'workspaceId', s.workspace_id, 'capabilities', s.capabilities, 'active', u.is_active,
        'session', encode(sha256(convert_to(s.token, 'UTF8')), 'hex'),
        'expiresAt', to_char(s.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      )::text, 'UTF8')), 'hex') AS revision
      FROM harness_shared.user_sessions s JOIN harness_shared.users u ON u.id = s.user_id
     WHERE s.token = ${token} AND s.workspace_id = ${workspaceId}
       AND s.expires_at > clock_timestamp() AND u.is_active = true
       AND s.capabilities @> ARRAY['*']::text[]`;
  const [original] = await authority(sql);
  if (!original || (input.kind === 'user' && input.subjectId !== original.userId))
    throw new HostAuthorityEnrollmentError('forbidden', 'full operator session and explicit self ownership required');

  return sql.begin('isolation level read committed', async transaction => {
    const tx = transaction as unknown as Sql;
    // Serialize enrollment, including absent subjects, with the effect reader's
    // SHARE lease. Acquire this BEFORE reading current credentials: a long wait
    // must not turn a formerly valid cookie into permission to write later.
    await tx`LOCK TABLE harness_shared.governance_host_authority_bindings IN SHARE ROW EXCLUSIVE MODE`;
    const current = await tx<Array<{ userId: string; revision: string }>>`${authority(tx)} FOR SHARE OF s, u`;
    if (current.length !== 1 || current[0].revision !== original.revision)
      throw new HostAuthorityEnrollmentError('forbidden', 'enrollment credential changed or expired');
    const existing = await tx`SELECT 1 FROM harness_shared.governance_host_authority_bindings
      WHERE workspace_id = ${workspaceId} AND kind = ${input.kind} AND subject_id = ${input.subjectId}`;
    if (existing.length) throw new HostAuthorityEnrollmentError('conflict', 'authority already enrolled; ownership replacement requires a separate guarded change');
    // Re-evaluate on the INSERT, after ALL lock waits, with wall-clock expiry
    // rather than transaction-start now(). Held auth rows block revocation and
    // capability changes through this effect; time itself still needs this test.
    const rows = await tx<HostAuthorityBinding[]>`
      INSERT INTO harness_shared.governance_host_authority_bindings
        (workspace_id, kind, subject_id, human_owner_id, request_principal_revision, reason)
      SELECT ${workspaceId}, ${input.kind}, ${input.subjectId}, a."userId", a.revision, ${input.reason}
        FROM (${authority(tx)}) a WHERE a.revision = ${original.revision} AND a."userId" = ${original.userId}
      ON CONFLICT DO NOTHING
      RETURNING kind, subject_id AS "subjectId", human_owner_id AS "humanOwnerId",
        request_principal_revision AS "requestPrincipalRevision", reason,
        to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "recordedAt"`;
    if (rows.length !== 1) throw new HostAuthorityEnrollmentError('forbidden', 'enrollment credential unavailable at effect');
    return { status: 'enrolled' as const, binding: rows[0] };
  });
}

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
