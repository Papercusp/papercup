/**
 * watchdog.ts — the HARD feed-in of the self-improvement loop
 * (close-the-self-improvement-loop-2026-06-05, D-003).
 *
 * Before this, the capture feed was agent-discretion only (the SU-prompt nudge +
 * the scheduled scan agent) — the backlog filled only when an agent remembered to
 * file. The watchdog fills it from SIGNALS: on a cadence it sweeps the operator's
 * own telemetry for things that are observably broken and auto-captures each as a
 * `kind=bug` improvement through the SAME `captureImprovement` core the tool uses
 * (so search-first dedup + the topic tagging + the kind column all hold).
 *
 * v1 signal sources (each one is a real "something is RED" surface that already
 * exists — no new instrumentation):
 *   - **red-test**            — `harness_shared.test_runs`: a test file that
 *                               failed repeatedly in the window AND is still
 *                               failing on its latest run (not a one-off dev red).
 *                               Carries the file path → feeds the protected-path gate.
 *   - **smoke-fail**          — `harness_shared.harness_smoke_test` rows with
 *                               status='fail' (the same signal plans:attention surfaces).
 *   - **repeated-tool-error** — `harness_shared.tool_invocations`: one tool
 *                               erroring/timing out ≥ threshold times in the window.
 *   - **service-down**        — the service-health monitor's last probe results
 *                               (a watched dev endpoint currently DOWN).
 *
 * Anti-flood (the plan's over-capture risk): `planWatchdogCaptures` is pure and
 * caps captures per tick (severity-ranked); cross-tick/cross-history dedup rides
 * the capture core's search-first with `dedupScope:'open'` (an OPEN duplicate
 * declines the re-file; a RESOLVED one means the problem regressed → re-file).
 */

import postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { lastServiceHealth, lastServiceHealthAt, probeAll, type ProbeResult } from '../../service-health';
import { STALE_PLAN_CLAIM_GRACE_MS } from '../../plan-items/stale-claims';
import { checkMigrationDrift } from '../../migration-drift';
import { findIssuesByWatchdogKeys } from '../../issues-engineer';
import { captureImprovement, type CaptureImprovementResult, type ImprovementKind } from './capture-core';
import { effectiveOrigin, type SignalOrigin } from './provenance';
import {
  processKnownOpenAging,
  agingOptionsFromTick,
  type KnownOpenAgingOutcome,
  type KnownOpenAgingTickTunables,
} from './known-open-aging';
import { processAutoClose as runAutoCloseSweep, type AutoCloseOutcome } from './auto-close';
import {
  classifyToolError,
  toolErrorSignalKey,
  toolErrorClassSqlCase,
  toolErrorFingerprintSqlCase,
  type ToolErrorClass,
} from './tool-error-classifier';
import type { ImprovementSeverity } from './policy';
import type { LearningSloOptions } from './learning-slo';

export type WatchdogSource =
  | 'red-test' | 'smoke-fail' | 'repeated-tool-error' | 'service-down'
  // P-010 blind-source collectors (watchdog-robustness):
  | 'migration-drift' | 'routine-failure' | 'stuck-plan' | 'failed-spawn' | 'expired-lease' | 'unresolved-escalation'
  // a role fire-path in error-backoff (autoloop_state.consecutive_errors):
  | 'fire-circuit-open'
  // an engine LOOP (loop:arm) parked at 'infinity' far past its fire with NO completion
  // marker + no session activity — its wake turn likely died silently (e.g. a 429 during a
  // rate-limit storm) and only the ≥30min stuck-park backstop will recover it. The early,
  // visible signal for the loop-wake-rate-limit-robustness class (P1b — agent-insights/
  // loop-wake-turn-deaths-recorded-as-delivered):
  | 'loop-stalled'
  // an ACTIVE agent-insight runbook citing repo files that no longer exist
  // (learning-system-audit P-051 — insight-staleness.ts):
  | 'insight-staleness'
  // hive-loop invariant monitors (hive-loop-e2e-testing-2026-06-10 P-010):
  | 'stalled-feature' | 'orphaned-spawn' | 'escalation-spike'
  // agent-activity-liveness-truth-2026-06-21 P-007 (D-001/D-004, folds EI-2311):
  // a work-item CLAIM held by a LIVE holder that has made NO item-scoped progress
  // for far past the window (fleet_assignment.stalled). The LOUD recurrence guard
  // for the incident — a claim is not progress; this fires even while the
  // RECLAIM_STALLED reconciler leg is dark, so stalled work is never silently
  // "covered". Distinct from stalled-feature (an UNCLAIMED dispatchable feature
  // sitting idle) and orphaned-spawn (a DEAD nursery row): this is a live holder
  // not advancing its claim.
  | 'stalled-claim'
  // the spawn-admission ceiling is consumed by rows that aren't actually
  // streaming — stale debits jamming `maxSimultaneousAgents` so NO bee can be
  // placed even though ~nothing is alive (EI-2186 — host-restart class). The
  // orphaned-spawn collector misses this because the jammed rows can carry a
  // FRESH heartbeat (a reused-pid false-alive bump); this reads stream activity
  // (last_output_at), which a dead process cannot fake:
  | 'spawn-ceiling-jam'
  // links 5–6 flow assertion (hive-loop-e2e-testing-2026-06-10 P-011 — ship-link.ts):
  | 'ship-link-stuck'
  // an auto-implement dispatch whose worker died without ever calling
  // improvements:resolve (consume-edges P-011 — orphaned-dispatch.ts):
  | 'orphaned-dispatch'
  // the auto-implement DISPATCHER itself has stopped firing while armed work
  // waits — `lastDispatchAt` stale despite an eligible queue (EI-2150 —
  // dispatcher-staleness.ts). The orphaned-dispatch collector only sees DEAD
  // WORKERS on open rows; this sees NO dispatches at all:
  | 'dispatcher-staleness'
  // learning-system SLO sensors (self-learning-frontier P-047 / FB-21 —
  // learning-slo.ts; flag-gated dark per D-001 until the P-001 arming gate):
  | 'triage-entropy' | 'capture-consume-imbalance' | 'mttsh-regression'
  | 'governor-starvation' | 'memory-zero-hit'
  // the perf/reliability REGRESSION RIG (infra-perf-reliability-audit-round4 P-013 —
  // system-health/perf-regression-rig.ts; flag-gated on papercusp-perf-regression-rig,
  // DEFAULT ON). Snapshots four reliability SLO metrics (event-loop-lag p95, PG
  // connection saturation %, the dispatch-orphan rate that silently regressed to 91%,
  // the coord open-escalation backlog) to harness_shared.perf_regression_snapshots and
  // FILES on a budget breach so the round-2/3/4 perf gains can't silently regress:
  | 'perf-regression'
  // the routines ENGINE itself is dead — every active routine overdue at once
  // (the 06-12 DBOS incident class). Detected OUT-OF-BAND by lib/red-queen/
  // engine-death.ts (P-031 / FB-20) since the watchdog rides the engine it
  // would be watching:
  | 'routine-engine-death'
  // a STARTED+eligible plan with open plan-items but ZERO work-items — plan→work-item
  // promotion silently stopped producing placeable work (the recurrence guard for the
  // unified-work-item-ledger P-003 silent-zero class; detector zero-promotion-detect.ts,
  // gated by papercusp-plan-workitem-promotion so it is inert while promotion is dark):
  | 'zero-promotion'
  // a feature work-item marked DONE (terminal/passed) that still carries requires_test
  // VAL(s) with NO passing covering test — the "claimed done, no framework test"
  // recurrence (enforce-system-on-generic-work P-009; detector done-without-test-detect.ts).
  // Naturally inert where the inline-VAL flow is dark (no requires_test assertions ⇒
  // nothing to flag), so it needs no flag gate. Per-harness: count = flagged items:
  | 'done-without-test';

export interface WatchdogSignal {
  source: WatchdogSource;
  /** Stable per-signal identity within a tick (dedup key). */
  key: string;
  /** STABLE capture title — no counts/timestamps, so search-first dedup matches across ticks. */
  title: string;
  /** Detail: counts, samples, timestamps live here, not in the title. */
  body: string;
  severity: ImprovementSeverity;
  /**
   * Improvement kind to file this as (P-008 / D-009). Default 'bug'. A caller/DX
   * signal (a tool repeatedly rejecting caller input) files as 'change' — a
   * schema/gate refinement, not a papercusp bug.
   */
  kind?: ImprovementKind;
  /** Repo-relative paths involved, when the signal knows them (feeds the path gate). */
  paths?: string[];
  /**
   * Capture scope — 'operator' (default) or 'harness:<slug>' when the signal is
   * about one Hive. Passed through to the capture so the D-005 triage taxonomy
   * can key off it (consume-edges P-021).
   */
  scope?: string;
  /**
   * Newest evidence timestamp (ISO) backing this signal (watchdog-audit P-005 /
   * D-002). Windowed/aggregate collectors set it (red-test, tool-error,
   * failed-spawn, smoke-fail, expired-lease) so a RESOLVED duplicate re-files
   * only when the evidence post-dates the resolution. Live-state collectors
   * (service-down, migration-drift, …) omit it — their firing means the problem
   * exists NOW, so a re-file after resolve is always legitimate.
   */
  latestAt?: string;
  /**
   * Resolution cooldown (ms). When set, a signal whose key matches only RESOLVED
   * dups is suppressed (→ `staleResolved`) if the newest resolution landed within
   * this window before the signal's `latestAt`. For collectors whose SCANNED tree
   * lags the source-of-truth tree by a deploy window — insight-staleness scans the
   * release/green checkout, behind staging — so a resolve-then-still-stale re-file
   * is a deploy-lag artifact, not a regression (EI-427). Omitted by every other
   * collector (a fast resolve→refail there IS a real regression worth re-filing).
   */
  resolutionCooldownMs?: number;
  /**
   * Learning-signal provenance (frontier P-002/D-002): organic (default) | drill
   * | replay | shadow. A drill harness's collectors tag their planted frictions
   * so the capture rides the drill lane end-to-end while staying out of organic
   * learners. Key-dup matching is origin-scoped: a drill signal never reads an
   * organic open item as its duplicate, and vice versa.
   */
  origin?: SignalOrigin;
  /**
   * Machine-readable finding class (frontier P-044/D-008): a stable
   * `<family>:<shape>` slug stamped into `payload.findingClass` so the
   * graduation tracker counts clean passes per class. Collectors should set
   * it; absent, graduation falls back to `<source>:unclassified`
   * (graduation/core.ts findingClassOf).
   */
  findingClass?: string;
}

/** `${source}:${key}` — the stable cross-tick identity of a signal (P-004 / D-001). */
export function watchdogKeyOf(s: Pick<WatchdogSignal, 'source' | 'key'>): string {
  return `${s.source}:${s.key}`;
}

/**
 * Per-collector outcome for one tick (watchdog-robustness P-001). Persisted in the
 * tick record so the watchdog can detect its OWN broken collector (P-002): an
 * element with `ok:false` is a collector that threw this tick.
 */
export interface CollectorStatus {
  name: string;
  ok: boolean;
  /** Signals the collector produced (0 when it failed). */
  signalCount: number;
  /** Error message when `ok:false`. */
  error?: string;
  /** Non-error note (e.g. a deliberate skip — `service-down` on a stale snapshot, P-004). */
  note?: string;
}

/**
 * A collector may return a bare signal array OR this richer shape to carry a
 * non-error `note` (watchdog-robustness P-004 — e.g. the service-down collector
 * skipping a stale service-health snapshot). `collectWatchdogSignalsDetailed`
 * normalizes both.
 */
export interface CollectorResult {
  signals: WatchdogSignal[];
  note?: string;
}

/** One durable watchdog-tick record (watchdog-robustness P-001 / D-002). */
export interface WatchdogTickRecord {
  workspaceId: string;
  installSlug?: string | null;
  /** 'ran' = swept + captured; 'skipped' = another host held the cross-host lock (P-003). */
  status: 'ran' | 'skipped';
  signals: number;
  captured: string[];
  declinedDuplicates: number;
  deferred: number;
  /** `${source}:${key}` of each signal the anti-flood cap deferred this tick (P-009). */
  deferredKeys?: string[];
  /** Keys the P-004 pre-filter dropped as already-filed OPEN improvements (audit D-001). */
  knownOpenKeys?: string[];
  /** Keys dropped as resolved-with-stale-evidence — not regressions (audit P-005 / D-002). */
  staleResolvedKeys?: string[];
  collectors: CollectorStatus[];
  /** Improvement ids the watchdog filed ABOUT ITSELF this tick (P-002). */
  selfEscalations: string[];
}

const SEVERITY_RANK: Record<ImprovementSeverity, number> = { critical: 3, major: 2, minor: 1, nit: 0 };

export interface WatchdogPlanOptions {
  /** Max captures per tick (global anti-flood). Default 3. */
  maxPerTick?: number;
  /**
   * Max captures per SOURCE per tick (watchdog-robustness P-009 / D-010). Stops one
   * noisy source (a backlog of `major` red-tests) from monopolizing every slot and
   * starving tool-error / health / structural signals — the second half of why the
   * memory:search structural signal never landed even when it fired. Default 2.
   */
  perSourceCap?: number;
  /**
   * Keys (`${source}:${key}`) deferred on recent ticks (P-009 deferred-escalation).
   * A signal that keeps losing a slot is ranked one severity higher so a
   * persistent-but-minor signal eventually lands instead of ageing out forever.
   */
  priorDeferredKeys?: readonly string[];
}

export interface WatchdogPlan {
  toCapture: WatchdogSignal[];
  /** Signals dropped by the per-tick cap (still visible next tick if they persist). */
  deferred: WatchdogSignal[];
}

/**
 * Pure (close-loop D-003 + watchdog-robustness P-009 / D-010): dedupe, then admit
 * captures under TWO bounds so no single source starves the rest:
 *   1. PER-SOURCE cap (default 2) — a flood of `major` red-tests can take at most
 *      `perSourceCap` slots, leaving room for tool-error / health / structural signals.
 *   2. global `maxPerTick` cap (default 3) — the overall ceiling; any budget left
 *      after the per-source pass is filled from the leftover by rank (never wasted).
 * Deferred-escalation: a signal whose key was deferred on a recent tick
 * (`priorDeferredKeys`) ranks one severity higher, so a persistent-but-minor signal
 * climbs and eventually lands instead of being starved every tick.
 */
