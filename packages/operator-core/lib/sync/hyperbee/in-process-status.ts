/**
 * in-process-status — non-HTTP composer for substrate status.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Mirrors the shape of GET /api/admin/dogfood-substrate-status +
 * /dogfood-substrate-health for callers that already live inside the
 * operator process. Useful for:
 *
 *   - Long-running daemons that want substrate health without going
 *     back through the HTTP loopback.
 *   - Test harnesses that fake the in-process trackers and want the
 *     same shape the JSON endpoint returns.
 *   - CLIs / scripts launched in the same Node process (rare; the
 *     HTTP path is preferred for spawnable scripts).
 *
 * Pure logic — composes listBootedHandles + listBootstrapProgress +
 * assessHarnessSubstrateHealth + summariseWorkspaceSubstrate. No PG,
 * no FS, no fetch. Tests can swap the underlying trackers via the
 * existing `_setHandleForTests` / `_setNowForTests` seams.
 */

import { listBootedHandles } from './boot-all';
import { listBootstrapProgress } from './bootstrap-progress';
import {
  assessHarnessSubstrateHealth,
  type SubstrateHealthVerdict,
} from './health';
import {
  summariseWorkspaceSubstrate,
  type WorkspaceSubstrateSummary,
} from './summary';
import { collectSubstrateLogStats, type HarnessLogStats } from './log-stats';

export interface InProcessHarnessHealth {
  workspaceId: string;
  harnessSlug: string;
  verdict: SubstrateHealthVerdict;
  reasons: string[];
}

export interface InProcessSubstrateStatus {
  /**
   * Whether the substrate is active. At runtime this is ALWAYS `true` — the
   * Model B substrate always boots (the PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE
   * opt-in gate was removed in Stage 4d). This is NOT a feature gate; it is
   * `false` ONLY when a test forces the disabled-rendering path via
   * `forceDisabledForTest`. Treat it as "substrate active", not "flag on".
   */
  substrateActive: boolean;
  bootedCount: number;
  summary: WorkspaceSubstrateSummary;
  harnesses: InProcessHarnessHealth[];
  /**
   * Per-harness log-growth + new-joiner replay-cost (substrate-peer-log-compaction
   * P-001/P-002). Surfaces the unbounded-growth signal P-009 flagged: `replayCostOps`
   * is what a fresh joiner folds; a future compaction must shrink it. Empty when no
   * harness is booted.
   */
  logStats: HarnessLogStats[];
}

export interface GetInProcessStatusOpts {
  /**
   * TEST SEAM ONLY — not a real gate. The Model B substrate always boots
   * (the PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE opt-in gate was removed in
   * Stage 4d), so production NEVER sets this. Tests pass `true` to exercise
   * the disabled-rendering path (`substrateActive: false`).
   */
  forceDisabledForTest?: boolean;
  /**
   * Per-harness claim stats fetcher — defaulted to a zero-stats
   * shape because the in-process path doesn't have PG and we don't
   * want to drag a PG dep in here. Production callers can pass a
   * resolver that hits `loadClaimAttemptStats`.
   */
  resolveClaimStats?: (
    workspaceId: string,
    harnessSlug: string,
  ) => { total: number; won: number; lost: number; error: number };
}

const ZERO_STATS = { total: 0, won: 0, lost: 0, error: 0 } as const;

export function getInProcessSubstrateStatus(
  opts: GetInProcessStatusOpts = {},
): InProcessSubstrateStatus {
  // Stage 4d: the substrate always boots; `substrateActive` is constant true
  // at runtime. `forceDisabledForTest` is a TEST-ONLY seam for exercising the
  // disabled-rendering path — production never passes it.
  const substrateActive = !opts.forceDisabledForTest;
  const booted = listBootedHandles();
  const progress = listBootstrapProgress();
  const progressByKey = new Map<
    string,
    ReturnType<typeof listBootstrapProgress>[number]
  >();
  for (const p of progress) {
    progressByKey.set(`${p.workspaceId}::${p.harnessSlug}`, p);
  }
  const resolveStats = opts.resolveClaimStats ?? (() => ZERO_STATS);

  const harnesses: InProcessHarnessHealth[] = booted.map((h) => {
    const stats = resolveStats(h.workspaceId, h.harnessSlug);
    const bp = progressByKey.get(`${h.workspaceId}::${h.harnessSlug}`);
    const { verdict, reasons } = assessHarnessSubstrateHealth({
      // health.ts's `flagEnabled` is its real "is the substrate active" input
      // (drives the 'disabled' verdict); feed it `substrateActive`.
      flagEnabled: substrateActive,
      handlePresent: true,
      claimStats: stats,
      bootstrapProgress: bp ?? null,
    });
    return {
      workspaceId: h.workspaceId,
      harnessSlug: h.harnessSlug,
      verdict,
      reasons,
    };
  });

  const summary = summariseWorkspaceSubstrate(substrateActive, harnesses);

  return {
    substrateActive,
    bootedCount: booted.length,
    summary,
    harnesses,
    // P-001/P-002: read-only per-harness log-growth + replay-cost snapshot.
    logStats: collectSubstrateLogStats(),
  };
}
