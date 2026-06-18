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
 *      other arm's lift OVER it — accuracy delta, cost-normalized (D-008: costPerResolved
 *      ratio + Pareto-dominance), and a conservative CI-non-overlap significance flag.
 *      (`buildSuiteReport`'s deltas are treatment−baseline for ONE treatment; this is the
 *      inverse view — one control, every capability as a treatment — which is the
 *      attribution framing of D-011.)
 *
 *   2. PER-TASK attribution — the "which capability, on which TASK" narrative (the plan's
 *      P-011 headline). For each capability arm we classify every commonly-scored task as
 *      `unlocked` (the capability resolves a strictly higher seed-rate than the control),
 *      `regressed` (strictly lower), or `neutral`. The unlocked-task list is the sellable
 *      evidence: "memory unlocked task-A; coord unlocked task-B".
 *
 *   3. A CROSS-SUITE roll-up — fold many per-suite attributions into the headline matrix
 *      (suite × capability → lift / significant? / Pareto-better? / #unlocked) + a
 *      per-capability summary across suites ("+memory lifts on N/M suites").
 *
 * Domain-free: it knows nothing about Papercusp's capability vocab — the control + the
 * capability arms are just arm ids — so it lives in `@papercusp/bench-metrics` next to
 * `buildSuiteReport` and reuses `aggregateArm`. The operator-core injection harnesses pass
 * their profile names (`vanilla` / `+memory` / …) as the arm ids.
 *
 * HONESTY (D-008/D-011): the per-task buckets are DESCRIPTIVE and seed-noisy (a 1-seed
 * "unlock" is weak evidence); significance is CI-non-overlap on pass@1 (conservative — it
 * UNDER-reports rather than over-claims); the single-capability arms are the PRIMARY
 * attribution, the `ours` bundle is confirmatory. The caveats ride the report so a
 * downstream renderer can't drop them.
 */
import type { ArmId, BenchSuite, TaskRunResult } from './schema';
import type { Interval } from './intervals';
import { aggregateArm, type AggregateOpts } from './aggregate';
import { isScored } from './cost';

/** The default control arm every capability is attributed OVER (the empty / bare-model profile). */
export const DEFAULT_CONTROL_ARM: ArmId = 'vanilla';

/** One capability arm's lift over the control, with cost-normalization + per-task attribution. */
export interface CapabilityArmAttribution {
  /** The capability arm (e.g. `+memory`, `+coord`, `ours`). */
  capability: ArmId;
  /** The control arm it is attributed over (e.g. `vanilla`). */
  control: ArmId;
  /** pass@1(capability) − pass@1(control). Positive ⇒ the capability lifts accuracy. */
  accuracyDelta: number;
  controlPassAt1: number;
  capabilityPassAt1: number;
  /** Bootstrap-over-tasks CIs for both arms (from {@link aggregateArm}). */
  controlPassAt1Ci: Interval;
  capabilityPassAt1Ci: Interval;
  /** TRUE when the two pass@1 CIs do NOT overlap — a conservative "this lift is real" flag. */
  significant: boolean;
  /** costPerResolved(capability) / costPerResolved(control). <1 ⇒ cheaper per resolved task (D-008).
   *  null when either arm resolved nothing (no denominator). */
  costRatio: number | null;
  /** capability mean-$/attempt as a fraction of the control's ("at Z% of the cost"). null if control free. */
  costFraction: number | null;
  /** Is the capability STRICTLY Pareto-better than the control (≥ accuracy AND ≤ cost, > on one axis)? (D-008) */
  paretoDominates: boolean;
  /** Tasks the capability UNLOCKED: scored in both arms, capability seed-rate strictly > control's. */
  unlockedTasks: string[];
  /** Tasks the capability REGRESSED: scored in both arms, capability seed-rate strictly < control's. */
  regressedTasks: string[];
  /** Tasks where both arms resolve at the same seed-rate (no attribution signal). */
  neutralTasks: string[];
  /** Count of tasks scored in BOTH arms (the per-task attribution denominator). */
  tasksCompared: number;
}

/** The per-suite attribution report: every non-control arm's lift over the control. */
export interface CapabilityAttributionReport {
  suite: BenchSuite;
  runId: string;
  control: ArmId;
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
}

/** Per-task scored seed-rate for one arm: taskId → { resolved-rate over scored seeds, scored-seed count }. */
function perTaskRate(rows: readonly TaskRunResult[]): Map<string, { rate: number; n: number }> {
  const acc = new Map<string, { c: number; n: number }>();
  for (const r of rows) {
    if (!isScored(r)) continue;
    const t = acc.get(r.taskId) ?? { c: 0, n: 0 };
    t.n += 1;
    if (r.resolved === true) t.c += 1;
    acc.set(r.taskId, t);
  }
  const out = new Map<string, { rate: number; n: number }>();
  for (const [taskId, { c, n }] of acc) out.set(taskId, { rate: n === 0 ? 0 : c / n, n });
  return out;
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
 * over it. Reuses {@link aggregateArm} for the headline pass@1 + CI + cost so the numbers are byte-identical
 * to {@link buildSuiteReport}'s; adds the cost-normalized lift (D-008) + the per-task unlock/regression
 * buckets (D-011). `rows` is every run-result for ONE suite (control + capability arms × seeds).
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
  const suite = rows[0].suite;
  const runId = rows[0].runId;

  const controlRows = rows.filter((r) => r.arm === control);
  if (controlRows.length === 0) {
    throw new Error(`buildCapabilityAttribution: control arm "${control}" has no rows (arms present: ${[...new Set(rows.map((r) => r.arm))].join(', ')})`);
  }

  // First-seen arm order (matches buildSuiteReport), minus the control.
  const armOrder = [...new Set(rows.map((r) => r.arm))];
  const capabilityArms = (opts.capabilityArms ?? armOrder).filter((a) => a !== control);

  const controlReport = aggregateArm(controlRows, suite, control, opts);
  const controlRate = perTaskRate(controlRows);
  const controlCostPerAttempt = costPerAttempt(controlReport.cost.costUsd, controlReport.attempts);

  const capabilities: CapabilityArmAttribution[] = [];
  for (const arm of capabilityArms) {
    const armRows = rows.filter((r) => r.arm === arm);
    if (armRows.length === 0) continue; // a named-but-absent capability arm is skipped (not an error).
    const armReport = aggregateArm(armRows, suite, arm, opts);
    const armRate = perTaskRate(armRows);

    // Per-task attribution over tasks scored in BOTH arms.
    const unlockedTasks: string[] = [];
    const regressedTasks: string[] = [];
    const neutralTasks: string[] = [];
    for (const [taskId, cap] of armRate) {
      const ctrl = controlRate.get(taskId);
      if (!ctrl) continue; // not scored in the control arm → no comparison.
      if (cap.rate > ctrl.rate) unlockedTasks.push(taskId);
      else if (cap.rate < ctrl.rate) regressedTasks.push(taskId);
      else neutralTasks.push(taskId);
    }

    const armCostPerAttempt = costPerAttempt(armReport.cost.costUsd, armReport.attempts);
    const cpr = armReport.cost.costPerResolved;
    const ctrlCpr = controlReport.cost.costPerResolved;
    const costRatio = cpr !== null && ctrlCpr !== null && ctrlCpr !== 0 ? cpr / ctrlCpr : null;
    const costFraction = controlCostPerAttempt === 0 ? null : armCostPerAttempt / controlCostPerAttempt;
    const paretoDominates =
      armReport.passAt1 >= controlReport.passAt1 &&
      armCostPerAttempt <= controlCostPerAttempt &&
      (armReport.passAt1 > controlReport.passAt1 || armCostPerAttempt < controlCostPerAttempt);

    capabilities.push({
      capability: arm,
      control,
      accuracyDelta: armReport.passAt1 - controlReport.passAt1,
      controlPassAt1: controlReport.passAt1,
      capabilityPassAt1: armReport.passAt1,
      controlPassAt1Ci: controlReport.passAt1Ci,
      capabilityPassAt1Ci: armReport.passAt1Ci,
      significant: ciDisjoint(controlReport.passAt1Ci, armReport.passAt1Ci),
      costRatio,
      costFraction,
      paretoDominates,
      unlockedTasks: unlockedTasks.sort(),
      regressedTasks: regressedTasks.sort(),
      neutralTasks: neutralTasks.sort(),
      tasksCompared: unlockedTasks.length + regressedTasks.length + neutralTasks.length,
    });
  }

  return { suite, runId, control, capabilities, caveats: ATTRIBUTION_CAVEATS };
}

/** The mandatory honest-framing lines that ride every attribution report (D-008/D-011). */
export const ATTRIBUTION_CAVEATS: string[] = [
  'PRIMARY = single-capability arms (D-011): the attribution story is the per-capability lift (+memory / +coord / +workqueue), each over the same vanilla control; the `ours` bundle is confirmatory, not the headline.',
  'COST-NORMALIZED (D-008): a capability "wins" only if it lifts pass@1 at equal-or-better cost — read `paretoDominates` + `costRatio` (costPerResolved capability/control; <1 = cheaper per resolved task), never the raw accuracy delta alone.',
  'SIGNIFICANCE is CI-non-overlap on pass@1 (bootstrap over tasks) — a CONSERVATIVE flag: it under-reports real lifts rather than over-claiming. A non-significant positive delta is suggestive, not established.',
  'PER-TASK buckets (unlocked / regressed) are DESCRIPTIVE and seed-noisy: a task "unlocked" on few seeds is weak evidence. Use them to point at WHERE a capability helps, then confirm with more seeds.',
];

/* ----------------------------- cross-suite roll-up ----------------------------- */

/** One cell of the headline matrix: a capability's attribution on one suite (compact). */
export interface CrossSuiteCell {
  suite: BenchSuite;
  capability: ArmId;
  accuracyDelta: number;
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
  /** Mean accuracy delta over those suites (simple mean — each suite weighted equally). */
  meanAccuracyDelta: number;
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
 * exactly the suites it appeared on; `meanAccuracyDelta` weights each such suite equally.
 */
export function buildCrossSuiteAttribution(reports: readonly CapabilityAttributionReport[]): CrossSuiteAttribution {
  const cells: CrossSuiteCell[] = [];
  for (const rep of reports) {
    for (const cap of rep.capabilities) {
      cells.push({
        suite: rep.suite,
        capability: cap.capability,
        accuracyDelta: cap.accuracyDelta,
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
      meanAccuracyDelta: suites === 0 ? 0 : cs.reduce((s, c) => s + c.accuracyDelta, 0) / suites,
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
    const delta = (c.accuracyDelta >= 0 ? '+' : '') + (c.accuracyDelta * 100).toFixed(1) + 'pp';
    const mark = c.accuracyDelta > 0 && c.significant && c.paretoDominates ? '✓' : c.accuracyDelta > 0 ? '~' : c.accuracyDelta < 0 ? '✗' : '·';
    const cost = c.costRatio === null ? 'cost n/a' : `${c.costRatio.toFixed(2)}× $/resolved`;
    const sig = c.significant ? 'sig' : 'ns';
    const tasks = `${c.unlockedTasks.length}↑/${c.regressedTasks.length}↓ of ${c.tasksCompared}`;
    return `${mark} ${c.capability} vs ${c.control} on ${report.suite}: ${delta} pass@1 (${sig}), ${cost}, tasks ${tasks}`;
  });
}