export function planWatchdogCaptures(signals: WatchdogSignal[], opts: WatchdogPlanOptions = {}): WatchdogPlan {
  const maxPerTick = Math.max(0, opts.maxPerTick ?? 3);
  const perSourceCap = Math.max(1, opts.perSourceCap ?? 2);
  const deferredSet = new Set(opts.priorDeferredKeys ?? []);

  // Dedupe by source:key.
  const seen = new Set<string>();
  const unique: WatchdogSignal[] = [];
  for (const s of signals) {
    const k = `${s.source}:${s.key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(s);
  }

  // Effective rank = severity, +1 if this key was recently deferred (P-009 escalation).
  const rankOf = (s: WatchdogSignal): number =>
    SEVERITY_RANK[s.severity] + (deferredSet.has(`${s.source}:${s.key}`) ? 1 : 0);
  const byRankDesc = (a: WatchdogSignal, b: WatchdogSignal): number => {
    const d = rankOf(b) - rankOf(a);
    if (d !== 0) return d;
    // Tie → a recently-deferred signal goes first (it has waited longest).
    const ad = deferredSet.has(`${a.source}:${a.key}`) ? 1 : 0;
    const bd = deferredSet.has(`${b.source}:${b.key}`) ? 1 : 0;
    return bd - ad;
  };

  // Pass 1 — per-source cap (highest-ranked first; a noisy source can't take >cap).
  const perSourceCount = new Map<WatchdogSource, number>();
  const admitted: WatchdogSignal[] = [];
  const leftover: WatchdogSignal[] = [];
  for (const s of [...unique].sort(byRankDesc)) {
    const used = perSourceCount.get(s.source) ?? 0;
    if (used < perSourceCap && admitted.length < maxPerTick) {
      perSourceCount.set(s.source, used + 1);
      admitted.push(s);
    } else {
      leftover.push(s);
    }
  }
  // Pass 2 — fill any remaining global budget from leftover by rank (don't waste it).
  for (const s of leftover.sort(byRankDesc)) {
    if (admitted.length >= maxPerTick) break;
    admitted.push(s);
  }

  const admittedSet = new Set(admitted);
  const deferred = unique.filter((s) => !admittedSet.has(s));
  return { toCapture: admitted, deferred };
}

// ── P-004/P-005 key-based pre-filter (watchdog-audit-2026-06-09) ─────────────

/** An existing improvement matched by `payload.watchdogKey` (the dedup feed). */
export interface WatchdogKeyDup {
  watchdogKey: string;
  state: string;
  /** ISO `updated_at` — for a resolved item, the resolution recency bound (D-002). */
  updatedAt: string;
  /** The item's signal_origin (frontier P-002) — dup matching is origin-scoped.
   *  Absent = organic (legacy rows / pre-column readers). */
  signalOrigin?: string;
}

/** The pre-filter's split of collected signals (P-004 / D-001 + P-005 / D-002). */
export interface SignalPartition {
  /** No matching key on file → genuinely new, goes to planning. */
  fresh: WatchdogSignal[];
  /** Key matches an OPEN improvement → standing, already filed. Never consumes budget. */
  knownOpen: WatchdogSignal[];
  /**
   * Key matches only RESOLVED improvements AND the signal's newest evidence
   * pre-dates the resolution → stale lookback-window evidence, not a regression.
   */
  staleResolved: WatchdogSignal[];
}

/**
 * Pure (P-004 / D-001 + P-005 / D-002): split collected signals against the
 * existing improvements that carry their `watchdogKey`:
 *   - an OPEN match → `knownOpen` (already filed; do not burn a capture slot);
 *   - only RESOLVED matches + `latestAt` <= the newest resolution `updatedAt`
 *     → `staleResolved` (pre-fix window evidence, not a regression);
 *   - only RESOLVED matches + the signal opted into `resolutionCooldownMs` and
 *     the newest resolution is within that window before `latestAt`
 *     → `staleResolved` (fix landed, still propagating — EI-427 deploy lag);
 *   - otherwise → `fresh` (genuinely new, or a real regression with fresh
 *     evidence — including a live-state signal with no `latestAt`, whose firing
 *     means the problem exists NOW).
 * Unparseable timestamps fail open (fresh): a phantom re-file beats a
 * suppressed real regression.
 */
export function partitionSignalsByKnownKeys(signals: WatchdogSignal[], dups: WatchdogKeyDup[]): SignalPartition {
  const byKey = new Map<string, WatchdogKeyDup[]>();
  for (const d of dups) {
    const list = byKey.get(d.watchdogKey);
    if (list) list.push(d);
    else byKey.set(d.watchdogKey, [d]);
  }
  const out: SignalPartition = { fresh: [], knownOpen: [], staleResolved: [] };
  for (const s of signals) {
    // Origin-scoped matching (frontier P-002/D-002): a dup only counts when its
    // signal_origin matches the signal's — an organic open item must not absorb
    // a drill signal (the drill would silently never file), nor a drill row an
    // organic signal (a synthetic row suppressing a real one).
    const matches = (byKey.get(watchdogKeyOf(s)) ?? []).filter(
      (m) => effectiveOrigin(m.signalOrigin) === effectiveOrigin(s.origin),
    );
    if (matches.some((m) => m.state === 'open')) {
      out.knownOpen.push(s);
      continue;
    }
    if (matches.length > 0 && s.latestAt) {
      const evidenceMs = Date.parse(s.latestAt);
      const newestResolutionMs = Math.max(...matches.map((m) => Date.parse(m.updatedAt)));
      if (Number.isFinite(evidenceMs) && Number.isFinite(newestResolutionMs)) {
        // (a) evidence pre-dates the resolution → stale lookback-window evidence.
        const evidencePreResolution = newestResolutionMs >= evidenceMs;
        // (b) resolution cooldown (EI-427): the fix resolved within the cooldown
        //     BEFORE this scan → suppress the re-file and let it propagate. Only
        //     for collectors that opt in via `resolutionCooldownMs` (the scanned
        //     tree lags the source-of-truth tree by a deploy window).
        const sinceResolutionMs = evidenceMs - newestResolutionMs;
        const withinCooldown =
          s.resolutionCooldownMs != null &&
          sinceResolutionMs >= 0 &&
          sinceResolutionMs <= s.resolutionCooldownMs;
        if (evidencePreResolution || withinCooldown) {
          out.staleResolved.push(s);
          continue;
        }
      }
    }
    out.fresh.push(s);
  }
  return out;
}

/**
 * Default key-dup reader: one indexed lookup over `payload.watchdogKey`
 * (engineer_issues_watchdog_key_idx). Injectable via `WatchdogDeps`.
 */
export async function readWatchdogKeyDups(keys: string[]): Promise<WatchdogKeyDup[]> {
  if (keys.length === 0) return [];
  const issues = await findIssuesByWatchdogKeys(keys);
  return issues.map((i) => ({
    watchdogKey: String((i.payload as Record<string, unknown> | null)?.watchdogKey ?? ''),
    state: i.state,
    updatedAt: i.updatedAt,
    signalOrigin: i.signalOrigin,
  }));
}

// ── signal collectors (IO) ───────────────────────────────────────────────────

/**
 * Collector bars + windows for one tick. Extends the FB-21 learning-SLO
 * tunables (learning-slo.ts LEARNING_SLO_DEFAULTS) so the five SLO sensors
 * tune from the same routine payload as every other collector.
 */
export interface CollectOptions extends LearningSloOptions {
  /** Lookback for the red-test sweep. Default 6h. */
  redTestWindowHours?: number;
  /** Minimum fail count in the window (and the latest run must be a fail). Default 3. */
  redTestMinFails?: number;
  /** Lookback for the repeated-tool-error CLASS sweep (P-008 / D-009). Default 24h. */
  toolErrorWindowHours?: number;
  /** Structural tool-error fires at this many occurrences in the window. Default 2 (deterministic bugs recur identically — few = real). */
  structuralMinCount?: number;
  /** Structural tool-error: OR fire when error-rate ≥ this over ≥ structuralMinCallsForRate calls. Default 0.5. */
  structuralMinRate?: number;
  /** Min calls before the structural error-RATE test applies. Default 3. */
  structuralMinCallsForRate?: number;
  /** Transient tool-error (timeout/load) volume bar. Default 15 (raised — timeouts are noisy). */
  transientMinCount?: number;
  /** Caller/DX tool-error (invalid_args / role-denied) sustained-pattern bar. Default 10. */
  callerMinCount?: number;
  /** External-rate-limit tool-error (provider 429 / TPM) volume bar. Default 8 — sustained, not a one-off spike (P-002). */
  rateLimitMinCount?: number;
  /** External-rate-limit fires MAJOR (vs minor) at this many occurrences in the window. Default 30. */
  rateLimitMajorCount?: number;
  /** Max age of the service-health snapshot to trust for service-down (P-004). Default 2× the 60s probe interval. */
  serviceHealthMaxStaleMs?: number;
  /** smoke-fail recency gate (audit P-007): only a failure recorded within this many hours fires. Default 48. */
  smokeFailRecentHours?: number;
  /** expired-lease recency window (audit P-006): count only leases expired within this many days. Default 7. */
  expiredLeaseWindowDays?: number;
  /** expired-lease fire threshold. Default 15. */
  expiredLeaseMinCount?: number;
  /** expired-lease grace (EI-530): only count claims lapsed > this long, matching the
   *  reclaim sweep's grace — so a claim the sweep hasn't yet had a chance to reap
   *  isn't double-reported as abandoned. Default STALE_PLAN_CLAIM_GRACE_MS (10 min). */
  expiredLeaseGraceMs?: number;
  /** failed-spawn lookback window. Default 6h. */
  failedSpawnWindowHours?: number;
  /** failed-spawn fire threshold (total failures in the window). Default 5. */
  failedSpawnMinCount?: number;
  /** stalled-feature: a dispatchable feature untouched this long fires. Default 12h. */
  stalledFeatureHours?: number;
  /** orphaned-spawn: a running row this much past the reclaim threshold fires. Default 15min (3× RECLAIM_STALE_MS). */
  orphanedSpawnStaleMinutes?: number;
  /** stalled-claim: a work-item claim held by a LIVE holder with no item-scoped progress
   *  for this long fires (agent-activity-liveness-truth P-007). Default 30min — well past
   *  the 10-min view `stalled` threshold, so only genuinely-stuck (not just-crossed) claims
   *  raise the loud signal. */
  stalledClaimMinutes?: number;
  /** spawn-ceiling-jam: a running row older than this with NO recent stream output counts as a
   *  suspected stale debit (EI-2186). Gives the "for > N minutes" semantics. Default 15min. */
  ceilingJamMinAgeMinutes?: number;
  /** spawn-ceiling-jam: a running row whose last_output_at is within this window is treated as
   *  genuinely live (a dead process cannot advance stream output). Default 15min. */
  ceilingJamSilentMinutes?: number;
  /** spawn-ceiling-jam: tolerate up to this many old, non-streaming rows before firing — absorbs
   *  a couple of legitimately quiet bees. Default 2. */
  ceilingJamSlack?: number;
  /** escalation-spike lookback window. Default 6h. */
  escalationSpikeWindowHours?: number;
  /** escalation-spike fire threshold (escalations in the window). Default 3. */
  escalationSpikeMinCount?: number;
  /** dispatcher-staleness: hours the auto-implement dispatcher may go silent (while armed
   *  work waits) before the lane is flagged stalled (EI-2150). Default 6. */
  dispatcherStalenessThresholdHours?: number;
}

type Sql = ReturnType<typeof getOrgPg>['sql'];

/**
 * Pure: normalize a `test_runs.file_path` to its REPO-RELATIVE form so one broken
 * test has ONE identity. Runs from the green-checkpoint (or any sibling
 * `papercupai-workspace/<tree>/`) checkout record prefixed paths — the same test
 * the canonical tree records as `packages/...` — which used to file DUPLICATE
 * improvements (EI-36/EI-143, EI-157/EI-163). Returns null for paths to drop
 * entirely: synthetic fixture tests (`__synthetic__`) are loop probes, not bugs.
 */
export function normalizeRedTestPath(filePath: string): string | null {
  if (filePath.includes('__synthetic__')) return null;
  return filePath.replace(/^.*papercupai-workspace\/[^/]+\//, '');
}

interface RedTestRow { file_path: string; framework: string; fails: number; sample: string | null; latest_fail_at?: string | Date | null }

/** ISO-or-undefined from a pg timestamp value (Date under postgres.js, string in tests). */
function toIsoOrUndefined(v: string | Date | null | undefined): string | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return v.toISOString();
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * Pure: red-test aggregate rows → signals, keyed by the NORMALIZED repo-relative
 * path. Rows whose paths normalize to the same test (canonical + checkpoint tree)
 * merge into one signal (fail counts summed, newest failure timestamp kept)
 * instead of two captures.
 */
export function redTestSignalsFromRows(rows: RedTestRow[], windowHours: number): WatchdogSignal[] {
  const byPath = new Map<string, RedTestRow>();
  for (const r of rows) {
    const path = normalizeRedTestPath(r.file_path);
    if (path == null) continue;
    const prev = byPath.get(path);
    if (prev) {
      prev.fails += r.fails;
      if (!prev.sample) prev.sample = r.sample;
      const a = toIsoOrUndefined(prev.latest_fail_at);
      const b = toIsoOrUndefined(r.latest_fail_at);
      prev.latest_fail_at = a && b ? (a >= b ? a : b) : (a ?? b ?? null);
    } else {
      byPath.set(path, { ...r, file_path: path });
    }
  }
  return [...byPath.values()].map((r) => ({
    source: 'red-test' as const,
    key: r.file_path,
    title: `Test failing repeatedly: ${r.file_path}`,
    body:
      `Watchdog signal (red-test): ${r.file_path} (${r.framework}) failed ${r.fails}× in the last ` +
      `${windowHours}h and its latest run is still red.\n\nLast failure tail:\n${(r.sample ?? '').slice(-1500) || '(no output captured)'}`,
    severity: 'major' as const,
    paths: [r.file_path],
    latestAt: toIsoOrUndefined(r.latest_fail_at),
  }));
}

/**
 * red-test: a test file that failed ≥ N times in the window AND whose LATEST run
 * in the window is still a fail — i.e. repeatedly red and currently red, not a
 * one-off dev iteration. Carries the file path (→ the protected-path gate).
 *
 * Workspace scoping (audit P-013): `test_runs` has NO workspace column, so this
 * collector is inherently BOX-GLOBAL — every workspace's tick sees the same
 * red tests. Acceptable on a one-box install; on a multi-workspace host the
 * cross-host tick lock + key dedup keep it to one filed item regardless.
 */
export async function collectRedTestSignals(sql: Sql, opts: CollectOptions = {}): Promise<WatchdogSignal[]> {
  const windowHours = opts.redTestWindowHours ?? 6;
  const minFails = opts.redTestMinFails ?? 3;
  const rows = await sql<RedTestRow[]>`
    WITH recent AS (
      SELECT file_path, framework, status, output_tail, started_at,
             row_number() OVER (PARTITION BY file_path ORDER BY started_at DESC) AS rn
        FROM harness_shared.test_runs
       WHERE started_at > now() - make_interval(hours => ${windowHours})
         AND status IN ('pass', 'fail', 'error')
         -- Only plausible repo paths: the test-runner's own test suites record
         -- synthetic fixture rows ('b', 'fail', 'no-such-bin') into test_runs;
         -- a real run always carries a repo-relative path with a separator.
         AND file_path LIKE '%/%'
    )
    SELECT file_path,
           max(framework) AS framework,
           count(*) FILTER (WHERE status IN ('fail', 'error'))::int AS fails,
           max(output_tail) FILTER (WHERE status IN ('fail', 'error')) AS sample,
           max(started_at) FILTER (WHERE status IN ('fail', 'error')) AS latest_fail_at
      FROM recent
     GROUP BY file_path
    HAVING count(*) FILTER (WHERE status IN ('fail', 'error')) >= ${minFails}
       AND max(CASE WHEN rn = 1 THEN status END) IN ('fail', 'error')
     LIMIT 20`;
  return redTestSignalsFromRows(rows, windowHours);
}

interface SmokeFailRow { harness_slug: string; failure_content: string | null; mtime_ms: number | string | null }

/**
 * Pure (audit P-007): smoke-fail rows → signals, RECENCY-GATED via `mtime_ms`
 * (the table has no timestamp column). Only a failure recorded within
 * `smokeFailRecentHours` (default 48h) fires — a never-re-run failing smoke from
 * weeks ago must not re-file forever. A row with NO mtime is treated as stale
 * (we cannot show the failure is current). The mtime also feeds `latestAt`
 * (P-005 regression gating).
 */
export function smokeFailSignalsFromRows(
  rows: SmokeFailRow[],
  opts: { recentHours?: number; nowMs?: number } = {},
): WatchdogSignal[] {
  const recentHours = opts.recentHours ?? 48;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoffMs = nowMs - recentHours * 3_600_000;
  const out: WatchdogSignal[] = [];
  for (const r of rows) {
    const mtime = r.mtime_ms == null ? NaN : Number(r.mtime_ms);
    if (!Number.isFinite(mtime) || mtime < cutoffMs) continue;
    out.push({
      source: 'smoke-fail' as const,
      key: r.harness_slug,
      title: `Smoke test failing in harness ${r.harness_slug}`,
      body: `Watchdog signal (smoke-fail): the ${r.harness_slug} smoke test is RED.\n\n${(r.failure_content ?? '').slice(0, 2000) || '(no failure content recorded)'}`,
      severity: 'major' as const,
      // Origin scope (P-032): a smoke fail is attributable to ONE harness.
      scope: `harness:${r.harness_slug}`,
      latestAt: new Date(mtime).toISOString(),
    });
  }
  return out;
}

/** smoke-fail: a harness smoke test currently failing (the plans:attention signal), recency-gated (P-007). */
export async function collectSmokeFailSignals(sql: Sql, workspaceId: string, opts: CollectOptions = {}): Promise<WatchdogSignal[]> {
  const rows = await sql<SmokeFailRow[]>`
    SELECT harness_slug, failure_content, mtime_ms
      FROM harness_shared.harness_smoke_test
     WHERE workspace_id = ${workspaceId}
       AND status = 'fail'
     LIMIT 20`;
  return smokeFailSignalsFromRows(rows, { recentHours: opts.smokeFailRecentHours });
}

/**
 * Tool-failure CLASS (watchdog-robustness P-008 / D-009). The collector detects
 * by CLASS, not raw count: a deterministic config bug recurs identically, so it
 * deserves a LOW bar; a transient timeout needs VOLUME to be worth filing.
 *   - structural — a real bug/misconfig (the tool itself, a missing table, a
 *     workspace-scoping gap). Fires on FEW occurrences OR a high error-rate.
 *   - transient  — timeout / load / network. Volume-gated, lower severity.
 *   - caller     — the CALLER sent bad input or lacks a role (invalid_args /
 *     role-denied). A sustained pattern = a DX/schema problem → kind=change.
 *   - rate-limit — an EXTERNAL provider rate-limit / quota (OpenAI embedding TPM,
 *     a 429, "rate limit reached"). NOT a code bug and NOT a structural defect —
 *     it's capacity. Volume-gated, kind=change, routed to infra/owner, never the
 *     auto-implement lane. (watchdog-embed-resilience-and-dedup-2026-06-17 P-002:
 *     a sustained OpenAI embed-429 used to fall through to `structural` and file
 *     as a deterministic tool bug, masked under an unrelated scoping EI.)
 */
// The ToolErrorClass type, the classifier (TS fn + the SQL CASE generator), the
// error-shape patterns, and the fingerprint helpers all moved to
// ./tool-error-classifier (watchdog-and-exposed-systems-improvement-2026-06-18
// P-011) so the TS fn and the SQL CASE are GENERATED from one ordered rule table
// and can no longer drift. `classifyToolError` + `ToolErrorClass` are re-exported
// for the existing import sites (watchdog.test.ts); the rest is imported above
// for internal use, or imported directly from the module by new callers.
export { classifyToolError, type ToolErrorClass };

interface ClassifiedToolErrorRow {
  tool_name: string;
  /** SQL alias `class`; one of ToolErrorClass. */
  class: ToolErrorClass;
  /**
   * Normalized error-shape fingerprint (P-003): SQL-computed for the `structural`
   * class only (first 6 alpha tokens of the digit/punct-stripped message), null
   * otherwise. Appended to the structural dedup key so two genuinely DIFFERENT
   * deterministic failure modes under the same tool don't collapse onto one key
   * (the 2026-06-17 embed-429-masked-by-EI-630 class of bug).
   */
  fingerprint?: string | null;
  /** Failures of this class for this tool in the window. */
  n: number;
  /** Total calls (any status) for this tool in the window — the rate denominator. */
  total: number;
  sample: string | null;
  /** Newest failure timestamp in the window (P-005 latestAt). */
  latest_at?: string | Date | null;
}

/**
 * Pure (watchdog-robustness P-006 / D-006): a tool name belonging to the
 * self-improvement loop ITSELF — the watchdog must never file a tool-error
 * capture about its own capture path (a self-amplifying loop: it would file a
 * bug about the very tool it files bugs through). The loop's own health is the
 * self-escalation's job (P-002), not a self-captured tool-error.
 */
export function isImprovementLoopTool(toolName: string): boolean {
  return /^improvements:/.test(toolName) || /^system:improvement-/.test(toolName);
}

/**
 * Pure (P-006/D-006 + P-008/D-009): per-(tool,class) aggregate rows → signals,
 * excluding the loop's own tools. Each class has its own FIRE bar + severity + kind:
 *   - structural: n ≥ structuralMinCount (2) OR (total ≥ structuralMinCallsForRate
 *     AND n/total ≥ structuralMinRate) → major, kind=bug. THIS is what catches the
 *     low-frequency structural failures the old absolute ≥5/60min threshold missed.
 *   - transient:  n ≥ transientMinCount (15) → minor (major at ≥50), kind=bug.
 *   - caller:     n ≥ callerMinCount (10) → minor, kind=change.
 */
export function toolErrorSignalsFromRows(rows: ClassifiedToolErrorRow[], opts: CollectOptions = {}): WatchdogSignal[] {
  const structuralMin = opts.structuralMinCount ?? 2;
  const structuralRate = opts.structuralMinRate ?? 0.5;
  const structuralRateCalls = opts.structuralMinCallsForRate ?? 3;
  const transientMin = opts.transientMinCount ?? 15;
  const callerMin = opts.callerMinCount ?? 10;
  const rateLimitMin = opts.rateLimitMinCount ?? 8;
  const rateLimitMajor = opts.rateLimitMajorCount ?? 30;

  const out: WatchdogSignal[] = [];
  for (const r of rows) {
    if (isImprovementLoopTool(r.tool_name)) continue;
    const rate = r.total > 0 ? r.n / r.total : 0;
    const pct = Math.round(rate * 100);
    const sample = (r.sample ?? '').slice(0, 800) || '(no message)';
    const latestAt = toIsoOrUndefined(r.latest_at);
    // The dedup key: tool:class[:fingerprint]. The fingerprint sharpens the key for
    // the FINGERPRINTED classes — structural + caller + transient (P-003 + P-012) —
    // so two genuinely DIFFERENT same-class modes under one tool don't collapse onto
    // one key and mask each other; rate-limit stays COARSE (one capacity concern).
    // toolErrorSignalKey is the single source (tool-error-classifier.ts), also used by
    // the post-deploy key-migration backfill so a migrated key matches this exactly.
    // `fp` (title display) tracks r.fingerprint, which the SQL already nulls for rate-limit.
    const fp = r.fingerprint ?? null;
    const key = toolErrorSignalKey(r.tool_name, r.class, r.fingerprint);

    if (r.class === 'structural') {
      if (!(r.n >= structuralMin || (r.total >= structuralRateCalls && rate >= structuralRate))) continue;
      out.push({
        source: 'repeated-tool-error',
        key,
        title: `Tool ${r.tool_name} returns a structural error${fp ? ` (${fp})` : ''}`,
        body:
          `Watchdog signal (structural tool-error): ${r.tool_name} returned a deterministic error ${r.n}× ` +
          `(${pct}% of ${r.total} calls) in the window — the shape that recurs identically (a bug/misconfig), ` +
          `not transient load.\n\nSample error: ${sample}`,
        severity: 'major',
        kind: 'bug',
        latestAt,
      });
    } else if (r.class === 'transient') {
      if (r.n < transientMin) continue;
      out.push({
        source: 'repeated-tool-error',
        key,
        title: `Tool ${r.tool_name} timing out repeatedly${fp ? ` (${fp})` : ''}`,
        body:
          `Watchdog signal (transient tool-error): ${r.tool_name} timed out / errored transiently ${r.n}× ` +
          `(${pct}% of ${r.total} calls) recently.\n\nSample: ${sample}`,
        severity: r.n >= 50 ? 'major' : 'minor',
        kind: 'bug',
        latestAt,
      });
    } else if (r.class === 'rate-limit') {
      // EXTERNAL provider rate-limit / quota (OpenAI embed TPM 429). Volume-gated
      // like transient; filed as kind=change (capacity / infra, not an auto-fixable
      // code bug). P-002 (watchdog-embed-resilience-and-dedup-2026-06-17).
      if (r.n < rateLimitMin) continue;
      out.push({
        source: 'repeated-tool-error',
        key,
        title: `Tool ${r.tool_name} failing on an external provider rate-limit`,
        body:
          `Watchdog signal (external rate-limit): ${r.tool_name} failed ${r.n}× ` +
          `(${pct}% of ${r.total} calls) in the window with a provider rate-limit / quota error ` +
          `(e.g. OpenAI embedding TPM saturation). This is EXTERNAL CAPACITY, not a code bug — route ` +
          `to infra/owner (a separate key/quota, throttling, or the account pool), NOT the ` +
          `auto-implement lane.\n\nSample: ${sample}`,
        severity: r.n >= rateLimitMajor ? 'major' : 'minor',
        kind: 'change',
        latestAt,
        findingClass: `external-rate-limit:${r.tool_name}`,
      });
    } else {
      if (r.n < callerMin) continue;
      out.push({
        source: 'repeated-tool-error',
        key,
        title: `Tool ${r.tool_name} repeatedly rejecting caller input${fp ? ` (${fp})` : ''}`,
        body:
          `Watchdog signal (caller/DX tool-error): ${r.tool_name} rejected caller input ${r.n}× ` +
          `(${pct}% of ${r.total} calls) — a sustained pattern suggests a confusing schema or a ` +
          `mis-scoped gate, not a tool bug.\n\nSample: ${sample}`,
        severity: 'minor',
        kind: 'change',
        latestAt,
      });
    }
  }
  return out;
}

/**
 * repeated-tool-error (P-008 / D-009): per-(tool,class) failure aggregates over a
 * 24h window, classified IN SQL (the CASE mirrors `classifyToolError`). The
 * per-class FIRE bar lives in `toolErrorSignalsFromRows` (pure + unit-tested). The
 * loop's own tools are excluded in SQL (efficient) and re-excluded in the pure fn
 * (defense-in-depth + the test seam).
 *
 * Workspace scoping (audit P-013): when `workspaceId` is given, the sweep covers
 * that workspace PLUS the box-global buckets — `'*'` (unscoped SU sessions, the
 * bulk of real traffic) and the coord workspace (DEFAULT_COORD_WORKSPACE) — so a
 * tick scoped to workspace W no longer counts another workspace's errors, without
 * going dark on the unscoped traffic where most signal lives.
 */
export async function collectToolErrorSignals(sql: Sql, opts: CollectOptions = {}, workspaceId?: string): Promise<WatchdogSignal[]> {
  const windowHours = opts.toolErrorWindowHours ?? 24;
  const scopes = workspaceId ? [...new Set([workspaceId, '*', DEFAULT_COORD_WORKSPACE])] : null;
  const rows = await sql<ClassifiedToolErrorRow[]>`
    WITH fail AS (
      SELECT tool_name,
        -- Classified by the GENERATED CASE from the shared TOOL_ERROR_RULES table
        -- (tool-error-classifier.ts) — the SAME ordered table classifyToolError walks,
        -- so the in-DB SQL and the TS fn CANNOT drift (P-011). The per-class FIRE bars
        -- live in toolErrorSignalsFromRows; the loop's own tools are excluded below.
        ${toolErrorClassSqlCase(sql)} AS class,
        error_message,
        invoked_at
        FROM harness_shared.tool_invocations
       WHERE status IN ('error', 'timeout')
         AND invoked_at > now() - make_interval(hours => ${windowHours})
         AND ${scopes ? sql`workspace_id = ANY(${scopes}::text[])` : sql`TRUE`}
         AND tool_name NOT LIKE 'improvements:%'
         AND tool_name NOT LIKE 'system:improvement-%'
    ),
    tot AS (
      SELECT tool_name, count(*)::int AS total
        FROM harness_shared.tool_invocations
       WHERE invoked_at > now() - make_interval(hours => ${windowHours})
         AND ${scopes ? sql`workspace_id = ANY(${scopes}::text[])` : sql`TRUE`}
         AND tool_name NOT LIKE 'improvements:%'
         AND tool_name NOT LIKE 'system:improvement-%'
       GROUP BY tool_name
    ),
    -- P-003 + P-012 fingerprint: the normalized error-shape skeleton (first 6 alpha
    -- tokens of the digit/punct-stripped message), computed by the GENERATED CASE from
    -- FINGERPRINTED_TOOL_ERROR_CLASSES (tool-error-classifier.ts). structural + caller +
    -- transient are fingerprinted, so distinct same-class modes under one tool split into
    -- separate keys instead of masking each other; rate-limit stays coarse (one capacity
    -- concern). toolErrorFingerprint() mirrors this exact arithmetic in TS for the
    -- key-migration backfill — parity proven by the integration test.
    tagged AS (
      SELECT tool_name, class, error_message, invoked_at,
        ${toolErrorFingerprintSqlCase(sql)} AS fingerprint
        FROM fail
    )
    SELECT tagged.tool_name, tagged.class, tagged.fingerprint, count(*)::int AS n,
           COALESCE(tot.total, count(*))::int AS total,
           max(tagged.error_message) AS sample,
           max(tagged.invoked_at) AS latest_at
      FROM tagged LEFT JOIN tot ON tot.tool_name = tagged.tool_name
     GROUP BY tagged.tool_name, tagged.class, tagged.fingerprint, tot.total
     ORDER BY count(*) DESC
     LIMIT 30`;
  return toolErrorSignalsFromRows(rows, opts);
}

/** service-down: a watched dev endpoint currently DOWN per the service-health monitor. */
export function collectServiceDownSignals(
  results = lastServiceHealth(),
): WatchdogSignal[] {
  return results
    .filter((r) => !r.up && r.present !== false)
    .map((r) => ({
      source: 'service-down' as const,
      key: r.name,
      title: `Service ${r.name} is down`,
      body:
        `Watchdog signal (service-down): the service-health monitor reports "${r.name}" DOWN` +
        (r.status ? ` (HTTP ${r.status})` : ' (no response)') +
        (r.note ? ` — ${r.note}` : '') +
        '.',
      severity: 'major' as const,
    }));
}

/**
 * The service-health probe runs every 60s (a DBOS scheduled workflow). The
 * `lastServiceHealth()` snapshot is a module singleton — if the probe workflow
 * has STOPPED (or the host just restarted), it goes stale and would feed the
 * watchdog phantom up/down data. Default freshness window = 2× the probe
 * interval (watchdog-robustness P-004 / D-004).
 */
export const DEFAULT_SERVICE_HEALTH_MAX_STALE_MS = 2 * 60_000;

/** Pure: is the service-health snapshot too old (or never populated) to trust? (P-004) */
export function isServiceHealthStale(at: number | null, now: number, maxStaleMs: number): boolean {
  if (at == null) return true; // never probed this process
  return now - at > maxStaleMs;
}

/**
 * Inline-probe-on-stale toggle (infra-self-healing R4-7). DEFAULT ON: when the
 * snapshot is stale the collector probes the endpoints FRESH inline rather than
 * skipping — so a real DOWN is still caught exactly when the periodic probe
 * workflow has stalled under load (the moment service-down matters most). The
 * inline probe is bounded by `probeAll`'s 3s-per-endpoint timeout. Set
 * `PAPERCUSP_WATCHDOG_SERVICE_HEALTH_INLINE_PROBE=0` to fall back to the prior
 * skip-with-note behavior if the inline probe ever proves costly.
 */
export function inlineProbeOnStaleEnabled(): boolean {
  return process.env.PAPERCUSP_WATCHDOG_SERVICE_HEALTH_INLINE_PROBE !== '0';
}

/**
 * The default `service-down` collector with the P-004 freshness gate. On a
 * FRESH snapshot it maps the cached probe results to signals as before. On a
 * STALE (or never-populated) snapshot the collector NO LONGER goes blind:
 *
 *  - inline-probe ON (default): run a fresh, bounded `probeAll()` inline and
 *    emit signals off THAT (infra-self-healing R4-7) — the periodic writer may
 *    be stalled, but a real DOWN is still caught. Carries a `stale-service-health
 *    (fresh inline probe)` note so the tick record shows the fallback fired. If
 *    the inline probe itself throws, emit a single DEGRADED/unknown signal so the
 *    collector never produces both zero signals AND no note.
 *  - inline-probe OFF: the prior P-004 behavior — emit nothing, carry a
 *    `stale-service-health` skip note.
 *
 * Async because the stale path may do I/O (the inline probe).
 */
export async function serviceDownCollectorResult(opts: {
  results?: ProbeResult[];
  at?: number | null;
  now?: number;
  maxStaleMs?: number;
  /** Inject the fresh-probe (tests); defaults to the real bounded `probeAll`. */
  probe?: () => Promise<ProbeResult[]>;
  /** Override the inline-probe toggle (tests); defaults to the env-gated flag. */
  inlineProbe?: boolean;
} = {}): Promise<CollectorResult> {
  const at = opts.at ?? lastServiceHealthAt();
  const now = opts.now ?? Date.now();
  const maxStaleMs = opts.maxStaleMs ?? DEFAULT_SERVICE_HEALTH_MAX_STALE_MS;
  if (isServiceHealthStale(at, now, maxStaleMs)) {
    const ageMs = at == null ? null : now - at;
    const ageDesc = ageMs == null ? 'never populated' : `is ${Math.round(ageMs / 1000)}s old`;
    const inline = opts.inlineProbe ?? inlineProbeOnStaleEnabled();
    if (!inline) {
      // Legacy fallback (PAPERCUSP_WATCHDOG_SERVICE_HEALTH_INLINE_PROBE=0): skip.
      return {
        signals: [],
        note:
          `stale-service-health: snapshot ${ageDesc} ` +
          `(> ${Math.round(maxStaleMs / 1000)}s) — skipping service-down collection (the probe workflow may have stopped)`,
      };
    }
    // Inline fresh probe — the periodic writer stalled, so probe NOW (bounded).
    try {
      const probe = opts.probe ?? (() => probeAll());
      const fresh = await probe();
      return {
        signals: collectServiceDownSignals(fresh),
        note:
          `stale-service-health: snapshot ${ageDesc} ` +
          `(> ${Math.round(maxStaleMs / 1000)}s) — ran a fresh inline probe (the periodic probe workflow may have stalled)`,
      };
    } catch (e) {
      // The inline probe itself failed: don't go blind — surface a single
      // DEGRADED/unknown signal so a stale-and-unprobeable monitor is visible.
      const msg = e instanceof Error ? e.message : String(e);
      return {
        signals: [{
          source: 'service-down' as const,
          key: 'service-health-monitor',
          title: 'Service-health monitor is degraded',
          body:
            `Watchdog signal (service-down): the service-health snapshot ${ageDesc} ` +
            `(> ${Math.round(maxStaleMs / 1000)}s) AND the fresh inline probe failed (${msg}) — ` +
            `service-down detection is degraded; the periodic probe workflow may have stalled.`,
          severity: 'major' as const,
          findingClass: 'service-down:monitor-degraded',
        }],
        note: `stale-service-health: snapshot ${ageDesc} — inline probe failed (${msg})`,
      };
    }
  }
  return { signals: collectServiceDownSignals(opts.results ?? lastServiceHealth()) };
}

// ── P-010 blind-source collectors (watchdog-robustness) ──────────────────────
// The watchdog watched only 4 surfaces; whole classes of failure (schema drift, a
// silently-failing background routine, stuck plans, failed spawns, abandoned work)
// were invisible. Each collector below is a CONSERVATIVE is-broken query; they all
// land behind the P-009 per-source budget + search-first dedup so a steady backlog
// can't flood the capture feed. Pure row→signal mappers are exported for unit tests.

/**
 * migration-drift: on-disk migrations the live DB has NOT applied — runtime code that
 * expects those columns/tables fails until the operator restarts (boot-apply). Rare +
 * catastrophic → critical, any drift fires. Wires the existing `checkMigrationDrift`
 * (injectable for tests).
 */
export async function collectMigrationDriftSignals(
  check: () => Promise<{ missing: string[] }> = checkMigrationDrift,
): Promise<WatchdogSignal[]> {
  let drift: { missing: string[] };
  try { drift = await check(); } catch { return []; }
  if (!drift.missing?.length) return [];
  return [{
    source: 'migration-drift',
    key: 'migration-drift',
    title: 'Schema drift: migrations on disk are not applied to the live DB',
    body:
      `Watchdog signal (migration-drift): ${drift.missing.length} migration file(s) exist on disk but are NOT ` +
      `applied to the live database — runtime code expecting those columns/tables will fail until the operator ` +
      `restarts (boot-apply).\n\nUnapplied: ${drift.missing.slice(0, 20).join(', ')}`,
    severity: 'critical',
    kind: 'bug',
    paths: ['libs/papercusp/libs/db/sql'],
  }];
}

interface RoutineFailureRow { name: string; last_error: string | null }
/** Pure: routines carrying a recorded error → signals. */
export function routineFailureSignalsFromRows(rows: RoutineFailureRow[]): WatchdogSignal[] {
  return rows
    .filter((r) => (r.last_error ?? '').trim().length > 0)
    .map((r) => ({
      source: 'routine-failure' as const,
      key: `routine:${r.name}`,
      title: `Background routine "${r.name}" is failing`,
      body:
        `Watchdog signal (routine-failure): the background routine "${r.name}" recorded an error and may be ` +
        `silently wedged (e.g. git-sync no longer pushing).\n\nLast error: ${(r.last_error ?? '').slice(0, 600)}`,
      severity: 'major' as const,
      kind: 'bug' as const,
    }));
}
/** routine-failure: an ACTIVE background routine with a recorded `metadata.last_error`. */
export async function collectRoutineFailureSignals(sql: Sql): Promise<WatchdogSignal[]> {
  const rows = await sql<RoutineFailureRow[]>`
    SELECT name, metadata->>'last_error' AS last_error
      FROM harness_shared.routines
     WHERE active = true AND COALESCE(metadata->>'last_error', '') <> ''
     LIMIT 20`;
  return routineFailureSignalsFromRows(rows);
}

interface LoopStalledRow {
  id: string;
  name: string;
  install_slug: string;
  target_owner_id: string;
  interval_sec: number;
  parked_secs: number;
}
/** Pure: loop-stalled rows → signals (one per stalled loop, keyed by install_slug:name). */
export function loopStalledSignalsFromRows(rows: LoopStalledRow[]): WatchdogSignal[] {
  return rows.map((r) => {
    const mins = Math.round(r.parked_secs / 60);
    return {
      source: 'loop-stalled' as const,
      key: `loop-stalled:${r.install_slug}:${r.name}`,
      title: `Engine loop ${r.name} stalled (parked, no completion)`,
      body:
        `Watchdog signal (loop-stalled): loop '${r.name}' (owner ${r.target_owner_id}, harness ${r.install_slug}, ` +
        `interval ${r.interval_sec}s) has been parked at 'infinity' for ~${mins}min with NO post-fire completion ` +
        `marker and no session activity. Its re-wake turn likely DIED silently (the classic case: a 429 during an ` +
        `account-wide rate-limit storm killed the detached resume turn) — the delivery was recorded 'delivered' on ` +
        `spawn, so nothing observed the death. Only the ≥30min stuck-park backstop will recover it. ` +
        `See agent-insights/loop-wake-turn-deaths-recorded-as-delivered.`,
      severity: 'major' as const,
      kind: 'bug' as const,
      // Origin scope (P-032): a loop belongs to ONE harness (its install_slug).
      scope: `harness:${r.install_slug}`,
    };
  });
}

/**
 * loop-stalled (P1b): an engine loop (loop:arm — `reschedule_interval_sec` + `target_owner_id`)
 * parked at 'infinity' (its turn in flight) for ≥ max(30min, 4×interval) past its fire, with NO
 * post-fire lifecycle 'ended' marker AND no genuine session activity since the fire — i.e. its
 * wake turn died/never-delivered, not a legitimately long turn (which keeps producing activity).
 * The same predicate the reconcile stuck-park backstop recovers on; here it is SURFACED as a
 * visible signal (the doc's P1b — the loop otherwise goes quiet with no observability). Read-only
 * + conservative.
 */
export async function collectLoopStalledSignals(sql: Sql, stuckParkSec = 1800): Promise<WatchdogSignal[]> {
  const rows = await sql<LoopStalledRow[]>`
    SELECT r.id,
           r.name,
           r.install_slug,
           r.target_owner_id,
           r.reschedule_interval_sec AS interval_sec,
           EXTRACT(EPOCH FROM (now() - r.last_fired_at))::float8 AS parked_secs
      FROM harness_shared.routines r
     WHERE r.active = true
       AND r.reschedule_interval_sec IS NOT NULL
       AND r.target_owner_id IS NOT NULL
       AND r.next_fire_at = 'infinity'::timestamptz
       AND r.last_fired_at IS NOT NULL
       AND r.last_fired_at < now() - make_interval(secs => GREATEST(${stuckParkSec}::int, 4 * r.reschedule_interval_sec))
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.agent_activity a
          WHERE a.owner_id = r.target_owner_id
            AND a.kind = 'lifecycle'
            AND a.summary ILIKE '%end%'
            AND a.created_at > r.last_fired_at)
       AND COALESCE(
             (SELECT max(p.last_active_at) FROM harness_shared.coord_presence p WHERE p.owner_id = r.target_owner_id),
             'epoch'::timestamptz
           ) <= r.last_fired_at
     ORDER BY r.last_fired_at ASC
     LIMIT 20`;
  return loopStalledSignalsFromRows(rows);
}

interface StuckPlanRow { harness_slug: string; plan_slug: string; status: string; stale_hours: number }
/** Pure: stuck-plan rows → signals. */
export function stuckPlanSignalsFromRows(rows: StuckPlanRow[]): WatchdogSignal[] {
  return rows.map((r) => ({
    source: 'stuck-plan' as const,
    key: `stuck-plan:${r.harness_slug}:${r.plan_slug}`,
    title: `Plan ${r.plan_slug} appears stuck`,
    body:
      `Watchdog signal (stuck-plan): plan "${r.plan_slug}" (harness ${r.harness_slug}) has been '${r.status}' with ` +
      `no status update for ~${Math.round(r.stale_hours)}h — its run may be hung.`,
    severity: 'major' as const,
    kind: 'bug' as const,
    // Origin scope (P-032): a stuck plan belongs to ONE harness.
    scope: `harness:${r.harness_slug}`,
  }));
}
/** stuck-plan: a plan 'started'/'paused' with no update for > staleHours (default 24h). */
export async function collectStuckPlanSignals(sql: Sql, workspaceId: string, staleHours = 24): Promise<WatchdogSignal[]> {
  const rows = await sql<StuckPlanRow[]>`
    SELECT harness_slug, plan_slug, status,
           EXTRACT(EPOCH FROM (now() - updated_at)) / 3600.0 AS stale_hours
      FROM harness_shared.harness_plan_status
     WHERE workspace_id = ${workspaceId}
       AND status IN ('started', 'paused')
       AND updated_at < now() - make_interval(hours => ${staleHours})
     ORDER BY updated_at ASC
     LIMIT 10`;
  return stuckPlanSignalsFromRows(rows);
}

/**
 * Pure (audit P-008): classify one spawn failure message into a coarse cause
 * class. The single global `failed-spawns` key conflated unrelated causes — a
 * resolved timeout-storm item would mask a new auth breakage. Keying the signal
 * by DOMINANT class gives one capture per diagnosable problem.
 */
export type SpawnErrorClass = 'timeout' | 'network' | 'auth' | 'missing-file' | 'config' | 'other';
export function classifySpawnError(message: string | null | undefined): SpawnErrorClass {
  const m = message ?? '';
  if (/timed?\s*out|timeout/i.test(m)) return 'timeout';
  if (/econnrefused|econnreset|enotfound|socket|network|fetch failed/i.test(m)) return 'network';
  if (/auth|credential|api.?key|401|403|unauthorized|forbidden/i.test(m)) return 'auth';
  if (/enoent|no such file|file not found/i.test(m)) return 'missing-file';
  if (/invalid|config|schema|parse|json/i.test(m)) return 'config';
  return 'other';
}

interface FailedSpawnRow { error_message: string | null; started_at: string | Date | null }

/**
 * Pure (audit P-008 + P-005): failed-spawn rows → at most ONE signal, keyed by the
 * DOMINANT error class (`failed-spawns:<class>`), with the full per-class
 * breakdown in the body and `latestAt` = the newest failure. A different dominant
 * cause next week gets a DIFFERENT key — a resolved timeout item no longer
 * swallows a fresh auth breakage.
 */
export function failedSpawnSignalsFromRows(
  rows: FailedSpawnRow[],
  opts: { windowHours?: number; minCount?: number } = {},
): WatchdogSignal[] {
  const windowHours = opts.windowHours ?? 6;
  const minCount = opts.minCount ?? 5;
  if (rows.length < minCount) return [];
  const byClass = new Map<SpawnErrorClass, { n: number; sample: string | null }>();
  let latestAt: string | undefined;
  for (const r of rows) {
    const cls = classifySpawnError(r.error_message);
    const agg = byClass.get(cls) ?? { n: 0, sample: null };
    agg.n += 1;
    if (!agg.sample && r.error_message) agg.sample = r.error_message;
    byClass.set(cls, agg);
    const iso = toIsoOrUndefined(r.started_at);
    if (iso && (!latestAt || iso > latestAt)) latestAt = iso;
  }
  const ranked = [...byClass.entries()].sort((a, b) => b[1].n - a[1].n);
  const [dominantClass, dominant] = ranked[0];
  const breakdown = ranked.map(([cls, v]) => `${cls}: ${v.n}`).join(', ');
  return [{
    source: 'failed-spawn',
    key: `failed-spawns:${dominantClass}`,
    title: `Agent spawns are failing repeatedly (${dominantClass})`,
    body:
      `Watchdog signal (failed-spawn): ${rows.length} agent spawn(s) failed in the last ${windowHours}h; ` +
      `the dominant cause class is "${dominantClass}" (${dominant.n}/${rows.length}).\n\n` +
      `Class breakdown: ${breakdown}\n\nSample (${dominantClass}): ${(dominant.sample ?? '').slice(0, 600) || '(none captured)'}`,
    severity: rows.length >= 20 ? 'major' : 'minor',
    kind: 'bug',
    latestAt,
  }];
}

/** failed-spawn: AGGREGATE — agent spawns that failed in the window, keyed by dominant cause class (P-008). */
export async function collectFailedSpawnSignals(sql: Sql, opts: CollectOptions = {}): Promise<WatchdogSignal[]> {
  const windowHours = opts.failedSpawnWindowHours ?? 6;
  const rows = await sql<FailedSpawnRow[]>`
    SELECT error_message, started_at
      FROM harness_shared.spawned_agents
     WHERE status = 'failed' AND started_at > now() - make_interval(hours => ${windowHours})
     ORDER BY started_at DESC
     LIMIT 500`;
  return failedSpawnSignalsFromRows(rows, { windowHours, minCount: opts.failedSpawnMinCount });
}

interface ExpiredLeaseRow { expires_ts: string | Date }

/**
 * Pure (audit P-006 + P-005): expired-lease rows → at most ONE signal, counting
 * only leases that expired within the RECENCY WINDOW (default 7 days). Before
 * this the count was all-time, so a pile of ancient leases made the signal fire
 * forever and the filed item perpetually re-file after resolve. `latestAt` = the
 * newest expiry, so post-resolve re-files need a lease that expired AFTER the
 * resolution (D-002). The collector DETECTS; stale-claim GC belongs to the
 * plan-item lifecycle, not here.
 */
export function expiredLeaseSignalsFromRows(
  rows: ExpiredLeaseRow[],
  opts: { windowDays?: number; minCount?: number; nowMs?: number } = {},
): WatchdogSignal[] {
  const windowDays = opts.windowDays ?? 7;
  const minCount = opts.minCount ?? 15;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoffMs = nowMs - windowDays * 86_400_000;
  const recent: number[] = [];
  for (const r of rows) {
    const ms = r.expires_ts instanceof Date ? r.expires_ts.getTime() : Date.parse(r.expires_ts);
    if (Number.isFinite(ms) && ms >= cutoffMs && ms <= nowMs) recent.push(ms);
  }
  if (recent.length < minCount) return [];
  const oldestHours = Math.round((nowMs - Math.min(...recent)) / 3_600_000);
  return [{
    source: 'expired-lease',
    key: 'expired-leases',
    title: 'Many plan-item claims have expired (abandoned work piling up)',
    body:
      `Watchdog signal (expired-lease): ${recent.length} plan-item claim(s) expired within the last ${windowDays}d ` +
      `(the holder died/vanished without releasing). The oldest recent expiry is ~${oldestHours}h stale — a sign ` +
      `lease cleanup or agent liveness needs attention.`,
    severity: 'minor',
    kind: 'bug',
    latestAt: new Date(Math.max(...recent)).toISOString(),
  }];
}

/**
 * expired-lease: AGGREGATE — plan-item claims whose lease expired RECENTLY and
 * whose holder is genuinely GONE (P-006 window).
 *
 * EI-530: the old query counted EVERY expired-but-present claim, regardless of
 * holder liveness — so a long-lived session that's still heartbeating but let a
 * lease lapse (which the reclaim sweep CORRECTLY skips) was falsely counted as
 * "the holder died/vanished", firing this signal forever. The watchdog now joins
 * the SAME alias-aware liveness rule + grace the reclaim sweep uses
 * (`reclaimExpiredPlanItemClaims`, plan-items/stale-claims.ts), so it counts ONLY
 * the set the sweep targets but hasn't reaped — i.e. genuine abandonment the GC
 * is failing to clean. If the sweep is healthy this is ~0; a sustained non-zero
 * count is the real "lease GC / liveness needs attention" signal the body
 * describes. Live-holder lapses are a claim-discipline concern (EI-483), not this.
 */
export async function collectExpiredLeaseSignals(sql: Sql, opts: CollectOptions = {}): Promise<WatchdogSignal[]> {
  const windowDays = opts.expiredLeaseWindowDays ?? 7;
  const graceSec = Math.max(1, Math.round((opts.expiredLeaseGraceMs ?? STALE_PLAN_CLAIM_GRACE_MS) / 1000));
  const rows = await sql<ExpiredLeaseRow[]>`
    WITH live_holder AS (
      -- Mirror reclaimExpiredPlanItemClaims's mig-225 alias-aware liveness join:
      -- fresh coord_presence rows…
      SELECT owner_id AS alias
        FROM harness_shared.coord_presence
       WHERE heartbeat_at IS NOT NULL
         AND (now() - heartbeat_at) < make_interval(secs => ${graceSec})
      UNION
      -- …plus every alias of a RUNNING nursery row with a fresh heartbeat.
      SELECT a.alias
        FROM harness_shared.spawned_agents n
        CROSS JOIN LATERAL (VALUES (n.spawn_id), (n.session_owner), (n.run_id)) AS a(alias)
       WHERE n.status IN ('running', 'restarting')
         AND n.heartbeat_at IS NOT NULL
         AND (now() - n.heartbeat_at) < make_interval(secs => ${graceSec})
         AND a.alias IS NOT NULL AND a.alias <> ''
    )
    SELECT c.expires_ts
      FROM harness_shared.plan_item_claims c
     WHERE c.expires_ts < now() - make_interval(secs => ${graceSec})
       AND c.expires_ts > now() - make_interval(days => ${windowDays})
       AND NOT EXISTS (SELECT 1 FROM live_holder h WHERE h.alias = c.owner)
     ORDER BY c.expires_ts DESC
     LIMIT 500`;
  return expiredLeaseSignalsFromRows(rows, { windowDays, minCount: opts.expiredLeaseMinCount });
}

interface EscalationRow { harness_slug: string; phase: string | null }
/** Pure: unresolved-escalation rows → signals. */
export function escalationSignalsFromRows(rows: EscalationRow[]): WatchdogSignal[] {
  return rows.map((r) => ({
    source: 'unresolved-escalation' as const,
    key: `escalation:${r.harness_slug}:${r.phase ?? ''}`,
    title: `Unresolved escalation in harness ${r.harness_slug}`,
    body:
      `Watchdog signal (unresolved-escalation): harness ${r.harness_slug}` +
      (r.phase ? ` (phase ${r.phase})` : '') +
      ` has a recorded escalation with no supervisor resolution yet.`,
    severity: 'major' as const,
    kind: 'bug' as const,
    // Origin scope (P-032): an escalation is attributable to ONE harness.
    scope: `harness:${r.harness_slug}`,
  }));
}
/** unresolved-escalation: a harness escalation with no supervisor_notes (unaddressed). */
export async function collectEscalationSignals(sql: Sql, workspaceId: string): Promise<WatchdogSignal[]> {
  const rows = await sql<EscalationRow[]>`
    SELECT harness_slug, phase
      FROM harness_shared.harness_escalations
     WHERE workspace_id = ${workspaceId}
       AND COALESCE(escalation, '') <> ''
       AND COALESCE(supervisor_notes, '') = ''
     LIMIT 10`;
  return escalationSignalsFromRows(rows);
}

interface CircuitOpenRow { harness_slug: string; role: string; consecutive_errors: number; last_status: string | null }
/** Pure: error-backoff fire-state rows → signals. */
export function circuitOpenSignalsFromRows(rows: CircuitOpenRow[]): WatchdogSignal[] {
  return rows.map((r) => ({
    source: 'fire-circuit-open' as const,
    key: `circuit:${r.harness_slug}:${r.role}`,
    title: `Role fire-path for ${r.harness_slug}/${r.role} is stuck in error-backoff`,
    body:
      `Watchdog signal (fire-circuit-open): the autoloop fire path for ${r.harness_slug}/${r.role} has failed ` +
      `${r.consecutive_errors} consecutive times — the fire gate is backing it off, so this role is effectively ` +
      `not running on its cadence until the underlying error is fixed (or autoloop:control reset-errors).` +
      `\n\nLast status: ${(r.last_status ?? '').slice(0, 400) || '(none recorded)'}`,
    severity: 'major' as const,
    kind: 'bug' as const,
    // Origin scope (P-032): a stuck role fire-path belongs to ONE harness.
    scope: `harness:${r.harness_slug}`,
  }));
}
/**
 * fire-circuit-open: a role fire-path (a role-target routine or autoloop trigger)
 * whose `autoloop_state.consecutive_errors` shows it repeatedly failing — the
 * fire gate (autoloop P-009) backs it off, so the role silently stops running on
 * its cadence. The `recordFire` error path was otherwise invisible to the
 * watchdog: `routine-failure` only sees system-action `metadata.last_error`.
 * Recency-gated so a long-dead historical row doesn't fire forever.
 */
export async function collectCircuitOpenSignals(
  sql: Sql,
  workspaceId: string,
  opts: { minConsecutiveErrors?: number; recentHours?: number } = {},
): Promise<WatchdogSignal[]> {
  const minErrors = opts.minConsecutiveErrors ?? 5;
  const recentHours = opts.recentHours ?? 24;
  const rows = await sql<CircuitOpenRow[]>`
    SELECT harness_slug, role, consecutive_errors::int, last_status
      FROM harness_shared.autoloop_state
     WHERE workspace_id = ${workspaceId}
       AND consecutive_errors >= ${minErrors}
       AND last_fired_at > now() - make_interval(hours => ${recentHours})
     ORDER BY consecutive_errors DESC
     LIMIT 10`;
  return circuitOpenSignalsFromRows(rows);
}

// ── hive-loop invariant monitors (hive-loop-e2e-testing-2026-06-10 P-010) ────
// The loop's liveness/hygiene oracles as standing monitors. Each is a
// CONSERVATIVE is-broken read over the loop's own state; violations file
// through the same captureImprovement core (tagged + cross-tick deduped) —
// the plan's "issues:create (tagged, deduped)" sink, on the improvements
// surface the papercusp-internal loop already routes to.

interface StalledFeatureRow { harness_slug: string; feature_id: string; updated_ts: number | string }
/** Pure: stalled dispatchable features → ONE aggregate signal per harness. */
export function stalledFeatureSignalsFromRows(
  rows: StalledFeatureRow[],
  opts: { staleHours?: number; nowMs?: number } = {},
): WatchdogSignal[] {
  const staleHours = opts.staleHours ?? 12;
  const nowMs = opts.nowMs ?? Date.now();
  const byHarness = new Map<string, { ids: string[]; oldestMs: number }>();
  for (const r of rows) {
    const g = byHarness.get(r.harness_slug) ?? { ids: [], oldestMs: nowMs };
    g.ids.push(r.feature_id);
    const ms = Number(r.updated_ts);
    if (Number.isFinite(ms) && ms < g.oldestMs) g.oldestMs = ms;
    byHarness.set(r.harness_slug, g);
  }
  return [...byHarness.entries()].map(([slug, g]) => ({
    source: 'stalled-feature' as const,
    key: `stalled:${slug}`,
    title: `Dispatchable work in harness ${slug} is not being picked up`,
    body:
      `Watchdog signal (stalled-feature): ${g.ids.length} dispatchable feature(s) in ${slug} have had no ` +
      `pipeline turn for > ${staleHours}h (oldest ~${Math.round((nowMs - g.oldestMs) / 3_600_000)}h): ` +
      `${g.ids.slice(0, 5).join(', ')}${g.ids.length > 5 ? ', …' : ''}. No live pipeline owns them, so the ` +
      `autonomous loop (routine tick → blueprint-run → dispatch) is not reaching this harness — check ` +
      `autoloop:status, the harness's bp-schedule routine, and the orchestrator scope env.`,
    severity: 'major' as const,
    kind: 'bug' as const,
    // Origin scope (P-032): one aggregate signal per harness — attributable to it.
    scope: `harness:${slug}`,
  }));
}
/**
 * stalled-feature: a feature the dispatcher SHOULD be running — NEEDS_WORK
 * status, kind=feature, plan-gate satisfied — untouched for N hours with no
 * live (PENDING/ENQUEUED) pipeline owning it. The loop's liveness oracle
 * ("a queued feature reaches a terminal state") as a standing monitor.
 * The dbos-schema guard mirrors durableOwnedFeatureIdsPg: schema absent → no
 * live-pipeline carve-out (every stalled row reports).
 */
