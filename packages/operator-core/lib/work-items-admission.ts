/**
 * G2 admission predicate — the SINGLE source of truth for "is this feature-family
 * work-item auto-runnable without auditor screening?".
 *
 * Plan: shared-hive-trust-admission-2026-06-14 (P-001). Successor to the shipped
 * papercusp-user-protection-gate-2026-05-31, whose gate was enforced ONLY on the
 * feature-frontier read (`dbos/orchestrator-loop.ts` readFrontierFeatures +
 * `@papercusp/orchestrator` state-pg.ts readFeaturesPg). The Hive's fleet/blackboard
 * distribution layer — `claimNextWorkItem`, `claimWorkItem`, `claimReplicaSlotLocal`,
 * `fleet:place_batch` (gatherFrontier) — grew up around that one read and never
 * inherited the predicate, so un-screened REMOTE work was claimable + runnable. This
 * module is that one predicate, applied at EVERY claim/place chokepoint so a future
 * path can't silently re-open the hole.
 *
 * Rule (mirrors `@papercusp/orchestrator` isAutoPickable, D-006 of the predecessor):
 * an item is auto-pickable iff it was authored LOCALLY (origin 'local' or NULL, the
 * pre-G1 back-compat case) OR the auditor ADMITTED it (audit_verdict = 'admit').
 * Remote + un-admitted ⇒ quarantined — fail-safe: it holds even if the auditor lane
 * is unwired/errors/lags. The TRUST-LIST fast-path (a trusted author's
 * verified_author_github_user_id) joins this predicate in Phase 3; the column lands
 * in Phase 2. Until then this is the exact behaviour of the proven frontier gate,
 * brought to every other path.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';

type OrgSql = ReturnType<typeof getOrgPg>['sql'];

/**
 * JS form — filter already-loaded rows (placement-gather, list surfacing). Keep this
 * byte-identical in meaning to {@link autoPickableWhereSql}; the drift-guard test
 * (P-006) asserts both agree with `@papercusp/orchestrator` isAutoPickable.
 */
export function isAutoPickable(
  origin: string | null | undefined,
  auditVerdict: string | null | undefined,
  verifiedAuthorGithubUserId?: number | null,
  trustedGithubUserIds?: ReadonlySet<number>,
): boolean {
  // Local features always bypass the auditor — origin NULL = local (pre-G1 back-compat).
  if (origin == null || origin === 'local') return true;
  // Remote features are pickable when the auditor has admitted them…
  if (auditVerdict === 'admit') return true;
  // …OR the TRUST fast-path (Phase 3 / P-010): a remote+un-admitted item whose
  // VERIFIED author (P-008, never a self-claimed id) is in the owner's LOCAL trust
  // list. The verified id must be present AND in the trusted set — a NULL verified
  // id (unverified / revoked binding / local row) never satisfies it. The caller
  // supplies the workspace's trusted set (it is owner/workspace-scoped — D-004).
  if (
    verifiedAuthorGithubUserId != null &&
    trustedGithubUserIds != null &&
    trustedGithubUserIds.has(verifiedAuthorGithubUserId)
  ) {
    return true;
  }
  return false;
}

/**
 * Issue-family (bug/change/task) LOCAL-claimability predicate — the issue-family
 * counterpart of {@link isAutoPickable}, but SIMPLER: a federated (origin='remote')
 * issue-family row is owned EXCLUSIVELY by its authoring peer's core (the
 * hyperbee->PG projector writes it under LWW — see EI-7833 / migration 521's
 * engineer_issues_view_dml remote-skip guard, and the hard invariant enforced at
 * work-items.ts's issue-family setWorkItemState: "its authoring peer must
 * claim/resolve it"). Unlike the feature family, there is NO audit-admit /
 * trust-list escape hatch here — a remote issue-family row is never locally
 * claimable, full stop. `origin` NULL (pre-federation back-compat) or 'local' is
 * locally claimable; anything else (today only 'remote') is not.
 *
 * WI-3649: `claimNextIssueWorkItem` (the claim_next/scheduler:get_next self-select),
 * `listWorkItems`'s issue branch (`admissibleOnly`), and `observeWorkItem` must all
 * apply this SAME predicate so "claimable"/"available" means what the actual claim
 * path (`claimIssue`'s view-trigger) will honor — mirroring EI-7841's fix, which
 * closed the identical read/write gap for the feature family only.
 */
