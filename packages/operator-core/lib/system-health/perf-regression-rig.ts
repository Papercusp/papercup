/**
 * perf-regression-rig.ts — the perf/reliability REGRESSION RIG + SLO budgets
 * (infra-perf-reliability-audit-round4-2026-06-19 P-013).
 *
 * The round-2/3/4 perf work won real reliability gains, but nothing STOOD WATCH on
 * them — the dispatch-orphan rate silently crept to 91% with no alarm because no
 * standing budget evaluated it. This rig closes that gap: a periodic SNAPSHOT of the
 * four key reliability SLO metrics, persisted to PG and evaluated against
 * PERF_REGRESSION_BUDGETS, filing a watchdog signal on every breach so a regression
 * surfaces as a captured improvement instead of a forensic slog.
 *
 * The tracked metrics:
 *   1. event-loop-lag p95 (ms)   — `currentLoopLag().p95Ms`, the per-thread saturation
 *                                  signal (reuses perf-budgets.ts PERF_BUDGETS thresholds).
 *   2. PG connection saturation  — `pgHealth().saturationPct` (server-wide).
 *   3. dispatch-orphan rate      — % of recent improvement_dispatches that orphaned from
 *                                  GENUINE LANE BREAKAGE over a recent window (excludes
 *                                  benign host-restart / worker-timeout / context-overflow /
 *                                  env deaths — the same `isLaneBreakageOrphan` predicate the
 *                                  orphan collector uses, so the SLO and the collector can't
 *                                  drift: EI-7534 was a false crit-breach because this rate
 *                                  counted all outcome='orphaned' rows). THE one that silently
 *                                  regressed to 91% — the rig's reason to exist.
 *   4. coord backlog             — open-escalation count (coord_open_escalations).
 *   5. /adv tab switch median    — app-side time to selected tab (EI-3034).
 *   6. /adv first contentful paint — app-side boot FCP (EI-3034).
 *
 * ADDITIVE + READ-MOSTLY: it reads existing instruments and INSERTs one snapshot row;
 * it changes no serving behavior. DORMANT-TOLERANT by contract — a missing table or an
 * unavailable metric returns a graceful note (never throws), so it degrades to a
 * partial snapshot rather than breaking the watchdog tick it rides.
 *
 * Pattern mirrors learning-slo.ts: a PURE-FN CORE (metrics → breaches → signals,
 * `evaluatePerfRegression`, exported for deterministic unit tests) + a THIN IO WRAPPER
 * (`collectPerfRegressionSnapshot`) over an injectable deps seam. Flag-gated on
 * FLAGS.PERF_REGRESSION_RIG (DEFAULT ON — the darkOrNull idiom INVERTED: it runs when
 * the flag is ON and reports a 'disabled' note when OFF).
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { currentLoopLag } from '../event-loop-lag-monitor';
import { pgHealth } from '../dev-data';
import { PERF_BUDGETS } from './perf-budgets';
import type { CollectorResult, WatchdogSignal } from '../harness/improvements/watchdog';
import type { ImprovementDispatchRow, DispatchOutcome } from '../harness/improvements/dispatch-ledger';
import { isLaneBreakageOrphan } from '../harness/improvements/orphaned-dispatch';

// ── SLO budgets (exported tunables) ──────────────────────────────────────────
//
// Two tiers per metric — `Warn` (severity major) and `Crit` (severity critical).
// The event-loop-lag budget REUSES perf-budgets.ts PERF_BUDGETS so the two surfaces
// can't drift: the crit reuses eventLoopLagP95CritMs (1000ms — the live-wedge band),
// the warn is the round-4 elevated band (600ms — the loop-pressure CRITICAL_P95_MS),
// which sits above PERF_BUDGETS.eventLoopLagP95WarnMs (250ms, the per-thread-health
// panel's sensitive warn) because a STANDING regression alarm wants the wedge band,
// not the every-blip band.

export interface PerfRegressionBudgets {
  /** event-loop-lag p95 (ms): major at/above this. Default 600 (the round-4 elevated band). */
  loopLagP95WarnMs: number;
  /** event-loop-lag p95 (ms): critical at/above this. Default PERF_BUDGETS.eventLoopLagP95CritMs (1000). */
  loopLagP95CritMs: number;
  /** PG server-wide saturation %: major at/above this. Default 85 (the danger zone). */
  connSaturationWarnPct: number;
  /** PG server-wide saturation %: critical at/above this. Default 92 (near the shed threshold). */
  connSaturationCritPct: number;
  /** dispatch-orphan rate (0..1): major at/above this. Default 0.30. */
  dispatchOrphanRateWarnPct: number;
  /** dispatch-orphan rate (0..1): critical at/above this. Default 0.60 (the 91% incident band). */
  dispatchOrphanRateCritPct: number;
  /** coord open-escalation backlog: major at/above this. Default 2000. */
  coordOpenEscalationsWarn: number;
  /** coord open-escalation backlog: critical at/above this. Default 8000. */
  coordOpenEscalationsCrit: number;
  /** /adv tab-switch median latency (ms): major at/above this. Default 500. */
  advTabSwitchMedianWarnMs: number;
  /** /adv tab-switch median latency (ms): critical at/above this. Default 1000. */
  advTabSwitchMedianCritMs: number;
  /** /adv first-contentful-paint (ms): major at/above this. Default 2500. */
  advFcpWarnMs: number;
  /** /adv first-contentful-paint (ms): critical at/above this. Default 4000. */
  advFcpCritMs: number;
  /** orphan-rate min dispatch sample before the SLO applies (a rate over 2 rows is noise). Default 20. */
  dispatchOrphanMinSample: number;
  /** dispatch-orphan recent window (hours). Default 24. */
  dispatchOrphanWindowHours: number;
}

