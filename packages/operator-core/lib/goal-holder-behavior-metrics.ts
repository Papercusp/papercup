/**
 * Goal-holder behavior metrics and ratings for one exact observation window.
 *
 * Plan goal-holder-plans-ideation-truthful-reports-2026-10-03: P-001 (measure) and
 * P-013 (the WOE rubric must fail on the failures witnessed 2026-10-01..03). Before this
 * module, a WOE grader rated plan authorship, ideation, report truthfulness, loop
 * liveness and nudge efficacy from impression, and the 00:53Z-02:13Z card for holder
 * su-9e72a11f left 11 criteria unknown while the holder wrote 0 plans over 31 unplanned
 * goal items, reported COST as "not measured per goal", and had 2 of 5 loop fires
 * suppressed. Every number here comes from a canonical ledger, so the scorecard
 * instrument seam (scorecards.ts resolveScorecardInstrumentSnapshots) can refuse a
 * rating the measurement contradicts.
 *
 * The holder is the scorecard subject (the agent_modes goal-lease holder). Never read
 * goals.metadata.agentOwnerId for it: that field named su-6aab097a while su-9e72a11f
 * held lease epoch 18.
 *
 * SQL is injected (`deps.sql`) so this module does not import @papercusp/db-org itself;
 * the parsing and rating halves are pure and unit-tested.
 */
import type { Sql } from 'postgres';
import { GOAL_OWNER_REPORT_FIELD } from './goal-owner-report';
import { GOAL_REVIEW_CLUSTER_MIN_ITEMS, GOAL_REVIEW_NO_NEW_PLAN_DISPOSITIONS } from './goal-planning-review';

export const GOAL_HOLDER_METRICS_VERSION = 1 as const;
/** Ideation is judged per goal-day: the 24h ending at the window end. */
export const GOAL_DAY_MS = 86_400_000;
/** More than this many suppressed loop fires per hour of lease fails liveness. */
export const LOOP_SUPPRESSION_MAX_PER_HOUR = 1;
/** Share of settled timed reminders that must have fired or been discharged. */
export const NUDGE_EFFECTIVE_SHARE_MIN = 0.5;

export const HOLDER_BEHAVIOR_CRITERIA = [
  'holder-plan-authorship',
  'ideation-yield',
  'owner-report-truthfulness',
  'stewardship-loop-liveness',
  'nudge-efficacy',
] as const;
export type HolderBehaviorCriterion = (typeof HOLDER_BEHAVIOR_CRITERIA)[number];

/** Instrument key each WOE criterion binds (criterion.instrumentKey). */
export const HOLDER_BEHAVIOR_INSTRUMENT_KEYS: Readonly<Record<HolderBehaviorCriterion, string>> = Object.freeze({
  'holder-plan-authorship': 'woe.holder-plan-authorship',
  'ideation-yield': 'woe.ideation-yield',
  'owner-report-truthfulness': 'woe.owner-report-truthfulness',
  'stewardship-loop-liveness': 'woe.stewardship-loop-liveness',
  'nudge-efficacy': 'woe.nudge-efficacy',
});

export function holderBehaviorCriterionForInstrument(key: string): HolderBehaviorCriterion | null {
  const hit = (Object.entries(HOLDER_BEHAVIOR_INSTRUMENT_KEYS) as [HolderBehaviorCriterion, string][]).find(
    ([, instrument]) => instrument === key,
  );
  return hit ? hit[0] : null;
}

export interface GoalHolderWindow {
  workspaceId: string;
  goalId: string;
  holderOwnerId: string;
  windowStart: string;
  windowEnd: string;
}

export interface GoalReviewRow {
  invokedAt: string;
  disposition: string | null;
  /** goalReview.coverage (P-009); absent on reviews filed before it existed. */
  coverage: unknown;
  ideasFiled: unknown;
  /** Open goal-stamped items with no plan at the moment of the review. */
  unplannedAtReview: number;
}

export interface OwnerReportRow {
  ts: string;
  cost: string | null;
  ownerWalled: string | null;
}

