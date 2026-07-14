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
import { hasForcedDiversity } from './invariants';
import type { RoutedIdeaProvenance } from './outcome-feedback';
import type { CreativeLens, SuIdeationLens } from './types';
import { SU_IDEATION_LENSES } from './types';

/** The digest lane a rubric-RATING-grounded idea is attributed to (scheduler's histogram key). */
export const RUBRIC_GROUNDING_LANE = 'rubric-rating';

/**
 * How many of the NEWEST scout-routed ideas the lens-diversity bar looks at (WI-4482).
 *
 * It MUST be a recent sample, not the whole window: the roster collapsed to a single lens
 * on 2026-06-25, but the ledger still holds multi-lens rows from 2026-06-11, so a lifetime
 * `distinct(lens)` count reports 4 lenses and PASSES a bar that is presently broken. Judging
 * a live-health question over a window that straddles the regression is the same
 * measure-across-a-boundary error that made the ledger-reconcile bar read as drift
 * (LEDGER_RECONCILE_EPOCH_MS) — here the fix is a recency sample rather than an epoch floor,
 * because "is the roster diverse RIGHT NOW" has no fix-boundary to anchor to.
 */
export const LENS_DIVERSITY_SAMPLE = 20;

/**
 * The program spans TWO ledger partitions, and the bars do not all live on the same one —
 * reading only one silently turns half the gate into UNKNOWN (the first live run of this
 * module did exactly that, and it looked like missing data rather than a bug in the read):
 *
 *  - **cadence** (`origin:'scout'`) — the ticks the CADENCE GATE actually governs. Only a
 *    Scout cycle is gated, scored, and joined to a cycleId, so the volume-mode, error-rate
 *    and reconciliation bars can ONLY be judged here. A `su-ideate` tick is a hand-recorded
 *    pass (blender:ideate-pass-record): it never gates, never carries a signal score, and
 *    never routes under a cycleId — asking it those questions is a category error.
 *  - **ideas** — every routed idea, BOTH origins. Rubric grounding and grader adoption are
 *    properties of the SUBSTRATE'S OUTPUT, wherever the idea came from; partitioning them
 *    would hide (e.g.) the fact that every graded+adopted idea today is Scout-origin.
 */
export interface ProgramSuccessInputs {
  cadence: ScoutQualityInputs<CreativeLens>;
  ideas: readonly RoutedIdeaProvenance[];
}

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
  window: {
    ticks: number;
    ranCycles: number;
    routedIdeas: number;
    ledgerTruncated: boolean;
    /** Assembly-time tick window; absent for injected pure-core fixtures. */
    tickWindowMs?: number;
    tickSinceMs?: number;
    tickInstallSlug?: string;
  };
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
  /**
   * Cycles started before this epoch-ms are EXCLUDED from the reconciliation bar (default
   * {@link LEDGER_RECONCILE_EPOCH_MS} — the P-003 fix's enablement). Pass 0 to judge all of
   * history, e.g. to re-measure the scale of the pre-fix damage.
   */
  reconcileEpochMs?: number;
}

const DEFAULT_MAX_ERROR_RATE = 0.05;

/**
 * ENABLEMENT EPOCH for the reconciliation bar (the D-013 pattern already used by
 * ungraded-filings-watchdog's SU_IDEATE_UNGRADED_EPOCH_MS — same problem, same shape).
 *
 * Cycles BEFORE this predate the P-003 ledger-gap fix (scheduler.ts persistRouted): idea ids
 * were POSITIONAL and the ledger upserts ON CONFLICT (idea_id), so every cycle OVERWROTE the
 * previous cycle's rows. Those rows are destroyed and unrecoverable (tracked for annotation
 * in WI-4467) — judging them here would red-pin this bar FOREVER on damage that no fix can
 * repair, and a gate that can never go green is a gate everyone learns to ignore. So the bar
 * judges only cycles the fix actually governs.
 *
 * Set to the bg-host restart that loaded the fix (2026-07-12 14:50 EDT). VERIFIED at that
 * boundary: 432 pre-fix routing cycles → 4 reconciled / 428 drifted; 7 post-fix cycles →
 * 7 reconciled / 0 drifted.
 */