export const PERF_REGRESSION_BUDGETS: PerfRegressionBudgets = {
  // reuse perf-budgets.ts for the lag CRIT so the regression rig and the per-thread
  // health panel share ONE crit threshold; the warn is the round-4 elevated band.
  loopLagP95WarnMs: 600,
  loopLagP95CritMs: PERF_BUDGETS.eventLoopLagP95CritMs, // 1000
  connSaturationWarnPct: 85,
  connSaturationCritPct: 92,
  dispatchOrphanRateWarnPct: 0.3,
  dispatchOrphanRateCritPct: 0.6,
  coordOpenEscalationsWarn: 2000,
  coordOpenEscalationsCrit: 8000,
  // EI-3034 baselines captured under load: tab-switch median 253ms (per-tab
  // 132-379ms), FCP ~1923ms. Warn budgets leave headroom above those medians;
  // tails still need quiet-window confirmation before tail SLOs are added.
  advTabSwitchMedianWarnMs: 500,
  advTabSwitchMedianCritMs: 1000,
  advFcpWarnMs: 2500,
  advFcpCritMs: 4000,
  dispatchOrphanMinSample: 20,
  dispatchOrphanWindowHours: 24,
};

// ── the metric bundle (the pure core's input) ────────────────────────────────

/**
 * The four reliability SLO metrics for one tick. A `null` metric = unavailable this
 * tick (no monitor running, a missing table) — the evaluator simply skips it (it
 * cannot breach a budget it has no value for), and the IO wrapper carries a note.
 */
export interface PerfRegressionMetrics {
  /** event-loop-lag p95 (ms), or null when no monitor is running on this thread. */
  loopLagP95Ms: number | null;
  /** PG server-wide saturation %, or null when pgHealth() was unreadable. */
  connSaturationPct: number | null;
  /** dispatch-orphan rate (0..1), or null when below the min sample / the table is absent. */
  dispatchOrphanRate: number | null;
  /** dispatch rows behind the orphan rate (the sample size the rate is over). */
  dispatchSample: number;
  /** coord open-escalation backlog, or null when the table is absent. */
  coordOpenEscalations: number | null;
  /** /adv tab-switch median latency (ms), or null when no app perf sample is available. */
  advTabSwitchMedianMs: number | null;
  /** /adv first-contentful-paint (ms), or null when no app perf sample is available. */
  advFcpMs: number | null;
}

