/**
 * learning-slo.ts — audit-as-sensors (self-learning-frontier-2026-06-12
 * P-047 / FB-21).
 *
 * The 2026-06-12 manual learning-system audit found its problems by reading
 * the same KPIs the Learning tab displays — triage routing, queue flow,
 * governor budgets, memory recall health. This module makes those findings
 * PERMANENT watchdog collectors: five learning-system SLOs swept on the
 * existing `system:improvement-watchdog` cadence, each breach filing through
 * the shared capture core into the very queue it measures (kinds per FB-18's
 * fidelity rules — a clear-correct-state breach is kind=bug and rides the
 * auto lane; a judgment-shaped one is kind=change and lands at the gate).
 *
 *   - **triage-entropy**            — the decision distribution over recently
 *     triaged items has collapsed (normalized Shannon entropy under the SLO):
 *     the EI-364 degeneracy class, where 100/100 ideas routed to one lane and
 *     the triage layer added zero information. kind=bug (EI-364's fix was a
 *     code fix: classifier scope wiring).
 *   - **capture-consume-imbalance** — captures are entering the improvements
 *     queue faster than ANYTHING leaves it: the audited drain pathology D-001
 *     exists to avoid pouring new capture into. kind=change (the fix is a
 *     capacity/policy decision).
 *   - **mttsh-regression**          — mean-time-to-self-heal measured by
 *     FB-20's red-queen drills has regressed vs its own baseline. Ships
 *     DORMANT-TOLERANT: FB-20 may not have landed/armed — an absent store is
 *     a per-tick note, never an error. kind=change (diagnosis-shaped).
 *   - **governor-starvation**       — an ENABLED, BUDGETED lifetime loop has
 *     spent down to the floor, so the D-004 preflight refuses every unattended
 *     run: the loop silently stopped learning. Deliberately ignores unbudgeted
 *     loops — those are the dark-shipped frontier loops awaiting their P-001
 *     budget, already on the governor's watch list. kind=change (budgets are
 *     the owner's dial).
 *   - **memory-zero-hit**           — the recall zero-hit rate (B-10's
 *     memory_recall_stats telemetry, mig 240) spiked vs its trailing baseline:
 *     the EI-366 index-degradation class. kind=bug (clear correct state — the
 *     baseline rate; regression-testable against the stats table).
 *
 * SLO thresholds are EXPORTED TUNABLES (`LEARNING_SLO_DEFAULTS`), overridable
 * per-tick from the watchdog routine's payload_template (PAYLOAD_TUNABLE_KEYS
 * in watchdog.ts) — threshold tuning never needs a deploy.
 *
 * Dark ship (D-001): all five collectors ride ONE flag,
 * `papercusp-learning-slo-sensors` (default OFF, KNOWN_DARK_FLAGS). They are
 * SQL-only (zero LLM spend), ride the watchdog's own routine (no routine of
 * their own, no governor registration), but a breach FILES — so the flag flip
 * is the single P-001 arming act. While dark each collector reports a 'dark'
 * note in the tick record and emits nothing.
 *
 * All signals are LIVE-STATE (no `latestAt`): a breach that still holds after
 * its filed item was resolved is a genuine regression, so the post-resolve
 * re-file is always legitimate (watchdog-audit P-005 semantics).
 *
 * Pure row→signal mappers are exported for unit tests; IO wrappers take an
 * injectable deps seam (the watchdog collector pattern).
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import {
  checkLoopVerdict,
  LEARNING_GOVERNOR_BUDGET_FLOOR_USD,
  type LearningLoopRegistration,
} from '../../learning-governor/core';
import { listLearningLoops } from '../../learning-governor/store';
import type { CollectorResult, WatchdogSignal } from './watchdog';

// ── SLO thresholds (exported tunables — FB-21's "SLO thresholds as exported
//    tunables" requirement; every key is also payload-tunable on the watchdog
//    routine, see PAYLOAD_TUNABLE_KEYS) ───────────────────────────────────────

export const LEARNING_SLO_DEFAULTS = {
  /** triage-entropy: trailing window of triaged items sampled (days). */
  triageEntropyWindowDays: 7,
  /** triage-entropy: minimum triaged items in the window before the SLO applies. */
  triageEntropyMinSample: 20,
  /** triage-entropy SLO: normalized decision entropy BELOW this = degenerate routing. */
  triageEntropyMinNormalized: 0.15,
  /** capture-vs-consume: trailing flow window (days). */
  flowWindowDays: 7,
  /** capture-vs-consume: minimum captures in the window before the SLO applies. */
  flowMinInflow: 10,
  /** capture-vs-consume SLO: inflow/outflow at or past this ratio = imbalance. */
  flowMaxRatio: 3,
  /** mttsh: recent measurement window (days). */
  mttshRecentDays: 7,
  /** mttsh: baseline window preceding the recent window (days). */
  mttshBaselineDays: 28,
  /** mttsh: minimum healed drills in EACH window before the SLO applies. */
  mttshMinSamples: 5,
  /** mttsh SLO: recent median at or past baseline median × this = regression. */
  mttshMaxRegressionFactor: 1.5,
  /** governor-starvation: the remaining-budget floor a lifetime loop refuses under (D-004). */
  governorStarvationFloorUsd: LEARNING_GOVERNOR_BUDGET_FLOOR_USD,
  /** memory zero-hit: recent recall window (hours). */
  memoryZeroHitRecentHours: 24,
  /** memory zero-hit: baseline window preceding the recent window (days). */
  memoryZeroHitBaselineDays: 7,
  /** memory zero-hit: minimum recalls in the recent window before the SLO applies. */
  memoryZeroHitMinRecalls: 20,
  /** memory zero-hit SLO: recent zero-hit rate must reach this absolute rate… */
  memoryZeroHitMaxRate: 0.4,
  /** …AND baseline rate × this factor (when a baseline of ≥ minRecalls exists). */
  memoryZeroHitSpikeFactor: 2,
  /**
   * EI-7774: …AND (when both windows carry a usable non-zero-hit top-score
   * median) the recent P50 has ALSO dropped to at most baseline × this
   * factor. A zero-hit rate spike with a STABLE-or-better top-score on the
   * recalls that DID hit is a healthy burst of cold-pool/novel queries, not
   * the EI-366 index-degradation signature (which collapses the top-score
   * distribution too). 0.85 = the recent median must fall to ≤85% of
   * baseline to still count as a genuine regression.
   */
  memoryZeroHitTopScoreDropFactor: 0.85,
} as const;

