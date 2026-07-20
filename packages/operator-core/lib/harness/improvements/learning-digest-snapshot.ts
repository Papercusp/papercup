/**
 * The compute behind the `learning.improvements` sync resolver — extracted so the
 * PRECOMPUTED default variant (a `system:precompute-derived-reads` producer) and
 * the resolver's live inline path for NON-default variants run the EXACT same code
 * and can never drift (precompute-sync-reads-phase2-compute-latency-2026-07-19
 * P-003 / WI-5460 follow-up; the same "the tab and the tool can never drift"
 * discipline the resolver was written under).
 *
 * ── What is and is NOT in here ───────────────────────────────────────────────
 * This builds the structured ImprovementDigest (+ the `flow` block + the WI-5412
 * humanQueue slimming) — the expensive part (buildDigest + human-queue ranking +
 * flow-metrics over the whole improvement corpus, measured 0.4-0.5s on read).
 *
 * The `recordQueueExposure` side-effect (FB-15 / P-043) is DELIBERATELY NOT here:
 * it records that the queue was rendered TO THE OWNER, so it must fire on the
 * actual user-facing read (the resolver), never on the routine thread that fills
 * the snapshot — otherwise the owner-preference model's "shown but ignored"
 * denominator would count exposures that never happened. The resolver fires it
 * from whatever humanQueue the read returns (snapshot or inline).
 */
import type { ImprovementDigest } from './digest';

export interface LearningImprovementsArgs {
  state?: 'open' | 'resolved' | 'closed';
  limit?: number;
  /** A Hive HOME slug narrows to that Hive's member-harness scopes; omit ⇒ whole workspace. */
  hive?: string;
}

/**
 * Build the `learning.improvements` payload row (the client reads `data[0]`).
 * Pure of the owner-exposure side-effect (see the module note) so it is safe to
 * run on the precompute routine's thread as well as inline on a read.
 */
export async function computeLearningImprovementsSnapshot(
  a: LearningImprovementsArgs,
): Promise<Array<ImprovementDigest & { flow: unknown }>> {
  const { readImprovementItems } = await import('./read-items');
  const { buildDigest } = await import('./digest');
  const { applyHumanQueueRanking } = await import('../../queue-ranker/human-queue');
  const { computeImprovementFlow, readWatchdogFlowTicks } = await import('./flow-metrics');
  const { activeWorkspaceId } = await import('../../workspace-registry');
  const { readOwnerFullAutonomyGrant } = await import('./full-autonomy-grant');
  const nowMs = Date.now();
  // The OWNER FULL-AUTONOMY grant (Phase 2): this feed IS the owner's Learning-tab
  // view of the queue — keep its auto/human split consistent with the live dispatch so
  // a protected-surface kind=bug isn't shown as "needs your decision" while the loop
  // auto-implements it once the grant is on.
  const ownerFullAutonomy = await readOwnerFullAutonomyGrant(activeWorkspaceId());
  // P-040: resolve the Hive → its member-harness scope set (the Hive is the
  // tenancy unit) so the feed only shows that Hive's improvements. Best-effort:
  // a registry read failure degrades to the unfiltered (workspace) feed rather
  // than 500ing the tab.
  let harnessScopes: string[] | undefined;
  if (a.hive) {
    try {
      const { loadHarnessRegistry, hiveMemberHarnessScopes } = await import('../../harness-registry');
      const reg = await loadHarnessRegistry();
      harnessScopes = hiveMemberHarnessScopes(reg.projects, a.hive);
    } catch (err) {
      console.warn('[learning.improvements] hive scope resolution failed:', err instanceof Error ? err.message : err);
    }
  }
  const items = await readImprovementItems({
    state: a.state,
    limit: a.limit,
    ...(harnessScopes ? { harnessScopes } : {}),
  });
  // Human lane ordered by the ONE ranker (frontier P-040; feature #1 is
  // consume-edges P-022's blocking impact) — the owner's queue leads with
  // what blocks the most, each item carrying its per-feature breakdown.
  const digest = await applyHumanQueueRanking(buildDigest(items, { nowMs, ownerFullAutonomy }), {
    candidates: items,
  });
  // Watchdog ticks are best-effort: a tick-read failure degrades the flow
  // strip to "watchdog: never" rather than 500ing the whole improvements view.
  let ticks: Awaited<ReturnType<typeof readWatchdogFlowTicks>> = [];
  try {
    ticks = await readWatchdogFlowTicks(activeWorkspaceId());
  } catch (err) {
    console.warn('[learning.improvements] watchdog tick read failed:', err instanceof Error ? err.message : err);
  }
  // Dispatch-ledger rollup (consume-edges P-010 / B-04) — same best-effort
  // rule: a ledger read failure degrades the strip's dispatch chip to "—".
  let dispatchStats: import('./dispatch-ledger').DispatchStats | null = null;
  try {
    const { readRecentDispatches, computeDispatchStats } = await import('./dispatch-ledger');
    dispatchStats = computeDispatchStats(await readRecentDispatches(activeWorkspaceId()), { nowMs });
  } catch (err) {
    console.warn('[learning.improvements] dispatch ledger read failed:', err instanceof Error ? err.message : err);
  }
  const flow = computeImprovementFlow(items, ticks, {
    nowMs,
    // Reuse the digest's recurrence computation (P-041) — do not re-derive.
    recurringSignatureCount: digest.recurringSignatures.length,
    dispatchStats,
  });
  // Wire slimming (WI-5412): the ranked humanQueue items each carry a ~1KB
  // `rank` breakdown + `impact` struct that NO Learning-tab consumer renders —
  // across ~380 items that was ~65% of a 479KB payload. The ORDER the ranker
  // produced is preserved; the per-feature "why" stays on the
  // improvements:digest tool for consumers that want it.
  const humanQueue = digest.humanQueue.map((item) => {
    const { impact: _impact, rank: _rank, ...slim } = item as typeof item & {
      impact?: unknown;
      rank?: unknown;
    };
    return slim;
  });
  return [{ ...digest, humanQueue, flow }];
}