/** One budget breach (also the JSONB shape persisted in `breached`). */
export interface PerfRegressionBreach {
  metric:
    | 'loop-lag-p95'
    | 'conn-saturation'
    | 'dispatch-orphan-rate'
    | 'coord-open-escalations'
    | 'adv-tab-switch-median'
    | 'adv-fcp';
  /** The measured value that breached. */
  value: number;
  /** The budget threshold it crossed. */
  budget: number;
  tier: 'warn' | 'crit';
}

// ── the pure core ─────────────────────────────────────────────────────────────

const SHARED_REMEDIATION =
  'Snapshot persisted to harness_shared.perf_regression_snapshots; ' +
  'compare against the recent series (perf_regression_snapshots, newest first) to see when it regressed. ' +
  'Budgets: packages/operator-core/lib/system-health/perf-regression-rig.ts (PERF_REGRESSION_BUDGETS).';

/** Pure: per-metric remediation pointer for the signal body. */
function remediationFor(metric: PerfRegressionBreach['metric']): string {
  switch (metric) {
    case 'loop-lag-p95':
      return 'The request event loop is saturated — a synchronous CPU block on the main thread. ' +
        'Enable the lag-triggered CPU profiler (PAPERCUSP_LOOP_PROFILER=1) to find the culprit frames ' +
        '(event-loop-lag-monitor.ts).';
    case 'conn-saturation':
      return 'PG connection pool is saturating — check the top holders by application_name ' +
        '(dev:pg_health byApplication) for a leaking/un-pooled path; the connection-pressure governor ' +
        'sheds at 90% but a sustained climb means a real leak.';
    case 'dispatch-orphan-rate':
      return 'Auto-implement dispatches are dying without resolving (the silently-regressed metric ' +
        'this rig exists to catch — it hit 91% once). Check the dispatcher + worker-death path: the ' +
        'orphaned-dispatch / dispatcher-staleness collectors and the improvement_dispatches ledger.';
    case 'coord-open-escalations':
      return 'The coord escalation backlog is unbounded — escalations are being filed faster than ' +
        'they are resolved. Drain the inbox (coord:escalations) or check for a stuck escalation source.';
    case 'adv-tab-switch-median':
      return 'The /adv shell tab-switch path has regressed — reproduce with the agent-e2e /adv tab sweep ' +
        'in a quiet window (load1 < 24) and inspect route/layout work on the slowest tab.';
    case 'adv-fcp':
      return 'The /adv boot path first-contentful-paint has regressed — reproduce with the agent-e2e boot ' +
        'sample in a quiet window and inspect bundle/code-split/static-serve regressions.';
  }
}

/**
 * Pure: evaluate the metric bundle against the budgets and produce one WatchdogSignal
 * per breach (crit before warn per metric — a metric emits at most ONE signal, its
 * worst tier). A null metric is skipped (no value ⇒ no breach). Every signal is
 * LIVE-STATE (no `latestAt`): a breach that still holds after its filed item resolved
 * is a genuine regression, so the post-resolve re-file is always legitimate (the
 * watchdog-audit P-005 semantics the learning-SLO collectors use).
 */
