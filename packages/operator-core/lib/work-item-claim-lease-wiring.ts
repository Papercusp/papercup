/**
 * Flag-gated wiring that re-points a work-item claim onto the per-Hive authority LEASE
 * (decentralized-dispatch-scaling-2026-06-08 P-004 / D-002, on D-007's recommended
 * HYBRID — authority-arbitrated exactly-once, fail-open to reconcile).
 *
 * DEFAULT OFF. `PAPERCUSP_WORKITEM_CLAIM_LEASE=1` is the OWNER'S RATIFICATION SWITCH:
 * until D-007 (P-001) is settled, this stays off and `work_items:claim_next` / `:claim`
 * behave EXACTLY as before (a local `SELECT … FOR UPDATE SKIP LOCKED` on one PG). The
 * owner flips it on to activate the cross-Swarm Hive-authority arbitration. (Env-gated
 * rather than a PostHog flag because it is a synchronous server-side dispatch decision
 * read deep in the claim path; promote to a PostHog flag if a UI toggle is wanted.)
 *
 * When ON: after the local claim sets `taken_by`, the claim tool acquires the Hive lease
 * through the per-Hive authority (the swarm router installed at boot — see
 * register-claim-authority-ops.ts). On a single box the authority is self → the lease is
 * a local row. Cross-Swarm, the Hive authority (lowest-live-device-pubkey,
 * `lockAuthorityForHive`) serializes: exactly one Swarm wins the lease; the loser
 * RELEASES its local claim so the item returns to the backlog. If the authority is
 * partitioned the acquire fails OPEN to a local advisory lease and
 * `work-item-claim-reconcile.ts` (P-005) resolves any double-claim on reconvergence.
 */
import { activeWorkspaceId } from './workspace-registry';
import { hiveHomeSlugForHarness } from './hive-federation';
import { acquireClaim } from './work-item-claims';

/** The owner's ratification switch (D-007 / P-001). Default OFF. */
export function workItemClaimLeaseEnabled(): boolean {
  return process.env.PAPERCUSP_WORKITEM_CLAIM_LEASE === '1';
}

/**
 * Acquire the per-Hive authority lease for a work item that was just locally claimed.
 * Returns whether THIS Swarm holds the Hive lease. On `false` the caller must release its
 * local claim (the item is held by another Swarm's Hive lease). Best-effort Hive
 * resolution: a non-Hive harness falls back to harness-scoped arbitration inside the
 * store. `holderPubkey` is left to the store default (null) here — it feeds the
 * cross-machine reconcile (P-005), which is the gated cross-Swarm path, not the
 * single-box claim.
 */
export async function leaseClaimedWorkItem(opts: {
  harness: string;
  workItemId: string;
  owner: string;
  workspaceId?: string;
}): Promise<boolean> {
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  let hiveSlug: string | null = null;
  try {
    hiveSlug = await hiveHomeSlugForHarness(workspaceId, opts.harness);
  } catch {
    hiveSlug = null; // not part of a Hive / resolution failed → harness-scoped fallback
  }
  const res = await acquireClaim({
    workspaceId,
    harnessSlug: opts.harness,
    workItemId: opts.workItemId,
    hiveSlug,
    owner: opts.owner,
    intent: 'work-stealing claim (claim_next)',
  });
  return res.ok;
}