/** Per-tick overrides for the SLO tunables (CollectOptions extends this). */
export interface LearningSloOptions {
  triageEntropyWindowDays?: number;
  triageEntropyMinSample?: number;
  triageEntropyMinNormalized?: number;
  flowWindowDays?: number;
  flowMinInflow?: number;
  flowMaxRatio?: number;
  mttshRecentDays?: number;
  mttshBaselineDays?: number;
  mttshMinSamples?: number;
  mttshMaxRegressionFactor?: number;
  governorStarvationFloorUsd?: number;
  memoryZeroHitRecentHours?: number;
  memoryZeroHitBaselineDays?: number;
  memoryZeroHitMinRecalls?: number;
  memoryZeroHitMaxRate?: number;
  memoryZeroHitSpikeFactor?: number;
  memoryZeroHitTopScoreDropFactor?: number;
}

/** Injectable IO seam (unit tests run without PG / flags). */
export interface LearningSloDeps {
  /** Armed check — default reads FLAGS.LEARNING_SLO_SENSORS (the D-001 dark gate). */
  isArmed: () => Promise<boolean>;
  sql: () => Sql;
}

const defaultDeps: LearningSloDeps = {
  isArmed: () => getFlag(FLAGS.LEARNING_SLO_SENSORS, 'learning-slo-sensors'),
  sql: () => getOrgPg().sql as unknown as Sql,
};

/** The dark-tick result every collector returns while the flag is OFF. */
export const LEARNING_SLO_DARK_NOTE =
  'dark: papercusp-learning-slo-sensors OFF (D-001 — the flag flip is the P-001 arming act)';

async function darkOrNull(deps: LearningSloDeps): Promise<CollectorResult | null> {
  let armed = false;
  try {
    armed = await deps.isArmed();
  } catch {
    armed = false; // a broken flag read keeps the sensors dark — never fail toward filing
  }
  return armed ? null : { signals: [], note: LEARNING_SLO_DARK_NOTE };
}

// ── triage-entropy ────────────────────────────────────────────────────────────

/** The triage decision space (triage.ts TriageDecision) — the entropy denominator. */
export const TRIAGE_DECISION_CLASSES = 4; // place | gate | gym | reject

/**
 * Pure: normalized Shannon entropy of a decision histogram in [0,1] —
 * 0 = every item routed to one lane (the EI-364 shape), 1 = uniform over the
 * full decision space. Normalized by log2(TRIAGE_DECISION_CLASSES) so the
 * value is comparable as the SLO regardless of which lanes appear.
 */