export function evaluatePerfRegression(
  metrics: PerfRegressionMetrics,
  budgets: PerfRegressionBudgets = PERF_REGRESSION_BUDGETS,
): { signals: WatchdogSignal[]; breaches: PerfRegressionBreach[] } {
  const breaches: PerfRegressionBreach[] = [];
  const signals: WatchdogSignal[] = [];

  const consider = (
    metric: PerfRegressionBreach['metric'],
    value: number | null,
    warn: number,
    crit: number,
    key: string,
    title: string,
    describe: (v: number, budget: number, tier: 'warn' | 'crit') => string,
  ): void => {
    if (value === null || !Number.isFinite(value)) return;
    let tier: 'warn' | 'crit' | null = null;
    let budget = warn;
    if (value >= crit) {
      tier = 'crit';
      budget = crit;
    } else if (value >= warn) {
      tier = 'warn';
      budget = warn;
    }
    if (tier === null) return;
    breaches.push({ metric, value, budget, tier });
    signals.push({
      source: 'perf-regression',
      key,
      title,
      body:
        `Watchdog signal (perf-regression): ${describe(value, budget, tier)}\n\n` +
        `${remediationFor(metric)}\n\n${SHARED_REMEDIATION}`,
      severity: tier === 'crit' ? 'critical' : 'major',
      kind: 'bug',
      findingClass: `perf-regression:${metric}`,
    });
  };

  consider(
    'loop-lag-p95',
    metrics.loopLagP95Ms,
    budgets.loopLagP95WarnMs,
    budgets.loopLagP95CritMs,
    'loop-lag-p95',
    'Event-loop lag p95 regressed past its SLO budget',
    (v, budget, tier) =>
      `event-loop lag p95 is ${Math.round(v)}ms, at or past the ${tier} budget of ${budget}ms — ` +
      `the request loop is carrying sustained synchronous work (the per-thread saturation class).`,
  );
  consider(
    'conn-saturation',
    metrics.connSaturationPct,
    budgets.connSaturationWarnPct,
    budgets.connSaturationCritPct,
    'conn-saturation',
    'PG connection saturation regressed past its SLO budget',
    (v, budget, tier) =>
      `server-wide PG connection saturation is ${v}%, at or past the ${tier} budget of ${budget}% — ` +
      `the pool is filling toward the "too many clients" cliff.`,
  );
  consider(
    'dispatch-orphan-rate',
    metrics.dispatchOrphanRate,
    budgets.dispatchOrphanRateWarnPct,
    budgets.dispatchOrphanRateCritPct,
    'dispatch-orphan-rate',
    'Auto-implement dispatch-orphan rate regressed past its SLO budget',
    (v, budget, tier) =>
      `${Math.round(v * 100)}% of the last ${metrics.dispatchSample} improvement_dispatches are ` +
      `orphaned (worker died without resolving), at or past the ${tier} budget of ${Math.round(budget * 100)}% — ` +
      `the regression class this rig exists to catch (it reached 91% once, silently).`,
  );
  consider(
    'coord-open-escalations',
    metrics.coordOpenEscalations,
    budgets.coordOpenEscalationsWarn,
    budgets.coordOpenEscalationsCrit,
    'coord-open-escalations',
    'Coord open-escalation backlog regressed past its SLO budget',
    (v, budget, tier) =>
      `the coord open-escalation backlog is ${v}, at or past the ${tier} budget of ${budget} — ` +
      `escalations are accumulating faster than they drain.`,
  );
  consider(
    'adv-tab-switch-median',
    metrics.advTabSwitchMedianMs,
    budgets.advTabSwitchMedianWarnMs,
    budgets.advTabSwitchMedianCritMs,
    'adv-tab-switch-median',
    '/adv tab-switch median regressed past its SLO budget',
    (v, budget, tier) =>
      `/adv tab-switch median is ${Math.round(v)}ms, at or past the ${tier} budget of ${budget}ms — ` +
      `the app-side navigation path is slower than the EI-3034 baseline.`,
  );
  consider(
    'adv-fcp',
    metrics.advFcpMs,
    budgets.advFcpWarnMs,
    budgets.advFcpCritMs,
    'adv-fcp',
    '/adv first-contentful-paint regressed past its SLO budget',
    (v, budget, tier) =>
      `/adv first-contentful-paint is ${Math.round(v)}ms, at or past the ${tier} budget of ${budget}ms — ` +
      `the boot/render path is slower than the EI-3034 baseline.`,
  );

  return { signals, breaches };
}

// ── the orphan-rate aggregate (pure mapper over the dispatch rows) ───────────

