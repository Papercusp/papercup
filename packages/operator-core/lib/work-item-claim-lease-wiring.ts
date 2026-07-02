/**
 * Flag-gated wiring that re-points a work-item claim onto the per-Hive authority LEASE
 * (decentralized-dispatch-scaling-2026-06-08 P-004 / D-002, on D-007's recommended
 * HYBRID — authority-arbitrated exactly-once, fail-open to reconcile).
 *
 * DEFAULT ON (graduated 2026-06-23, owner-directed verify+flip, WI-597 — the flag registry
 * libs/flags/src/types.ts is the source of truth; this header previously said OFF and lied,
 * cross-machine-coord-parity-and-trust-2026-07-01 P-017). The `WORKITEM_CLAIM_LEASE` FLAG
 * remains the OWNER'S KILL SWITCH: flipping it OFF reverts `work_items:claim_next` / `:claim`
 * to the plain local `SELECT … FOR UPDATE SKIP LOCKED` on one PG. Migrated off the ad-hoc `PAPERCUSP_WORKITEM_CLAIM_LEASE` env gate to a FLAG
 * (work-queue-stuck-item-recovery P-012 / D-008); because the decision is read SYNC deep in
 * the claim path, the flag is held in a SYNC-cached boolean refreshed on boot + every flag
 * change (the lexicon/issues-engineer pattern). Listed in KNOWN_DARK_FLAGS.
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
import { FLAGS } from '@papercusp/flags';
import { getFlag, onFlagChange } from '@papercusp/flags/server';
import { activeWorkspaceId } from './workspace-registry';
import { systemDistinctId } from './flag-distinct-id';
import { hiveHomeSlugForHarness } from './hive-federation';
import { acquireClaim, releaseClaimForItem } from './work-item-claims';
import { getBootedHarness } from './sync/hyperbee/boot-all';
import { resolveMyPubkey } from './orchestrator/distributed-claim';

// P-012 / D-008: the WORKITEM_CLAIM_LEASE flag, SYNC-cached because the claim-path read
// must be synchronous. Refreshed on an initial read + every flag change (the
// issues-engineer/lexicon pattern). Unloaded → false (DEFAULT OFF, the safe behavior).
let claimLeaseOn = false;
async function refreshClaimLease(): Promise<void> {
  try {
    claimLeaseOn = await getFlag(FLAGS.WORKITEM_CLAIM_LEASE, systemDistinctId());
  } catch {
    claimLeaseOn = false;
  }
}
void refreshClaimLease();
onFlagChange((key) => {
  if (key === null || key === FLAGS.WORKITEM_CLAIM_LEASE) void refreshClaimLease();
});

/** The owner's ratification switch (D-008). Default OFF. Read from the SYNC-cached
 *  WORKITEM_CLAIM_LEASE flag (migrated off the PAPERCUSP_WORKITEM_CLAIM_LEASE env gate). */