export async function collectStalledFeatureSignals(
  sql: Sql,
  workspaceId: string,
  opts: CollectOptions = {},
): Promise<WatchdogSignal[]> {
  const staleHours = opts.stalledFeatureHours ?? 12;
  const reg = await sql<{ t: string | null }[]>`SELECT to_regclass('dbos.workflow_status') AS t`;
  const hasDbos = Boolean(reg[0]?.t);
  const rows = await sql<StalledFeatureRow[]>`
    SELECT w.harness_slug, w.feature_id, w.updated_ts
      FROM harness_shared.work_items w
     WHERE w.workspace_id = ${workspaceId}
       AND w.item_kind = 'feature'
       AND w.status IN ('todo', 'failing', 'pending', 'failed')
       AND w.updated_ts < (extract(epoch from now()) * 1000 - ${staleHours} * 3600000)
       AND (
         (w.metadata->>'source_plan') IS NULL
         OR (w.metadata->>'source_plan') IN (
           SELECT plan_slug FROM harness_shared.harness_plans
            WHERE workspace_id = ${workspaceId} AND harness_slug = w.harness_slug
              AND op_status = 'started'
         )
       )
       ${hasDbos
         ? sql`AND NOT EXISTS (
             SELECT 1 FROM dbos.workflow_status d
              WHERE d.workflow_uuid LIKE 'pipeline:' || w.harness_slug || ':' || w.feature_id || ':e%'
                AND d.status IN ('PENDING', 'ENQUEUED'))`
         : sql``}
     ORDER BY w.updated_ts ASC
     LIMIT 100`;
  return stalledFeatureSignalsFromRows(rows, { staleHours });
}