export interface GoalHolderBehaviorMetrics {
  version: typeof GOAL_HOLDER_METRICS_VERSION;
  window: GoalHolderWindow;
  planAuthorship: {
    plansNew: number;
    plansStarted: number;
    planFleetLaunches: number;
    /** Open (at window end) goal-stamped work items with no source plan. */
    unplannedOpenGoalItems: number;
  };
  ideation: {
    since: string;
    plansNew: number;
    ideasFiled: number;
    reviews: number;
    noNewPlanReviews: number;
    /** No-new-plan reviews filed while 3+ goal items had no plan. */
    noNewPlanReviewsOverUnplannedCluster: number;
    /** Reviews whose coverage map names a 3+ item need with no planRef and no justification. */
    reviewsWithUncoveredClusterNeed: number;
  };
  ownerReports: {
    reports: number;
    costNotMeasured: number;
    walledEntries: number;
    /** Walled entries that are only work-item ids: they name no owner action. */
    bareWalledEntries: number;
  };
  loop: {
    deliveredFires: number;
    suppressedFires: number;
    windowHours: number;
  };
  nudges: {
    timedReminders: number;
    fired: number;
    cancelled: number;
    cancelledWithReason: number;
    dischargedCancels: number;
    /** Untimed obligation watches (plan:/goal: keys) cancelled in the window with no reason. */
    watchChurnWithoutReason: number;
  };
}

// ---------------------------------------------------------------------------
// Pure parsing
// ---------------------------------------------------------------------------

/** A COST line that admits it did not measure the goal's spend. */
export function costLineIsUnmeasured(cost: string | null | undefined): boolean {
  if (!cost || !cost.trim()) return true;
  return /\bnot\s+(?:measured|attributable|goal-attributable)\b|\bunmeasured\b/i.test(cost);
}

const WORK_ITEM_REF = /\b(?:WI|EI|F)-\d+\b/g;

/**
 * Split an ownerWalled section into entries and flag those that are only ids. "WI-10004856,
 * WI-10004875, WI-10005042" and "WI-10004856/4875/5042" name no action for the owner;
 * "hud P-003 route (solo/fleet/drop)" does.
 */
export function walledEntries(text: string | null | undefined): { entry: string; bare: boolean }[] {
  if (!text || !text.trim()) return [];
  return text
    .split(/;|\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry && !/^(?:none|nothing|n\/a)\.?$/i.test(entry))
    .map((entry) => {
      const hasRef = WORK_ITEM_REF.test(entry);
      WORK_ITEM_REF.lastIndex = 0;
      const residue = entry.replace(WORK_ITEM_REF, ' ').replace(/[^A-Za-z]+/g, ' ').trim();
      return { entry, bare: hasRef && residue.split(/\s+/).filter((word) => word.length > 1).length === 0 };
    });
}

function countIdeas(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  return 0;
}

/** A coverage entry naming 3+ items with neither a covering plan nor a justification. */
export function coverageHasUncoveredClusterNeed(coverage: unknown): boolean {
  if (!Array.isArray(coverage)) return false;
  return coverage.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as Record<string, unknown>;
    const items = Array.isArray(record.itemRefs) ? record.itemRefs.length : 0;
    const planRef = typeof record.planRef === 'string' && record.planRef.trim();
    const justification = typeof record.justification === 'string' && record.justification.trim();
    return items >= GOAL_REVIEW_CLUSTER_MIN_ITEMS && !planRef && !justification;
  });
}

export function summarizeGoalReviews(rows: readonly GoalReviewRow[]): Omit<
  GoalHolderBehaviorMetrics['ideation'],
  'since' | 'plansNew'
> {
  const noNewPlan = new Set<string>(GOAL_REVIEW_NO_NEW_PLAN_DISPOSITIONS);
  let ideasFiled = 0;
  let noNewPlanReviews = 0;
  let noNewPlanReviewsOverUnplannedCluster = 0;
  let reviewsWithUncoveredClusterNeed = 0;
  for (const row of rows) {
    ideasFiled += countIdeas(row.ideasFiled);
    const isNoNewPlan = row.disposition !== null && noNewPlan.has(row.disposition);
    if (isNoNewPlan) {
      noNewPlanReviews += 1;
      if (row.unplannedAtReview >= GOAL_REVIEW_CLUSTER_MIN_ITEMS && !Array.isArray(row.coverage)) {
        // A legacy review without a coverage map cannot show the unplanned items are
        // covered, so "existing plans suffice" over 3+ unplanned items is unsupported.
        noNewPlanReviewsOverUnplannedCluster += 1;
      }
    }
    if (coverageHasUncoveredClusterNeed(row.coverage)) reviewsWithUncoveredClusterNeed += 1;
  }
  return {
    ideasFiled,
    reviews: rows.length,
    noNewPlanReviews,
    noNewPlanReviewsOverUnplannedCluster,
    reviewsWithUncoveredClusterNeed,
  };
}