export function normalizedTriageEntropy(counts: Record<string, number>): { n: number; entropy: number } {
  let n = 0;
  for (const c of Object.values(counts)) n += Math.max(0, c);
  if (n === 0) return { n: 0, entropy: 0 };
  let h = 0;
  for (const c of Object.values(counts)) {
    if (c <= 0) continue;
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return { n, entropy: h / Math.log2(TRIAGE_DECISION_CLASSES) };
}

/**
 * Pure: triaged-item decision rows → at most ONE degeneracy signal. Fires when
 * the window holds ≥ minSample triaged items AND their normalized decision
 * entropy is under the SLO — i.e. the triage layer is adding ~zero routing
 * information (EI-364: 100/100 ideas → gate). kind=bug per FB-18's fidelity
 * rules: the correct state is clear (a distribution that discriminates), the
 * cause is code-level (classifier/scope wiring), and the fix is
 * regression-testable — EI-364's was.
 */
export function triageEntropySignalsFromRows(
  rows: { decision: string }[],
  opts: LearningSloOptions = {},
): WatchdogSignal[] {
  const minSample = opts.triageEntropyMinSample ?? LEARNING_SLO_DEFAULTS.triageEntropyMinSample;
  const slo = opts.triageEntropyMinNormalized ?? LEARNING_SLO_DEFAULTS.triageEntropyMinNormalized;
  const windowDays = opts.triageEntropyWindowDays ?? LEARNING_SLO_DEFAULTS.triageEntropyWindowDays;
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.decision] = (counts[r.decision] ?? 0) + 1;
  const { n, entropy } = normalizedTriageEntropy(counts);
  if (n < minSample || entropy >= slo) return [];
  const breakdown = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([d, c]) => `${d}: ${c}`)
    .join(', ');
  return [{
    source: 'triage-entropy',
    key: 'triage-decision-distribution',
    title: 'Triage decision distribution is degenerate (entropy SLO breach)',
    body:
      `Watchdog signal (triage-entropy): across the ${n} item(s) triaged in the last ${windowDays}d the ` +
      `decision distribution is ${breakdown} — normalized entropy ${entropy.toFixed(3)}, under the ${slo} SLO. ` +
      `The triage layer is adding ~zero routing information (the EI-364 degeneracy class: a misrouting ` +
      `classifier or a structurally uninformative taxonomy), so every capture lands in one lane regardless ` +
      `of its shape.`,
    severity: 'major',
    kind: 'bug',
    findingClass: 'learning-slo:triage-degeneracy',
    paths: ['packages/operator-core/lib/harness/improvements/triage.ts'],
  }];
}

/**
 * triage-entropy: decision distribution over items triaged in the window
 * (payload.ideaLifecycle.triageDecision; updated_at is the window proxy —
 * post-triage transitions bump it, but a degenerate router fires regardless).
 * Organic-only per D-002 — drill/replay rows must not shape the distribution.
 */
export async function collectTriageEntropySignals(
  sql: Sql,
  workspaceId: string,
  opts: LearningSloOptions = {},
): Promise<WatchdogSignal[]> {
  const windowDays = opts.triageEntropyWindowDays ?? LEARNING_SLO_DEFAULTS.triageEntropyWindowDays;
  const rows = await sql<{ decision: string }[]>`
    SELECT payload->'ideaLifecycle'->>'triageDecision' AS decision
      FROM harness_shared.engineer_issues
     WHERE workspace_id = ${workspaceId}
       AND COALESCE(signal_origin, 'organic') = 'organic'
       AND payload->'ideaLifecycle'->>'triageDecision' IS NOT NULL
       AND updated_at > now() - make_interval(days => ${windowDays})
     LIMIT 2000`;
  return triageEntropySignalsFromRows(rows, opts);
}

// ── capture-vs-consume flow imbalance ────────────────────────────────────────

export interface FlowAggregate {
  /** Items captured (created) in the window. */
  inflow: number;
  /** Items that LEFT the open state in the window (resolved/closed; updated_at proxy). */
  outflow: number;
  /** Currently-open backlog (all time). */
  backlog: number;
}

/**
 * Pure: flow aggregate → at most ONE imbalance signal. Fires when the window's
 * inflow clears the volume bar AND inflow/outflow reaches the SLO ratio — the
 * audited "pouring capture into a drain under repair" pathology D-001 names.
 * kind=change per FB-18: the fix is a judgment call (raise consume capacity,
 * pause a capture source, tune the caps), not a clear correct state.
 */
