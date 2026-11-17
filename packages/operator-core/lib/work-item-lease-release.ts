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
import { releaseAllClaimsForOwner as releaseAllPlanItemClaimsForOwner } from './plan-items/claims';
import { issuesScopeWorkspace } from './issues-engineer';
import { activeWorkspaceId } from './workspace-registry';
import { captureWorkItemFlightRecordsForItems, harnessFromIssueScope } from './work-item-flight-record';

export interface OwnerLeaseReleaseResult {
  /** Work-item ids whose lease was released (or found already clear). */
  releasedIds: string[];
  /** Orphan rows swept after the canonical releases perform their own claim cleanup. */
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
      sql<Array<{ id: string; scope: string | null }>>`
        SELECT issue_id AS id, scope
          FROM harness_shared.engineer_issues
         WHERE workspace_id = ${issueWs} AND assignee = ${ownerId}`,
    ]);
    // Snapshot recovery evidence while the holder relationship is still intact.
    // This MUST finish before either claim ledger or lease row is mutated.
    const featureRefs = featureRows.map((r) => ({ id: r.id, harness: r.harness }));
    const issueRefs = issueRows.map((r) => ({ id: r.id, harness: harnessFromIssueScope(r.scope) }));
    if (featureWs === issueWs) {
      await captureWorkItemFlightRecordsForItems({
        ownerId,
        workspaceId: featureWs,
        cause: 'lease-release',
        items: [...featureRefs, ...issueRefs],
      });
    } else {
      await Promise.all([
        captureWorkItemFlightRecordsForItems({
          ownerId,
          workspaceId: featureWs,
          cause: 'lease-release',
          items: featureRefs,
        }),
        captureWorkItemFlightRecordsForItems({
          ownerId,
          workspaceId: issueWs,
          cause: 'lease-release',
          items: issueRefs,
        }),
      ]);
    }

    // The guarded canonical release owns per-item claim cleanup. Clearing all
    // claims first loses a still-held item's lease if its UPDATE/audit fails.
    // Continue other rows, but retain unswept claims until every release succeeds.
    let releaseFailed = false;
    for (const r of featureRows) {
      try {
        const released = await releaseWorkItem(r.id, { harness: r.harness, expectedAssignee: ownerId });
        if (released) releasedIds.push(r.id);
        else releaseFailed = true;
      } catch (e) {
        releaseFailed = true;
        console.warn(`[work-item-lease-release] release failed for ${r.id} (${ownerId}):`, (e as Error)?.message ?? e);
      }
    }
    for (const r of issueRows) {
      try {
        const released = await releaseWorkItem(r.id, { expectedAssignee: ownerId });
        if (released) releasedIds.push(r.id);
        else releaseFailed = true;
      } catch (e) {
        releaseFailed = true;
        console.warn(`[work-item-lease-release] release failed for ${r.id} (${ownerId}):`, (e as Error)?.message ?? e);
      }
    }
    // Sweep orphaned claims only after the item releases. This includes the
    // separate plan ledger (EI-21674158297810406); a failed item remains retryable.
    // claimsCleared counts these sweeps, not cleanup already done by releaseWorkItem.
    let claimsCleared = 0;
    if (!releaseFailed) {
      try {
        claimsCleared = await releaseAllClaimsForOwner(featureWs, ownerId);
      } catch (e) {
        console.warn(`[work-item-lease-release] claim-ledger reconcile failed for ${ownerId}:`, (e as Error)?.message ?? e);
      }
      try {
        claimsCleared += await releaseAllPlanItemClaimsForOwner(featureWs, ownerId);
      } catch (e) {
        console.warn(`[work-item-lease-release] plan-item claim-ledger reconcile failed for ${ownerId}:`, (e as Error)?.message ?? e);
      }
    }
    return { releasedIds, claimsCleared };
  } catch (e) {
    console.warn(`[work-item-lease-release] sweep failed for ${ownerId} (non-fatal):`, (e as Error)?.message ?? e);
    return { releasedIds, claimsCleared: 0 };
  }
}
