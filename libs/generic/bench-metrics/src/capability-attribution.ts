/**
 * capability-attribution.ts — per-capability attribution + cross-suite roll-up
 * (plan benchmark-capability-injection-redesign-2026-06-17, P-011 / Phase 4 reporting).
 *
 * `buildSuiteReport` already gives per-arm pass@1/pass^k + the cost/accuracy Pareto +
 * pairwise treatment-vs-baseline deltas. This module adds the THREE things P-011 needs
 * that it does not:
 *
 *   1. A FIXED-CONTROL per-capability lift. The injection arms are
 *      `vanilla` (control) + the single-capability arms `+memory` / `+coord` /
 *      `+workqueue` + the `ours` bundle. We hold `vanilla` as the control and read each
 *      other arm's lift OVER it — value delta, cost-normalized (D-008: costPerResolved
 *      ratio + Pareto-dominance), and a conservative CI-non-overlap significance flag.
 *      (`buildSuiteReport`'s deltas are treatment−baseline for ONE treatment; this is the
 *      inverse view — one control, every capability as a treatment — the attribution
 *      framing of D-011.)
 *
 *   2. PER-TASK attribution — the "which capability, on which TASK" narrative (the plan's
 *      P-011 headline). For each capability arm we classify every commonly-scored task as
 *      `unlocked` (the capability scores strictly higher than the control), `regressed`
 *      (strictly lower), or `neutral`. The unlocked-task list is the sellable evidence:
 *      "memory unlocked task-A; coord unlocked task-B".
 *
 *   3. A CROSS-SUITE roll-up — fold many per-suite attributions into the headline matrix
 *      (suite × capability → lift / significant? / Pareto-better? / #unlocked) + a
 *      per-capability summary across suites ("+memory lifts on N/M suites").
 *
 * BOOLEAN *and* CONTINUOUS suites (the `metric` option). Boolean-resolved suites
 * (tau2 reward∈{0,1}, SWE) attribute on **pass@1** (`metric:'passAt1'`, the default); the
 * pass@1 path delegates to {@link aggregateArm} so the numbers are byte-identical to
 * `buildSuiteReport`. Continuous / partial-credit suites (SwarmBench's sim score,
 * AgentsNet, TheAgentCompany/PaperBench rubric scores) carry `resolved=null` + a numeric
 * `score`, where pass@1 is meaningless (it would read every continuous row as a fail) — so
 * they attribute on **meanScore** (`metric:'meanScore'`): per-task mean `score` over scored
 * rows, then mean over tasks (same task-weighting + bootstrap-over-tasks CI as pass@1).
 * Both produce the SAME {@link CapabilityArmAttribution} shape, so a continuous suite's
 * +coord lift sits in the SAME cross-suite headline as a boolean suite's +memory lift.
 *
 * Domain-free: it knows nothing about Papercusp's capability vocab — the control + the
 * capability arms are just arm ids — so it lives in `@papercusp/bench-metrics` next to
 * `buildSuiteReport`. The operator-core injection harnesses pass their profile names
 * (`vanilla` / `+memory` / …) as the arm ids.
 *
 * HONESTY (D-008/D-011): the per-task buckets are DESCRIPTIVE and seed-noisy; significance
 * is CI-non-overlap (conservative — it UNDER-reports rather than over-claims); the
 * single-capability arms are the PRIMARY attribution, the `ours` bundle is confirmatory.
 * The caveats ride the report so a downstream renderer can't drop them.
 */
import type { ArmId, BenchSuite, TaskRunResult } from './schema';
import type { Interval } from './intervals';
import { bootstrapMeanCI } from './intervals';
import { aggregateArm, type AggregateOpts } from './aggregate';
import { isScored } from './cost';

/** The default control arm every capability is attributed OVER (the empty / bare-model profile). */
export const DEFAULT_CONTROL_ARM: ArmId = 'vanilla';

/** Which metric the lift is read on. `passAt1` = boolean-resolved suites; `meanScore` = continuous/partial-credit. */
export type AttributionMetric = 'passAt1' | 'meanScore';