export function flowSignalsFromAggregate(agg: FlowAggregate, opts: LearningSloOptions = {}): WatchdogSignal[] {
  const windowDays = opts.flowWindowDays ?? LEARNING_SLO_DEFAULTS.flowWindowDays;
  const minInflow = opts.flowMinInflow ?? LEARNING_SLO_DEFAULTS.flowMinInflow;
  const maxRatio = opts.flowMaxRatio ?? LEARNING_SLO_DEFAULTS.flowMaxRatio;
  if (agg.inflow < minInflow) return [];
  const ratio = agg.inflow / Math.max(1, agg.outflow);
  if (ratio < maxRatio) return [];
  return [{
    source: 'capture-consume-imbalance',
    key: 'improvements-flow',
    title: 'Improvements queue inflow is outrunning consumption',
    body:
      `Watchdog signal (capture-consume-imbalance): ${agg.inflow} improvement(s) captured vs ${agg.outflow} ` +
      `consumed (resolved/closed) in the last ${windowDays}d — ratio ${ratio.toFixed(1)}, at or past the ` +
      `${maxRatio}× SLO; the open backlog stands at ${agg.backlog}. This is the audited drain pathology the ` +
      `frontier program's D-001 arming gate exists to avoid: capture sources are outrunning the consume edge, ` +
      `so the queue accumulates instead of converting into fixes.`,
    severity: 'major',
    kind: 'change',
    findingClass: 'learning-slo:flow-imbalance',
  }];
}

/** capture-vs-consume: one aggregate pass over engineer_issues (organic-only, D-002). */
export async function collectFlowSignals(
  sql: Sql,
  workspaceId: string,
  opts: LearningSloOptions = {},
): Promise<WatchdogSignal[]> {
  const windowDays = opts.flowWindowDays ?? LEARNING_SLO_DEFAULTS.flowWindowDays;
  const rows = await sql<{ inflow: number; outflow: number; backlog: number }[]>`
    SELECT
      count(*) FILTER (WHERE created_at > now() - make_interval(days => ${windowDays}))::int AS inflow,
      count(*) FILTER (WHERE state <> 'open' AND updated_at > now() - make_interval(days => ${windowDays}))::int AS outflow,
      count(*) FILTER (WHERE state = 'open')::int AS backlog
      FROM harness_shared.engineer_issues
     WHERE workspace_id = ${workspaceId}
       AND COALESCE(signal_origin, 'organic') = 'organic'`;
  const r = rows[0];
  if (!r) return [];
  return flowSignalsFromAggregate(
    { inflow: Number(r.inflow), outflow: Number(r.outflow), backlog: Number(r.backlog) },
    opts,
  );
}

// ── MTTSH regression (the FB-20 read seam — dormant-tolerant) ────────────────

/** Heal-duration samples split into the two comparison windows (ms). */
export interface MttshWindows {
  recentMs: number[];
  baselineMs: number[];
}

/** Pure: median of a non-empty array. */
export function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Pure: linear-interpolated quantile of a SORTED array (0 ≤ q ≤ 1). */
function quantileOfSorted(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Pure: drop values beyond the classic Tukey IQR fence (Q3 + 1.5×IQR) — the
 * standard robust-stats outlier exclusion, applied identically to whichever
 * window it's given (never hand-tuned per call). EI-8387: a handful of
 * red-queen drills landing during a REAL, independently-confirmed infra
 * incident (a shared PG/gateway hiccup that also slows the collector's own
 * query) produce multi-MINUTE detect times alongside a normal population of
 * sub-2s..90s drills — a raw median is not actually robust to this shape
 * (rank-13-of-26 still landed inside a genuinely-elevated tier), so it read
 * "the loop got slower" when the loop's own code was unchanged (verified: the
 * collector queries this drill class exercises ran in ~30ms against the live
 * DB at investigation time) and the true (non-incident) typical-case median
 * was WELL UNDER the SLO's own baseline. Trimming keeps the SLO measuring the
 * self-heal LOOP's code speed, not incidental external outages it is not
 * trying to detect (those have their own service-health/gateway watchdogs).
 * Never returns empty — an all-outlier input degrades to the untrimmed set.
 */
export function trimStatisticalOutliers(values: number[]): number[] {
  if (values.length < 4) return values; // too few for a meaningful IQR fence
  const s = [...values].sort((a, b) => a - b);
  const q1 = quantileOfSorted(s, 0.25);
  const q3 = quantileOfSorted(s, 0.75);
  const fence = q3 + 1.5 * (q3 - q1);
  const kept = s.filter((v) => v <= fence);
  return kept.length > 0 ? kept : s;
}