export function summarizeOwnerReports(rows: readonly OwnerReportRow[]): GoalHolderBehaviorMetrics['ownerReports'] {
  let costNotMeasured = 0;
  let walled = 0;
  let bare = 0;
  for (const row of rows) {
    if (costLineIsUnmeasured(row.cost)) costNotMeasured += 1;
    for (const entry of walledEntries(row.ownerWalled)) {
      walled += 1;
      if (entry.bare) bare += 1;
    }
  }
  return { reports: rows.length, costNotMeasured, walledEntries: walled, bareWalledEntries: bare };
}

// ---------------------------------------------------------------------------
// Pure rating (thresholds pinned by goal-holder-behavior-metrics.test.ts)
// ---------------------------------------------------------------------------

export type HolderBehaviorVerdict = 'pass' | 'fail' | 'unknown';
export interface HolderBehaviorRating {
  verdict: HolderBehaviorVerdict;
  reason: string;
}

export function rateGoalHolderBehavior(
  metrics: GoalHolderBehaviorMetrics,
): Record<HolderBehaviorCriterion, HolderBehaviorRating> {
  const { planAuthorship: plans, ideation, ownerReports: reports, loop, nudges } = metrics;

  const planRating = ((): HolderBehaviorRating => {
    if (plans.unplannedOpenGoalItems >= GOAL_REVIEW_CLUSTER_MIN_ITEMS && plans.plansNew === 0) {
      return {
        verdict: 'fail',
        reason: `${plans.unplannedOpenGoalItems} open goal items had no plan and the holder wrote 0 plans in the window.`,
      };
    }
    if (plans.plansNew > 0 && (plans.plansStarted > 0 || plans.planFleetLaunches > 0)) {
      return {
        verdict: 'pass',
        reason: `Holder wrote ${plans.plansNew} plan(s), started ${plans.plansStarted}, launched ${plans.planFleetLaunches} plan fleet(s).`,
      };
    }
    if (plans.plansNew > 0) {
      return { verdict: 'unknown', reason: `Holder wrote ${plans.plansNew} plan(s) but none was started or staffed in the window.` };
    }
    return {
      verdict: 'unknown',
      reason: `Not exercised: ${plans.unplannedOpenGoalItems} unplanned open goal items (< ${GOAL_REVIEW_CLUSTER_MIN_ITEMS}) and no plan written.`,
    };
  })();

  const ideationRating = ((): HolderBehaviorRating => {
    const candidates = ideation.plansNew + ideation.ideasFiled;
    if (ideation.noNewPlanReviewsOverUnplannedCluster > 0 || ideation.reviewsWithUncoveredClusterNeed > 0) {
      return {
        verdict: 'fail',
        reason:
          `${ideation.noNewPlanReviewsOverUnplannedCluster} no-new-plan review(s) over 3+ unplanned goal items and ` +
          `${ideation.reviewsWithUncoveredClusterNeed} review(s) with an uncovered 3+ item need in the goal-day since ${ideation.since}.`,
      };
    }
    if (candidates >= 1) {
      return { verdict: 'pass', reason: `${candidates} evaluated candidate(s) (plans ${ideation.plansNew}, ideas ${ideation.ideasFiled}) in the goal-day.` };
    }
    return { verdict: 'fail', reason: `0 evaluated new candidates for the goal in the goal-day since ${ideation.since}.` };
  })();

  const reportRating = ((): HolderBehaviorRating => {
    if (reports.reports === 0) return { verdict: 'unknown', reason: 'No goal owner report in the window.' };
    if (reports.costNotMeasured > 0 || reports.bareWalledEntries > 0) {
      return {
        verdict: 'fail',
        reason:
          `${reports.costNotMeasured} of ${reports.reports} report(s) gave no measured goal COST; ` +
          `${reports.bareWalledEntries} of ${reports.walledEntries} walled entries named no owner action.`,
      };
    }
    return {
      verdict: 'pass',
      reason: `${reports.reports} report(s) with measured COST and an owner action on every walled entry (correction-of-false-lines is graded by hand).`,
    };
  })();

  const loopRating = ((): HolderBehaviorRating => {
    const fires = loop.deliveredFires + loop.suppressedFires;
    if (fires === 0) return { verdict: 'unknown', reason: 'No loop fire in the window.' };
    const perHour = loop.windowHours > 0 ? loop.suppressedFires / loop.windowHours : loop.suppressedFires;
    if (perHour > LOOP_SUPPRESSION_MAX_PER_HOUR) {
      return {
        verdict: 'fail',
        reason: `${loop.suppressedFires} of ${fires} loop fires suppressed (${perHour.toFixed(2)}/h > ${LOOP_SUPPRESSION_MAX_PER_HOUR}/h).`,
      };
    }
    if (loop.deliveredFires === 0) return { verdict: 'fail', reason: `${fires} loop fire(s), none delivered a turn.` };
    return { verdict: 'pass', reason: `${loop.deliveredFires} delivered, ${loop.suppressedFires} suppressed loop fire(s).` };
  })();

  const nudgeRating = ((): HolderBehaviorRating => {
    const unattributed = nudges.cancelled - nudges.cancelledWithReason;
    if (nudges.timedReminders === 0 && nudges.watchChurnWithoutReason === 0) {
      return { verdict: 'unknown', reason: 'No agent-obligation reminder in the window.' };
    }
    if (unattributed > 0 || nudges.watchChurnWithoutReason > 0) {
      return {
        verdict: 'fail',
        reason:
          `${unattributed} timed reminder cancel(s) and ${nudges.watchChurnWithoutReason} obligation watch cancel(s) ` +
          'carry no cancel_reason, so delivery cannot be shown.',
      };
    }
    const settled = nudges.fired + nudges.cancelled;
    const effective = nudges.fired + nudges.dischargedCancels;
    if (settled > 0 && effective / settled < NUDGE_EFFECTIVE_SHARE_MIN) {
      return { verdict: 'fail', reason: `${effective} of ${settled} settled timed reminders fired or were discharged.` };
    }
    if (settled === 0) return { verdict: 'unknown', reason: `${nudges.timedReminders} timed reminder(s), none settled yet.` };
    return { verdict: 'pass', reason: `${effective} of ${settled} settled timed reminders fired or were discharged.` };
  })();

  return {
    'holder-plan-authorship': planRating,
    'ideation-yield': ideationRating,
    'owner-report-truthfulness': reportRating,
    'stewardship-loop-liveness': loopRating,
    'nudge-efficacy': nudgeRating,
  };
}

