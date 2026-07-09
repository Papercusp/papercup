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

import nodeCluster from 'node:cluster';
import { listBootedHandles, type BootedHandleSummary } from './boot-all';
import type { RemoteBootedHandlesSnapshot } from './cluster-booted-handles-sync';
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
import {
  getReplicationLiveness,
  type HarnessReplicationLiveness,
} from './replication-liveness';
import { getOwnLogForkState, type OwnLogForkState } from './own-log-fork-guard';

export interface InProcessHarnessHealth {
  workspaceId: string;
  harnessSlug: string;
  verdict: SubstrateHealthVerdict;
  reasons: string[];
  /**
   * EI-1618: substrate-outbox DRAIN stats for this harness. `undrainedCount` =
   * rows with `drained_at IS NULL`; `oldestUndrainedAgeMs` = age of the oldest
   * (null when none / not measured). A non-trivial stalled value is the
   * silent-stall (EI-681) signal that boot-health alone hides.
   */
  drain: { undrainedCount: number; oldestUndrainedAgeMs: number | null };
  /**
   * P-003 (own-log-fork-guard, WI-3535): does this harness's own writable log
   * currently sit in the (non-self-healing) fork/equivocation-loop state?
   * Also feeds the health verdict (`forked:true` ⇒ 'unhealthy').
   */
  ownLogFork: OwnLogForkState;
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
   * EI-8816: was this read able to reach the substrate-owning process's actual boot
   * state? `true` when this process IS the owner (the primary, or single-process mode)
   * OR a genuine cluster worker had a fresh cached broadcast from the primary. `false`
   * means the read is a BLIND SPOT, not a true "nothing booted" — a worker with no (or
   * a stale) cached snapshot. Distinguishes the EI-8816 blind spot from the legitimate
   * idle-ground-state `bootedCount: 0`; callers should surface this explicitly rather
   * than let a `false` render identically to a genuinely-empty substrate.
   */
  reachedSubstrateOwner: boolean;
  /**
   * Per-harness log-growth + new-joiner replay-cost (substrate-peer-log-compaction
   * P-001/P-002). Surfaces the unbounded-growth signal P-009 flagged: `replayCostOps`
   * is what a fresh joiner folds; a future compaction must shrink it. Empty when no
   * harness is booted.
   */
  logStats: HarnessLogStats[];
  /**
   * P-004 (WI-1840, WI-183 class): per-harness replication-liveness snapshot —
   * per admitted remote log, is replication actually ALIVE (replicator attached
   * + ingest progressing), or connected-but-dead (`no_replicator` / `frozen`)?
   * Also feeds each harness's health verdict (any stalled log ⇒ 'unhealthy').
   * Empty when nothing is tracked (no remote logs sampled yet). NB: registry is
   * process-local — under SUBSTRATE_SIDECAR mode the authoritative copy lives in
   * the sidecar (read it via the `getReplicationLiveness` RPC method there).
   */
  replicationLiveness: HarnessReplicationLiveness[];
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
  /**
   * EI-1618 — per-harness substrate-outbox drain stats fetcher. Defaulted to
   * zero because this module is pure (no PG). Production callers (e.g. the
   * federation-status route) pass a resolver that queries `substrate_outbox`:
   *   undrainedCount = COUNT(*) WHERE drained_at IS NULL (for the scope),
   *   oldestUndrainedAgeMs = now - MIN(ts) of those rows (null if none). NB the
   *   capture-time column is `ts` (epoch-ms bigint), NOT `captured_ts`/`created_ts`
   *   (verified vs 000-baseline.sql; see load-drain-stats.ts).
   * This is what flips a stuck (captured-but-not-federating) harness off "healthy".
   */
  resolveDrainStats?: (
    workspaceId: string,
    harnessSlug: string,
  ) => { undrainedCount: number; oldestUndrainedAgeMs: number | null };
  /**
   * WI-899 (A): resolve SUBSTRATE_SIDECAR process liveness — `true`/`false` when
   * measured (sidecar mode is on), `null`/`undefined` when not applicable (sidecar
   * mode off, or the caller hasn't wired a resolver). Defaulted to a no-op (`null`)
   * because this module is pure (no IPC); production callers (e.g. the
   * dogfood-substrate-status/-health routes) pass a resolver backed by
   * `probeSubstrateSidecar` (service-health.ts) — see the route wiring for the
   * "handlePresent hardcoded true even for a dead sidecar" bug this closes.
   */
  resolveSidecarLive?: () => boolean | null;
  /**
   * EI-8816 — resolve the primary's latest CACHED booted-handles broadcast (see
   * `cluster-booted-handles-sync.ts`'s `getCachedRemoteBootedHandles`). Only consulted
   * when this process is NOT the substrate owner (a genuine forked cluster worker);
   * defaulted to a no-op (`undefined` ⇒ always `null`) because this module is pure (no
   * IPC). Production callers (dogfood-substrate-status/-health) pass the real cache reader.
   */
  resolveRemoteBootedHandles?: () => RemoteBootedHandlesSnapshot | null;
  /**
   * TEST SEAM ONLY — overrides the real `node:cluster`-derived "is this process the
   * substrate owner" check (`nodeCluster.isPrimary`: true for the primary AND for
   * single-process/non-clustered hosts; false only inside a genuine forked worker).
   * Production never sets this.
   */
  isSubstrateOwnerProcessForTest?: boolean;
}