/**
 * Pure: windowed MTTSH samples → at most ONE regression signal. Fires when
 * BOTH windows hold ≥ minSamples healed drills AND the recent median has
 * regressed past baseline × factor. kind=change per FB-18: a slower heal
 * pipeline needs diagnosis (which stage regressed, why) — judgment-shaped.
 * EI-8387: each window's outliers are trimmed (Tukey IQR fence) BEFORE the
 * median, so a handful of incident-correlated extreme drills can't, by
 * themselves, manufacture a "regression" the loop's own code has nothing to
 * do with — see trimStatisticalOutliers.
 */
export function mttshSignalsFromWindows(w: MttshWindows, opts: LearningSloOptions = {}): WatchdogSignal[] {
  const minSamples = opts.mttshMinSamples ?? LEARNING_SLO_DEFAULTS.mttshMinSamples;
  const factor = opts.mttshMaxRegressionFactor ?? LEARNING_SLO_DEFAULTS.mttshMaxRegressionFactor;
  const recentDays = opts.mttshRecentDays ?? LEARNING_SLO_DEFAULTS.mttshRecentDays;
  if (w.recentMs.length < minSamples || w.baselineMs.length < minSamples) return [];
  const recent = medianOf(trimStatisticalOutliers(w.recentMs));
  const baseline = medianOf(trimStatisticalOutliers(w.baselineMs));
  if (baseline <= 0 || recent < baseline * factor) return [];
  const fmt = (ms: number): string => `${Math.round(ms / 1000)}s`;
  return [{
    source: 'mttsh-regression',
    key: 'mttsh',
    title: 'MTTSH regressed: the loop is healing planted frictions slower',
    body:
      `Watchdog signal (mttsh-regression): median time-to-self-heal over the last ${recentDays}d of ` +
      `red-queen drills is ${fmt(recent)} (${w.recentMs.length} drill(s)) vs a ${fmt(baseline)} baseline ` +
      `(${w.baselineMs.length} drill(s)) — ${(recent / baseline).toFixed(2)}×, at or past the ${factor}× SLO. ` +
      `Some stage of detect→triage→fix slowed down; the drill rows carry the per-stage timings for diagnosis.`,
    severity: 'major',
    kind: 'change',
    findingClass: 'learning-slo:mttsh-regression',
  }];
}

/**
 * THE FB-20 SEAM — the one function that knows red-queen's storage shape.
 * Reads heal-duration measurements from FB-20's drill store, split into the
 * recent/baseline windows. DORMANT-TOLERANT by contract:
 *   - store not landed (to_regclass null)  → `{ dormant: '…' }`, never an error;
 *   - store landed with a different shape  → `{ dormant: '…' }` carrying the
 *     error, visible in every tick record until this SELECT is updated;
 *   - no measured drills yet               → empty windows (the pure fn stays quiet).
 * Coordinated with FB-20 (su-19d66): table harness_shared.red_queen_drills
 * (migration 255), `mttsh_total_ms` (non-null = measured heal) + `resolved_at`,
 * aliased below to keep the window split generic. If red-queen's shape moves,
 * update ONLY this function.
 */