export interface DispatchOrphanAggregate {
  /** Total dispatches in the recent window. */
  total: number;
  /** Of those, how many orphaned from GENUINE lane breakage (isLaneBreakageOrphan). */
  orphaned: number;
}

/** The dispatch-row fields the orphan-rate needs — the read-side of {@link ImprovementDispatchRow}. */
export type DispatchOrphanRow = Pick<ImprovementDispatchRow, 'outcome' | 'resolvedBy' | 'fireError'>;

/**
 * Pure: window rows → { total, orphaned } for the SLO. `orphaned` counts ONLY genuine
 * lane-breakage orphans — it reuses `isLaneBreakageOrphan`, the SAME predicate the orphan
 * collector uses, so benign host-restart / worker-timeout / context-overflow / env deaths
 * (each with its own bounded handling) never inflate the reliability SLO. Before EI-7534 this
 * rate counted every outcome='orphaned' row, so a host-restart storm + worker timeouts (both
 * benign) falsely breached the 60% crit budget while the real lane-breakage rate was ~25%.
 */
export function dispatchOrphanAggregateFromRows(rows: readonly DispatchOrphanRow[]): DispatchOrphanAggregate {
  let orphaned = 0;
  for (const r of rows) {
    if (r.outcome === 'orphaned' && isLaneBreakageOrphan(r)) orphaned += 1;
  }
  return { total: rows.length, orphaned };
}

/**
 * Pure: orphan-rate aggregate → { rate, sample }. Below `minSample` the rate is null
 * (a 1/1 = 100% over a single dispatch is noise, not a regression). The rate is
 * orphaned / total over the recent window — exactly the metric that silently hit 91%.
 */
export function dispatchOrphanRateFromAggregate(
  agg: DispatchOrphanAggregate,
  minSample: number = PERF_REGRESSION_BUDGETS.dispatchOrphanMinSample,
): { rate: number | null; sample: number } {
  const total = Math.max(0, agg.total);
  if (total < minSample) return { rate: null, sample: total };
  return { rate: Math.max(0, agg.orphaned) / total, sample: total };
}

// ── the IO seam (injectable; unit tests run without PG / flags) ──────────────

export interface PerfRegressionDeps {
  /** Armed check — default reads FLAGS.PERF_REGRESSION_RIG (default ON). */
  isEnabled: () => Promise<boolean>;
  sql: () => Sql;
  /** Event-loop lag p95 (ms) or null. Default `currentLoopLag()`. */
  readLoopLagP95Ms: () => number | null;
  /** PG server-wide saturation %, or null on failure. Default `pgHealth().saturationPct`. */
  readConnSaturationPct: () => Promise<number | null>;
  /** /adv tab-switch median (ms), or null until an app perf sampler writes one. */
  readAdvTabSwitchMedianMs?: () => Promise<number | null>;
  /** /adv first-contentful-paint (ms), or null until an app perf sampler writes one. */
  readAdvFcpMs?: () => Promise<number | null>;
}

const defaultDeps: PerfRegressionDeps = {
  isEnabled: () => getFlag(FLAGS.PERF_REGRESSION_RIG, 'perf-regression-rig'),
  sql: () => getOrgPg().sql as unknown as Sql,
  readLoopLagP95Ms: () => {
    const lag = currentLoopLag();
    return lag ? lag.p95Ms : null;
  },
  readConnSaturationPct: async () => {
    try {
      return (await pgHealth()).saturationPct;
    } catch {
      return null;
    }
  },
  readAdvTabSwitchMedianMs: async () => null,
  readAdvFcpMs: async () => null,
};

/** The note every tick returns while the flag is OFF (the kill-switch). */
export const PERF_REGRESSION_DISABLED_NOTE =
  'disabled: papercusp-perf-regression-rig OFF — the perf/reliability regression watch is blind';

/** Pure-detect: is this a "table not yet migrated" Postgres error (dormant-tolerant)? */
function isMissingTableError(e: unknown, table: string): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return new RegExp(`relation\\b.*${table}|${table}.*does not exist`, 'i').test(msg);
}