// ---------------------------------------------------------------------------
// Collection (SQL)
// ---------------------------------------------------------------------------

const PLAN_CANDIDATE_TOOLS = ['plans:new'] as const;

/**
 * Which goal (and workspace) a holder stewarded in a window. A scorecard subject names
 * only the holder, and the holder's agent_modes row disappears once the lease moves on,
 * so the ledger of the holder's own goal-stamped calls in the window decides; the live
 * goal lease is the fallback for a window with no goal-stamped call.
 */
export async function resolveHolderGoalForWindow(
  input: { holderOwnerId: string; windowStart: string; windowEnd: string },
  deps: { sql: Sql },
): Promise<{ workspaceId: string; goalId: string } | null> {
  const { sql } = deps;
  const start = new Date(input.windowStart);
  const end = new Date(input.windowEnd);
  const fromCalls = await sql<{ workspace_id: string; goal_id: string }[]>`
    SELECT workspace_id, goal_id
      FROM harness_shared.tool_invocations
     WHERE coord_owner_id = ${input.holderOwnerId}
       AND invoked_at BETWEEN ${start} AND ${end}
       AND goal_id IS NOT NULL
     GROUP BY workspace_id, goal_id
     ORDER BY count(*) DESC
     LIMIT 1`;
  if (fromCalls[0]) return { workspaceId: fromCalls[0].workspace_id, goalId: fromCalls[0].goal_id };
  const fromLease = await sql<{ workspace_id: string; subject: string }[]>`
    SELECT workspace_id, subject
      FROM harness_shared.agent_modes
     WHERE owner_id = ${input.holderOwnerId}
       AND mode = 'goal'
       AND subject IS NOT NULL
       AND set_at <= ${end}
     ORDER BY set_at DESC
     LIMIT 1`;
  return fromLease[0] ? { workspaceId: fromLease[0].workspace_id, goalId: fromLease[0].subject } : null;
}