export async function readMttshSamples(
  sql: Sql,
  opts: LearningSloOptions = {},
): Promise<MttshWindows | { dormant: string }> {
  const recentDays = opts.mttshRecentDays ?? LEARNING_SLO_DEFAULTS.mttshRecentDays;
  const baselineDays = opts.mttshBaselineDays ?? LEARNING_SLO_DEFAULTS.mttshBaselineDays;
  const reg = await sql<{ t: string | null }[]>`SELECT to_regclass('harness_shared.red_queen_drills') AS t`;
  if (!reg[0]?.t) return { dormant: 'dormant: red-queen drill store not landed yet (FB-20 / frontier P-031)' };
  try {
    const rows = await sql<{ mttsh_ms: number | string; completed_at: string | Date }[]>`
      SELECT mttsh_total_ms AS mttsh_ms, resolved_at AS completed_at
        FROM harness_shared.red_queen_drills
       WHERE mttsh_total_ms IS NOT NULL
         AND resolved_at IS NOT NULL
         AND resolved_at > now() - make_interval(days => ${recentDays + baselineDays})
       ORDER BY resolved_at DESC
       LIMIT 2000`;
    const cutoffMs = Date.now() - recentDays * 86_400_000;
    const out: MttshWindows = { recentMs: [], baselineMs: [] };
    for (const r of rows) {
      const ms = Number(r.mttsh_ms);
      if (!Number.isFinite(ms) || ms < 0) continue;
      const at = r.completed_at instanceof Date ? r.completed_at.getTime() : Date.parse(String(r.completed_at));
      (Number.isFinite(at) && at >= cutoffMs ? out.recentMs : out.baselineMs).push(ms);
    }
    return out;
  } catch (e) {
    return {
      dormant:
        `dormant: red-queen drill store has an unexpected shape — update readMttshSamples (the FB-21↔FB-20 ` +
        `seam): ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ── governor budget starvation ───────────────────────────────────────────────

/**
 * Pure: governor registry rows → one signal per STARVED loop. Starved =
 * enabled, carrying an explicit lifetime budget, and spent down to (or past)
 * the floor — the D-004 preflight refuses every unattended run, so the loop
 * has silently stopped learning. Unbudgeted loops are deliberately EXCLUDED:
 * those are the dark-shipped frontier loops awaiting their P-001 budget
 * (already the governor summary's watch list, not a breach). kind=change per
 * FB-18: budgets are the owner's dial, never auto-raised.
 */
export function governorStarvationSignals(
  loops: readonly LearningLoopRegistration[],
  opts: LearningSloOptions = {},
): WatchdogSignal[] {
  const floor = opts.governorStarvationFloorUsd ?? LEARNING_SLO_DEFAULTS.governorStarvationFloorUsd;
  const out: WatchdogSignal[] = [];
  for (const loop of loops) {
    if (!loop.enabled || loop.budgetUsd === null) continue;
    const verdict = checkLoopVerdict(loop, floor);
    if (verdict.reason !== 'exhausted') continue;
    out.push({
      source: 'governor-starvation',
      key: `starved:${loop.loopId}`,
      title: `Learning loop ${loop.loopId} is budget-starved`,
      body:
        `Watchdog signal (governor-starvation): loop "${loop.loopId}" (${loop.displayName}) is enabled with a ` +
        `lifetime budget of $${loop.budgetUsd.toFixed(2)} but has spent $${loop.spentUsd.toFixed(2)} — ` +
        `remaining $${(verdict.remainingUsd ?? 0).toFixed(2)} is at or under the $${floor.toFixed(2)} floor, so ` +
        `the learning governor refuses every unattended run (D-004). The loop has silently stopped learning; ` +
        `raising (or deliberately retiring) the budget is an owner act.`,
      severity: 'major',
      kind: 'change',
      findingClass: 'learning-slo:governor-starvation',
    });
  }
  return out;
}

/** governor-starvation: the registry read + the pure verdict pass. */
export async function collectGovernorStarvationSignals(
  sql: Sql,
  workspaceId: string,
  opts: LearningSloOptions = {},
): Promise<WatchdogSignal[]> {
  const loops = await listLearningLoops(sql, { workspaceId });
  return governorStarvationSignals(loops, opts);
}

// ── memory recall zero-hit spike ─────────────────────────────────────────────

export interface RecallRateAggregate {
  recentRecalls: number;
  recentZero: number;
  baselineRecalls: number;
  baselineZero: number;
  /**
   * EI-7774: median top_score over the recent window's NON-zero-hit recalls
   * (null/undefined when unavailable — a caller on an older query shape, or a
   * window with no non-zero recalls to take a median of). Optional and
   * backward-compatible: omitting both P50 fields falls back to the pre-
   * EI-7774 rate-only behavior below.
   */
  recentTopScoreP50?: number | null;
  /** Median top_score over the baseline window's non-zero-hit recalls. */
  baselineTopScoreP50?: number | null;
}

/**
 * Pure: recall-rate aggregate → at most ONE spike signal. Fires when the
 * recent window holds ≥ minRecalls AND its zero-hit rate reaches the absolute
 * SLO rate AND (when a baseline of ≥ minRecalls exists) the rate has spiked
 * to ≥ baseline × factor — "no relevant memory" stays a healthy zero; a rate
 * jump against the system's own history is the EI-366 index-degradation
 * class. kind=bug per FB-18: the correct state is the baseline rate and the
 * stats table makes it regression-testable.
 *
 * EI-7774: a rate spike ALONE cannot distinguish that degradation class from
 * a healthy burst of cold-pool/novel queries (which also zero-hit at a higher
 * rate, but whose recalls that DID hit score normally). So when BOTH windows
 * carry a usable top-score P50 (from recalls that hit), also require the
 * recent P50 to have dropped to ≤ baseline × memoryZeroHitTopScoreDropFactor
 * — the actual EI-366 signature — before firing. Missing/null P50 data (an
 * older caller, or a window with zero non-zero-hit recalls to median) falls
 * back to the original rate-only gate unchanged.
 */
export function memoryZeroHitSignalsFromAggregate(
  agg: RecallRateAggregate,
  opts: LearningSloOptions = {},
): WatchdogSignal[] {
  const minRecalls = opts.memoryZeroHitMinRecalls ?? LEARNING_SLO_DEFAULTS.memoryZeroHitMinRecalls;
  const maxRate = opts.memoryZeroHitMaxRate ?? LEARNING_SLO_DEFAULTS.memoryZeroHitMaxRate;
  const factor = opts.memoryZeroHitSpikeFactor ?? LEARNING_SLO_DEFAULTS.memoryZeroHitSpikeFactor;
  const scoreDropFactor = opts.memoryZeroHitTopScoreDropFactor ?? LEARNING_SLO_DEFAULTS.memoryZeroHitTopScoreDropFactor;
  const recentHours = opts.memoryZeroHitRecentHours ?? LEARNING_SLO_DEFAULTS.memoryZeroHitRecentHours;
  const baselineDays = opts.memoryZeroHitBaselineDays ?? LEARNING_SLO_DEFAULTS.memoryZeroHitBaselineDays;
  if (agg.recentRecalls < minRecalls) return [];
  const rate = agg.recentZero / agg.recentRecalls;
  if (rate < maxRate) return [];
  const hasBaseline = agg.baselineRecalls >= minRecalls;
  const baseRate = hasBaseline ? agg.baselineZero / agg.baselineRecalls : null;
  if (baseRate !== null && rate < baseRate * factor) return [];
  // EI-7774: both P50s present AND the recent one has NOT materially
  // dropped ⇒ the recalls that hit still score normally — a healthy zero
  // burst, not index degradation. Stay quiet.
  const recentP50 = agg.recentTopScoreP50;
  const baseP50 = agg.baselineTopScoreP50;
  const hasScoreData = recentP50 != null && baseP50 != null && baseP50 > 0;
  const scoreCollapsed = hasScoreData ? recentP50! <= baseP50! * scoreDropFactor : null;
  if (hasScoreData && !scoreCollapsed) return [];
  const pct = (x: number): string => `${Math.round(x * 100)}%`;
  return [{
    source: 'memory-zero-hit',
    key: 'recall-zero-hit-rate',
    title: 'Memory recall zero-hit rate spiked',
    body:
      `Watchdog signal (memory-zero-hit): ${pct(rate)} of the ${agg.recentRecalls} memory recalls in the last ` +
      `${recentHours}h returned NOTHING` +
      (baseRate !== null
        ? ` — vs a ${pct(baseRate)} baseline over the prior ${baselineDays}d (${agg.baselineRecalls} recalls), ` +
          `a ${(rate / Math.max(baseRate, 0.001)).toFixed(1)}× spike`
        : ` (no usable baseline window — the absolute ${pct(maxRate)} SLO fired)`) +
      (hasScoreData
        ? ` — AND the non-zero recalls' top-score P50 also collapsed: ${recentP50!.toFixed(3)} vs a ` +
          `${baseP50!.toFixed(3)} baseline (${(recentP50! / Math.max(baseP50!, 0.001)).toFixed(2)}×)`
        : '') +
      `. A spike against the system's own history means index degradation, not "no relevant memory" ` +
      `(the EI-366 class B-10's memory_recall_stats telemetry exists to catch).`,
    severity: 'major',
    kind: 'bug',
    findingClass: 'learning-slo:recall-degradation',
    paths: ['packages/operator-core/lib/memory/recall-stats.ts'],
  }];
}