// Mirror aggregate.ts's bootstrap defaults so the pass@1 CI here matches buildSuiteReport exactly.
const DEFAULT_SEED = 0xbe0c;
const DEFAULT_ITERATIONS = 10_000;

/** One capability arm's lift over the control, with cost-normalization + per-task attribution. */
export interface CapabilityArmAttribution {
  /** The capability arm (e.g. `+memory`, `+coord`, `ours`). */
  capability: ArmId;
  /** The control arm it is attributed over (e.g. `vanilla`). */
  control: ArmId;
  /** Which metric `value`/`valueDelta` are in (`passAt1` boolean suites | `meanScore` continuous suites). */
  metric: AttributionMetric;
  /** value(capability) − value(control). Positive ⇒ the capability lifts the metric. */
  valueDelta: number;
  /** The control arm's headline value (pass@1 or meanScore). */
  controlValue: number;
  /** The capability arm's headline value (pass@1 or meanScore). */
  capabilityValue: number;
  /** Bootstrap-over-tasks CIs for both arms' values. */
  controlValueCi: Interval;
  capabilityValueCi: Interval;
  /** TRUE when the two value CIs do NOT overlap — a conservative "this lift is real" flag. */
  significant: boolean;
  /** costPerResolved(capability) / costPerResolved(control). <1 ⇒ cheaper per resolved task (D-008).
   *  null when either arm resolved nothing (no denominator) — incl. pure-continuous suites (no boolean resolved). */
  costRatio: number | null;
  /** capability mean-$/attempt as a fraction of the control's ("at Z% of the cost"). null if control free. */
  costFraction: number | null;
  /** Is the capability STRICTLY Pareto-better than the control (≥ value AND ≤ cost, > on one axis)? (D-008) */
  paretoDominates: boolean;
  /** Tasks the capability UNLOCKED: scored in both arms, capability value strictly > control's. */
  unlockedTasks: string[];
  /** Tasks the capability REGRESSED: scored in both arms, capability value strictly < control's. */
  regressedTasks: string[];
  /** Tasks where both arms score the same value (no attribution signal). */
  neutralTasks: string[];
  /** Count of tasks scored in BOTH arms (the per-task attribution denominator). */
  tasksCompared: number;
}

/** The per-suite attribution report: every non-control arm's lift over the control. */
export interface CapabilityAttributionReport {
  suite: BenchSuite;
  runId: string;
  control: ArmId;
  metric: AttributionMetric;
  /** One row per capability arm (single-capability arms + the bundle), in input arm order. */
  capabilities: CapabilityArmAttribution[];
  /** MANDATORY honest-framing lines (D-008/D-011) — a renderer must surface these. */
  caveats: string[];
}

export interface CapabilityAttributionOpts extends AggregateOpts {
  /** The control arm (default {@link DEFAULT_CONTROL_ARM} = `vanilla`). */
  control?: ArmId;
  /** Restrict attribution to these capability arms (default: every non-control arm, first-seen order). */
  capabilityArms?: ArmId[];
  /** Boolean-resolved (`passAt1`, default) vs continuous/partial-credit (`meanScore`) suites. */
  metric?: AttributionMetric;
}

/** Per-task value for one arm: taskId → { headline value, scored-seed count } under the chosen metric. */
function perTaskValue(rows: readonly TaskRunResult[], metric: AttributionMetric): Map<string, { value: number; n: number }> {
  const acc = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    if (!isScored(r)) continue;
    if (metric === 'meanScore' && typeof r.score !== 'number') continue; // a continuous suite scores on numeric `score`.
    const t = acc.get(r.taskId) ?? { sum: 0, n: 0 };
    t.n += 1;
    t.sum += metric === 'meanScore' ? (r.score as number) : r.resolved === true ? 1 : 0;
    acc.set(r.taskId, t);
  }
  const out = new Map<string, { value: number; n: number }>();
  for (const [taskId, { sum, n }] of acc) out.set(taskId, { value: n === 0 ? 0 : sum / n, n });
  return out;
}

