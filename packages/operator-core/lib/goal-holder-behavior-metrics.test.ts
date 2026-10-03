import { describe, expect, it } from 'vitest';
import {
  classifyDissolvedCluster,
  costLineIsUnmeasured,
  coverageHasUncoveredClusterNeed,
  emptyDissolvedClusterFates,
  HOLDER_BEHAVIOR_CRITERIA,
  HOLDER_BEHAVIOR_INSTRUMENT_KEYS,
  holderBehaviorCriterionForInstrument,
  rateGoalHolderBehavior,
  summarizeGoalReviews,
  summarizeOwnerReports,
  walledEntries,
  type GoalHolderBehaviorMetrics,
} from './goal-holder-behavior-metrics';

const WINDOW = {
  workspaceId: 'papercusp-workspace',
  goalId: 'work-on-everything-fresh-grading-and-improvement-60d3a8',
  holderOwnerId: 'su-9e72a11f-da70-4737-b3da-62fa98badea8',
  windowStart: '2026-10-03T00:53:17Z',
  windowEnd: '2026-10-03T02:13:10Z',
};

/**
 * The witnessed window (holder su-9e72a11f, 2026-10-03 00:53:17Z-02:13:10Z), measured from
 * the ledgers on 2026-10-03: 0 plans written over 31 unplanned goal items; no ideas filed
 * and the day's reviews said existing plans suffice; both owner reports printed COST "not
 * measured per goal" and listed walled items as bare ids; 2 of 5 loop fires suppressed;
 * 3 timed reminders (1 fired, 2 cancelled, 0 with a reason) and 28 watch cancels with no
 * reason. Every new WOE criterion must FAIL on it (P-013 positive control).
 */
function witnessed(): GoalHolderBehaviorMetrics {
  return {
    version: 1,
    window: WINDOW,
    // The rating's fail case is an OVERDUE CLUSTER, not the 31 unplanned singletons
    // (WI-10005920). Whether the real 00:53Z window had one depends on the detector
    // (unplanned-clusters.ts); this fixture pins the rule, not that measurement.
    planAuthorship: {
      plansNew: 0,
      plansStarted: 0,
      planFleetLaunches: 0,
      unplannedOpenGoalItems: 31,
      unplannedClusters: 1,
      overdueUnplannedClusters: 1,
      overdueClustersAtStart: 1,
      dissolvedOverdueClusters: emptyDissolvedClusterFates(), overdueClustersNudged: 0,
    },
    ideation: {
      since: '2026-10-02T02:13:10.000Z',
      plansNew: 0,
      ...summarizeGoalReviews([
        { invokedAt: '2026-10-02T23:13:03Z', disposition: 'existing-plans-sufficient', coverage: undefined, ideasFiled: [], unplannedAtReview: 29 },
        { invokedAt: '2026-10-03T00:15:35Z', disposition: 'existing-plans-sufficient', coverage: undefined, ideasFiled: [], unplannedAtReview: 30 },
      ]),
    },
    ownerReports: summarizeOwnerReports([
      {
        ts: '2026-10-03T00:58:13Z',
        cost: 'not measured per goal; pot-wide last 24h read $4266 (older read).',
        ownerWalled: 'hud P-003 route (asked ~20:55Z); WI-10004856, WI-10004875, WI-10005042; goal budget ceiling (propose rolling 500000c/86400s).',
      },
      {
        ts: '2026-10-03T01:50:58Z',
        cost: 'not measured per goal; pot-wide last read $4266/24h.',
        ownerWalled: 'hud P-003 route; budget ceiling ask conv-murpg1rk (propose 500000c/86400s); WI-10004856, WI-10004875, WI-10005042.',
      },
    ]),
    loop: { deliveredFires: 3, suppressedFires: 2, windowHours: 79.88 / 60 },
    nudges: { timedReminders: 3, fired: 1, cancelled: 2, cancelledWithReason: 0, dischargedCancels: 0, watchChurnWithoutReason: 28 },
  };
}