export function workItemClaimLeaseEnabled(): boolean {
  return claimLeaseOn;
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

/**
 * EI-6832: best-effort lease cleanup for a work item RETURNING to the unclaimed pool via
 * `work_items:release` (voluntary release, not `leaseClaimedWorkItem`'s own claimId-checked
 * release). See {@link releaseClaimForItem}'s doc comment for the full mechanism this
 * closes (a stale, not-yet-expired lease silently poisoning the item for every OTHER
 * claimant until its TTL lapses — up to 30m/2h — even though the item is visibly
 * unclaimed). A no-op when the lease flag is off (nothing to clean up) or `owner` is
 * empty (nothing was ever leased under that identity). NEVER throws — callers must not
 * let this cleanup's failure block the actual release; a leftover stale lease degrades
 * to "this one item is temporarily un-self-selectable", never a correctness break.
 */
export async function releaseWorkItemLease(opts: { harness: string; workItemId: string; owner: string | null | undefined }): Promise<void> {
  if (!claimLeaseOn || !opts.owner) return;
  try {
    const workspaceId = activeWorkspaceId();
    // Same hiveSlug resolution as leaseClaimedWorkItem (above), so a release routes to
    // the SAME authority scope the original acquire did — on a single box this is a
    // no-op (authority = self either way); cross-Swarm it matters.
    let hiveSlug: string | null = null;
    try {
      hiveSlug = await hiveHomeSlugForHarness(workspaceId, opts.harness);
    } catch {
      hiveSlug = null;
    }
    await releaseClaimForItem({ workspaceId, harnessSlug: opts.harness, workItemId: opts.workItemId, hiveSlug, owner: opts.owner });
  } catch {
    // best-effort — a stale lease that outlives its TTL is a temporary DX papercut,
    // never worth risking the caller's actual release for.
  }
}

/**
 * The serializable subset of a held work-item lease that the DBOS pipeline carries so it
 * can RENEW the lease + SELF-ABORT if it is stolen mid-run (shared-hive-loop-e2e-testing
 * D-007). Plain data — threaded through `PipelineInput` (DBOS-serializable). `workItemId`,
 * `harnessSlug`, `workspaceId` are already on `PipelineInput`, so only the lease identity
 * lives here. The heartbeat re-keys on (workItemId, claimId, owner) routed by `hiveSlug`.
 */
export interface WorkItemClaimLeaseHandle {
  claimId: string;
  /** THIS Swarm's lease owner (its device pubkey, or the swarm-local fallback). */
  owner: string;
  hiveSlug: string | null;
  holderPubkey: string | null;
}

/** The outcome of an executor lease attempt: whether this Swarm may run the feature, plus
 *  the lease HANDLE to thread into the pipeline when it took one (D-007). */
export interface FeatureLeaseResult {
  /** This Swarm may run the feature (it holds the lease, or fail-open). */
  ok: boolean;
  /** The acquired lease, present only when `ok` AND a real claim was taken. ABSENT on
   *  refusal (another Swarm holds it) AND on the fail-open path (no handle to heartbeat →
   *  the pipeline runs WITHOUT the D-007 zombie-guard, exactly as before the lease landed). */
  claim?: WorkItemClaimLeaseHandle;
}

/**
 * The orchestrator-side (per-Swarm executor) lease gate — decentralized-dispatch-scaling
 * P-007/P-008. Before the DBOS executor dispatches a READY feature (eligibility still
 * decided by computeFrontier), acquire the per-Hive lease so that cross-Swarm exactly ONE
 * Swarm runs it: the lease is the cross-machine exactly-once gate, with DBOS workflow-id
 * dedup remaining the LOCAL guard (D-006 — the orchestrator is demoted from sole global
 * dispatcher to one Swarm's executor that work-steals).
 *
 * Owner = THIS Swarm's device pubkey so two Swarms are DISTINCT holders (a shared owner
 * would both "win" the acquire's own-extend clause). Returns whether this Swarm may run
 * the feature AND (on success) the lease handle to thread into the pipeline — the running
 * pipeline then renews the lease + self-aborts on a steal (D-007), which retires the old
 * dispatch-loop keep-alive re-acquire (a long pipeline keeps its OWN lease alive now).
 *
 * FAIL-OPEN (D-007): any resolution / authority / PG error → returns `{ ok: true }` (no
 * handle) so dispatch proceeds. The lease gate must NEVER wedge the live dispatcher; a
 * rare cross-Swarm double-run (e.g. a lease that lapses mid-pipeline) is the
 * tolerate-and-reconcile case (work-item-claim-reconcile, P-005). A generous TTL (2h)
 * covers a long pipeline and an enqueue-wait before the pipeline starts heartbeating.
 */
export async function leaseFeatureForExecutor(opts: {
  workspaceId: string;
  harness: string;
  featureId: string;
}): Promise<FeatureLeaseResult> {
  try {
    const booted = getBootedHarness(opts.workspaceId, opts.harness);
    const owner = (booted ? resolveMyPubkey(booted) : null) ?? `swarm-local:${opts.harness}`;
    let hiveSlug: string | null = null;
    try {
      hiveSlug = await hiveHomeSlugForHarness(opts.workspaceId, opts.harness);
    } catch {
      hiveSlug = null;
    }
    const res = await acquireClaim({
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harness,
      workItemId: opts.featureId,
      hiveSlug,
      owner,
      holderPubkey: owner,
      intent: 'executor dispatch (orchestrator)',
      ttlSec: 7200,
    });
    if (!res.ok) return { ok: false };
    return {
      ok: true,
      claim: {
        claimId: res.claim.claimId,
        owner: res.claim.owner,
        hiveSlug: res.claim.hiveSlug,
        holderPubkey: res.claim.holderPubkey,
      },
    };
  } catch {
    return { ok: true }; // fail-open — never let the lease gate wedge the live dispatcher
  }
}
