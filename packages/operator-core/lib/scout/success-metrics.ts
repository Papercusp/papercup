/**
 * success-metrics.ts — the blender-self-learning program's DONE-CHECK
 * (blender-self-learning-2026-07-12 P-015).
 *
 * The program shipped a learning substrate (rubric-grounded ideation, a routed-idea
 * ledger, volume-mode cadence, grading throughput). P-015 asks the one question that
 * closes it: **did the substrate actually start working, on real rows?** — not "do the
 * tests pass" (they did, while the rubric lane sat silently at zero for its whole life)
 * but "is the shipped instrumentation reading back the values the program promised?".
 *
 * So this is a GATE, not another metric: five named bars, each PASS / FAIL / UNKNOWN,
 * evaluated against the ledgers the program itself shipped.
 *
 * Three layers, the same split as {@link ./quality-metrics} (whose readers + report this
 * module REUSES rather than re-querying — a second PG read of the same ledgers is how the
 * two surfaces would silently disagree):
 *
 *  1. **Pure core** — {@link evaluateProgramSuccess} folds the injected ledger snapshots
 *     ({@link ScoutQualityInputs}) into a {@link ProgramSuccessReport}. No PG, no clock.
 *  2. **Assembly** — {@link buildProgramSuccessReport} reads the real ledgers via
 *     {@link buildQualityReportInputs} (lazy PG edge) and folds them.
 *  3. **Surface** — `blender:success-metrics` (agent-tools/scout/success-metrics.ts) makes
 *     it QUERYABLE, which is the actual P-015 deliverable: a check nobody can run is not a
 *     gate. (quality-metrics' own degradation watchdog was built, tested, and never wired
 *     to a caller — this module deliberately ships with its consumer.)
 *
 * ## UNKNOWN is a first-class verdict
 * A bar whose DENOMINATOR is empty is `unknown`, never `pass` and never `fail`: an empty
 * window cannot prove the substrate works, and it must not be allowed to silently certify
 * the program done. The standing house rule — a decision procedure must be shown to
 * DISCRIMINATE on real data before it may act (agent-insights/prove-it-discriminates-
 * before-it-acts) — is why every bar below reports what it actually measured (`observed`)
 * next to the bar it was judged against (`bar`), so a green gate can be audited rather
 * than trusted.
 */

import { groundingLaneHistogram } from './scheduler';
import { computeScoutQualityReport, buildQualityReportInputs, type ScoutQualityInputs } from './quality-metrics';
import type { BuildQualityInputsOptions } from './quality-metrics';
import type { SuIdeationLens } from './types';
import { SU_IDEATION_LENSES } from './types';

/** The digest lane a rubric-RATING-grounded idea is attributed to (scheduler's histogram key). */
export const RUBRIC_GROUNDING_LANE = 'rubric-rating';

export type SuccessStatus = 'pass' | 'fail' | 'unknown';

/** One named bar of the program's done-check. */
export interface SuccessCriterion {
  /** Stable key (the join key for a trend read / a scorecard). */
  key: string;
  /** The bar as the plan stated it. */
  bar: string;
  status: SuccessStatus;
  /** What was actually MEASURED — the audit trail behind `status`. */
  observed: string;
  /** Why the bar could not be judged (present only when status==='unknown'). */
  unknownReason?: string;
}

export interface ProgramSuccessReport {
  criteria: SuccessCriterion[];
  passed: number;
  failed: number;
  unknown: number;
  /**
   * 'pass' — every bar passed. 'fail' — at least one bar FAILED (a real regression
   * against a promise the program made). 'incomplete' — no failures, but at least one bar
   * is unknown (not enough evidence yet). Only 'pass' closes the program.
   */
  verdict: 'pass' | 'fail' | 'incomplete';
  /** Window provenance, so a verdict is never read without knowing what it saw. */
  window: { ticks: number; ranCycles: number; routedIdeas: number; ledgerTruncated: boolean };
}

export interface ProgramSuccessOptions {
  /** Max cycle error rate before the bar fails (default 0.05 — the plan's <5%). */
  maxErrorRate?: number;
  /**
   * The ledger snapshot hit its row limit, so older rows are missing. Reconciliation is
   * reported `unknown` rather than FAILING on rows the read simply never saw (a truncated
   * read would otherwise manufacture phantom drift — the exact false positive that makes a
   * gate untrustworthy and then ignored).
   */
  ledgerTruncated?: boolean;
}

const DEFAULT_MAX_ERROR_RATE = 0.05;

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/**
 * Fold the ledger snapshots into the program's done-check. PURE — deterministic over the
 * inputs, no IO, no clock.
 */