/**
 * Read every metric for one window. event_awaits and routine_loop_transitions rows for a
 * session live under workspace 'default', not the papercusp workspace, so those two reads
 * scope by the holder's (globally unique) owner id only.
 */
export async function collectGoalHolderBehaviorMetrics(
  window: GoalHolderWindow,
  deps: { sql: Sql },
): Promise<GoalHolderBehaviorMetrics> {
  const { sql } = deps;
  const start = new Date(window.windowStart);
  const end = new Date(window.windowEnd);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) {
    throw new Error(`invalid holder window ${window.windowStart}..${window.windowEnd}`);
  }
  const daySince = new Date(end.getTime() - GOAL_DAY_MS);
  const endMs = end.getTime();

  const [toolRows, unplannedRows, reviewRows, plansNewDayRows, reportRows, loopRows, reminderRows, churnRows] =
    await Promise.all([
      sql<{ tool_name: string; n: string }[]>`
        SELECT tool_name, count(*)::text AS n
          FROM harness_shared.tool_invocations
         WHERE workspace_id = ${window.workspaceId}
           AND coord_owner_id = ${window.holderOwnerId}
           AND invoked_at BETWEEN ${start} AND ${end}
           AND status = 'ok'
           AND tool_name IN ('plans:new', 'plans:start', 'fleet:launch-on-plan')
         GROUP BY tool_name`,
      sql<{ n: string }[]>`
        SELECT count(*)::text AS n
          FROM harness_shared.work_items w
         WHERE w.workspace_id = ${window.workspaceId}
           AND w.goal_id = ${window.goalId}
           AND w.lane IS DISTINCT FROM 'observation'
           AND w.source_plan_slug IS NULL
           AND w.created_ts <= ${endMs}
           AND (w.closed_ts IS NULL OR w.closed_ts > ${endMs})`,
      sql<{ invoked_at: Date; disposition: string | null; coverage: unknown; ideas_filed: unknown; unplanned: string }[]>`
        SELECT t.invoked_at,
               t.args_json -> 'goalReview' ->> 'disposition' AS disposition,
               t.args_json -> 'goalReview' -> 'coverage' AS coverage,
               t.args_json -> 'ideasFiled' AS ideas_filed,
               (SELECT count(*)
                  FROM harness_shared.work_items w
                 WHERE w.workspace_id = t.workspace_id
                   AND w.goal_id = ${window.goalId}
                   AND w.lane IS DISTINCT FROM 'observation'
                   AND w.source_plan_slug IS NULL
                   AND w.created_ts <= (extract(epoch FROM t.invoked_at) * 1000)::bigint
                   AND (w.closed_ts IS NULL OR w.closed_ts > (extract(epoch FROM t.invoked_at) * 1000)::bigint)
               )::text AS unplanned
          FROM harness_shared.tool_invocations t
         WHERE t.workspace_id = ${window.workspaceId}
           AND t.tool_name = 'blender:ideate-pass-record'
           AND t.status = 'ok'
           AND t.args_json -> 'goalReview' ->> 'goalId' = ${window.goalId}
           AND t.invoked_at BETWEEN ${daySince} AND ${end}
         ORDER BY t.invoked_at`,
      sql<{ n: string }[]>`
        SELECT count(*)::text AS n
          FROM harness_shared.tool_invocations
         WHERE workspace_id = ${window.workspaceId}
           AND goal_id = ${window.goalId}
           AND status = 'ok'
           AND tool_name IN ${sql([...PLAN_CANDIDATE_TOOLS])}
           AND invoked_at BETWEEN ${daySince} AND ${end}`,
      sql<{ ts: Date; cost: string | null; owner_walled: string | null }[]>`
        SELECT e.ts,
               e.body -> ${GOAL_OWNER_REPORT_FIELD} ->> 'cost' AS cost,
               e.body -> ${GOAL_OWNER_REPORT_FIELD} ->> 'ownerWalled' AS owner_walled
          FROM harness_shared.coord_event_log e
         WHERE e.workspace_id = ${window.workspaceId}
           AND e.body ->> 'from' = ${window.holderOwnerId}
           AND e.body -> ${GOAL_OWNER_REPORT_FIELD} ->> 'goalId' = ${window.goalId}
           AND e.ts BETWEEN ${start} AND ${end}
         ORDER BY e.ts`,
      sql<{ delivered: string; suppressed: string }[]>`
        SELECT count(*) FILTER (WHERE event = 'rearmed' AND actor = 'reconcile-loop-routines')::text AS delivered,
               count(*) FILTER (WHERE event = 'rearmed' AND actor = 'await-suppression')::text AS suppressed
          FROM harness_shared.routine_loop_transitions
         WHERE target_owner_id = ${window.holderOwnerId}
           AND at BETWEEN ${start} AND ${end}`,
      sql<{ total: string; fired: string; cancelled: string; with_reason: string; discharged: string }[]>`
        SELECT count(*)::text AS total,
               count(fired_at)::text AS fired,
               count(cancelled_at)::text AS cancelled,
               count(cancelled_at) FILTER (WHERE cancel_reason IS NOT NULL)::text AS with_reason,
               count(cancelled_at) FILTER (WHERE cancel_reason ILIKE '%discharg%')::text AS discharged
          FROM harness_shared.event_awaits
         WHERE subscriber_id = ${window.holderOwnerId}
           AND bound_to ->> 'kind' = 'agent-obligation'
           AND expires_ts IS NOT NULL
           AND created_at BETWEEN ${start} AND ${end}`,
      sql<{ n: string }[]>`
        SELECT count(*)::text AS n
          FROM harness_shared.event_awaits
         WHERE subscriber_id = ${window.holderOwnerId}
           AND bound_to ->> 'kind' = 'agent-obligation'
           AND expires_ts IS NULL
           AND cancelled_at BETWEEN ${start} AND ${end}
           AND cancel_reason IS NULL`,
    ]);

  const toolCount = (name: string) => Number(toolRows.find((row) => row.tool_name === name)?.n ?? 0);
  const reviews = summarizeGoalReviews(
    reviewRows.map((row) => ({
      invokedAt: new Date(row.invoked_at).toISOString(),
      disposition: row.disposition,
      coverage: row.coverage,
      ideasFiled: row.ideas_filed,
      unplannedAtReview: Number(row.unplanned),
    })),
  );
  const reminder = reminderRows[0];
  return {
    version: GOAL_HOLDER_METRICS_VERSION,
    window,
    planAuthorship: {
      plansNew: toolCount('plans:new'),
      plansStarted: toolCount('plans:start'),
      planFleetLaunches: toolCount('fleet:launch-on-plan'),
      unplannedOpenGoalItems: Number(unplannedRows[0]?.n ?? 0),
    },
    ideation: { since: daySince.toISOString(), plansNew: Number(plansNewDayRows[0]?.n ?? 0), ...reviews },
    ownerReports: summarizeOwnerReports(
      reportRows.map((row) => ({ ts: new Date(row.ts).toISOString(), cost: row.cost, ownerWalled: row.owner_walled })),
    ),
    loop: {
      deliveredFires: Number(loopRows[0]?.delivered ?? 0),
      suppressedFires: Number(loopRows[0]?.suppressed ?? 0),
      windowHours: (end.getTime() - start.getTime()) / 3_600_000,
    },
    nudges: {
      timedReminders: Number(reminder?.total ?? 0),
      fired: Number(reminder?.fired ?? 0),
      cancelled: Number(reminder?.cancelled ?? 0),
      cancelledWithReason: Number(reminder?.with_reason ?? 0),
      dischargedCancels: Number(reminder?.discharged ?? 0),
      watchChurnWithoutReason: Number(churnRows[0]?.n ?? 0),
    },
  };
}