interface OrphanedSpawnRow { spawn_id: string; harness_slug: string | null; heartbeat_at: string | Date | null; started_at: string | Date }
/** Pure: lingering past-reclaim 'running' rows → ONE aggregate signal. */
export function orphanedSpawnSignalsFromRows(
  rows: OrphanedSpawnRow[],
  opts: { staleMinutes?: number } = {},
): WatchdogSignal[] {
  if (rows.length === 0) return [];
  const staleMinutes = opts.staleMinutes ?? 15;
  const sample = rows.slice(0, 5).map((r) => r.spawn_id).join(', ');
  return [{
    source: 'orphaned-spawn',
    key: 'orphaned-running-rows',
    title: 'Orphaned running nursery rows are evading the heartbeat reclaim',
    body:
      `Watchdog signal (orphaned-spawn): ${rows.length} spawned_agents row(s) are status='running'/'restarting' ` +
      `with a heartbeat > ${staleMinutes} min stale — well past the reclaim threshold, so the stale-heartbeat ` +
      `sweep (spawn-reclaim) is apparently not running or not freeing them. They poison the concurrency ceiling ` +
      `until reclaimed. Sample: ${sample}${rows.length > 5 ? ', …' : ''}.`,
    severity: 'major',
    kind: 'bug',
  }];
}
/**
 * orphaned-spawn: 'running' nursery rows whose heartbeat is stale far beyond
 * RECLAIM_STALE_MS (default 3×). The reclaim runs in-line on every spawn
 * attempt and on getSpawnHeadroom — rows lingering past the threshold mean the
 * hygiene path itself is broken (the loop's hygiene oracle as a monitor).
 * Distinct from failed-spawn (failure VOLUME) — this is reclaim NON-EXECUTION.
 */