/** An arm's headline value (mean over tasks of per-task value) + bootstrap-over-tasks CI, for `metric`. */
function armValue(
  perTask: Map<string, { value: number; n: number }>,
  opts: CapabilityAttributionOpts,
): { value: number; ci: Interval } {
  const vals = [...perTask.values()].map((t) => t.value);
  const value = vals.length === 0 ? 0 : vals.reduce((a, b) => a + b, 0) / vals.length;
  const ci = bootstrapMeanCI(vals, {
    ci: opts.ci ?? 0.95,
    seed: opts.bootstrapSeed ?? DEFAULT_SEED,
    iterations: opts.bootstrapIterations ?? DEFAULT_ITERATIONS,
  });
  return { value, ci };
}

/** Two CIs are non-overlapping (a conservative significance test) when one's upper < the other's lower. */
function ciDisjoint(a: Interval, b: Interval): boolean {
  return a.upper < b.lower || b.upper < a.lower;
}

/** Mean $/attempt for an arm (the cost axis; mirrors `buildSuiteReport`'s Pareto points). */
function costPerAttempt(costUsd: number, attempts: number): number {
  return attempts === 0 ? 0 : costUsd / attempts;
}

/**
 * Build the per-suite capability-attribution report: hold `control` fixed and read every other arm's lift
 * over it. The pass@1 path delegates to {@link aggregateArm} (numbers byte-identical to {@link buildSuiteReport});
 * the meanScore path computes the continuous-score equivalent. Adds the cost-normalized lift (D-008) + the
 * per-task unlock/regression buckets (D-011). `rows` is every run-result for ONE suite (control + capability
 * arms × seeds).
 *
 * Throws when `rows` is empty or the control arm has no rows (an attribution with nothing to attribute over
 * is a caller error, mirroring `buildSuiteReport`'s empty-rows throw).
 */
export function buildCapabilityAttribution(
  rows: readonly TaskRunResult[],
  opts: CapabilityAttributionOpts = {},
): CapabilityAttributionReport {
  if (rows.length === 0) throw new Error('buildCapabilityAttribution: no rows');
  const control = opts.control ?? DEFAULT_CONTROL_ARM;
  const metric = opts.metric ?? 'passAt1';
  const suite = rows[0].suite;
  const runId = rows[0].runId;

  const controlRows = rows.filter((r) => r.arm === control);
  if (controlRows.length === 0) {
    throw new Error(`buildCapabilityAttribution: control arm "${control}" has no rows (arms present: ${[...new Set(rows.map((r) => r.arm))].join(', ')})`);
  }

  // First-seen arm order (matches buildSuiteReport), minus the control.
  const armOrder = [...new Set(rows.map((r) => r.arm))];
  const capabilityArms = (opts.capabilityArms ?? armOrder).filter((a) => a !== control);

  const controlAgg = aggregateArm(controlRows, suite, control, opts);
  const controlPerTask = perTaskValue(controlRows, metric);
  const controlVal = metric === 'meanScore' ? armValue(controlPerTask, opts) : { value: controlAgg.passAt1, ci: controlAgg.passAt1Ci };
  const controlCostPerAttempt = costPerAttempt(controlAgg.cost.costUsd, controlAgg.attempts);

  const capabilities: CapabilityArmAttribution[] = [];
  for (const arm of capabilityArms) {
    const armRows = rows.filter((r) => r.arm === arm);
    if (armRows.length === 0) continue; // a named-but-absent capability arm is skipped (not an error).
    const armAgg = aggregateArm(armRows, suite, arm, opts);
    const armPerTask = perTaskValue(armRows, metric);
    const armVal = metric === 'meanScore' ? armValue(armPerTask, opts) : { value: armAgg.passAt1, ci: armAgg.passAt1Ci };

    // Per-task attribution over tasks scored in BOTH arms.
    const unlockedTasks: string[] = [];
    const regressedTasks: string[] = [];
    const neutralTasks: string[] = [];
    for (const [taskId, cap] of armPerTask) {
      const ctrl = controlPerTask.get(taskId);
      if (!ctrl) continue; // not scored in the control arm → no comparison.
      if (cap.value > ctrl.value) unlockedTasks.push(taskId);
      else if (cap.value < ctrl.value) regressedTasks.push(taskId);
      else neutralTasks.push(taskId);
    }

    const armCostPerAttempt = costPerAttempt(armAgg.cost.costUsd, armAgg.attempts);
    const cpr = armAgg.cost.costPerResolved;
    const ctrlCpr = controlAgg.cost.costPerResolved;
    const costRatio = cpr !== null && ctrlCpr !== null && ctrlCpr !== 0 ? cpr / ctrlCpr : null;
    const costFraction = controlCostPerAttempt === 0 ? null : armCostPerAttempt / controlCostPerAttempt;
    const paretoDominates =
      armVal.value >= controlVal.value &&
      armCostPerAttempt <= controlCostPerAttempt &&
      (armVal.value > controlVal.value || armCostPerAttempt < controlCostPerAttempt);

    capabilities.push({
      capability: arm,
      control,
      metric,
      valueDelta: armVal.value - controlVal.value,
      controlValue: controlVal.value,
      capabilityValue: armVal.value,
      controlValueCi: controlVal.ci,
      capabilityValueCi: armVal.ci,
      significant: ciDisjoint(controlVal.ci, armVal.ci),
      costRatio,
      costFraction,
      paretoDominates,
      unlockedTasks: unlockedTasks.sort(),
      regressedTasks: regressedTasks.sort(),
      neutralTasks: neutralTasks.sort(),
      tasksCompared: unlockedTasks.length + regressedTasks.length + neutralTasks.length,
    });
  }

  return { suite, runId, control, metric, capabilities, caveats: ATTRIBUTION_CAVEATS };
}