export function isIssueLocallyClaimable(origin: string | null | undefined): boolean {
  return origin == null || origin === 'local';
}

/**
 * SQL form — a composable WHERE fragment for the porsager `sql` instance the caller
 * already holds (so it composes into that query). Columns are UNQUALIFIED — use only
 * in single-table queries over `harness_features_consolidated` (every claim/place
 * chokepoint is one). Pass the caller's own `sql`.
 *
 *   ...WHERE ... AND ${autoPickableWhereSql(sql)}
 */
export function autoPickableWhereSql(sql: OrgSql, workspaceId?: string) {
  // TRUST fast-path (Phase 3 / P-010). The subquery MUST be explicitly scoped to
  // `workspaceId` — NOT left to user_trust_list's RLS — because the admin db
  // handle BYPASSES RLS at some claim chokepoints, so an unscoped subquery would
  // trust-admit a workspace-A feature whose verified author is trusted in
  // workspace B (a cross-workspace trust leak, D-004). `workspaceId` omitted ⇒ the
  // trust leg is dropped entirely (fail-safe: the gate only ever UNDER-admits when
  // the caller can't scope it — never over-admits). verified_author_github_user_id
  // (P-008) is NULL for local / unverified / revoked-binding rows, so only a
  // genuinely-verified trusted author satisfies it.
  const trustLeg = workspaceId
    ? sql` OR (verified_author_github_user_id IS NOT NULL AND verified_author_github_user_id IN (SELECT trusted_github_user_id FROM harness_shared.user_trust_list WHERE workspace_id = ${workspaceId}))`
    : sql``;
  return sql`(origin = 'local' OR origin IS NULL OR audit_verdict = 'admit'${trustLeg})`;
}

/**
 * P-008 (Phase 2) — the PRODUCER side of the trust gate: resolve a federated
 * feature's `author_pubkey` to a github_user_id ONLY via a VERIFIED, non-revoked
 * device attestation in `hive_members` — never a self-claimed id. Returns NULL
 * when the pubkey has no such attestation (the caller stores NULL → the gate
 * conservatively refuses the trust fast-path). The trust DECISION stays at the
 * consumer (isAutoPickable / autoPickableWhereSql, ws-scoped per D-004); this
 * only establishes "who, provably, authored it".
 *
 * Security invariants (contributor-row-types.ts DeviceAttestationEntry +
 * revoked_pubkeys "a verifier MUST refuse any attestation whose pubkey is here"):
 *   - binding_status = 'verified'  (BINDING_STATUSES: verified|pending|unverified)
 *   - author_pubkey ∈ device_attestations (an attested binding exists)
 *   - author_pubkey ∉ revoked_pubkeys (the device wasn't revoked)
 *   - workspace-scoped (hive_members is owner/workspace-keyed); hive_home_slug
 *     narrows further when known. The COALESCE guards keep a member with a NULL
 *     revoked_pubkeys / device_attestations from being wrongly excluded/erroring.
 */