export async function collectOrphanedSpawnSignals(
  sql: Sql,
  workspaceId: string,
  opts: CollectOptions = {},
): Promise<WatchdogSignal[]> {
  const staleMinutes = opts.orphanedSpawnStaleMinutes ?? 15;
  const rows = await sql<OrphanedSpawnRow[]>`
    SELECT spawn_id, harness_slug, heartbeat_at, started_at
      FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId}
       AND status IN ('running', 'restarting')
       AND COALESCE(heartbeat_at, started_at) < now() - make_interval(mins => ${staleMinutes})
     ORDER BY COALESCE(heartbeat_at, started_at) ASC
     LIMIT 50`;
  return orphanedSpawnSignalsFromRows(rows, { staleMinutes });
}

interface StalledClaimRow {
  work_item_id: string | null;
  agent_id: string | null;
  harness_slug: string | null;
  detail: string | null;
  stalled_minutes: number | string | null;
}
/**
 * Pure (agent-activity-liveness-truth P-007, D-001): live-holder-but-no-progress
 * work-item claims → ONE aggregate signal. The recurrence guard for the incident
 * (a claim is not progress; a dead/stalled holder must never read as "covered").
 * Folds EI-2311 — re-dispatch-of-dead-holder: the durable cure is that the
 * RECONCILER frees these (P-003) AND this fires loudly while that leg is dark.
 */
export function stalledClaimSignalsFromRows(
  rows: StalledClaimRow[],
  opts: { minMinutes?: number } = {},
): WatchdogSignal[] {
  if (rows.length === 0) return [];
  const minMinutes = opts.minMinutes ?? 30;
  const sample = rows
    .slice(0, 5)
    .map((r) => `${r.work_item_id ?? '?'}<-${r.agent_id ?? '?'} (${Math.round(Number(r.stalled_minutes ?? 0))}m)`)
    .join(', ');
  return [{
    source: 'stalled-claim',
    key: 'stalled-work-item-claims',
    title: 'Work-item claims held by a live agent are not progressing (stalled)',
    body:
      `Watchdog signal (stalled-claim): ${rows.length} work-item claim(s) are held by a LIVE holder ` +
      `that has recorded NO item-scoped progress (a state transition / checkpoint) for > ${minMinutes} min ` +
      `— a claim is not progress (agent-activity-liveness-truth D-001). The holder is heartbeating but the ` +
      `work is not advancing, so the item reads as "covered" while actually stuck. The RECLAIM_STALLED ` +
      `reconciler leg auto-frees these when armed (default OFF — a live-placement change); until then this ` +
      `is the loud signal so the work is re-picked, not silently blocked (folds EI-2311). ` +
      `Sample: ${sample}${rows.length > 5 ? ', …' : ''}.`,
    severity: 'major',
    kind: 'bug',
    findingClass: 'coordination:stalled-claim',
  }];
}
/**
 * stalled-claim: work-item claims whose holder is ALIVE (fresh presence/nursery
 * heartbeat) but whose last_progress_at is far past the window — reads straight
 * off the reconciled fleet_assignment view's `stalled` column (migration 358),
 * the SAME truth the reconciler + every reader use, with a longer min-age so only
 * genuinely-stuck claims raise the loud aggregate signal.
 */
export async function collectStalledClaimSignals(
  sql: Sql,
  workspaceId: string,
  opts: CollectOptions = {},
): Promise<WatchdogSignal[]> {
  const minMinutes = opts.stalledClaimMinutes ?? 30;
  const rows = await sql<StalledClaimRow[]>`
    SELECT work_item_id, agent_id, harness_slug, detail,
           EXTRACT(epoch FROM (now() - COALESCE(last_progress_at, claim_acquired_ts))) / 60 AS stalled_minutes
      FROM harness_shared.fleet_assignment
     WHERE source = 'work_item_claim'
       AND stalled IS TRUE
       AND workspace_id = ${workspaceId}
       AND (now() - COALESCE(last_progress_at, claim_acquired_ts)) > make_interval(mins => ${minMinutes})
     ORDER BY COALESCE(last_progress_at, claim_acquired_ts) ASC
     LIMIT 50`;
  return stalledClaimSignalsFromRows(rows, { minMinutes });
}

interface CeilingJamRow {
  spawn_id: string;
  harness_slug: string | null;
  started_at: string | Date;
  last_output_at: string | Date | null;
}
/**
 * Pure: classify the workspace's `running`/`restarting` nursery rows into
 * genuinely-live (streamed output within `silentMinutes`) vs. suspected stale
 * debits (older than `minAgeMinutes` AND not streaming), and emit ONE aggregate
 * signal when the admission ceiling is consumed by the latter (EI-2186).
 *
 * Why stream output and not heartbeat: a host restart kills the launcher before
 * its admission-release runs, so the row jams `maxSimultaneousAgents` forever, and
 * the periodic reclaim cannot clear it — a stale `launch` row's reused pid reads as
 * "alive" and its HEARTBEAT gets bumped each sweep (a false-alive). `last_output_at`
 * is NOT touched by that bump path, and a dead process cannot advance it, so it is
 * the one liveness proxy the jam cannot fake. The fire condition is conservative —
 * the suspect rows must OUTNUMBER the live-streaming ones and clear the slack — so a
 * busy fleet (many streaming bees) and a couple of quiet/long-tool-call bees never trip it.
 */
export function ceilingJamSignalsFromRows(
  rows: CeilingJamRow[],
  opts: { ceiling?: number; minAgeMinutes?: number; silentMinutes?: number; slack?: number; now?: number } = {},
): WatchdogSignal[] {
  const minAgeMinutes = opts.minAgeMinutes ?? 15;
  const silentMinutes = opts.silentMinutes ?? 15;
  const slack = opts.slack ?? 2;
  const now = opts.now ?? Date.now();
  const ms = (v: string | Date | null): number | null => {
    if (v == null) return null;
    const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
    return Number.isNaN(t) ? null : t;
  };
  const running = rows.length;
  let streamingLive = 0;
  const jammed: string[] = [];
  for (const r of rows) {
    const outAt = ms(r.last_output_at);
    const streamedRecently = outAt != null && now - outAt <= silentMinutes * 60_000;
    if (streamedRecently) {
      streamingLive++;
      continue;
    }
    const startedAt = ms(r.started_at);
    const oldEnough = startedAt != null && now - startedAt > minAgeMinutes * 60_000;
    if (oldEnough) jammed.push(r.spawn_id);
  }
  // Fire only when the stale-suspect rows clear the slack AND outnumber the live
  // streamers — i.e. the ceiling is consumed by rows that aren't actually working.
  if (jammed.length <= slack || jammed.length <= streamingLive) return [];
  const sample = jammed.slice(0, 5).join(', ');
  const ceilingNote = opts.ceiling != null ? ` (fleet ceiling maxSimultaneousAgents=${opts.ceiling})` : '';
  return [{
    source: 'spawn-ceiling-jam',
    key: 'spawn-ceiling-jam',
    title: 'Spawn-admission ceiling jammed by non-streaming rows — stale debits blocking placement',
    body:
      `Watchdog signal (spawn-ceiling-jam): ${running} spawned_agents row(s) are status='running'/'restarting'${ceilingNote}, ` +
      `but only ${streamingLive} have streamed output in the last ${silentMinutes} min — ${jammed.length} have been running ` +
      `> ${minAgeMinutes} min with NO stream activity. That is the EI-2186 class: a host/process restart left admission ` +
      `debits that never released, so the concurrency ceiling reads full while ~nothing is alive and NO bee can be placed. ` +
      `The heartbeat-based reclaim misses these (a reused-pid false-alive keeps their heartbeat fresh); the boot reconcile ` +
      `(reconcileSpawnAdmissionOnBoot) clears them at the next operator restart. Sample: ${sample}${jammed.length > 5 ? ', …' : ''}.`,
    severity: 'critical',
    kind: 'bug',
  }];
}
/**
 * spawn-ceiling-jam: the recurrence guard for EI-2186. Distinct from orphaned-spawn
 * (which keys on a STALE heartbeat — and the jam's signature is a FRESH heartbeat
 * from the false-alive bump): this keys on stream-output recency, which a dead row
 * cannot fake. Box-global ceiling, workspace-scoped rows (matching admission's
 * per-workspace `countRunning`).
 */
export async function collectCeilingJamSignals(
  sql: Sql,
  workspaceId: string,
  opts: CollectOptions = {},
): Promise<WatchdogSignal[]> {
  const minAgeMinutes = opts.ceilingJamMinAgeMinutes ?? 15;
  const rows = await sql<CeilingJamRow[]>`
    SELECT spawn_id, harness_slug, started_at, last_output_at
      FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId}
       AND status IN ('running', 'restarting')
     ORDER BY started_at ASC
     LIMIT 200`;
  let ceiling: number | undefined;
  try {
    const { getCachedRateLimitConfig } = await import('../../rate-limit-config');
    ceiling = getCachedRateLimitConfig().maxSimultaneousAgents;
  } catch {
    /* best-effort — the signal stands without the ceiling number in its body */
  }
  return ceilingJamSignalsFromRows(rows, {
    ceiling,
    minAgeMinutes,
    silentMinutes: opts.ceilingJamSilentMinutes,
    slack: opts.ceilingJamSlack,
  });
}