/**
 * Read the dispatch-orphan-rate over the recent window. DORMANT-TOLERANT: the
 * improvement_dispatches table (mig 238) may be absent on a fresh box → returns a
 * dormant note (never throws). One aggregate pass, workspace-scoped.
 */
export async function readDispatchOrphanRate(
  sql: Sql,
  workspaceId: string,
  budgets: PerfRegressionBudgets = PERF_REGRESSION_BUDGETS,
): Promise<{ rate: number | null; sample: number } | { dormant: string }> {
  try {
    // Fetch the window's death-cause fields (not a raw count) so the orphan numerator can
    // reuse `isLaneBreakageOrphan` — the ONE predicate the orphan collector uses — instead
    // of re-encoding the benign-category list in SQL (that duplication is exactly how the
    // SLO drifted from the collector and false-breached on benign deaths, EI-7534). The
    // window is 24h and the lane's cadence is low, so the row read is small and bounded.
    const rows = await sql<{ outcome: string | null; resolved_by: string | null; fire_error: string | null }[]>`
      SELECT outcome, resolved_by, fire_error
        FROM harness_shared.improvement_dispatches
       WHERE workspace_id = ${workspaceId}
         AND fired_at > now() - make_interval(hours => ${budgets.dispatchOrphanWindowHours})`;
    const agg = dispatchOrphanAggregateFromRows(
      rows.map((r) => ({
        outcome: (r.outcome ?? null) as DispatchOutcome | null,
        resolvedBy: r.resolved_by,
        fireError: r.fire_error,
      })),
    );
    return dispatchOrphanRateFromAggregate(agg, budgets.dispatchOrphanMinSample);
  } catch (e) {
    if (isMissingTableError(e, 'improvement_dispatches')) {
      return { dormant: 'dormant: improvement_dispatches not migrated yet (mig 238)' };
    }
    throw e;
  }
}

/**
 * Read the coord open-escalation backlog. DORMANT-TOLERANT: the
 * coord_open_escalations projection (mig 355) may be absent → returns a dormant note.
 */
export async function readCoordOpenEscalations(
  sql: Sql,
  workspaceId: string,
): Promise<number | { dormant: string }> {
  try {
    const rows = await sql<{ n: number | string }[]>`
      SELECT count(*)::int AS n
        FROM harness_shared.coord_open_escalations
       WHERE workspace_id = ${workspaceId}`;
    return Number(rows[0]?.n ?? 0);
  } catch (e) {
    if (isMissingTableError(e, 'coord_open_escalations')) {
      return { dormant: 'dormant: coord_open_escalations not migrated yet (mig 355)' };
    }
    throw e;
  }
}

/**
 * THE rig entry point (the watchdog collector calls this). When the flag is ON:
 *   1. read the metrics (each fail-soft → null + a note fragment, never a throw);
 *   2. INSERT one snapshot row (best-effort — a write failure is a note, not a throw,
 *      so a dormant snapshot table never breaks the watchdog tick that rides this);
 *   3. evaluate against PERF_REGRESSION_BUDGETS → one WatchdogSignal per breach.
 * When OFF: a 'disabled' note, zero signals, zero IO.
 */