/** The mandatory honest-framing lines that ride every attribution report (D-008/D-011). */
export const ATTRIBUTION_CAVEATS: string[] = [
  'PRIMARY = single-capability arms (D-011): the attribution story is the per-capability lift (+memory / +coord / +workqueue), each over the same vanilla control; the `ours` bundle is confirmatory, not the headline.',
  'COST-NORMALIZED (D-008): a capability "wins" only if it lifts the metric at equal-or-better cost — read `paretoDominates` + `costRatio` (costPerResolved capability/control; <1 = cheaper per resolved task), never the raw value delta alone.',
  'SIGNIFICANCE is CI-non-overlap on the headline value (bootstrap over tasks) — a CONSERVATIVE flag: it under-reports real lifts rather than over-claiming. A non-significant positive delta is suggestive, not established.',
  'PER-TASK buckets (unlocked / regressed) are DESCRIPTIVE and seed-noisy: a task "unlocked" on few seeds is weak evidence. Use them to point at WHERE a capability helps, then confirm with more seeds.',
  'METRIC: boolean-resolved suites attribute on pass@1; continuous / partial-credit suites (SwarmBench, AgentsNet, rubric suites) attribute on meanScore — the value delta is in that suite\'s metric, never mixed across metrics.',
];

/* ----------------------------- cross-suite roll-up ----------------------------- */

/** One cell of the headline matrix: a capability's attribution on one suite (compact). */
export interface CrossSuiteCell {
  suite: BenchSuite;
  capability: ArmId;
  metric: AttributionMetric;
  valueDelta: number;
  significant: boolean;
  costRatio: number | null;
  paretoDominates: boolean;
  unlockedCount: number;
  regressedCount: number;
}

/** A capability's summary ACROSS suites (the "+memory lifts on N/M suites" line). */
export interface CapabilityRollup {
  capability: ArmId;
  /** Suites this capability ran on (had a row). */
  suites: number;
  /** Mean value delta over those suites (simple mean — each suite weighted equally).
   *  NB this mixes pass@1 + meanScore deltas across suites of different metrics; read it as a coarse
   *  "net direction" indicator and rely on the per-suite cells for the honest per-metric number. */
  meanValueDelta: number;
  /** Suites where the lift was significant (CI-disjoint). */
  suitesSignificant: number;
  /** Suites where the capability was strictly Pareto-better than the control. */
  suitesParetoBetter: number;
  /** Total tasks unlocked across suites. */
  totalUnlocked: number;
  /** Total tasks regressed across suites (the honest counter-evidence). */
  totalRegressed: number;
}