interface EscalationSpikeRow { harness_slug: string; mtime_ms: number | string }
/** Pure: recent-escalation rows → ONE spike signal when ≥ minCount in the window. */
export function escalationSpikeSignalsFromRows(
  rows: EscalationSpikeRow[],
  opts: { windowHours?: number; minCount?: number } = {},
): WatchdogSignal[] {
  const windowHours = opts.windowHours ?? 6;
  const minCount = opts.minCount ?? 3;
  if (rows.length < minCount) return [];
  const byHarness = new Map<string, number>();
  for (const r of rows) byHarness.set(r.harness_slug, (byHarness.get(r.harness_slug) ?? 0) + 1);
  const breakdown = [...byHarness.entries()].map(([s, n]) => `${s}×${n}`).join(', ');
  return [{
    source: 'escalation-spike',
    key: 'escalation-rate',
    title: 'Escalation rate spike across the hive',
    body:
      `Watchdog signal (escalation-spike): ${rows.length} escalation(s) recorded in the last ${windowHours}h ` +
      `(threshold ${minCount}) — ${breakdown}. A burst of ESCALATE terminals means pipelines are systematically ` +
      `failing to complete (validator rejections, broken roles, or a poisoned harness), not one-off hard features.`,
    severity: 'major',
    kind: 'bug',
  }];
}
/**
 * escalation-spike: the RATE complement to unresolved-escalation (presence).
 * Escalations written within the window (mtime_ms — the table's only
 * timestamp) at ≥ threshold volume = the loop is systematically escalating.
 */
export async function collectEscalationSpikeSignals(
  sql: Sql,
  workspaceId: string,
  opts: CollectOptions = {},
): Promise<WatchdogSignal[]> {
  const windowHours = opts.escalationSpikeWindowHours ?? 6;
  const rows = await sql<EscalationSpikeRow[]>`
    SELECT harness_slug, mtime_ms
      FROM harness_shared.harness_escalations
     WHERE workspace_id = ${workspaceId}
       AND COALESCE(escalation, '') <> ''
       AND mtime_ms > (extract(epoch from now()) * 1000 - ${windowHours} * 3600000)
     LIMIT 200`;
  return escalationSpikeSignalsFromRows(rows, { windowHours, minCount: opts.escalationSpikeMinCount });
}

/** (P-011) Collector definition: a pluggable source of watchdog signals for a target. */
export interface WatchdogCollector {
  /** Collector name (e.g., 'papercusp-red-test', 'my-project-integration-test'). */
  name: string;
  /**
   * Collect signals. May return a bare array or a `CollectorResult` to carry a
   * non-error note (P-004). Errors are caught + logged by collectWatchdogSignalsDetailed.
   */
  collect: () => Promise<WatchdogSignal[] | CollectorResult>;
}

/** Injectable collector seam (the routine handler uses the default; tests inject). */
export interface WatchdogDeps {
  collect: () => Promise<WatchdogSignal[]>;
  capture: typeof captureImprovement;
  /** Tick-record sink (P-001). Defaults to the PG writer; tests inject. */
  recordTick: (rec: WatchdogTickRecord) => Promise<void>;
  /**
   * Recent-ticks reader for self-escalation (P-002) + the deferred-escalation
   * boost. `filter.status` narrows to ticks of one status — the deferred-keys
   * read uses `{ status: 'ran' }` so a 'skipped' tick (cross-host lock loser,
   * which records an empty deferred list) cannot wipe the boost (audit P-011).
   */
  readRecentTicks: (workspaceId: string, limit: number, filter?: { status?: 'ran' | 'skipped' }) => Promise<RecentTick[]>;
  /** Cross-host tick lock (P-003). Defaults to the PG advisory lock; tests inject. */
  withTickLock: <T>(workspaceId: string, fn: () => Promise<T>) => Promise<TickLockOutcome<T>>;
  /** Key-dup feed for the P-004/P-005 pre-filter. Defaults to the indexed PG lookup; tests inject. */
  readKeyDups: (keys: string[]) => Promise<WatchdogKeyDup[]>;
  /** Tick-retention prune (audit P-009). Best-effort, never aborts the tick; tests inject. */
  pruneTicks: (workspaceId: string, olderThanDays: number) => Promise<void>;
  /**
   * Known-open AGING (consume-edges P-020 / EI-363): turn persistent known-open
   * firing into escalation pressure. Defaults to `processKnownOpenAging`; tests inject.
   */
  processAging: (workspaceId: string, knownOpenKeys: string[], opts: WatchdogTickOptions) => Promise<KnownOpenAgingOutcome[]>;
  /**
   * AUTO-CLOSE (P-009): retire watchdog-sourced EIs whose signal stopped firing for N
   * ran-ticks. Defaults to `processAutoClose` (DEFAULT-OFF flag-gated); tests inject.
   */
  processAutoClose?: (workspaceId: string, opts: WatchdogTickOptions) => Promise<AutoCloseOutcome[]>;
}

/** (P-011) Default papercusp collectors: red-test, smoke-fail, repeated-tool-error, service-down.
 *  `opts.installSlug` (carried on the WatchdogTickOptions the tick passes through) is threaded
 *  to the dispatcher-staleness collector so it mirrors the dispatcher's runner/flag resolution
 *  (EI-2150). */
export async function defaultPapercuspCollectors(
  workspaceId: string,
  opts: CollectOptions & { installSlug?: string | null } = {},
): Promise<WatchdogCollector[]> {
  return [
    {
      name: 'papercusp-red-test',
      collect: () => collectRedTestSignals(getOrgPg().sql, opts),
    },
    {
      name: 'papercusp-smoke-fail',
      collect: () => collectSmokeFailSignals(getOrgPg().sql, workspaceId, opts),
    },
    {
      name: 'papercusp-repeated-tool-error',
      collect: () => collectToolErrorSignals(getOrgPg().sql, opts, workspaceId),
    },
    {
      name: 'papercusp-service-down',
      collect: () => serviceDownCollectorResult({ maxStaleMs: opts.serviceHealthMaxStaleMs }),
    },
    // P-010 blind-source collectors (each conservative + behind the P-009 per-source budget).
    { name: 'papercusp-migration-drift', collect: () => collectMigrationDriftSignals() },
    { name: 'papercusp-routine-failure', collect: () => collectRoutineFailureSignals(getOrgPg().sql) },
    { name: 'papercusp-stuck-plan', collect: () => collectStuckPlanSignals(getOrgPg().sql, workspaceId) },
    { name: 'papercusp-failed-spawn', collect: () => collectFailedSpawnSignals(getOrgPg().sql, opts) },
    { name: 'papercusp-expired-lease', collect: () => collectExpiredLeaseSignals(getOrgPg().sql, opts) },
    { name: 'papercusp-unresolved-escalation', collect: () => collectEscalationSignals(getOrgPg().sql, workspaceId) },
    { name: 'papercusp-fire-circuit-open', collect: () => collectCircuitOpenSignals(getOrgPg().sql, workspaceId) },
    // loop-wake-rate-limit-robustness P1b: an engine loop parked-stalled with a dead/undelivered
    // wake turn (the early, visible signal before the ≥30min stuck-park backstop recovers it).
    { name: 'papercusp-loop-stalled', collect: () => collectLoopStalledSignals(getOrgPg().sql) },
    // Hive-loop invariant monitors (hive-loop-e2e-testing-2026-06-10 P-010):
    // liveness (stalled dispatchable work), hygiene (reclaim non-execution),
    // safety (systematic ESCALATE volume).
    { name: 'papercusp-stalled-feature', collect: () => collectStalledFeatureSignals(getOrgPg().sql, workspaceId, opts) },
    { name: 'papercusp-orphaned-spawn', collect: () => collectOrphanedSpawnSignals(getOrgPg().sql, workspaceId, opts) },
    // agent-activity-liveness-truth P-007: a LIVE holder sitting on a non-progressing
    // work-item claim (fleet_assignment.stalled) — the loud recurrence guard so stalled
    // work is re-picked even while the RECLAIM_STALLED reconciler leg is dark.
    { name: 'papercusp-stalled-claim', collect: () => collectStalledClaimSignals(getOrgPg().sql, workspaceId, opts) },
    // EI-2186: the spawn-ceiling-jam recurrence guard — admission ceiling consumed by
    // non-streaming rows (stale debits from a host restart). Keys on stream activity,
    // not heartbeat, so it catches the jam orphaned-spawn misses (fresh false-alive heartbeat).
    { name: 'papercusp-spawn-ceiling-jam', collect: () => collectCeilingJamSignals(getOrgPg().sql, workspaceId, opts) },
    { name: 'papercusp-escalation-spike', collect: () => collectEscalationSpikeSignals(getOrgPg().sql, workspaceId, opts) },
    // P-051 (learning-system-audit): active insights citing missing repo files →
    // kind=change review captures (fs-only, no PG; lazy import keeps boot cheap).
    {
      name: 'papercusp-insight-staleness',
      collect: () => import('./insight-staleness').then((m) => m.collectInsightStalenessSignals()),
    },
    // Links 5–6 flow assertion (hive-loop-e2e P-011): unshipped staging work
    // older than the lag bar = the ship link is silently stuck (git-only; skips
    // with a note off the release host).
    // Consume-edges P-011: auto-implement dispatches whose worker died without
    // resolving — drives the open ledger row terminal ('orphaned') and signals
    // per affected item. Skips with a note until migration 238 is applied.
    {
      name: 'papercusp-orphaned-dispatch',
      collect: () => import('./orphaned-dispatch').then((m) => m.collectOrphanedDispatchSignals(workspaceId)),
    },
    // EI-2150: the DISPATCHER-STALL detector — the dispatcher itself stopped firing
    // (lastDispatchAt stale) while armed, never-dispatched work waits. The sibling
    // orphaned-dispatch collector only catches DEAD WORKERS on open rows; this catches
    // the lane going dark entirely. Skips with a note while disarmed / env-paused / the
    // ledger is absent (migration 238).
    {
      name: 'papercusp-dispatcher-staleness',
      collect: () =>
        import('./dispatcher-staleness').then((m) =>
          m.collectDispatcherStalenessSignals(workspaceId, {
            dispatcherStalenessThresholdHours: opts.dispatcherStalenessThresholdHours,
            // Mirror the dispatcher's armed inputs (EI-2150): without the install slug the
            // collector reads the runner env-only and skips as "disarmed" in the env-unset
            // config that caused the incident — going dark in the scenario it exists to watch.
            installSlug: opts.installSlug,
          }),
        ),
    },
    {
      name: 'papercusp-ship-link',
      collect: () => import('./ship-link').then((m) => m.collectShipLinkSignals()),
    },
    // Audit-as-sensors (self-learning-frontier P-047 / FB-21): the learning
    // system's own health KPIs as standing SLO collectors — a breach files
    // into the very queue it measures, kinds per FB-18's fidelity rules.
    // All five ride ONE dark flag (papercusp-learning-slo-sensors, D-001 —
    // each reports a 'dark' note while OFF), are SQL-only, and read their
    // thresholds from LEARNING_SLO_DEFAULTS / this tick's payload tunables.
    {
      name: 'papercusp-triage-entropy',
      collect: () => import('./learning-slo').then((m) => m.triageEntropyCollector(workspaceId, opts)),
    },
    {
      name: 'papercusp-capture-consume-flow',
      collect: () => import('./learning-slo').then((m) => m.captureConsumeFlowCollector(workspaceId, opts)),
    },
    {
      name: 'papercusp-mttsh-regression',
      collect: () => import('./learning-slo').then((m) => m.mttshRegressionCollector(opts)),
    },
    {
      name: 'papercusp-governor-starvation',
      collect: () => import('./learning-slo').then((m) => m.governorStarvationCollector(workspaceId, opts)),
    },
    {
      name: 'papercusp-memory-recall-zero-hit',
      collect: () => import('./learning-slo').then((m) => m.memoryZeroHitCollector(opts)),
    },
    // infra-perf-reliability-audit-round4 P-013: the perf/reliability regression rig —
    // snapshots four reliability SLO metrics (event-loop-lag p95, PG connection
    // saturation %, the dispatch-orphan rate that silently regressed to 91%, coord
    // open-escalation backlog) to harness_shared.perf_regression_snapshots and files on
    // a budget breach. Flag-gated on papercusp-perf-regression-rig (DEFAULT ON — reports
    // a 'disabled' note while OFF); SQL + in-memory only, additive + read-mostly,
    // dormant-tolerant (a missing table/metric is a note, never a throw).
    {
      name: 'papercusp-perf-regression',
      collect: () =>
        import('../../system-health/perf-regression-rig').then((m) => m.collectPerfRegressionSnapshot(workspaceId)),
    },
    // unified-work-item-ledger P-009: the recurrence guard for the P-003 silent-zero
    // promotion class — a started+eligible plan with open items but ZERO work-items.
    // Gated by papercusp-plan-workitem-promotion (reports a 'dark' note while OFF so it
    // is inert while promotion is dark). SQL-only, one workspace-scoped query.
    {
      name: 'papercusp-zero-promotion',
      collect: () => import('./zero-promotion-detect').then((m) => m.collectZeroPromotionSignals(workspaceId)),
    },
    // enforce-system-on-generic-work P-009: the "done without test" recurrence guard —
    // a feature work-item marked done (terminal/passed) that still carries requires_test
    // VAL(s) with no passing covering test. SQL-only (three workspace-scoped reads), no
    // flag gate (naturally inert where the inline-VAL flow is dark). One finding per
    // harness, count = number of flagged items.
    {
      name: 'papercusp-done-without-test',
      collect: () => import('./done-without-test-detect').then((m) => m.collectDoneWithoutTestSignals(workspaceId)),
    },
  ];
}

/**
 * Collect signals AND the per-collector status (watchdog-robustness P-001). The
 * status array is what makes a forever-failing collector visible — before this
 * the only trace of a rejected collector was a `console.warn` nobody tails.
 */
/**
 * Ephemeral benchmark / throwaway harness instances — the xbench fleet
 * (`xbench-su-*`, `xbq…` hive hashes), `*-DELETEME` memory-capacity probes, hive-loop
 * e2e harnesses, gym-eval sandboxes — spin up, churn, and are torn down constantly.
 * Their stalled features, unresolved git-sync escalations, and saturated-fleet governor
 * signals are TEST DEBRIS, not improvements: on 2026-06-17 they were ~94% of open
 * stalled-feature and 100% of open unresolved-escalation EIs, drowning the real signal.
 * Conservative pattern (only unmistakable throwaway markers) so a real harness slug —
 * papercup, papercup-org, papercup-hive, sheets, … — never matches.
 * (watchdog-embed-resilience-and-dedup-2026-06-17 P-006.)
 */
export const EPHEMERAL_BENCHMARK_SLUG_RE =
  /(^|[^a-z0-9])(xbench|xbq[a-z0-9]{6}|hiveloop|memcap|memrun)|-instance[_-]|_instance[_-]|deleteme|^e2e-imp|^sb-gym|gym-eval|^bench-|smoke-p[0-9]/i;

export function isEphemeralBenchmarkHarnessSlug(slug: string | null | undefined): boolean {
  return !!slug && EPHEMERAL_BENCHMARK_SLUG_RE.test(slug);
}

/** Per-harness watchdog sources whose signal is meaningless for a torn-down benchmark
 *  instance. Global code-health sources (red-test, repeated-tool-error, migration-drift,
 *  service-down, insight-staleness, …) are NEVER filtered — they are not per-harness. */
const HARNESS_SCOPED_WATCHDOG_SOURCES: ReadonlySet<WatchdogSource> = new Set([
  'stalled-feature', 'unresolved-escalation', 'escalation-spike', 'orphaned-spawn',
  'failed-spawn', 'stuck-plan', 'smoke-fail', 'fire-circuit-open', 'ship-link-stuck',
  'governor-starvation',
  // zero-promotion is per-plan/per-harness: a torn-down benchmark instance's
  // started plan firing is test debris, not an improvement (P-006 dedup class).
  'zero-promotion',
  // done-without-test is per-harness (scope harness:<slug>): a torn-down benchmark
  // instance's done-without-test items are test debris, not an improvement.
  'done-without-test',
]);

/** A signal is ephemeral-benchmark debris when it is a per-harness source AND any slug it
 *  carries (scope `harness:<slug>`, key, or title) matches the benchmark pattern. */
export function isEphemeralBenchmarkSignal(s: WatchdogSignal): boolean {
  if (!HARNESS_SCOPED_WATCHDOG_SOURCES.has(s.source)) return false;
  const slugFromScope = s.scope?.startsWith('harness:') ? s.scope.slice('harness:'.length) : '';
  return [slugFromScope, s.key, s.title].some((c) => isEphemeralBenchmarkHarnessSlug(c));
}

// ── P-008: the FIRST-CLASS ephemeral flag (harness_shared.projects.ephemeral) ──────
// The principled successor to the P-006 slug-regex: a harness explicitly marked
// ephemeral (set at creation / backfilled by migration 309) is debris regardless of
// its slug. The regex stays as the fallback for un-flagged rows.

/** The harness slug a per-harness signal is about (from scope `harness:<slug>`), or null. */
export function ephemeralSignalSlug(s: WatchdogSignal): string | null {
  if (!HARNESS_SCOPED_WATCHDOG_SOURCES.has(s.source)) return null;
  return s.scope?.startsWith('harness:') ? s.scope.slice('harness:'.length) : null;
}

/** Pure: a signal is ephemeral when the slug-regex matches (P-006) OR its harness slug is
 *  FLAGGED ephemeral in projects (P-008). The flag is authoritative; the regex is fallback. */
export function isEphemeralSignal(s: WatchdogSignal, ephemeralSlugs: ReadonlySet<string>): boolean {
  if (isEphemeralBenchmarkSignal(s)) return true;
  const slug = ephemeralSignalSlug(s);
  return slug != null && ephemeralSlugs.has(slug);
}