export function evaluateProgramSuccess(
  inputs: ScoutQualityInputs<SuIdeationLens>,
  opts: ProgramSuccessOptions = {},
): ProgramSuccessReport {
  const report = computeScoutQualityReport(inputs, { lenses: SU_IDEATION_LENSES });
  const maxErrorRate = opts.maxErrorRate ?? DEFAULT_MAX_ERROR_RATE;
  const ranTicks = inputs.ticks.filter((t) => t.status === 'ran');
  const criteria: SuccessCriterion[] = [];

  // ── 1. rubric-grounded routed ideas > 0 ─────────────────────────────────────
  // The program's founding defect: the rubric digest lane produced ZERO grounded ideas for
  // its entire life and nobody could see it. Reuse the scheduler's own lane histogram so
  // this reads the SAME attribution the tick detail records (one classifier, not two).
  const lanes = groundingLaneHistogram(inputs.routedIdeas);
  const rubricGrounded = lanes[RUBRIC_GROUNDING_LANE] ?? 0;
  criteria.push({
    key: 'rubric-grounded-ideas',
    bar: 'rubric-grounded routed ideas > 0 (sustained)',
    ...(inputs.routedIdeas.length === 0
      ? {
          status: 'unknown' as const,
          observed: 'no routed ideas in the window',
          unknownReason: 'empty ledger window — nothing to attribute to a lane',
        }
      : {
          status: (rubricGrounded > 0 ? 'pass' : 'fail') as SuccessStatus,
          observed: `${rubricGrounded} of ${inputs.routedIdeas.length} routed ideas grounded in the rubric lane (all lanes: ${JSON.stringify(lanes)})`,
        }),
  });

  // ── 2. zero score-0 cycles fired ────────────────────────────────────────────
  // Volume mode must veto a cycle over an unchanged corpus ('no-signal'), so spend tracks
  // real activity. A cycle that FIRED at score 0 is pure waste. Judged on the score the
  // scheduler now persists at fire time (P-015); ticks predating that write carry no score
  // and are simply not counted against the bar — an ABSENT score means "volume mode wasn't
  // engaged", never "the score was 0", and conflating those would fail the bar on history.
  const scored = ranTicks.filter((t) => typeof t.detail?.signalScore === 'number');
  const zeroSignalFires = scored.filter((t) => (t.detail?.signalScore as number) <= 0);
  const noSignalGates = report.gatedTickBreakdown['no-signal'] ?? 0;
  criteria.push({
    key: 'zero-signal-cycles',
    bar: 'zero score-0 cycles fired (spend drops in quiet periods)',
    ...(scored.length === 0
      ? {
          status: 'unknown' as const,
          observed: `no fired cycle in the window carries a signal score (${noSignalGates} no-signal veto(es) recorded)`,
          unknownReason:
            'volume mode not engaged on any fired tick in this window (or all ticks predate the P-015 score write)',
        }
      : {
          status: (zeroSignalFires.length === 0 ? 'pass' : 'fail') as SuccessStatus,
          observed: `${zeroSignalFires.length} of ${scored.length} scored cycles fired at score<=0; ${noSignalGates} quiet ticks vetoed by the no-signal gate`,
        }),
  });

  // ── 3. cycle error rate < 5% ────────────────────────────────────────────────
  const errorRate = report.totalTicks > 0 ? report.errorTicks / report.totalTicks : null;
  criteria.push({
    key: 'cycle-error-rate',
    bar: `cycle error rate < ${pct(maxErrorRate)} (was ~30%)`,
    ...(errorRate === null
      ? {
          status: 'unknown' as const,
          observed: 'no ticks in the window',
          unknownReason: 'empty tick window — no denominator',
        }
      : {
          status: (errorRate < maxErrorRate ? 'pass' : 'fail') as SuccessStatus,
          observed: `${report.errorTicks} error ticks / ${report.totalTicks} total = ${pct(errorRate)}`,
        }),
  });

  // ── 4. ledger rows reconcile with tick routed counts ────────────────────────
  // Per-CYCLE join (not a window total): a tick claiming it routed N ideas must have N rows
  // on the ledger under its cycleId. A window-level sum would cancel a +3/-3 drift to zero
  // and certify a broken write path as healthy.
  const byCycle = new Map<string, number>();
  for (const idea of inputs.routedIdeas) {
    if (idea.cycleId) byCycle.set(idea.cycleId, (byCycle.get(idea.cycleId) ?? 0) + 1);
  }
  const mismatches: string[] = [];
  let reconciled = 0;
  for (const t of ranTicks) {
    const cycleId = typeof t.detail?.cycleId === 'string' ? t.detail.cycleId : undefined;
    if (!cycleId) continue;
    const claimed = t.ideasRouted ?? 0;
    const actual = byCycle.get(cycleId) ?? 0;
    if (claimed === 0 && actual === 0) continue; // trivially consistent — not evidence
    if (claimed === actual) reconciled += 1;
    else mismatches.push(`${cycleId}: tick claims ${claimed}, ledger has ${actual}`);
  }
  criteria.push({
    key: 'ledger-reconciles',
    bar: 'ledger rows reconcile with tick routed counts (per cycle)',
    ...(opts.ledgerTruncated
      ? {
          status: 'unknown' as const,
          observed: `ledger snapshot truncated at its row limit — ${reconciled} cycle(s) reconciled, ${mismatches.length} apparent mismatch(es) NOT trusted`,
          unknownReason:
            'a truncated ledger read cannot distinguish real write-path drift from rows the read simply did not fetch — re-run with a higher `limit`',
        }
      : reconciled === 0 && mismatches.length === 0
        ? {
            status: 'unknown' as const,
            observed: 'no cycle in the window both ran and routed ideas',
            unknownReason: 'nothing to reconcile — no routing activity in the window',
          }
        : {
            status: (mismatches.length === 0 ? 'pass' : 'fail') as SuccessStatus,
            observed:
              mismatches.length === 0
                ? `${reconciled} cycle(s) reconcile exactly`
                : `${mismatches.length} mismatch(es): ${mismatches.slice(0, 5).join('; ')}`,
          }),
  });

  // ── 5. ≥1 grader suggestion adopted + shipped with attribution ──────────────
  // Operational definition (stated so a green here is auditable): an idea that carries a
  // grader's free-text critique (humanFeedback — the suggestion), a grade attributed to a
  // grader (gradedBy), and a routedRef (it was adopted onto a rail, not just scored). That
  // triple is the closed learning loop the program set out to build: a grade that CHANGED
  // something and can be traced back to who said it.
  const graded = inputs.routedIdeas.filter((i) => i.humanGrade != null);
  const adopted = inputs.routedIdeas.filter(
    (i) => i.humanFeedback && i.humanFeedback.trim().length > 0 && i.gradedBy && i.routedRef,
  );
  criteria.push({
    key: 'grader-suggestion-adopted',
    bar: '>=1 grader suggestion adopted + shipped with attribution',
    ...(graded.length === 0
      ? {
          status: 'unknown' as const,
          observed: `0 of ${inputs.routedIdeas.length} routed ideas are graded at all`,
          unknownReason: 'no grades in the window — the grading channel has not produced input yet',
        }
      : {
          status: (adopted.length > 0 ? 'pass' : 'fail') as SuccessStatus,
          observed: `${adopted.length} graded+attributed idea(s) routed onto a rail (of ${graded.length} graded / ${inputs.routedIdeas.length} routed)`,
        }),
  });

  const passed = criteria.filter((c) => c.status === 'pass').length;
  const failed = criteria.filter((c) => c.status === 'fail').length;
  const unknown = criteria.filter((c) => c.status === 'unknown').length;
  return {
    criteria,
    passed,
    failed,
    unknown,
    verdict: failed > 0 ? 'fail' : unknown > 0 ? 'incomplete' : 'pass',
    window: {
      ticks: inputs.ticks.length,
      ranCycles: ranTicks.length,
      routedIdeas: inputs.routedIdeas.length,
      ledgerTruncated: opts.ledgerTruncated === true,
    },
  };
}