export async function collectPerfRegressionSnapshot(
  workspaceId: string,
  deps: PerfRegressionDeps = defaultDeps,
  budgets: PerfRegressionBudgets = PERF_REGRESSION_BUDGETS,
): Promise<CollectorResult> {
  let enabled = false;
  try {
    enabled = await deps.isEnabled();
  } catch {
    enabled = false; // a broken flag read keeps the rig quiet — never fail toward filing
  }
  if (!enabled) return { signals: [], note: PERF_REGRESSION_DISABLED_NOTE };

  const sql = deps.sql();
  const notes: string[] = [];

  // 1. event-loop-lag p95 (in-memory; null when this thread runs no monitor).
  const loopLagP95Ms = deps.readLoopLagP95Ms();
  if (loopLagP95Ms === null) notes.push('loop-lag: no event-loop-lag monitor on this thread');

  // 2. PG connection saturation %.
  const connSaturationPct = await deps.readConnSaturationPct();
  if (connSaturationPct === null) notes.push('conn-saturation: pgHealth() unreadable this tick');

  // 3. dispatch-orphan rate (dormant-tolerant).
  let dispatchOrphanRate: number | null = null;
  let dispatchSample = 0;
  const orphan = await readDispatchOrphanRate(sql, workspaceId, budgets);
  if ('dormant' in orphan) notes.push(orphan.dormant);
  else {
    dispatchOrphanRate = orphan.rate;
    dispatchSample = orphan.sample;
    if (orphan.rate === null && orphan.sample > 0) {
      notes.push(`dispatch-orphan: ${orphan.sample} dispatches < min sample ${budgets.dispatchOrphanMinSample}`);
    }
  }

  // 4. coord open-escalation backlog (dormant-tolerant).
  let coordOpenEscalations: number | null = null;
  const backlog = await readCoordOpenEscalations(sql, workspaceId);
  if (typeof backlog === 'object') notes.push(backlog.dormant);
  else coordOpenEscalations = backlog;

  // 5/6. App-side /adv perf metrics (EI-3034). The sampler is intentionally an
  // injected seam for now; until a quiet-window E2E writer lands, null means the
  // budget exists but this tick has no app perf sample to grade.
  const readNullableUiMetric = async (
    label: string,
    reader: (() => Promise<number | null>) | undefined,
  ): Promise<number | null> => {
    if (!reader) return null;
    try {
      return await reader();
    } catch (e) {
      notes.push(`${label}: unreadable this tick (${e instanceof Error ? e.message : String(e)})`);
      return null;
    }
  };
  const advTabSwitchMedianMs = await readNullableUiMetric('adv-tab-switch-median', deps.readAdvTabSwitchMedianMs);
  const advFcpMs = await readNullableUiMetric('adv-fcp', deps.readAdvFcpMs);

  const metrics: PerfRegressionMetrics = {
    loopLagP95Ms,
    connSaturationPct,
    dispatchOrphanRate,
    dispatchSample,
    coordOpenEscalations,
    advTabSwitchMedianMs,
    advFcpMs,
  };

  const { signals, breaches } = evaluatePerfRegression(metrics, budgets);

  // 2/3. Persist the snapshot (best-effort — a missing snapshot table is a note, not a
  // throw: the rig must never break the watchdog tick it rides). `breached` carries the
  // tick's breaches for the audit trail.
  try {
    // jsonb write: bind as `${JSON.stringify(x)}::jsonb` — NOT sql.json(), which throws
    // under the repo's postgres-js ("Buffer.byteLength received Object"; see
    // gym/store.ts, rationale/pg-store.ts) and is mistyped against JSONValue here.
    await sql`
      INSERT INTO harness_shared.perf_regression_snapshots
        (workspace_id, loop_lag_p95_ms, conn_saturation_pct, dispatch_orphan_rate, dispatch_sample,
         coord_open_escalations, adv_tab_switch_median_ms, adv_fcp_ms, breached)
      VALUES
        (${workspaceId}, ${metrics.loopLagP95Ms}, ${metrics.connSaturationPct}, ${metrics.dispatchOrphanRate},
         ${metrics.dispatchSample}, ${metrics.coordOpenEscalations}, ${metrics.advTabSwitchMedianMs}, ${metrics.advFcpMs},
         ${JSON.stringify(breaches)}::text::jsonb)`;
  } catch (e) {
    if (isMissingTableError(e, 'perf_regression_snapshots')) {
      notes.push('dormant: perf_regression_snapshots not migrated yet (mig 395) — snapshot not persisted');
    } else {
      notes.push(`snapshot insert failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { signals, ...(notes.length ? { note: notes.join('; ') } : {}) };
}