/** P-008 fail-soft IO: which of the candidate harness slugs are flagged ephemeral in PG.
 *  Returns empty on ANY error (incl. the `ephemeral` column not existing before migration
 *  309 lands) — so the filter degrades to the regex (P-006 behavior) until then. */
export async function readEphemeralFlaggedSlugs(slugs: string[]): Promise<Set<string>> {
  const unique = [...new Set(slugs.filter(Boolean))];
  if (unique.length === 0) return new Set();
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ slug: string }[]>`
      SELECT slug FROM harness_shared.projects
       WHERE ephemeral = true AND slug = ANY(${unique}::text[])`;
    return new Set(rows.map((r) => r.slug));
  } catch {
    return new Set(); // pre-migration column-missing / DB blip → regex-only fallback
  }
}

export async function collectWatchdogSignalsDetailed(
  workspaceId: string,
  opts: CollectOptions = {},
  collectors?: WatchdogCollector[],
): Promise<{ signals: WatchdogSignal[]; collectors: CollectorStatus[] }> {
  // (P-011) Use provided collectors or default to papercusp
  const activeCollectors = collectors ?? (await defaultPapercuspCollectors(workspaceId, opts));

  const settled = await Promise.allSettled(activeCollectors.map((c) => c.collect()));
  const signals: WatchdogSignal[] = [];
  const statuses: CollectorStatus[] = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    const name = activeCollectors[i]?.name ?? `collector[${i}]`;
    if (s.status === 'fulfilled') {
      // Normalize a bare array or the richer { signals, note } shape (P-004).
      const out = Array.isArray(s.value) ? { signals: s.value } : s.value;
      signals.push(...out.signals);
      statuses.push({ name, ok: true, signalCount: out.signals.length, ...(out.note ? { note: out.note } : {}) });
    } else {
      const error = s.reason instanceof Error ? s.reason.message : String(s.reason);
      console.warn(`[improvement-watchdog] collector "${name}" failed: ${error}`);
      statuses.push({ name, ok: false, signalCount: 0, error });
    }
  }
  // P-006/P-008: drop ephemeral benchmark-instance debris (xbench / *-DELETEME / gym-eval /
  // hive-loop) from the per-harness sources — torn-down test churn, not improvements. The
  // first-class projects.ephemeral flag (P-008) is authoritative; the slug-regex (P-006) is
  // the fallback. Fail-soft: a missing column (pre-migration-309) / DB blip degrades to the
  // regex. Counted into a synthetic collector status so the drop is visible, never silent.
  const ephemeralFlagged = await readEphemeralFlaggedSlugs(
    signals.map(ephemeralSignalSlug).filter((s): s is string => s != null),
  );
  const kept: WatchdogSignal[] = [];
  let benchmarkDropped = 0;
  for (const sig of signals) {
    if (isEphemeralSignal(sig, ephemeralFlagged)) benchmarkDropped++;
    else kept.push(sig);
  }
  if (benchmarkDropped > 0) {
    statuses.push({
      name: 'ephemeral-benchmark-filter',
      ok: true,
      signalCount: 0,
      note: `dropped ${benchmarkDropped} ephemeral-benchmark harness signal(s) — projects.ephemeral flag (P-008) + slug-regex (P-006) debris`,
    });
  }
  return { signals: kept, collectors: statuses };
}

/** Back-compat: signals only (delegates to the detailed collector). */
export async function collectWatchdogSignals(workspaceId: string, opts: CollectOptions = {}, collectors?: WatchdogCollector[]): Promise<WatchdogSignal[]> {
  return (await collectWatchdogSignalsDetailed(workspaceId, opts, collectors)).signals;
}

// ── P-013: signal-to-noise rollup for improvements:watchdog-status ────────────────
// Surfaces how much the ephemeral-benchmark filter dropped (P-006/P-008) and the
// per-class repeated-tool-error spread, so a classification regression (a class
// suddenly ballooning) or a noise spike is VISIBLE in the status tool, not buried in
// raw ticks. Pure — unit-tested. (watchdog-and-exposed-systems-improvement-2026-06-18.)
export interface WatchdogRollupTick {
  collectors?: Array<{ name: string; note?: string }>;
  knownOpenKeys?: string[];
}
export interface WatchdogRollup {
  /** Ephemeral-benchmark signals the filter dropped across the ticks (P-006/P-008). */
  benchmarkDropped: number;
  /** OPEN repeated-tool-error keys by class — structural | transient | caller | rate-limit | other. */
  toolErrorByClass: Record<string, number>;
}
export function rollupWatchdogTicks(ticks: readonly WatchdogRollupTick[]): WatchdogRollup {
  let benchmarkDropped = 0;
  const toolErrorByClass: Record<string, number> = {};
  for (const t of ticks) {
    for (const c of t.collectors ?? []) {
      if (c.name === 'ephemeral-benchmark-filter' && c.note) {
        const m = /dropped (\d+)/.exec(c.note);
        if (m) benchmarkDropped += Number(m[1]);
      }
    }
    for (const k of t.knownOpenKeys ?? []) {
      if (!k.startsWith('repeated-tool-error:')) continue;
      const cls = /:rate-limit$/.test(k)
        ? 'rate-limit'
        : /:transient$/.test(k)
          ? 'transient'
          : /:caller$/.test(k)
            ? 'caller'
            : /:structural$/.test(k) || /:structural:/.test(k)
              ? 'structural'
              : 'other';
      toolErrorByClass[cls] = (toolErrorByClass[cls] ?? 0) + 1;
    }
  }
  return { benchmarkDropped, toolErrorByClass };
}

/**
 * Default tick-record sink (watchdog-robustness P-001): one row per tick into
 * `harness_shared.watchdog_ticks`. Injectable via `WatchdogDeps.recordTick` so
 * unit tests observe the record without PG. The caller swallows its errors — a
 * bookkeeping failure must never abort the tick.
 */
export async function recordWatchdogTick(rec: WatchdogTickRecord): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.watchdog_ticks
      (workspace_id, install_slug, status, signals, captured, declined_duplicates, deferred, deferred_keys,
       known_open_keys, stale_resolved_keys, collectors, self_escalations)
    VALUES (${rec.workspaceId}, ${rec.installSlug ?? null}, ${rec.status}, ${rec.signals},
            ${rec.captured}::text[], ${rec.declinedDuplicates}, ${rec.deferred}, ${rec.deferredKeys ?? []}::text[],
            ${rec.knownOpenKeys ?? []}::text[], ${rec.staleResolvedKeys ?? []}::text[],
            ${JSON.stringify(rec.collectors)}::text::jsonb, ${rec.selfEscalations}::text[])
  `;
}

/**
 * Tick-retention prune (audit P-009): drop tick rows older than `olderThanDays`
 * for this workspace. Called best-effort at the end of each tick (same
 * swallow-errors contract as recordTick) — the table grew ~96 rows/day/host
 * unbounded with no GC before this.
 */
export async function pruneWatchdogTicks(workspaceId: string, olderThanDays: number): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    DELETE FROM harness_shared.watchdog_ticks
     WHERE workspace_id = ${workspaceId}
       AND tick_at < now() - make_interval(days => ${olderThanDays})`;
}

/** A prior tick, as read for the self-escalation streak (P-002). Newest-first. */
export interface RecentTick {
  status: 'ran' | 'skipped';
  collectors: CollectorStatus[];
  /** Keys deferred on that tick (P-009) — fed back as the escalation history. */
  deferredKeys?: string[];
}

/**
 * Default recent-ticks reader (P-002): the last `limit` ticks for a workspace,
 * newest-first. `filter.status` narrows to one status — the deferred-keys boost
 * reads `{ status: 'ran' }` so a skipped tick can't wipe it (audit P-011).
 */
export async function readRecentWatchdogTicks(
  workspaceId: string,
  limit: number,
  filter: { status?: 'ran' | 'skipped' } = {},
): Promise<RecentTick[]> {
  if (limit <= 0) return [];
  const { sql } = getOrgPg();
  const rows = await sql<{ status: 'ran' | 'skipped'; collectors: CollectorStatus[]; deferred_keys: string[] }[]>`
    SELECT status, collectors, deferred_keys
      FROM harness_shared.watchdog_ticks
     WHERE workspace_id = ${workspaceId}
       AND ${filter.status ? sql`status = ${filter.status}` : sql`TRUE`}
     ORDER BY tick_at DESC
     LIMIT ${limit}`;
  return rows.map((r) => ({
    status: r.status,
    collectors: Array.isArray(r.collectors) ? r.collectors : [],
    deferredKeys: Array.isArray(r.deferred_keys) ? r.deferred_keys : [],
  }));
}

/** One full tick row for the observability surface (audit P-010). */
export interface WatchdogTickStatusRow {
  tickAt: string;
  installSlug: string | null;
  status: 'ran' | 'skipped';
  signals: number;
  captured: string[];
  declinedDuplicates: number;
  deferred: number;
  deferredKeys: string[];
  knownOpenKeys: string[];
  staleResolvedKeys: string[];
  collectors: CollectorStatus[];
  selfEscalations: string[];
}

/**
 * Observability read (audit P-010): the last `limit` tick rows IN FULL — the
 * data backing `improvements:watchdog-status`. Before this the only consumer of
 * `watchdog_ticks` was the watchdog itself; diagnosing it took raw psql.
 */
export async function readWatchdogStatus(workspaceId: string, limit = 10): Promise<WatchdogTickStatusRow[]> {
  const { sql } = getOrgPg();
  const rows = await sql<{
    tick_at: Date | string;
    install_slug: string | null;
    status: 'ran' | 'skipped';
    signals: number;
    captured: string[];
    declined_duplicates: number;
    deferred: number;
    deferred_keys: string[];
    known_open_keys: string[];
    stale_resolved_keys: string[];
    collectors: CollectorStatus[];
    self_escalations: string[];
  }[]>`
    SELECT tick_at, install_slug, status, signals, captured, declined_duplicates, deferred,
           deferred_keys, known_open_keys, stale_resolved_keys, collectors, self_escalations
      FROM harness_shared.watchdog_ticks
     WHERE workspace_id = ${workspaceId}
     ORDER BY tick_at DESC
     LIMIT ${Math.min(Math.max(1, limit), 200)}`;
  return rows.map((r) => ({
    tickAt: r.tick_at instanceof Date ? r.tick_at.toISOString() : String(r.tick_at),
    installSlug: r.install_slug,
    status: r.status,
    signals: r.signals,
    captured: r.captured ?? [],
    declinedDuplicates: r.declined_duplicates,
    deferred: r.deferred,
    deferredKeys: r.deferred_keys ?? [],
    knownOpenKeys: r.known_open_keys ?? [],
    staleResolvedKeys: r.stale_resolved_keys ?? [],
    collectors: Array.isArray(r.collectors) ? r.collectors : [],
    selfEscalations: r.self_escalations ?? [],
  }));
}

/**
 * Pure (watchdog-robustness P-002 / D-003): which collectors have failed for
 * `failStreakToEscalate` CONSECUTIVE ticks (this tick + the most-recent priors),
 * and so should self-escalate. A tick counts toward a collector's streak only when
 * it OBSERVED that collector failing (`ok:false`); an absent collector or a
 * 'skipped' tick (no sweep) breaks the streak — we never saw it fail there.
 * `priorTicks` must be newest-first (the `readRecentWatchdogTicks` order).
 */
export function planSelfEscalations(
  thisTick: CollectorStatus[],
  priorTicks: RecentTick[],
  opts: { failStreakToEscalate?: number } = {},
): string[] {
  const need = Math.max(1, opts.failStreakToEscalate ?? 3);
  const escalate: string[] = [];
  for (const c of thisTick) {
    if (c.ok) continue;
    let streak = 1; // this tick observed it failing
    for (const t of priorTicks) {
      const prior = t.collectors.find((x) => x.name === c.name);
      if (prior && !prior.ok) streak += 1;
      else break;
    }
    if (streak >= need) escalate.push(c.name);
  }
  return escalate;
}

/**
 * The outcome of attempting to run the tick under the cross-host lock (P-003):
 * `{ ran:true, value }` when we held the lock (or fail-open ran unlocked), or
 * `{ ran:false }` when another host held it and we deferred the sweep.
 */
export type TickLockOutcome<T> = { ran: true; value: T } | { ran: false };

/**
 * The DIRECT (non-pooled) URL the tick lock connects on. Deliberately
 * `getHarnessAdminUrl()` — which does NOT route through `maybePgbouncer` — so the
 * lock NEVER rides the PgBouncer transaction pooler, even under PAPERCUSP_PGBOUNCER=1.
 * Exported so the P-001 regression test can assert this invariant (transaction
 * pooling would silently break a session-level advisory lock; see below).
 */
export function watchdogTickLockUrl(): string {
  return getHarnessAdminUrl();
}

/**
 * Dedicated DIRECT `max:1` admin connection for the cross-host tick lock
 * (backend-connection-scaling-2026-06-17 P-001).
 *
 * The tick mutex is a SESSION-level `pg_advisory_lock` whose acquire and release
 * MUST hit the same backend. Under PgBouncer transaction pooling
 * (PAPERCUSP_PGBOUNCER=1) `getOrgPg().sql` routes through the pooler, where each
 * statement is its own transaction and consecutive statements (lock → … → unlock)
 * can land on DIFFERENT server backends → the `pg_advisory_unlock` misses, the lock
 * LEAKS on the original backend, and every subsequent tick fails to acquire →
 * `{ ran:false }` forever → the watchdog SILENTLY STOPS SWEEPING. So the lock rides
 * its OWN dedicated direct connection (bypasses `maybePgbouncer`, exactly like the
 * LISTEN buses do), pinning one stable backend for the lock's whole lifetime.
 *
 * Cost: ONE extra direct backend per process, lazily opened only on hosts that
 * actually run the watchdog (bg-host / :3070) — it does NOT reintroduce the
 * org-pool bloat that C2 cures. `idle_timeout:0` keeps the session alive between
 * ticks (an idle-closed session would drop the lock). Correct in BOTH modes: a
 * direct connection always has a stable session, so there is no PgBouncer-on/off
 * behavioral fork.
 */
let _tickLockSql: Sql | null = null;
function tickLockSql(): Sql {
  if (!_tickLockSql) {
    _tickLockSql = postgres(watchdogTickLockUrl(), {
      onnotice: () => {},
      max: 1,
      idle_timeout: 0, // never idle-close: an idle-closed session drops the advisory lock
      connection: {
        application_name: `pcusp:watchdog-ticklock:p${process.pid}`.slice(0, 63),
      },
    });
  }
  return _tickLockSql;
}

/** Test-only — close + drop the dedicated tick-lock connection between cases. */
export async function _closeWatchdogTickLockForTests(): Promise<void> {
  if (_tickLockSql) {
    await _tickLockSql.end({ timeout: 1 }).catch(() => {});
    _tickLockSql = null;
  }
}

/**
 * Run `fn` while holding the cross-host watchdog advisory lock (watchdog-robustness
 * P-003 / D-004). Two operator hosts (`:3070` + `:3170`, or a deploy overlap) can
 * fire `system:improvement-watchdog` against the ONE shared DB; without this they
 * both sweep and the capture core's search-then-create races into duplicate
 * captures. We hold a SESSION advisory lock on a reserved connection for the whole
 * tick (the captures themselves run on the pool — the lock is just the mutex).
 *
 * The lock connection is a dedicated DIRECT (non-pooled) admin connection — see
 * `tickLockSql()` for WHY (a session advisory lock breaks under PgBouncer
 * transaction pooling; backend-connection-scaling-2026-06-17 P-001).
 *
 * `{ ran:false }` ⇒ another host owns this tick → the caller records a skipped tick.
 * FAIL-OPEN: if the lock plumbing itself errors (can't reserve / lock query fails),
 * run `fn` unlocked — a missed mutex is better than a missed sweep. A `fn` error is
 * NEVER swallowed or double-run; it propagates cleanly.
 */