const ZERO_STATS = { total: 0, won: 0, lost: 0, error: 0 } as const;
const ZERO_DRAIN = { undrainedCount: 0, oldestUndrainedAgeMs: null } as const;
/** How stale a cached remote broadcast may be before a worker stops trusting it (3x the
 *  broadcaster's default 5s interval — generous for one missed beat, not so generous that
 *  a wedged/dead primary keeps rendering as "reached" for minutes). */
const DEFAULT_REMOTE_BOOTED_HANDLES_MAX_AGE_MS = 15_000;

/**
 * EI-8816: decide which booted-handles list this read should trust, and whether the
 * read actually reached the substrate-owning process's real state.
 *
 *   - This process IS the owner (primary, or single-process mode — `nodeCluster.isPrimary`)
 *     ⇒ trust `local` directly; it's a direct read of the same process-local map the
 *     substrate boot itself populated. Always `reachedSubstrateOwner: true`, INCLUDING a
 *     legitimate zero-booted idle state (nothing has booted yet) — that is real data, not
 *     a blind spot.
 *   - This process is a genuine forked WORKER (never boots anything itself, so `local` is
 *     always `[]`) ⇒ fall back to the cached broadcast from the primary, if one exists and
 *     is fresh (`now - receivedAt <= maxAgeMs`). Stale/missing ⇒ `reachedSubstrateOwner: false`
 *     with an empty list — an explicit blind-spot marker, never silently identical to
 *     "nothing booted".
 *
 * Pure + exported for direct unit testing without mocking `node:cluster`.
 */
export function resolveEffectiveBootedHandles(
  local: BootedHandleSummary[],
  opts: {
    isSubstrateOwnerProcess: boolean;
    resolveRemote?: () => RemoteBootedHandlesSnapshot | null;
    now?: number;
    maxAgeMs?: number;
  },
): { booted: BootedHandleSummary[]; reachedSubstrateOwner: boolean } {
  if (opts.isSubstrateOwnerProcess) {
    return { booted: local, reachedSubstrateOwner: true };
  }
  const remote = opts.resolveRemote?.() ?? null;
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_REMOTE_BOOTED_HANDLES_MAX_AGE_MS;
  if (remote && now - remote.receivedAt <= maxAgeMs) {
    return { booted: remote.handles, reachedSubstrateOwner: true };
  }
  return { booted: [], reachedSubstrateOwner: false };
}