/**
 * memory-zero-hit: one aggregate pass over memory_recall_stats (B-10 /
 * consume-edges P-031, mig 240). The table has no workspace column — this
 * collector is inherently BOX-GLOBAL (the red-test P-013 stance): acceptable
 * on a one-box install; the cross-host tick lock + key dedup bound it to one
 * filed item regardless.
 */
export async function collectMemoryZeroHitSignals(sql: Sql, opts: LearningSloOptions = {}): Promise<WatchdogSignal[]> {
  const recentHours = opts.memoryZeroHitRecentHours ?? LEARNING_SLO_DEFAULTS.memoryZeroHitRecentHours;
  const baselineDays = opts.memoryZeroHitBaselineDays ?? LEARNING_SLO_DEFAULTS.memoryZeroHitBaselineDays;
  // EI-7774: also median the NON-zero-hit top_score in each window (NULL on
  // zero hits, so the FILTER + percentile_cont naturally excludes them) —
  // the signature that distinguishes a healthy cold-query zero burst from
  // real EI-366 index degradation (see memoryZeroHitSignalsFromAggregate).
  const rows = await sql<
    {
      recent_recalls: number;
      recent_zero: number;
      base_recalls: number;
      base_zero: number;
      recent_top_score_p50: number | null;
      base_top_score_p50: number | null;
    }[]
  >`
    SELECT
      count(*) FILTER (WHERE created_at > now() - make_interval(hours => ${recentHours}))::int AS recent_recalls,
      count(*) FILTER (WHERE created_at > now() - make_interval(hours => ${recentHours}) AND hit_count = 0)::int AS recent_zero,
      count(*) FILTER (WHERE created_at <= now() - make_interval(hours => ${recentHours}))::int AS base_recalls,
      count(*) FILTER (WHERE created_at <= now() - make_interval(hours => ${recentHours}) AND hit_count = 0)::int AS base_zero,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY top_score)
        FILTER (WHERE created_at > now() - make_interval(hours => ${recentHours}) AND top_score IS NOT NULL) AS recent_top_score_p50,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY top_score)
        FILTER (WHERE created_at <= now() - make_interval(hours => ${recentHours}) AND top_score IS NOT NULL) AS base_top_score_p50
      FROM harness_shared.memory_recall_stats
     WHERE created_at > now() - make_interval(hours => ${recentHours}) - make_interval(days => ${baselineDays})`;
  const r = rows[0];
  if (!r) return [];
  return memoryZeroHitSignalsFromAggregate(
    {
      recentRecalls: Number(r.recent_recalls),
      recentZero: Number(r.recent_zero),
      baselineRecalls: Number(r.base_recalls),
      baselineZero: Number(r.base_zero),
      recentTopScoreP50: r.recent_top_score_p50 == null ? null : Number(r.recent_top_score_p50),
      baselineTopScoreP50: r.base_top_score_p50 == null ? null : Number(r.base_top_score_p50),
    },
    opts,
  );
}