export async function withWatchdogTickLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<TickLockOutcome<T>> {
  let reserved: Awaited<ReturnType<ReturnType<typeof tickLockSql>['reserve']>>;
  try {
    reserved = await tickLockSql().reserve();
  } catch (e) {
    console.warn(`[improvement-watchdog] could not reserve a connection for the tick lock, running unlocked (fail-open): ${e instanceof Error ? e.message : e}`);
    return { ran: true, value: await fn() };
  }

  let acquired = false;
  let lockErrored = false;
  try {
    try {
      const rows = await reserved<{ ok: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtext('improvement-watchdog'), hashtext(${workspaceId})) AS ok`;
      if (rows[0]?.ok) acquired = true;
    } catch (e) {
      lockErrored = true;
      console.warn(`[improvement-watchdog] advisory-lock query failed, running unlocked (fail-open): ${e instanceof Error ? e.message : e}`);
    }
    if (lockErrored) return { ran: true, value: await fn() };
    if (!acquired) return { ran: false };
    return { ran: true, value: await fn() };
  } finally {
    if (acquired) {
      await reserved`SELECT pg_advisory_unlock(hashtext('improvement-watchdog'), hashtext(${workspaceId}))`.catch(() => {});
    }
    reserved.release();
  }
}

export interface WatchdogTickResult {
  /** 'ran' = swept + captured; 'skipped' = another host held the cross-host lock (P-003). */
  status: 'ran' | 'skipped';
  signals: number;
  captured: string[];
  declinedDuplicates: number;
  deferred: number;
  /** `${source}:${key}` of each deferred signal this tick (P-009 deferred-escalation). */
  deferredKeys?: string[];
  /** Signals dropped pre-plan: their key matches an OPEN improvement (audit P-004 / D-001). */
  knownOpen: number;
  knownOpenKeys: string[];
  /** Signals dropped pre-plan: resolved dup + evidence pre-dating the resolution (audit P-005 / D-002). */
  staleResolved: number;
  staleResolvedKeys: string[];
  /** Per-collector outcomes this tick (P-001) — the read path for self-escalation (P-002). */
  collectors: CollectorStatus[];
  /** Improvement ids the watchdog filed about its OWN broken collectors (P-002). */
  selfEscalations: string[];
  /**
   * Issue ids escalated by known-open AGING this tick (consume-edges P-020 /
   * EI-363). Not persisted on the tick row — the durable trace is the item's
   * `payload.knownOpenAging` stamp + the coord escalation record + the comment.
   */
  agingEscalations: string[];
}

/** Options the tick accepts beyond planning/collection (P-001 install slug). */
export interface WatchdogTickOptions extends WatchdogPlanOptions, CollectOptions, KnownOpenAgingTickTunables {
  /** The routine's install slug, recorded on the tick (observability only). */
  installSlug?: string | null;
  /** Consecutive failing ticks before a collector self-escalates (P-002). Default 3. */
  failStreakToEscalate?: number;
  /** Max self-escalations filed per tick (P-002, anti-flood). Default 1. */
  maxSelfEscalationsPerTick?: number;
  /** Tick rows older than this are pruned at the end of each tick (audit P-009). Default 14. */
  tickRetentionDays?: number;
}

/** The collect/capture/record deps a tick body runs with, already resolved. */
interface ResolvedTickDeps {
  capture: typeof captureImprovement;
  recordTick: (rec: WatchdogTickRecord) => Promise<void>;
  readRecentTicks: (workspaceId: string, limit: number, filter?: { status?: 'ran' | 'skipped' }) => Promise<RecentTick[]>;
  readKeyDups: (keys: string[]) => Promise<WatchdogKeyDup[]>;
  pruneTicks: (workspaceId: string, olderThanDays: number) => Promise<void>;
  processAging: (workspaceId: string, knownOpenKeys: string[], opts: WatchdogTickOptions) => Promise<KnownOpenAgingOutcome[]>;
  processAutoClose: (workspaceId: string, opts: WatchdogTickOptions) => Promise<AutoCloseOutcome[]>;
  collect?: () => Promise<WatchdogSignal[]>;
  collectors?: WatchdogCollector[];
}

/**
 * One watchdog tick: collect → plan (cap) → capture each through the shared core
 * (`dedupScope:'open'` — an open duplicate declines; a resolved one re-files the
 * regression) → self-escalate a persistently-failing collector (P-002) → record
 * the tick (P-001, best-effort). The cross-host lock (P-003) wraps this — see
 * `runWatchdogTick`.
 */
async function runWatchdogTickBody(
  workspaceId: string,
  opts: WatchdogTickOptions,
  deps: ResolvedTickDeps,
): Promise<WatchdogTickResult> {
  const { capture, recordTick, readRecentTicks, readKeyDups, pruneTicks } = deps;

  // Collect signals + per-collector status. When a test injects `collect` we lose
  // per-collector granularity (the seam returns signals only), so synthesize one
  // 'injected' status so the tick record is still coherent.
  let signals: WatchdogSignal[];
  let collectors: CollectorStatus[];
  if (deps.collect) {
    signals = await deps.collect();
    collectors = [{ name: 'injected', ok: true, signalCount: signals.length }];
  } else {
    const detailed = await collectWatchdogSignalsDetailed(workspaceId, opts, deps.collectors);
    signals = detailed.signals;
    collectors = detailed.collectors;
  }

  // P-004 / D-001 pre-filter: ONE indexed lookup over payload.watchdogKey drops
  // signals that are already filed (OPEN dup) or whose evidence pre-dates the
  // matching resolution (P-005 / D-002) BEFORE planning — so a standing signal
  // never consumes the per-tick capture budget (live evidence: every slot burned
  // on declined title-dups for a whole 24h window). Best-effort: a read failure
  // degrades to the old behavior (everything planned, title net catches dups).
  let partition: SignalPartition = { fresh: signals, knownOpen: [], staleResolved: [] };
  if (signals.length > 0) {
    try {
      const dups = await readKeyDups([...new Set(signals.map(watchdogKeyOf))]);
      partition = partitionSignalsByKnownKeys(signals, dups);
    } catch (e) {
      console.warn(`[improvement-watchdog] key-dup pre-filter failed (degrading to title dedup): ${e instanceof Error ? e.message : e}`);
    }
  }

  // Known-open AGING (consume-edges P-020 / EI-363): the pre-filter above is
  // correct dedup, but it made persistence FREE — a known-open key could fire
  // every tick for days with zero added pressure. Continuous firing past the
  // aging threshold bumps the open item's severity once and coord:escalate's
  // the owner (infra-class keys on the short threshold per D-002; re-escalation
  // capped weekly). Best-effort — an aging failure never aborts the tick; a
  // tick with no known-open signals does zero extra reads.
  let agingEscalations: string[] = [];
  if (partition.knownOpen.length > 0) {
    try {
      const outcomes = await deps.processAging(workspaceId, partition.knownOpen.map(watchdogKeyOf), opts);
      agingEscalations = outcomes.map((o) => o.issueId);
    } catch (e) {
      console.warn(`[improvement-watchdog] known-open aging failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // P-009 (auto-close lifecycle): retire watchdog-sourced EIs whose signal cleared
  // (absent from the recent ran-ticks' known-open keys). DEFAULT-OFF flag-gated inside;
  // best-effort — an auto-close failure never aborts the tick.
  try {
    await deps.processAutoClose(workspaceId, opts);
  } catch (e) {
    console.warn(`[improvement-watchdog] auto-close failed: ${e instanceof Error ? e.message : e}`);
  }

  // P-009 deferred-escalation: feed the last RAN tick's deferred keys so a signal
  // that keeps losing a slot is boosted until it lands. Reading status='ran'
  // specifically means a 'skipped' tick (cross-host lock loser, empty deferred
  // list) cannot wipe the boost (audit P-011). Only when there is CONTENTION
  // (more fresh signals than the cap can admit) is the boost meaningful — so a
  // healthy/quiet tick still does zero PG reads (the P-002 no-read-when-healthy
  // invariant). Best-effort — a read failure just means no escalation this tick.
  const planCap = Math.max(0, opts.maxPerTick ?? 3);
  const priorDeferredKeys = partition.fresh.length > planCap
    ? await readRecentTicks(workspaceId, 1, { status: 'ran' }).then((t) => t[0]?.deferredKeys ?? []).catch(() => [] as string[])
    : [];
  const plan = planWatchdogCaptures(partition.fresh, { ...opts, priorDeferredKeys });
  const captured: string[] = [];
  let declinedDuplicates = 0;
  for (const s of plan.toCapture) {
    let res: CaptureImprovementResult;
    try {
      res = await capture({
        title: s.title,
        kind: s.kind ?? 'bug',
        body: s.body,
        severity: s.severity,
        paths: s.paths,
        // Explicit scope (consume-edges P-021): the D-005 triage taxonomy keys off it.
        // allow-scope-default: 'operator' is the explicit top-level improvement scope (not a workspace).
        scope: s.scope ?? 'operator',
        foundDuring: 'improvement-watchdog',
        createdBy: 'system:improvement-watchdog',
        sourceRole: 'system',
        source: 'su',
        dedupScope: 'open',
        // P-004: the stable identity the NEXT tick's pre-filter matches on.
        watchdogKey: watchdogKeyOf(s),
        // P-005: the title net's resolved dups also gate on evidence recency.
        evidenceAt: s.latestAt,
        // Frontier P-002: provenance rides from the signal into the row (default organic).
        origin: s.origin,
        // Frontier P-044: the taxonomy slug graduation counts clean passes by.
        findingClass: s.findingClass,
      });
    } catch (e) {
      console.warn(`[improvement-watchdog] capture failed for ${s.source}:${s.key}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (res.created && res.issue) captured.push(res.issue.id);
    else if (res.reason === 'likely-duplicate' || res.reason === 'stale-evidence') declinedDuplicates += 1;
  }

  // P-002: the watchdog watches itself. If a collector is failing THIS tick, check
  // whether it has now failed `failStreakToEscalate` consecutive ticks and, if so,
  // file ONE kind=bug capture about it through the same core (a forever-failing
  // collector is exactly the kind of broken-thing the watchdog exists to surface).
  // Skipped entirely when nothing failed this tick — no PG read in the healthy case.
  const selfEscalations: string[] = [];
  if (collectors.some((c) => !c.ok)) {
    const failStreak = Math.max(1, opts.failStreakToEscalate ?? 3);
    const maxSelf = Math.max(0, opts.maxSelfEscalationsPerTick ?? 1);
    try {
      const priors = failStreak > 1 ? await readRecentTicks(workspaceId, failStreak - 1) : [];
      const toEscalate = planSelfEscalations(collectors, priors, { failStreakToEscalate: failStreak }).slice(0, maxSelf);
      for (const name of toEscalate) {
        const failed = collectors.find((c) => c.name === name);
        try {
          const res = await capture({
            title: `Watchdog collector "${name}" is failing`,
            kind: 'bug',
            body:
              `The self-improvement watchdog collector "${name}" has failed ${failStreak} consecutive ticks — ` +
              `its signal feed is dark until it is fixed.\n\nLatest error: ${failed?.error ?? '(none captured)'}`,
            severity: 'major',
            paths: ['packages/operator-core/lib/harness/improvements/watchdog.ts'],
            foundDuring: 'improvement-watchdog',
            createdBy: 'system:improvement-watchdog',
            sourceRole: 'system',
            source: 'su',
            dedupScope: 'open',
            watchdogKey: `watchdog-self:${name}`,
          });
          if (res.created && res.issue) selfEscalations.push(res.issue.id);
        } catch (e) {
          console.warn(`[improvement-watchdog] self-escalation capture failed for ${name}: ${e instanceof Error ? e.message : e}`);
        }
      }
    } catch (e) {
      console.warn(`[improvement-watchdog] self-escalation skipped (recent-ticks read failed): ${e instanceof Error ? e.message : e}`);
    }
  }

  const result: WatchdogTickResult = {
    status: 'ran',
    signals: signals.length,
    captured,
    declinedDuplicates,
    deferred: plan.deferred.length,
    deferredKeys: plan.deferred.map((s) => `${s.source}:${s.key}`),
    knownOpen: partition.knownOpen.length,
    knownOpenKeys: partition.knownOpen.map(watchdogKeyOf),
    staleResolved: partition.staleResolved.length,
    staleResolvedKeys: partition.staleResolved.map(watchdogKeyOf),
    collectors,
    selfEscalations,
    agingEscalations,
  };

  // P-001: record the tick (best-effort — a bookkeeping failure never aborts it).
  try {
    await recordTick({
      workspaceId,
      installSlug: opts.installSlug ?? null,
      status: result.status,
      signals: result.signals,
      captured: result.captured,
      declinedDuplicates: result.declinedDuplicates,
      deferred: result.deferred,
      deferredKeys: result.deferredKeys,
      knownOpenKeys: result.knownOpenKeys,
      staleResolvedKeys: result.staleResolvedKeys,
      collectors: result.collectors,
      selfEscalations: result.selfEscalations,
    });
  } catch (e) {
    console.warn(`[improvement-watchdog] tick record failed: ${e instanceof Error ? e.message : e}`);
  }

  // P-009 (audit): prune old tick rows — best-effort, same swallow-errors
  // contract as recordTick; a GC failure must never abort the tick.
  try {
    await pruneTicks(workspaceId, Math.max(1, opts.tickRetentionDays ?? 14));
  } catch (e) {
    console.warn(`[improvement-watchdog] tick prune failed: ${e instanceof Error ? e.message : e}`);
  }

  return result;
}

/**
 * Run one watchdog tick under the cross-host advisory lock (P-003). If another
 * host holds the lock this tick is SKIPPED (a `skipped` tick is recorded) so the
 * two hosts can't double-sweep and race the capture core into duplicate captures.
 * (P-011) Accepts optional collectors for per-target-project sources.
 */
export async function runWatchdogTick(
  workspaceId: string,
  opts: WatchdogTickOptions = {},
  deps?: Partial<WatchdogDeps> & { collectors?: WatchdogCollector[] },
): Promise<WatchdogTickResult> {
  const capture = deps?.capture ?? captureImprovement;
  const recordTick = deps?.recordTick ?? recordWatchdogTick;
  const readRecentTicks = deps?.readRecentTicks ?? readRecentWatchdogTicks;
  const withLock = deps?.withTickLock ?? withWatchdogTickLock;
  const readKeyDups = deps?.readKeyDups ?? readWatchdogKeyDups;
  const pruneTicks = deps?.pruneTicks ?? pruneWatchdogTicks;
  const processAging = deps?.processAging
    ?? ((ws: string, keys: string[], o: WatchdogTickOptions) => processKnownOpenAging(ws, keys, agingOptionsFromTick(o)));
  const processAutoClose = deps?.processAutoClose
    ?? ((ws: string, _o: WatchdogTickOptions) => runAutoCloseSweep(ws));

  const outcome = await withLock(workspaceId, () =>
    runWatchdogTickBody(workspaceId, opts, {
      capture,
      recordTick,
      readRecentTicks,
      readKeyDups,
      pruneTicks,
      processAging,
      processAutoClose,
      collect: deps?.collect,
      collectors: deps?.collectors,
    }),
  );
  if (outcome.ran) return outcome.value;

  // Another host owns this tick — record a skipped tick and return (P-003).
  const skipped: WatchdogTickResult = {
    status: 'skipped',
    signals: 0,
    captured: [],
    declinedDuplicates: 0,
    deferred: 0,
    knownOpen: 0,
    knownOpenKeys: [],
    staleResolved: 0,
    staleResolvedKeys: [],
    collectors: [],
    selfEscalations: [],
    agingEscalations: [],
  };
  try {
    await recordTick({ workspaceId, installSlug: opts.installSlug ?? null, ...skipped });
  } catch (e) {
    console.warn(`[improvement-watchdog] skipped-tick record failed: ${e instanceof Error ? e.message : e}`);
  }
  return skipped;
}

// ── P-012 (audit): routine-tunable options ───────────────────────────────────

/** The numeric tick options tunable from the routine's `payload_template` (audit P-012).
 *  Exported so the `improvements:set-watchdog-tunables` control tool
 *  (live-configurability-audit P-004) validates writes against the same whitelist. */
export const PAYLOAD_TUNABLE_KEYS = [
  // planning caps
  'maxPerTick', 'perSourceCap',
  // collector bars (CollectOptions)
  'redTestWindowHours', 'redTestMinFails', 'toolErrorWindowHours', 'structuralMinCount',
  'structuralMinRate', 'structuralMinCallsForRate', 'transientMinCount', 'callerMinCount',
  'serviceHealthMaxStaleMs', 'smokeFailRecentHours', 'expiredLeaseWindowDays',
  'expiredLeaseMinCount', 'failedSpawnWindowHours', 'failedSpawnMinCount',
  // dispatcher-staleness (EI-2150): hours the auto-implement dispatcher may go silent
  // while armed work waits before the lane is flagged stalled
  'dispatcherStalenessThresholdHours',
  // self-escalation + retention
  'failStreakToEscalate', 'maxSelfEscalationsPerTick', 'tickRetentionDays',
  // known-open aging (consume-edges P-020 — D-004 PROPOSED defaults, tunable here
  // so the ratified values land via the routine payload without a deploy)
  'agingGeneralThresholdHours', 'agingInfraThresholdHours', 'agingReescalateDays',
  'agingContinuityGapMinutes', 'maxAgingEscalationsPerTick',
  // learning-SLO sensor thresholds (frontier P-047 / FB-21 — defaults in
  // learning-slo.ts LEARNING_SLO_DEFAULTS; tunable here so SLO tuning never
  // needs a deploy)
  'triageEntropyWindowDays', 'triageEntropyMinSample', 'triageEntropyMinNormalized',
  'flowWindowDays', 'flowMinInflow', 'flowMaxRatio',
  'mttshRecentDays', 'mttshBaselineDays', 'mttshMinSamples', 'mttshMaxRegressionFactor',
  'governorStarvationFloorUsd',
  'memoryZeroHitRecentHours', 'memoryZeroHitBaselineDays', 'memoryZeroHitMinRecalls',
  'memoryZeroHitMaxRate', 'memoryZeroHitSpikeFactor',
] as const;

/**
 * Pure (audit P-012): extract the numeric tick tunables from a routine's
 * `payload_template`, so collector bars + caps tune from the routines admin
 * WITHOUT a deploy. Whitelisted keys only; non-numeric values are ignored
 * (collector defaults hold). Env (`PAPERCUSP_IMPROVEMENT_WATCHDOG_MAX_PER_TICK`)
 * still wins over the payload for maxPerTick — env is the emergency override,
 * the payload is the standing config.
 */
export function watchdogOptionsFromPayload(payload: Record<string, unknown> | null | undefined): Partial<WatchdogTickOptions> {
  const out: Record<string, number> = {};
  if (!payload) return out;
  for (const k of PAYLOAD_TUNABLE_KEYS) {
    const v = payload[k];
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (Number.isFinite(n)) out[k] = n;
  }
  return out as Partial<WatchdogTickOptions>;
}
