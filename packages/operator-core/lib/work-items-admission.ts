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