export async function resolveVerifiedAuthorGithubId(
  sql: OrgSql,
  opts: { workspaceId: string; authorPubkey: string | null | undefined; potHomeSlug?: string },
): Promise<number | null> {
  const pubkey = (opts.authorPubkey ?? '').trim();
  if (!pubkey || !opts.workspaceId) return null;
  try {
    const hiveFilter = opts.potHomeSlug ? sql`AND hive_home_slug = ${opts.potHomeSlug}` : sql``;
    const rows = await sql<{ github_user_id: string | number }[]>`
      SELECT github_user_id
        FROM harness_shared.hive_members
       WHERE workspace_id = ${opts.workspaceId}
         ${hiveFilter}
         AND binding_status = 'verified'
         AND NOT (${pubkey} = ANY(COALESCE(revoked_pubkeys, ARRAY[]::text[])))
         AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements(COALESCE(device_attestations, '[]'::jsonb)) a
            WHERE a->>'device_pubkey' = ${pubkey}
         )
       LIMIT 1`;
    if (!rows[0]) return null;
    const raw = rows[0].github_user_id;
    const id = typeof raw === 'string' ? Number(raw) : raw;
    return Number.isFinite(id) ? id : null;
  } catch {
    // Best-effort + FAIL-SAFE: an unreadable/absent hive_members (e.g. a transient
    // error, or a projection running against a partial schema) yields NULL → the
    // trust fast-path simply doesn't fire (the gate conservatively refuses), and
    // the federated-ingest projection loop is never crashed by the optional stamp.
    return null;
  }
}

/**
 * Load the owner's LOCAL trust list for a workspace as a Set<github_user_id> —
 * the JS-gate (isAutoPickable) counterpart of the SQL trust subquery. WORKSPACE-
 * SCOPED (D-004: the list is owner/workspace-keyed; a remote item must only be
 * trust-admitted against its OWN workspace's list, never cross-workspace). Empty
 * set on any read failure (fail-safe: no trust fast-path rather than over-broad).
 */
export async function loadTrustedGithubUserIds(workspaceId: string): Promise<Set<number>> {
  const out = new Set<number>();
  if (!workspaceId) return out;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ trusted_github_user_id: string | number }[]>`
      SELECT trusted_github_user_id FROM harness_shared.user_trust_list
       WHERE workspace_id = ${workspaceId}`;
    for (const r of rows) {
      const raw = r.trusted_github_user_id;
      const id = typeof raw === 'string' ? Number(raw) : raw;
      if (Number.isFinite(id)) out.add(id);
    }
  } catch {
    /* fail-safe — empty set ⇒ trust fast-path simply doesn't fire */
  }
  return out;
}

/**
 * Per-id admission read for paths that don't already SELECT the item's provenance —
 * the replica lane reads `work_item_replicas`, not the consolidated feature row. Reads
 * origin + audit_verdict and applies {@link isAutoPickable}. A missing row returns
 * `false` (fail-safe: a vanished/foreign item never slips through here; the caller's
 * own not-found handling runs first for the legitimate-missing case).
 */
export async function isWorkItemAutoPickable(
  workItemId: string,
  opts: { harness: string; workspaceId?: string },
): Promise<boolean> {
  const { sql } = getOrgPg();
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<{ origin: string | null; audit_verdict: string | null; verified_author_github_user_id: number | string | null }[]>`
    SELECT origin, audit_verdict, verified_author_github_user_id
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${opts.harness}
       AND workspace_id = ${ws}
       AND feature_id = ${workItemId}
     LIMIT 1`;
  if (!rows[0]) return false;
  // Local / auditor-admitted fast path (no trust-list read needed).
  if (isAutoPickable(rows[0].origin, rows[0].audit_verdict)) return true;
  // TRUST fast-path: a remote+un-admitted item whose VERIFIED author is in this
  // workspace's local trust list (explicitly ws-scoped — D-004). NULL verified id
  // (unverified / revoked / local) never qualifies.
  const raw = rows[0].verified_author_github_user_id;
  const verifiedId = raw == null ? null : typeof raw === 'string' ? Number(raw) : raw;
  if (verifiedId == null || !Number.isFinite(verifiedId)) return false;
  const trusted = await sql`
    SELECT 1 FROM harness_shared.user_trust_list
     WHERE workspace_id = ${ws} AND trusted_github_user_id = ${verifiedId} LIMIT 1`;
  return trusted.length > 0;
}