// ── the five collector entry points (defaultPapercuspCollectors wiring) ──────

/** triage-entropy collector (flag-gated; D-001 dark note while OFF). */
export async function triageEntropyCollector(
  workspaceId: string,
  opts: LearningSloOptions = {},
  deps: LearningSloDeps = defaultDeps,
): Promise<CollectorResult> {
  const dark = await darkOrNull(deps);
  if (dark) return dark;
  return { signals: await collectTriageEntropySignals(deps.sql(), workspaceId, opts) };
}

/** capture-vs-consume flow collector (flag-gated). */
export async function captureConsumeFlowCollector(
  workspaceId: string,
  opts: LearningSloOptions = {},
  deps: LearningSloDeps = defaultDeps,
): Promise<CollectorResult> {
  const dark = await darkOrNull(deps);
  if (dark) return dark;
  return { signals: await collectFlowSignals(deps.sql(), workspaceId, opts) };
}

/** MTTSH-regression collector (flag-gated; dormant-tolerant — see readMttshSamples). */
export async function mttshRegressionCollector(
  opts: LearningSloOptions = {},
  deps: LearningSloDeps = defaultDeps,
): Promise<CollectorResult> {
  const dark = await darkOrNull(deps);
  if (dark) return dark;
  const samples = await readMttshSamples(deps.sql(), opts);
  if ('dormant' in samples) return { signals: [], note: samples.dormant };
  return { signals: mttshSignalsFromWindows(samples, opts) };
}

/** governor-starvation collector (flag-gated). */
export async function governorStarvationCollector(
  workspaceId: string,
  opts: LearningSloOptions = {},
  deps: LearningSloDeps = defaultDeps,
): Promise<CollectorResult> {
  const dark = await darkOrNull(deps);
  if (dark) return dark;
  return { signals: await collectGovernorStarvationSignals(deps.sql(), workspaceId, opts) };
}

/** memory zero-hit collector (flag-gated; box-global — see collectMemoryZeroHitSignals). */
export async function memoryZeroHitCollector(
  opts: LearningSloOptions = {},
  deps: LearningSloDeps = defaultDeps,
): Promise<CollectorResult> {
  const dark = await darkOrNull(deps);
  if (dark) return dark;
  return { signals: await collectMemoryZeroHitSignals(deps.sql(), opts) };
}