/** A window that meets every bar. */
function healthy(): GoalHolderBehaviorMetrics {
  return {
    version: 1,
    window: WINDOW,
    planAuthorship: {
      plansNew: 1,
      plansStarted: 1,
      planFleetLaunches: 1,
      unplannedOpenGoalItems: 2,
      unplannedClusters: 0,
      overdueUnplannedClusters: 0,
      overdueClustersAtStart: 0,
      dissolvedOverdueClusters: emptyDissolvedClusterFates(), overdueClustersNudged: 0,
    },
    ideation: {
      since: '2026-10-02T02:13:10.000Z',
      plansNew: 1,
      ideasFiled: 2,
      reviews: 1,
      noNewPlanReviews: 0,
      noNewPlanReviewsOverUnplannedCluster: 0,
      reviewsWithUncoveredClusterNeed: 0,
    },
    ownerReports: { reports: 2, costNotMeasured: 0, walledEntries: 2, bareWalledEntries: 0 },
    loop: { deliveredFires: 5, suppressedFires: 0, windowHours: 1.33 },
    nudges: { timedReminders: 3, fired: 2, cancelled: 1, cancelledWithReason: 1, dischargedCancels: 1, watchChurnWithoutReason: 0 },
  };
}

describe('goal-holder behavior parsing', () => {
  it('treats a COST line that admits no goal measurement as unmeasured', () => {
    expect(costLineIsUnmeasured('not measured per goal; pot-wide last 24h read $4266')).toBe(true);
    expect(costLineIsUnmeasured('$8779 measured cumulative, pot-wide (not goal-attributable).')).toBe(true);
    expect(costLineIsUnmeasured('')).toBe(true);
    expect(costLineIsUnmeasured('290656c, no ceiling declared, goal-lineage-rollup, measured 20:45:43Z')).toBe(false);
  });

  it('flags walled entries that are only work-item ids', () => {
    const entries = walledEntries('hud P-003 route (solo/fleet/drop); WI-10004856, WI-10004875, WI-10005042; WI-10004856/4875/5042');
    expect(entries.map((entry) => entry.bare)).toEqual([false, true, true]);
    expect(walledEntries('WI-10004856: approve the budget ceiling of 500000c/day')[0].bare).toBe(false);
    expect(walledEntries('none')).toEqual([]);
  });

  it('finds a coverage need spanning 3+ items with no plan and no justification', () => {
    expect(coverageHasUncoveredClusterNeed([{ need: 'liveness', itemRefs: ['WI-1', 'WI-2', 'WI-3'] }])).toBe(true);
    expect(coverageHasUncoveredClusterNeed([{ need: 'liveness', itemRefs: ['WI-1', 'WI-2', 'WI-3'], planRef: 'p' }])).toBe(false);
    expect(coverageHasUncoveredClusterNeed([{ need: 'x', itemRefs: ['WI-1', 'WI-2', 'WI-3'], justification: 'one root cause, one fix' }])).toBe(false);
    expect(coverageHasUncoveredClusterNeed([{ need: 'x', itemRefs: ['WI-1', 'WI-2'] }])).toBe(false);
    expect(coverageHasUncoveredClusterNeed(undefined)).toBe(false);
  });

  it('counts a legacy no-new-plan review over 3+ unplanned items, but not one with a coverage map', () => {
    const summary = summarizeGoalReviews([
      { invokedAt: 'a', disposition: 'existing-plans-sufficient', coverage: undefined, ideasFiled: ['i1'], unplannedAtReview: 5 },
      { invokedAt: 'b', disposition: 'existing-plans-sufficient', coverage: [], ideasFiled: 2, unplannedAtReview: 5 },
      { invokedAt: 'c', disposition: 'route-work', coverage: undefined, ideasFiled: null, unplannedAtReview: 5 },
      { invokedAt: 'd', disposition: 'no-eligible-work', coverage: undefined, ideasFiled: [], unplannedAtReview: 2 },
    ]);
    expect(summary).toEqual({
      ideasFiled: 3,
      reviews: 4,
      noNewPlanReviews: 3,
      noNewPlanReviewsOverUnplannedCluster: 1,
      reviewsWithUncoveredClusterNeed: 0,
    });
  });
});

