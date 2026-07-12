/**
 * work-item-lease-release.ts — force-release EVERY work-item lease
 * (`taken_by`/`assignee`) AND coordination claim (`work_item_claims`) held by
 * one specific owner (session-death-claim-release-2026-07-11).
 *
 * The shared core behind BOTH halves of the fix:
 *  - P-002 (fast path, event-driven): `activity:report`'s SessionEnd/Stop
 *    lifecycle branch calls this UNCONDITIONALLY for the ending owner — no
 *    liveness judgment needed, the event itself IS the death signal.
 *  - P-001 (backstop, scheduled): `idle-session-reaper.ts`'s
 *    `runWorkItemLeaseReap` calls this per DEAD owner it identifies via its
 *    liveness sweep, for the sessions whose SessionEnd never fired (SIGKILL,
 *    a raw terminal close that skips the hook, a host crash).
 *
 * Deliberately NOT gated on any liveness check itself — the caller establishes
 * that ("this owner's session just ended" / "this owner is confirmed dead").
 * Compare-and-release throughout (`expectedAssignee`): if the lease changed
 * hands to a live agent between the caller's read and this call, the release
 * is a safe no-op for that row rather than clobbering a fresh claim.
 */
import { getOrgPg } from '@papercusp/db-org';
import { releaseWorkItem } from './work-items';
import { releaseAllClaimsForOwner } from './work-item-claims';
import { issuesScopeWorkspace } from './issues-engineer';
import { activeWorkspaceId } from './workspace-registry';

export interface OwnerLeaseReleaseResult {
  /** Work-item ids whose lease was released (or found already clear). */
  releasedIds: string[];
  /** True when the coordination claim ledger (work_item_claims) was also swept for this owner. */
  claimsCleared: number;
}

/**
 * Force-release every currently-held work-item lease (feature + issue family)
 * for `ownerId`, then clear its `work_item_claims` rows. Best-effort per row —
 * one failed release never blocks the rest; never throws (a caller invoking
 * this from a fire-and-forget hook path must never see it fail the request).
 */
export async function releaseAllWorkItemLeasesForOwner(ownerId: string): Promise<OwnerLeaseReleaseResult> {
  const releasedIds: string[] = [];
  try {
    const { sql } = getOrgPg();
    const featureWs = activeWorkspaceId();
    const issueWs = issuesScopeWorkspace();
    const [featureRows, issueRows] = await Promise.all([
      sql<Array<{ id: string; harness: string }>>`
        SELECT feature_id AS id, harness_slug AS harness
          FROM harness_shared.harness_features_consolidated
         WHERE workspace_id = ${featureWs} AND taken_by = ${ownerId}`,
      sql<Array<{ id: string }>>`
        SELECT issue_id AS id
          FROM harness_shared.engineer_issues
         WHERE workspace_id = ${issueWs} AND assignee = ${ownerId}`,
    ]);
    for (const r of featureRows) {
      try {
        const released = await releaseWorkItem(r.id, { harness: r.harness, expectedAssignee: ownerId });
        if (released) releasedIds.push(r.id);
      } catch (e) {
        console.warn(`[work-item-lease-release] release failed for ${r.id} (${ownerId}):`, (e as Error)?.message ?? e);
      }
    }
    for (const r of issueRows) {
      try {
        const released = await releaseWorkItem(r.id, { expectedAssignee: ownerId });
        if (released) releasedIds.push(r.id);
      } catch (e) {
        console.warn(`[work-item-lease-release] release failed for ${r.id} (${ownerId}):`, (e as Error)?.message ?? e);
      }
    }
    let claimsCleared = 0;
    try {
      claimsCleared = await releaseAllClaimsForOwner(featureWs, ownerId);
    } catch (e) {
      console.warn(`[work-item-lease-release] claim-ledger reconcile failed for ${ownerId}:`, (e as Error)?.message ?? e);
    }
    return { releasedIds, claimsCleared };
  } catch (e) {
    console.warn(`[work-item-lease-release] sweep failed for ${ownerId} (non-fatal):`, (e as Error)?.message ?? e);
    return { releasedIds, claimsCleared: 0 };
  }
}