export const LEDGER_RECONCILE_EPOCH_MS = Date.parse('2026-07-12T18:50:00Z');

/** A scout cycleId is `scout-<epochMs>` — recover the cycle's wall-clock for the epoch floor. */
function cycleStartMs(cycleId: string): number | null {
  const ms = Number(cycleId.replace(/^scout-/, '').split(':')[0]);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/**
 * Fold the ledger snapshots into the program's done-check. PURE — deterministic over the
 * inputs, no IO, no clock.
 */
export function evaluateProgramSuccess(
  inputs: ProgramSuccessInputs,
  opts: ProgramSuccessOptions = {},
): ProgramSuccessReport {
  const report = computeScoutQualityReport(inputs.cadence);
  const maxErrorRate = opts.maxErrorRate ?? DEFAULT_MAX_ERROR_RATE;
  const ranTicks = inputs.cadence.ticks.filter((t) => t.status === 'ran');
  const ideas = inputs.ideas;
  const criteria: SuccessCriterion[] = [];

  // ── 1. rubric-grounded routed ideas > 0 ─────────────────────────────────────
  // The program's founding defect: the rubric digest lane produced ZERO grounded ideas for
  // its entire life and nobody could see it. Reuse the scheduler's own lane histogram so
  // this reads the SAME attribution the tick detail records (one classifier, not two).
  const lanes = groundingLaneHistogram(ideas);
  const rubricGrounded = lanes[RUBRIC_GROUNDING_LANE] ?? 0;
  const anyGrounded = Object.values(lanes).reduce((a, b) => a + b, 0);
  criteria.push({
    key: 'rubric-grounded-ideas',
    bar: 'rubric-grounded routed ideas > 0 (sustained)',
    ...(ideas.length === 0
      ? {
          status: 'unknown' as const,
          observed: 'no routed ideas in the window',
          unknownReason: 'empty ledger window — nothing to attribute to a lane',
        }
      : {
          status: (rubricGrounded > 0 ? 'pass' : 'fail') as SuccessStatus,
          // When EVERY lane is zero, the defect is upstream of the rubric lane: nothing is
          // grounded to anything, so the rubric lane CANNOT be non-zero. Say so — "0
          // rubric-grounded" and "nothing is grounded to anything" are very different bugs
          // and the second masquerades as the first.
          //
          // But do NOT name a culprit we have not verified. An earlier version of this line
          // asserted "addressesPatternRefs is never populated on the ledger WRITE" — and that
          // false attribution cost a real investigation (WI-4474): the write path was correct
          // all along and the READ path (readRoutedIdeas) was silently dropping the column.
          // A read-side field-drop is INDISTINGUISHABLE from a write-side population failure
          // from here, because this report only ever sees the read. So state the observation
          // and hand over the one query that discriminates, rather than guessing a direction.
          observed:
            anyGrounded === 0
              ? `NO routed idea carries pattern refs at all (0 of ${ideas.length}) — every grounding lane is empty, so the rubric lane cannot be non-zero. This is upstream of the rubric lane, but it does NOT say whether the WRITE or the READ is at fault (this report only sees the read). Discriminate before fixing: SELECT count(*) FILTER (WHERE jsonb_array_length(COALESCE(addresses_pattern_refs,'[]'::jsonb)) > 0) FROM harness_shared.scout_routed_ideas WHERE origin='scout' — refs present in the column ⇒ the read path is dropping them; absent ⇒ the write/ideator path never produced them.`
              : `${rubricGrounded} of ${ideas.length} routed ideas grounded in the rubric lane (all lanes: ${JSON.stringify(lanes)})`,
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
  // Counts only genuine FAILURES. A cycle withheld because the LLM pool had no capacity is
  // gated ('no-capacity'), not errored — pool busy-ness is a resource ceiling, not breakage,
  // and counting it here is what pinned this bar at ~30%. The classification is applied on
  // BOTH sides by the SAME pure predicate (capacity-errors.isCapacityError): the scheduler
  // gates a LIVE capacity failure at write time, and computeScoutQualityReport re-classifies
  // a HISTORICAL error tick the same way at read time — so this bar reflects real breakage
  // regardless of when the write-path change went live, instead of staying red on legacy rows
  // (WI-4475). The capacity gate is reported alongside so the pressure stays VISIBLE rather
  // than reclassified out of sight: a high no-capacity count with a green error bar is a real
  // and actionable signal (the loop is healthy but the account pool is starved).
  const errorRate = report.totalTicks > 0 ? report.errorTicks / report.totalTicks : null;
  const noCapacity = report.gatedTickBreakdown['no-capacity'] ?? 0;
  const capacityNote =
    noCapacity > 0 ? ` — plus ${noCapacity} cycle(s) withheld by the no-capacity gate (pool starved, not broken)` : '';
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
          observed: `${report.errorTicks} error ticks / ${report.totalTicks} total = ${pct(errorRate)}${capacityNote}`,
        }),
  });

  // ── 4. ledger rows reconcile with tick routed counts ────────────────────────
  // Per-CYCLE join (not a window total): a tick claiming it routed N ideas must have N rows
  // on the ledger under its cycleId. A window-level sum would cancel a +3/-3 drift to zero
  // and certify a broken write path as healthy.
  // Joined WITHIN the cadence partition: a scout tick's cycleId can only match a
  // scout-origin ledger row, so a cross-origin join would report phantom drift.
  const byCycle = new Map<string, number>();
  for (const idea of inputs.cadence.routedIdeas) {
    if (idea.cycleId) byCycle.set(idea.cycleId, (byCycle.get(idea.cycleId) ?? 0) + 1);
  }
  const epoch = opts.reconcileEpochMs ?? LEDGER_RECONCILE_EPOCH_MS;
  const mismatches: string[] = [];
  let reconciled = 0;
  let preFixSkipped = 0;
  for (const t of ranTicks) {
    const cycleId = typeof t.detail?.cycleId === 'string' ? t.detail.cycleId : undefined;
    if (!cycleId) continue;
    const claimed = t.ideasRouted ?? 0;
    const actual = byCycle.get(cycleId) ?? 0;
    if (claimed === 0 && actual === 0) continue; // trivially consistent — not evidence
    // Pre-fix cycles are EXCLUDED, not counted as drift (see LEDGER_RECONCILE_EPOCH_MS). A
    // cycle with an unparseable id is judged rather than silently skipped — an unknown-age
    // cycle must not become a free pass.
    const startedMs = cycleStartMs(cycleId);
    if (startedMs !== null && startedMs < epoch) {
      preFixSkipped += 1;
      continue;
    }
    if (claimed === actual) reconciled += 1;
    else mismatches.push(`${cycleId}: tick claims ${claimed}, ledger has ${actual}`);
  }
  const preFixNote = preFixSkipped > 0 ? ` (${preFixSkipped} pre-fix cycle(s) excluded — their rows were destroyed by the pre-P-003 overwrite bug; see WI-4467)` : '';
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
            observed: `no post-fix cycle in the window both ran and routed ideas${preFixNote}`,
            unknownReason: 'nothing to reconcile — no routing activity the P-003 fix governs',
          }
        : {
            status: (mismatches.length === 0 ? 'pass' : 'fail') as SuccessStatus,
            observed:
              mismatches.length === 0
                ? `${reconciled} cycle(s) reconcile exactly${preFixNote}`
                : `${mismatches.length} mismatch(es)${preFixNote}: ${mismatches.slice(0, 5).join('; ')}`,
          }),
  });

  // ── 5. ≥1 routed idea has grade + feedback + grader attribution ──────────────
  // This ledger can prove that feedback was RECORDED and ATTRIBUTED on a routed idea. It
  // cannot prove the feedback was ADOPTED: routedRef is written when the idea is initially
  // routed, before human_grade / human_feedback exist, so using routedRef as post-grade
  // adoption evidence is structurally backwards (WI-4768). Keep this bar deliberately
  // narrower and honest; feedback-driven revision/adoption is judged by the rubric's
  // grade→revise drill until the ledger carries explicit revision lineage.
  const graded = ideas.filter((i) => i.humanGrade != null);
  const attributedFeedback = graded.filter(
    (i) => i.humanFeedback && i.humanFeedback.trim().length > 0 && i.gradedBy,
  );
  criteria.push({
    key: 'grader-feedback-attributed',
    bar: '>=1 routed idea carries an explicit grade, feedback, and grader attribution',
    ...(graded.length === 0
      ? {
          status: 'unknown' as const,
          observed: `0 of ${ideas.length} routed ideas are graded at all`,
          unknownReason: 'no grades in the window — the grading channel has not produced input yet',
        }
      : {
          status: (attributedFeedback.length > 0 ? 'pass' : 'fail') as SuccessStatus,
          observed: `${attributedFeedback.length} routed idea(s) carry grade+feedback+grader attribution (of ${graded.length} graded / ${ideas.length} routed); this bar does not claim the feedback was adopted`,
        }),
  });

  // ── 6. lens diversity — the roster actually spans lenses (D-004) ─────────────
  // WI-4482: a stale debug config (`maxIdeators: 1`, set 2026-06-25) collapsed the roster to
  // the FIRST lens only, so every cycle for 17 days ran `analogical` alone. That silently
  // voided forced-diversity (D-004) AND left the entire per-lens learning subsystem
  // (scout_lens_weights / perLensWinRates / weight-proportional extra ideators) with a
  // dimension that never varies — a founding invariant of this program, dead, with NOTHING
  // in the gate to notice. A health check that cannot see its own premise collapse is the
  // defect this bar exists to close.
  //
  // Judged on the SCOUT partition only: su-ideate rows carry a different lens vocabulary
  // (SU_IDEATION_LENSES), so mixing them would let su lens variety mask a dead scout roster.
  // Reuses the shipped D-004 predicate (invariants.hasForcedDiversity) rather than
  // re-deriving "diverse" — one notion, every consumer.
  const recentScoutIdeas = inputs.cadence.routedIdeas.slice(0, LENS_DIVERSITY_SAMPLE);
  const lensesSeen = [...new Set(recentScoutIdeas.map((i) => i.lens))].sort();
  criteria.push({
    key: 'lens-diversity',
    bar: `scout roster spans >=2 lenses (D-004 forced diversity, newest ${LENS_DIVERSITY_SAMPLE} routed ideas)`,
    // A sample of 0-1 ideas CANNOT certify diversity. hasForcedDiversity() deliberately
    // returns true for <=1 idea ("a single idea cannot collapse") — correct as an invariant,
    // but as a health bar that is a FALSE PASS: it would green exactly when a roster so
    // broken it emits one idea per window is at its worst. Empty denominators are unknown.
    ...(recentScoutIdeas.length < 2
      ? {
          status: 'unknown' as const,
          observed: `only ${recentScoutIdeas.length} scout-routed idea(s) in the recent sample — too few to judge diversity`,
          unknownReason:
            'a sample of <2 ideas cannot distinguish a diverse roster from a collapsed one (and must not be allowed to certify either)',
        }
      : {
          status: (hasForcedDiversity(recentScoutIdeas, 2) ? 'pass' : 'fail') as SuccessStatus,
          observed:
            lensesSeen.length >= 2
              ? `${lensesSeen.length} distinct lenses across the newest ${recentScoutIdeas.length} scout-routed ideas: ${lensesSeen.join(', ')}`
              : `ROSTER COLLAPSED — all ${recentScoutIdeas.length} of the newest scout-routed ideas are a SINGLE lens (${lensesSeen[0]}). The per-lens learning subsystem has nothing to learn from. Check the scout routine's budget.maxIdeators (1 ⇒ first lens only; see WI-4482).`,
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
      ticks: inputs.cadence.ticks.length,
      ranCycles: ranTicks.length,
      routedIdeas: ideas.length,
      ledgerTruncated: opts.ledgerTruncated === true,
    },
  };
}

export interface BuildProgramSuccessOptions
  extends Pick<BuildQualityInputsOptions, 'workspaceId' | 'harnessSlug' | 'limit' | 'tickLimit'> {
  maxErrorRate?: number;
  /** Release-bar time box. Default 48h, matching blender-release-readiness. */
  cycleWindowMs?: number;
  /** Deterministic clock injection for tests. */
  nowMs?: number;
}

/** Default ledger row cap — also the truncation probe (rows === limit ⇒ older rows unseen). */
const DEFAULT_LEDGER_LIMIT = 500;
/** The active blender-release-readiness rubric's cycle-error window. */
export const CYCLE_ERROR_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Workspace-global Scout ticks and Scout-origin routed ideas live here. */
export const SCOUT_TICK_INSTALL_SLUG = '@singleton';

/**
 * Build the two production reader scopes in one pure helper. The split is load-bearing:
 * workspace Scout cadence ticks AND Scout-origin routed ideas live under `@singleton`,
 * while su-ideate rows remain scoped to their originating harness. Using a member harness
 * for the cadence ledger manufactured missing-row failures: the singleton ticks claimed
 * routes that the same read had filtered out (WI-4733).
 */
export function programSuccessReadScopes(opts: BuildProgramSuccessOptions = {}): {
  cadence: BuildQualityInputsOptions & { origin: 'scout' };
  suIdeate: BuildQualityInputsOptions & { origin: 'su-ideate'; lenses: readonly SuIdeationLens[] };
  tickWindowMs: number;
  tickSinceMs: number;
} {
  const tickWindowMs = opts.cycleWindowMs ?? CYCLE_ERROR_WINDOW_MS;
  const tickSinceMs = (opts.nowMs ?? Date.now()) - tickWindowMs;
  const shared: BuildQualityInputsOptions = {
    ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    ...(opts.limit != null ? { limit: opts.limit } : {}),
    ...(opts.tickLimit != null ? { tickLimit: opts.tickLimit } : {}),
  };
  return {
    cadence: {
      ...shared,
      harnessSlug: SCOUT_TICK_INSTALL_SLUG,
      origin: 'scout',
      tickInstallSlug: SCOUT_TICK_INSTALL_SLUG,
      tickSinceMs,
    },
    suIdeate: {
      ...shared,
      ...(opts.harnessSlug ? { harnessSlug: opts.harnessSlug } : {}),
      origin: 'su-ideate',
      lenses: SU_IDEATION_LENSES,
    },
    tickWindowMs,
    tickSinceMs,
  };
}

/**
 * Read the real ledgers and evaluate the program's done-check. Reads BOTH partitions via
 * {@link buildQualityReportInputs} (see {@link ProgramSuccessInputs} for why the bars split
 * across them) and reuses that same assembly, so this gate and the standing quality report
 * can never read different rows.
 *
 * The tick window is TIME-bounded (48h by default): newest-N pinned the bar on stale pre-fix
 * rows when the loop was quiet and could also hide a current error when harness scoping omitted
 * the workspace-global singleton rows. A release bar is about elapsed time, not row volume.
 */
export async function buildProgramSuccessReport(
  opts: BuildProgramSuccessOptions = {},
): Promise<ProgramSuccessReport> {
  const limit = opts.limit ?? DEFAULT_LEDGER_LIMIT;
  const scopes = programSuccessReadScopes({ ...opts, limit });
  const [cadence, suIdeate] = await Promise.all([
    buildQualityReportInputs<CreativeLens>(scopes.cadence),
    buildQualityReportInputs<SuIdeationLens>(scopes.suIdeate),
  ]);
  const ideas = [...cadence.routedIdeas, ...suIdeate.routedIdeas];
  const report = evaluateProgramSuccess(
    { cadence, ideas },
    {
      ...(opts.maxErrorRate != null ? { maxErrorRate: opts.maxErrorRate } : {}),
      // A full page back on EITHER partition means the read almost certainly hit the cap and
      // older rows are unseen — reconciliation must not FAIL on rows it never fetched.
      ledgerTruncated: cadence.routedIdeas.length >= limit || suIdeate.routedIdeas.length >= limit,
    },
  );
  return {
    ...report,
    window: {
      ...report.window,
      tickWindowMs: scopes.tickWindowMs,
      tickSinceMs: scopes.tickSinceMs,
      tickInstallSlug: SCOUT_TICK_INSTALL_SLUG,
    },
  };
}
