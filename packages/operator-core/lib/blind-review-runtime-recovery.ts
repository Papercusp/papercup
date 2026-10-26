/** Cutoff hooks and bounded restart/expiry reconciliation for original custody. */
import { getOrgPg } from '@papercusp/db-org';
import { createCanonicalRuntimeCustodyStore } from './blind-review-runtime-authority';
import { createLinuxRuntimeNamespaceBackend } from './blind-review-runtime-backend';
import { runtimeReviewerIdentityFromLease, type createRuntimeCustodyStore, type RuntimeLease } from './blind-review-runtime-custody';
import { releaseRuntimeNamespace, type RuntimeNamespaceBackend } from './blind-review-runtime-lifecycle';

type Dependencies = { sql?: Sql; store?: ReturnType<typeof createRuntimeCustodyStore>; backend?: RuntimeNamespaceBackend };
type Sql = ReturnType<typeof getOrgPg>['sql'];
async function installed(sql: Sql) {
  const [row] = await sql<Array<{ name: string | null }>>`
    SELECT to_regclass('harness_shared.blind_review_runtime_leases')::text AS name`;
  return !!row?.name; // Rolling deployment: old schema has no runtime resources.
}
async function release(leases: RuntimeLease[], reason: string, deps: Dependencies) {
  if (!leases.length) return { cutoff: 0, released: 0, pending: 0 };
  const store = deps.store ?? createCanonicalRuntimeCustodyStore(deps.sql);
  const backend = deps.backend ?? createLinuxRuntimeNamespaceBackend();
  let released = 0;
  for (const lease of leases) {
    const identity = runtimeReviewerIdentityFromLease(lease);
    if (await releaseRuntimeNamespace({ store, identity, leaseId: lease.id, backend, reason })) released++;
  }
  return { cutoff: leases.length, released, pending: leases.length - released };
}

/** Call after the canonical binding writer commits. No authority can be restored. */
export async function retireRuntimeNamespacesForBinding(input: {
  workspaceId: string; bindingId: number; reason: 'review-posted' | 'review-replaced';
}, deps: Dependencies = {}) {
  const sql = deps.sql ?? getOrgPg().sql;
  if (!await installed(sql)) return { cutoff: 0, released: 0, pending: 0 };
  const leases = await sql<RuntimeLease[]>`UPDATE harness_shared.blind_review_runtime_leases
    SET state = 'releasing', revoked_at = COALESCE(revoked_at, clock_timestamp()),
      release_reason = COALESCE(release_reason, ${input.reason}), updated_at = clock_timestamp()
    WHERE workspace_id = ${input.workspaceId} AND binding_id = ${input.bindingId}
      AND state IN ('allocating','ready','releasing') RETURNING *`;
  return release(leases, input.reason, { ...deps, sql });
}

/** Exact winning native-end identity, so a late hook cannot retire a successor. */
export async function retireRuntimeNamespacesForNativeEnd(input: {
  workspaceId: string; advSessionId: number; nativeSessionId: string;
}, deps: Dependencies = {}) {
  const sql = deps.sql ?? getOrgPg().sql;
  if (!await installed(sql)) return { cutoff: 0, released: 0, pending: 0 };
  const leases = await sql<RuntimeLease[]>`UPDATE harness_shared.blind_review_runtime_leases AS lease
    SET state = 'releasing', revoked_at = COALESCE(lease.revoked_at, clock_timestamp()),
      release_reason = COALESCE(lease.release_reason, 'reviewer-native-ended'), updated_at = clock_timestamp()
    FROM harness_shared.plan_blind_review_sessions AS binding
    WHERE lease.workspace_id = ${input.workspaceId} AND binding.workspace_id = lease.workspace_id
      AND binding.id = lease.binding_id AND binding.adv_session_id = ${input.advSessionId}
      AND binding.native_session_id = ${input.nativeSessionId}
      AND lease.admission->>'nativeSessionId' = ${input.nativeSessionId}
      AND lease.state IN ('allocating','ready','releasing') RETURNING lease.*`;
  return release(leases, 'reviewer-native-ended', { ...deps, sql });
}

/** Missing hooks/restarts cannot strand intents, including create-before-append. */
export async function reconcileRuntimeNamespaces(deps: Dependencies = {}) {
  const sql = deps.sql ?? getOrgPg().sql;
  if (!await installed(sql)) return { checked: 0, released: 0, pending: 0, failures: [] as string[] };
  const store = deps.store ?? createCanonicalRuntimeCustodyStore(sql);
  const backend = deps.backend ?? createLinuxRuntimeNamespaceBackend();
  const leases = await sql<RuntimeLease[]>`SELECT * FROM harness_shared.blind_review_runtime_leases
    WHERE state IN ('allocating','ready','releasing') ORDER BY updated_at, id LIMIT 32`;
  let released = 0, pending = 0;
  const failures: string[] = [];
  for (const original of leases) {
    try {
      const identity = runtimeReviewerIdentityFromLease(original);
      const current = await store.reconciliationDisposition(identity, original.id);
      if (current.lease.state === 'released') continue;
      let reason = current.reason;
      if (!reason && current.staleAllocation) {
        // A live creator holds the lifecycle connection across boot. Recovery
        // acquires it only after that creator is fenced; it never adopts/replays.
        const fence = await store.withLifecycle(identity, original.id, async () => true);
        if (fence.acquired) reason = 'runtime-interrupted-allocation';
      } else if (!reason && current.lease.state === 'ready') {
        const observed = await backend.inspect(current.lease, current.resources, AbortSignal.timeout(5_000));
        if (observed.scopeAbsent && observed.creatorStopped) reason = 'runtime-scope-ended';
      }
      if (reason) {
        if (await releaseRuntimeNamespace({ store, identity, leaseId: original.id, backend, reason })) released++;
        else pending++;
      }
    } catch {
      // Expose an accountable id without source, credentials, SQL or paths.
      failures.push(original.id); pending++;
    }
  }
  return { checked: leases.length, released, pending, failures };
}