export function getInProcessSubstrateStatus(
  opts: GetInProcessStatusOpts = {},
): InProcessSubstrateStatus {
  // Stage 4d: the substrate always boots; `substrateActive` is constant true
  // at runtime. `forceDisabledForTest` is a TEST-ONLY seam for exercising the
  // disabled-rendering path — production never passes it.
  const substrateActive = !opts.forceDisabledForTest;
  const isSubstrateOwnerProcess = opts.isSubstrateOwnerProcessForTest ?? nodeCluster.isPrimary;
  const { booted, reachedSubstrateOwner } = resolveEffectiveBootedHandles(listBootedHandles(), {
    isSubstrateOwnerProcess,
    resolveRemote: opts.resolveRemoteBootedHandles,
  });
  const progress = listBootstrapProgress();
  const progressByKey = new Map<
    string,
    ReturnType<typeof listBootstrapProgress>[number]
  >();
  for (const p of progress) {
    progressByKey.set(`${p.workspaceId}::${p.harnessSlug}`, p);
  }
  const resolveStats = opts.resolveClaimStats ?? (() => ZERO_STATS);
  const resolveDrain = opts.resolveDrainStats ?? (() => ZERO_DRAIN);
  const resolveSidecarLive = opts.resolveSidecarLive ?? (() => null);
  // WI-899 (A): resolved ONCE per call (process-wide, not per-harness — see the
  // opt's doc comment) rather than re-probing per booted harness.
  const sidecarLive = resolveSidecarLive();
  // P-004 (WI-1840): read-time replication-liveness snapshot, resolved once and
  // joined per-harness below (feeds the health verdict + the status payload).
  const replicationLiveness = getReplicationLiveness();
  const livenessByKey = new Map<string, HarnessReplicationLiveness>();
  for (const l of replicationLiveness) {
    livenessByKey.set(`${l.workspaceId}::${l.harnessSlug}`, l);
  }

  const harnesses: InProcessHarnessHealth[] = booted.map((h) => {
    const stats = resolveStats(h.workspaceId, h.harnessSlug);
    const drain = resolveDrain(h.workspaceId, h.harnessSlug);
    const bp = progressByKey.get(`${h.workspaceId}::${h.harnessSlug}`);
    const ownLogFork = getOwnLogForkState(h.workspaceId, h.harnessSlug);
    const { verdict, reasons } = assessHarnessSubstrateHealth({
      // health.ts's `flagEnabled` is its real "is the substrate active" input
      // (drives the 'disabled' verdict); feed it `substrateActive`.
      flagEnabled: substrateActive,
      // WI-899 (A): this is a KNOWN LIE when the sidecar is dead — `listBootedHandles()`
      // still returns the boot-time proxy regardless. `sidecarLive: false` below is what
      // actually catches that case (forces `unhealthy` overriding this `true`).
      handlePresent: true,
      claimStats: stats,
      bootstrapProgress: bp ?? null,
      // EI-1618: a stalled outbox flips the verdict off 'healthy'.
      drainStats: drain,
      // P-004 (WI-1840): connected-but-dead replication flips to 'unhealthy'.
      replicationLiveness: (() => {
        const l = livenessByKey.get(`${h.workspaceId}::${h.harnessSlug}`);
        return l
          ? {
              noReplicator: l.counts.noReplicator,
              frozen: l.counts.frozen,
              samplingStale: l.counts.samplingStale,
            }
          : undefined;
      })(),
      // P-003 (WI-3535): a forked own-log flips to 'unhealthy' — local writes blocked.
      ownLogFork: ownLogFork.forked ? { forked: true, detail: ownLogFork.detail ?? undefined } : undefined,
      // WI-899 (A): a confirmed-dead sidecar overrides everything above.
      sidecarLive,
    });
    return {
      workspaceId: h.workspaceId,
      harnessSlug: h.harnessSlug,
      verdict,
      reasons,
      drain,
      ownLogFork,
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
    // P-004 (WI-1840): per-log replication-liveness verdicts.
    replicationLiveness,
    // EI-8816: explicit blind-spot marker — see resolveEffectiveBootedHandles above.
    reachedSubstrateOwner,
  };
}