describe('rateGoalHolderBehavior thresholds', () => {
  it('fails every holder-behavior criterion on the witnessed 00:53Z-02:13Z window (positive control)', () => {
    const metrics = witnessed();
    expect(metrics.ownerReports).toEqual({ reports: 2, costNotMeasured: 2, walledEntries: 6, bareWalledEntries: 2 });
    const ratings = rateGoalHolderBehavior(metrics);
    for (const criterion of HOLDER_BEHAVIOR_CRITERIA) {
      expect({ criterion, verdict: ratings[criterion].verdict }).toEqual({ criterion, verdict: 'fail' });
    }
  });

  it('passes every criterion on a window that meets each bar (negative control)', () => {
    const ratings = rateGoalHolderBehavior(healthy());
    for (const criterion of HOLDER_BEHAVIOR_CRITERIA) {
      expect({ criterion, verdict: ratings[criterion].verdict }).toEqual({ criterion, verdict: 'pass' });
    }
  });

  it('plan authorship: an overdue cluster fails unless a plan is written AND staffed; singletons never fail (WI-10005920)', () => {
    const at = (p: { unplanned?: number; clusters?: number; overdue: number; plansNew: number; started?: number; fleets: number }) =>
      rateGoalHolderBehavior({
        ...healthy(),
        planAuthorship: {
          plansNew: p.plansNew,
          plansStarted: p.started ?? 0,
          planFleetLaunches: p.fleets,
          unplannedOpenGoalItems: p.unplanned ?? 3,
          unplannedClusters: p.clusters ?? p.overdue,
          overdueUnplannedClusters: p.overdue,
          overdueClustersAtStart: p.overdue,
          dissolvedOverdueClusters: emptyDissolvedClusterFates(), overdueClustersNudged: 0,
        },
      })['holder-plan-authorship'].verdict;
    // Overdue cluster: nothing written, written only, written+started all fail; staffed passes.
    expect(at({ overdue: 1, plansNew: 0, fleets: 0 })).toBe('fail');
    expect(at({ overdue: 1, plansNew: 1, fleets: 0 })).toBe('fail');
    expect(at({ overdue: 1, plansNew: 1, started: 1, fleets: 0 })).toBe('fail');
    expect(at({ overdue: 1, plansNew: 1, fleets: 1 })).toBe('pass');
    // The measured su-a70547cc shape: 29 unplanned singletons, 0 clusters, 0 plans -> not exercised.
    expect(at({ unplanned: 29, clusters: 0, overdue: 0, plansNew: 0, fleets: 0 })).toBe('unknown');
    // A cluster younger than 2 reporting cycles is not yet due.
    expect(at({ unplanned: 5, clusters: 1, overdue: 0, plansNew: 0, fleets: 0 })).toBe('unknown');
    // Written but not staffed with nothing overdue is unknown; written and staffed passes.
    expect(at({ overdue: 0, plansNew: 1, fleets: 0 })).toBe('unknown');
    expect(at({ overdue: 0, plansNew: 1, fleets: 1 })).toBe('pass');
  });

  it('plan authorship: a cluster overdue at window START is judged by how it dissolved, never "not exercised" (WI-10005965)', () => {
    const at = (fates: Partial<Record<'planned' | 'dismissed-with-reason' | 'dissolved-without-drop' | 'dropped-without-reason', number>>, fleets = 0) =>
      rateGoalHolderBehavior({
        ...healthy(),
        planAuthorship: {
          plansNew: fleets,
          plansStarted: 0,
          planFleetLaunches: fleets,
          unplannedOpenGoalItems: 26,
          unplannedClusters: 0,
          overdueUnplannedClusters: 0,
          overdueClustersAtStart: 1,
          dissolvedOverdueClusters: { ...emptyDissolvedClusterFates(), ...fates },
          overdueClustersNudged: 0,
        },
      })['holder-plan-authorship'];
    // The measured P-008 W2 shape (goal 60d3a8, 2026-10-03): cluster EI-23772322660353682 was
    // overdue at 09:49:40Z; the holder dropped 3 duplicates with reasons and closed the nudge
    // dropped with a reason. Before the fix this read "unknown: Not exercised: 0 clusters".
    const w2 = at({ 'dismissed-with-reason': 1 });
    expect(w2.verdict).toBe('pass');
    expect(w2.reason).toContain('1 dismissed with a reason');
    expect(at({ planned: 1 }).verdict).toBe('pass');
    // Dropping the cluster away with no reason fails, even beside an unrelated staffed plan.
    expect(at({ 'dropped-without-reason': 1 }).verdict).toBe('fail');
    expect(at({ 'dropped-without-reason': 1 }, 1).verdict).toBe('fail');
    // Work completed or items regrouped: nothing to credit or blame.
    expect(at({ 'dissolved-without-drop': 1 }).verdict).toBe('unknown');
  });

  it('plan authorship: a fail names whether the overdue cluster was ever nudged (WI-10005942)', () => {
    const fail = (nudged: number) =>
      rateGoalHolderBehavior({
        ...healthy(),
        planAuthorship: {
          plansNew: 0, plansStarted: 0, planFleetLaunches: 0, unplannedOpenGoalItems: 30,
          unplannedClusters: 1, overdueUnplannedClusters: 1, overdueClustersAtStart: 1,
          dissolvedOverdueClusters: emptyDissolvedClusterFates(), overdueClustersNudged: nudged,
        },
      })['holder-plan-authorship'];
    // P-008 W1 shape: the cluster's detector (signal 5) reached the holder's serving build
    // mid-window and no nudge existed for most of it, so the fail must flag the attribution.
    expect(fail(0).verdict).toBe('fail');
    expect(fail(0).reason).toContain('0 of them had a watchdog nudge filed at least one reporting cycle before window end; check whether the holder could see');
    expect(fail(1).verdict).toBe('fail');
    expect(fail(1).reason).toContain('1 of them had a watchdog nudge filed at least one reporting cycle before window end.');
    expect(fail(1).reason).not.toContain('check whether the holder could see');
  });

  it('classifyDissolvedCluster: plan membership, reasoned nudge close, then per-member drop reasons (WI-10005965)', () => {
    const member = (status: string, reason: string | null = null, planned = false) => ({ status, reason, planned });
    // Measured W2 members: canonical item blocked, 3 duplicates dropped with terminal_completion_ref reasons.
    const w2Members = [
      member('blocked'),
      member('dropped', 'Duplicate kernel stale-artifact preflight symptom; canonical duplicate edge points to EI-23772322660353682.'),
      member('dropped', 'Duplicate kernel stale-artifact preflight symptom; canonical duplicate edge points to EI-23772322660353682.'),
      member('dropped', 'Duplicate kernel stale-artifact preflight symptom; canonical duplicate edge points to EI-23772322660353682.'),
    ];
    const w2Nudge = { status: 'dropped', reason: 'Dropped the request for a new four-item plan after explicit duplicate consolidation.' };
    expect(classifyDissolvedCluster({ members: w2Members, nudges: [w2Nudge] })).toBe('dismissed-with-reason');
    // Per-member drop reasons alone also count as a reasoned dismissal.
    expect(classifyDissolvedCluster({ members: w2Members, nudges: [] })).toBe('dismissed-with-reason');
    // Same drops with no reason anywhere: the dodge this rule exists to catch.
    expect(
      classifyDissolvedCluster({ members: [member('blocked'), member('dropped'), member('dropped', '  '), member('dropped')], nudges: [] }),
    ).toBe('dropped-without-reason');
    // A nudge closed without a reason does not rescue reasonless drops.
    expect(
      classifyDissolvedCluster({ members: [member('dropped'), member('dropped'), member('dropped')], nudges: [{ status: 'dropped', reason: null }] }),
    ).toBe('dropped-without-reason');
    // Planned members, or a nudge closed done, mean the cluster was placed as a plan.
    expect(classifyDissolvedCluster({ members: [member('open', null, true), member('dropped')], nudges: [] })).toBe('planned');
    expect(classifyDissolvedCluster({ members: [member('done'), member('open')], nudges: [{ status: 'done', reason: 'planned as p' }] })).toBe('planned');
    // No member dropped: completed or regrouped.
    expect(classifyDissolvedCluster({ members: [member('done'), member('done'), member('open')], nudges: [] })).toBe('dissolved-without-drop');
  });

  it("review quality counts only the graded holder's reviews; ideas count for the goal (WI-10005920)", () => {
    const legacy = { disposition: 'existing-plans-sufficient', coverage: undefined, unplannedAtReview: 30 };
    const predecessor = summarizeGoalReviews([
      { invokedAt: '2026-10-03T00:15:35Z', ...legacy, ideasFiled: undefined, byHolder: false },
      { invokedAt: '2026-10-03T08:08:22Z', disposition: 'route-work', coverage: [], ideasFiled: ['EI-1'], unplannedAtReview: 28, byHolder: true },
    ]);
    expect(predecessor.noNewPlanReviewsOverUnplannedCluster).toBe(0);
    expect(predecessor.ideasFiled).toBe(1);
    const own = summarizeGoalReviews([{ invokedAt: '2026-10-03T08:30:00Z', ...legacy, ideasFiled: undefined }]);
    expect(own.noNewPlanReviewsOverUnplannedCluster).toBe(1);
  });

  it('ideation: zero candidates in a goal-day fails even with no review; one candidate passes', () => {
    const at = (ideation: Partial<GoalHolderBehaviorMetrics['ideation']>) =>
      rateGoalHolderBehavior({ ...healthy(), ideation: { ...healthy().ideation, ...ideation } })['ideation-yield'].verdict;
    expect(at({ plansNew: 0, ideasFiled: 0, reviews: 0 })).toBe('fail');
    expect(at({ plansNew: 0, ideasFiled: 1 })).toBe('pass');
    expect(at({ reviewsWithUncoveredClusterNeed: 1 })).toBe('fail');
    expect(at({ noNewPlanReviewsOverUnplannedCluster: 1 })).toBe('fail');
  });

  it('owner reports: no report is unknown; one unmeasured COST or one bare walled entry fails', () => {
    const at = (reports: GoalHolderBehaviorMetrics['ownerReports']) =>
      rateGoalHolderBehavior({ ...healthy(), ownerReports: reports })['owner-report-truthfulness'].verdict;
    expect(at({ reports: 0, costNotMeasured: 0, walledEntries: 0, bareWalledEntries: 0 })).toBe('unknown');
    expect(at({ reports: 3, costNotMeasured: 1, walledEntries: 0, bareWalledEntries: 0 })).toBe('fail');
    expect(at({ reports: 3, costNotMeasured: 0, walledEntries: 4, bareWalledEntries: 1 })).toBe('fail');
  });

  it('loop liveness: exactly 1 suppressed fire per hour passes; more fails; fires with none delivered fails', () => {
    const at = (delivered: number, suppressed: number, hours: number) =>
      rateGoalHolderBehavior({ ...healthy(), loop: { deliveredFires: delivered, suppressedFires: suppressed, windowHours: hours } })[
        'stewardship-loop-liveness'
      ].verdict;
    expect(at(3, 1, 1)).toBe('pass');
    expect(at(3, 2, 1)).toBe('fail');
    expect(at(0, 0, 1)).toBe('unknown');
    expect(at(0, 1, 2)).toBe('fail');
  });

  it('nudges: any reasonless cancel fails; under half fired-or-discharged fails; none in window is unknown', () => {
    const at = (nudges: Partial<GoalHolderBehaviorMetrics['nudges']>) =>
      rateGoalHolderBehavior({ ...healthy(), nudges: { ...healthy().nudges, ...nudges } })['nudge-efficacy'].verdict;
    expect(at({ cancelled: 2, cancelledWithReason: 1 })).toBe('fail');
    expect(at({ watchChurnWithoutReason: 1 })).toBe('fail');
    expect(at({ timedReminders: 4, fired: 1, cancelled: 3, cancelledWithReason: 3, dischargedCancels: 0 })).toBe('fail');
    expect(at({ timedReminders: 4, fired: 1, cancelled: 3, cancelledWithReason: 3, dischargedCancels: 1 })).toBe('pass');
    expect(at({ timedReminders: 0, fired: 0, cancelled: 0, cancelledWithReason: 0, dischargedCancels: 0 })).toBe('unknown');
  });

  it('maps every criterion to a distinct woe.* instrument key and back', () => {
    const keys = HOLDER_BEHAVIOR_CRITERIA.map((criterion) => HOLDER_BEHAVIOR_INSTRUMENT_KEYS[criterion]);
    expect(new Set(keys).size).toBe(HOLDER_BEHAVIOR_CRITERIA.length);
    for (const criterion of HOLDER_BEHAVIOR_CRITERIA) {
      expect(holderBehaviorCriterionForInstrument(HOLDER_BEHAVIOR_INSTRUMENT_KEYS[criterion])).toBe(criterion);
    }
    expect(holderBehaviorCriterionForInstrument('woe.goal-mode-base-scorecard')).toBeNull();
  });
});