export interface CrossSuiteAttribution {
  /** suite × capability cells (every report's every capability), in report-then-arm order. */
  cells: CrossSuiteCell[];
  /** Per-capability summary across the suites it appeared on. */
  rollup: CapabilityRollup[];
  caveats: string[];
}

/**
 * Fold many per-suite {@link CapabilityAttributionReport}s into the headline cross-suite matrix + a
 * per-capability roll-up — "the same model + capability layer is measurably better; here's which capability,
 * on which suite". Pure aggregation over the per-suite reports (no re-scoring). A capability is rolled up over
 * exactly the suites it appeared on; `meanValueDelta` weights each such suite equally.
 */
export function buildCrossSuiteAttribution(reports: readonly CapabilityAttributionReport[]): CrossSuiteAttribution {
  const cells: CrossSuiteCell[] = [];
  for (const rep of reports) {
    for (const cap of rep.capabilities) {
      cells.push({
        suite: rep.suite,
        capability: cap.capability,
        metric: cap.metric,
        valueDelta: cap.valueDelta,
        significant: cap.significant,
        costRatio: cap.costRatio,
        paretoDominates: cap.paretoDominates,
        unlockedCount: cap.unlockedTasks.length,
        regressedCount: cap.regressedTasks.length,
      });
    }
  }

  // Per-capability roll-up, in first-seen capability order across the reports.
  const order: ArmId[] = [];
  const byCap = new Map<ArmId, CrossSuiteCell[]>();
  for (const c of cells) {
    if (!byCap.has(c.capability)) {
      byCap.set(c.capability, []);
      order.push(c.capability);
    }
    byCap.get(c.capability)!.push(c);
  }
  const rollup: CapabilityRollup[] = order.map((capability) => {
    const cs = byCap.get(capability)!;
    const suites = cs.length;
    return {
      capability,
      suites,
      meanValueDelta: suites === 0 ? 0 : cs.reduce((s, c) => s + c.valueDelta, 0) / suites,
      suitesSignificant: cs.filter((c) => c.significant).length,
      suitesParetoBetter: cs.filter((c) => c.paretoDominates).length,
      totalUnlocked: cs.reduce((s, c) => s + c.unlockedCount, 0),
      totalRegressed: cs.reduce((s, c) => s + c.regressedCount, 0),
    };
  });

  return { cells, rollup, caveats: ATTRIBUTION_CAVEATS };
}

/* ----------------------------- narrative formatting ----------------------------- */

/**
 * One human-readable line per capability for a suite report — the narrative the methodology doc / report
 * surface prints. Pure formatting over {@link buildCapabilityAttribution}'s output (no recompute). Marks a
 * significant + Pareto-better lift "✓", a positive-but-unconfirmed lift "~", a regression "✗".
 */
export function formatAttributionLines(report: CapabilityAttributionReport): string[] {
  return report.capabilities.map((c) => {
    const delta =
      c.metric === 'passAt1'
        ? (c.valueDelta >= 0 ? '+' : '') + (c.valueDelta * 100).toFixed(1) + 'pp pass@1'
        : (c.valueDelta >= 0 ? '+' : '') + c.valueDelta.toFixed(3) + ' meanScore';
    const mark = c.valueDelta > 0 && c.significant && c.paretoDominates ? '✓' : c.valueDelta > 0 ? '~' : c.valueDelta < 0 ? '✗' : '·';
    const cost = c.costRatio === null ? 'cost n/a' : `${c.costRatio.toFixed(2)}× $/resolved`;
    const sig = c.significant ? 'sig' : 'ns';
    const tasks = `${c.unlockedTasks.length}↑/${c.regressedTasks.length}↓ of ${c.tasksCompared}`;
    return `${mark} ${c.capability} vs ${c.control} on ${report.suite}: ${delta} (${sig}), ${cost}, tasks ${tasks}`;
  });
}