export interface BuildProgramSuccessOptions
  extends Pick<BuildQualityInputsOptions, 'workspaceId' | 'harnessSlug' | 'limit' | 'tickLimit'> {
  maxErrorRate?: number;
}

/** Default ledger row cap — also the truncation probe (rows === limit ⇒ older rows unseen). */
const DEFAULT_LEDGER_LIMIT = 500;

/**
 * Read the real ledgers and evaluate the program's done-check. Reuses
 * {@link buildQualityReportInputs} over the `su-ideate` partition, so this gate and the
 * standing quality report can never read different rows.
 */
export async function buildProgramSuccessReport(
  opts: BuildProgramSuccessOptions = {},
): Promise<ProgramSuccessReport> {
  const limit = opts.limit ?? DEFAULT_LEDGER_LIMIT;
  const inputs = await buildQualityReportInputs<SuIdeationLens>({
    ...opts,
    limit,
    origin: 'su-ideate',
    lenses: SU_IDEATION_LENSES,
  });
  return evaluateProgramSuccess(inputs, {
    ...(opts.maxErrorRate != null ? { maxErrorRate: opts.maxErrorRate } : {}),
    // A full page back means the read almost certainly hit the cap and older rows are
    // unseen — reconciliation must not FAIL on rows it never fetched.
    ledgerTruncated: inputs.routedIdeas.length >= limit,
  });
}
