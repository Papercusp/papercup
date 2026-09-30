/**
 * goal-detail-model tests (goal-mode-2026-08-07 P-021).
 *
 * The cases that earn their place here are the ones where a plausible-looking
 * implementation is silently WRONG rather than obviously broken: an unmeasured
 * tripwire rendered as a confident zero, a killed pot quietly dropped, a
 * shared-pot count that includes the goal you are already looking at.
 */
import { describe, expect, it } from 'vitest';
import {
  agoText,
  ceilingLine,
  goalModeStateView,
  killCriterionLine,
  partitionPots,
  planLabel,
  spendStack,
  tripwireBar,
  tripwireBars,
  waitingCount,
  workRail,
  type GoalDetailInput,
  type GoalDetailPotInput,
} from './goal-detail-model';

describe('goalModeStateView — server projection parity', () => {
  it('carries the server-selected action, demand, timing, generation and omission receipt verbatim', () => {
    const view = goalModeStateView({
      status: 'known',
      ownerId: 'su-goal',
      observedAt: '2026-09-06T00:00:00.000Z',
      portfolio: {
        goal: { id: 'goal-1', title: 'Ship it', status: 'active' },
        queue: { total: 8, inFlight: 2, blocked: 1, needsHuman: 0, claimable: 5 },
        priorities: ['finish P-009'],
      },
      obligations: {
        sourceGeneration: 'agenda-generation',
        projection: {
          entries: [
            {
              id: 'obligation-1',
              title: 'Independent verification',
              status: 'due',
              applicableDemand: 2,
              sourceGeneration: 'rule-generation',
              dueAt: '2026-09-06T00:30:00.000Z',
              ageMs: 90_000,
              reason: 'two acceptance opportunities are unverified',
              action: { summary: 'Run independent acceptance' },
            },
          ],
          receipt: {
            sink: 'turn-start',
            entriesAvailable: 4,
            entriesDelivered: 1,
            entriesOmitted: 3,
            bodyTruncated: true,
            refused: false,
            reason: 'character-cap',
          },
        },
        detailRef: 'coord:orient for the complete obligation agenda',
      },
    });

    expect(view).toMatchObject({
      status: 'known',
      ownerId: 'su-goal',
      sourceGeneration: 'agenda-generation',
      entriesAvailable: 4,
      entriesDelivered: 1,
      entriesOmitted: 3,
      omissionReason: 'character-cap',
      detailRef: 'coord:orient for the complete obligation agenda',
      empty: null,
      portfolio: {
        title: 'Ship it',
        status: 'active',
        queue: '2 in flight · 1 blocked · 0 needs you · 5 claimable',
      },
    });
    expect(view.obligations[0]).toEqual({
      id: 'obligation-1',
      title: 'Independent verification',
      status: 'due',
      action: 'Run independent acceptance',
      reason: 'two acceptance opportunities are unverified',
      demand: 2,
      deadline: '2026-09-06T00:30:00.000Z',
      age: '1m',
      sourceGeneration: 'rule-generation',
      measurementFailure: null,
    });
  });

  it('treats an absent or unrecognised envelope as unknown, never an all-clear', () => {
    expect(goalModeStateView(undefined)).toMatchObject({
      status: 'unknown',
      empty: 'unavailable',
      notices: [expect.stringContaining('not included')],
    });
    expect(goalModeStateView({ status: 'future-wire-value' })).toMatchObject({
      status: 'unknown',
      empty: 'unavailable',
    });
  });

  it('distinguishes measured no-demand, degraded silence, and all-omitted overflow', () => {
    const receipt = (entriesAvailable: number, entriesOmitted = entriesAvailable) => ({
      projection: {
        entries: [],
        receipt: {
          entriesAvailable,
          entriesDelivered: 0,
          entriesOmitted,
          bodyTruncated: entriesOmitted > 0,
          refused: false,
        },
      },
    });

    expect(goalModeStateView({ status: 'known', obligations: receipt(0) }).empty).toBe('no-demand');
    expect(
      goalModeStateView({
        status: 'degraded',
        degradedReasons: ['portfolio timed out'],
        obligations: receipt(0),
      }),
    ).toMatchObject({ empty: 'unavailable', notices: ['portfolio timed out'] });
    expect(goalModeStateView({ status: 'known', obligations: receipt(3) })).toMatchObject({
      empty: 'overflow',
      entriesAvailable: 3,
      entriesOmitted: 3,
    });
  });
});

describe('tripwireBar', () => {
  it('phrases a usd tripwire as $current of $threshold', () => {
    const bar = tripwireBar({ metric: 'spend', label: 'Spend', threshold: 500, current: 310, unit: 'usd' });
    expect(bar.valueText).toBe('$310 of $500');
    expect(bar.pct).toBe(62);
    expect(bar.tone).toBe('ok');
  });

  it('phrases a days tripwire as "day N of M"', () => {
    const bar = tripwireBar({ metric: 'elapsed', label: 'Elapsed', threshold: 30, current: 12, unit: 'days' });
    expect(bar.valueText).toBe('day 12 of 30');
    expect(bar.pct).toBe(40);
  });

  it('suffixes an arbitrary unit', () => {
    const bar = tripwireBar({ metric: 'builds', label: 'Shipped builds', threshold: 4, current: 1, unit: 'builds' });
    expect(bar.valueText).toBe('1 of 4 builds');
  });

  it('renders a MISSING reading as unread, never as zero', () => {
    // The whole surface exists to stop a promise being mistaken for a readout.
    // A bar that shows 0% for "nobody measured this" is that same mistake with
    // extra confidence, so it must be distinguishable from a real zero.
    const unread = tripwireBar({ metric: 'spend', label: 'Spend', threshold: 500, unit: 'usd' });
    expect(unread.tone).toBe('unread');
    expect(unread.pct).toBeNull();
    expect(unread.measured).toBe(false);
    expect(unread.valueText).toBe('not measured yet — limit $500');

    const measuredZero = tripwireBar({ metric: 'spend', label: 'Spend', threshold: 500, current: 0, unit: 'usd' });
    expect(measuredZero.tone).toBe('ok');
    expect(measuredZero.pct).toBe(0);
    expect(measuredZero.measured).toBe(true);
    expect(measuredZero.valueText).toBe('$0 of $500');
  });

  it('reports a reading with NO threshold as measured, even though its pct is null', () => {
    // The trap this pins: `pct` is null for TWO unrelated reasons — nothing was
    // measured, or there is no threshold to measure against. Deriving
    // "unmeasured" from `pct == null` therefore mislabels a real reading as
    // absent, which is the exact unknown-is-not-absent failure the `measured`
    // field was added to prevent. If someone later "simplifies" `measured` away
    // and re-derives it from `pct`, this test is what fails.
    const noThreshold = tripwireBar({ metric: 'builds', label: 'Builds', threshold: 0, current: 12 });
    expect(noThreshold.pct).toBeNull();
    expect(noThreshold.measured).toBe(true);
    expect(noThreshold.tone).toBe('ok');
    expect(noThreshold.valueText).toBe('12');
  });

  /*
   * PROVENANCE (EI-21605510614702802). `measured` answers "is there a reading",
   * `derived` answers "who took it". The tests above pin the first; these pin
   * the second, and pin that adding it did not quietly redefine the first.
   */
  it('reports a bare reading as measured but NOT derived — a hand-set number', () => {
    // The filing's own example: an agent typed `0 of 30` and nothing has
    // re-scored it since. It is a reading, so `measured` stays true; it is
    // nobody's measurement, so `derived` is false and the two do not collapse.
    const handSet = tripwireBar({ metric: 'surfaces_verified', label: 'Surfaces', threshold: 30, current: 0 });
    expect(handSet.measured).toBe(true);
    expect(handSet.derived).toBe(false);
    expect(handSet.measuredAtMs).toBeNull();
    expect(handSet.title).toBe('Surfaces: 0 of 30 — entered by hand, not measured by the platform');
    // The number itself is still shown: the reading is the point.
    expect(handSet.valueText).toBe('0 of 30');
  });

  it('reports a platform-stamped reading as derived, and exposes its age', () => {
    const stamped = tripwireBar({
      metric: 'spend_usd',
      label: 'Spend',
      threshold: 500,
      current: 310,
      unit: 'usd',
      measuredBy: { source: 'resolver:spend_usd', atMs: 1_700_000, value: 310 },
    });
    expect(stamped.derived).toBe(true);
    expect(stamped.measuredAtMs).toBe(1_700_000);
    expect(stamped.title).toBe('Spend: $310 of $500');
  });

  it('VOIDS a stamp that no longer matches the reading it vouches for', () => {
    // The hand-edit-after-measurement case, at the render layer: the platform
    // measured $310, then someone wrote $12 over it. A present-but-stale stamp
    // must not lend the edited number the measurement's credibility.
    const tampered = tripwireBar({
      metric: 'spend_usd',
      label: 'Spend',
      threshold: 500,
      current: 12,
      unit: 'usd',
      measuredBy: { source: 'resolver:spend_usd', atMs: 1_700_000, value: 310 },
    });
    expect(tampered.measured).toBe(true);
    expect(tampered.derived).toBe(false);
    expect(tampered.measuredAtMs).toBeNull();
  });

  it('never calls an UNREAD bar derived', () => {
    const unread = tripwireBar({ metric: 'spend', label: 'Spend', threshold: 500, unit: 'usd' });
    expect(unread.measured).toBe(false);
    expect(unread.derived).toBe(false);
    expect(unread.measuredAtMs).toBeNull();
    // An unread bar keeps its own phrasing — provenance never overwrites it.
    expect(unread.title).toBe('Spend: no reading has been taken yet');
  });

  it('warns in the last fifth and breaches at the limit', () => {
    expect(tripwireBar({ metric: 'm', label: 'm', threshold: 100, current: 79 }).tone).toBe('ok');
    expect(tripwireBar({ metric: 'm', label: 'm', threshold: 100, current: 80 }).tone).toBe('warn');
    expect(tripwireBar({ metric: 'm', label: 'm', threshold: 100, current: 100 }).tone).toBe('breached');
  });

  it('clamps a past-the-limit bar to 100 instead of overflowing its track', () => {
    const bar = tripwireBar({ metric: 'm', label: 'm', threshold: 10, current: 40 });
    expect(bar.pct).toBe(100);
    expect(bar.tone).toBe('breached');
    // The NUMBER still tells the truth even though the bar is clamped.
    expect(bar.valueText).toBe('40 of 10');
  });

  it('still shows the reading when the threshold is unusable', () => {
    const bar = tripwireBar({ metric: 'm', label: 'm', threshold: 0, current: 7 });
    expect(bar.pct).toBeNull();
    expect(bar.valueText).toBe('7');
    expect(bar.tone).toBe('ok');
  });

  it('falls back to the metric when no label was authored', () => {
    expect(tripwireBar({ metric: 'days_since_build', label: '', threshold: 14, current: 2 }).label).toBe(
      'days_since_build',
    );
  });
});

describe('tripwireBars', () => {
  it('returns none for a free-text criterion — the supported NORMAL case', () => {
    expect(tripwireBars({ id: 'g1', title: 'g', status: 'active', killCriterion: 'when it stops paying' })).toEqual([]);
    expect(tripwireBars({ id: 'g1', title: 'g', status: 'active', tripwires: null })).toEqual([]);
    expect(tripwireBars(null)).toEqual([]);
  });

  it('drops malformed entries rather than throwing the whole section away', () => {
    const bars = tripwireBars({
      id: 'g1',
      title: 'g',
      status: 'active',
      tripwires: [
        { metric: 'ok', label: 'Ok', threshold: 10, current: 1 },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { label: 'no metric', threshold: 3 } as any,
      ],
    });
    expect(bars.map((b) => b.key)).toEqual(['ok']);
  });
});

describe('killCriterionLine', () => {
  it('passes a written criterion through VERBATIM', () => {
    const line = killCriterionLine({
      id: 'g',
      title: 't',
      status: 'active',
      killCriterion: 'Stop if no paying user by day 30.',
    });
    expect(line.text).toBe('Stop if no paying user by day 30.');
    expect(line.missing).toBe(false);
  });

  it('states the absence outright — an unstoppable goal is the alarming case', () => {
    for (const goal of [null, { id: 'g', title: 't', status: 'active', killCriterion: '   ' }]) {
      const line = killCriterionLine(goal);
      expect(line.missing).toBe(true);
      expect(line.text).toMatch(/nothing can stop this goal/i);
    }
  });
});

describe('partitionPots', () => {
  const base: GoalDetailPotInput = { harnessSlug: 'alpha', role: 'owner', servesGoals: 1 };

  it('KEEPS killed pots instead of filtering them out', () => {
    // If kills vanish, the page only ever shows growth and "the agent actually
    // closes things" becomes invisible exactly when it is working.
    const { active, removed } = partitionPots([
      base,
      { ...base, harnessSlug: 'beta', removedAt: '2026-08-01T00:00:00Z', note: 'no traction' },
    ]);
    expect(active.map((p) => p.harnessSlug)).toEqual(['alpha']);
    expect(removed.map((p) => p.harnessSlug)).toEqual(['beta']);
    expect(removed[0].note).toBe('no traction');
    expect(removed[0].removed).toBe(true);
  });

  it('excludes THIS goal from the shared-with count', () => {
    // servesGoals counts every goal the pot serves, this one included — so
    // a pot serving only this goal (1) must show no badge at all.
    expect(partitionPots([{ ...base, servesGoals: 1 }]).active[0].sharedBadge).toBeNull();
    expect(partitionPots([{ ...base, servesGoals: 2 }]).active[0].sharedBadge).toBe('shared with 1 other goal');
    expect(partitionPots([{ ...base, servesGoals: 3 }]).active[0].sharedBadge).toBe('shared with 2 other goals');
  });

  it('surfaces a pot missing its own kill criterion (clause 4)', () => {
    const [withCrit] = partitionPots([{ ...base, killCriterion: 'ship or stop' }]).active;
    expect(withCrit.killCriterionMissing).toBe(false);
    expect(withCrit.killCriterionText).toBe('ship or stop');

    const [without] = partitionPots([base]).active;
    expect(without.killCriterionMissing).toBe(true);
  });

  it('handles an absent pot list', () => {
    expect(partitionPots(null)).toEqual({ active: [], removed: [] });
  });
});

describe('spendStack', () => {
  it('stacks each day by pot and sizes columns against the tallest day', () => {
    const stack = spendStack([
      { day: '2026-08-01', harnessSlug: 'alpha', costUsd: 3 },
      { day: '2026-08-01', harnessSlug: 'beta', costUsd: 1 },
      { day: '2026-08-02', harnessSlug: 'alpha', costUsd: 8 },
    ]);
    expect(stack.days.map((d) => d.day)).toEqual(['2026-08-01', '2026-08-02']);
    expect(stack.maxDayUsd).toBe(8);
    expect(stack.totalUsd).toBe(12);
    expect(stack.days[0].heightPct).toBe(50);
    expect(stack.days[1].heightPct).toBe(100);
    // Slices are shares of their OWN column, so they sum to 100 within a day.
    expect(stack.days[0].slices.map((s) => s.pct)).toEqual([75, 25]);
    expect(stack.harnesses).toEqual(['alpha', 'beta']);
  });

  it('orders days chronologically regardless of input order', () => {
    const stack = spendStack([
      { day: '2026-08-03', harnessSlug: 'a', costUsd: 1 },
      { day: '2026-08-01', harnessSlug: 'a', costUsd: 1 },
    ]);
    expect(stack.days.map((d) => d.day)).toEqual(['2026-08-01', '2026-08-03']);
  });

  it('SUMS a repeated day+pot pair rather than keeping only the last', () => {
    // The resolver groups already; this guards the reshape against silently
    // discarding rows if a caller ever passes ungrouped ones.
    const stack = spendStack([
      { day: '2026-08-01', harnessSlug: 'alpha', costUsd: 2 },
      { day: '2026-08-01', harnessSlug: 'alpha', costUsd: 5 },
    ]);
    expect(stack.days[0].totalUsd).toBe(7);
    expect(stack.days[0].slices).toHaveLength(1);
  });

  it('labels an unattributed pot rather than dropping its cost', () => {
    const stack = spendStack([{ day: '2026-08-01', harnessSlug: null, costUsd: 4 }]);
    expect(stack.days[0].slices[0].harnessSlug).toBe('unattributed');
    expect(stack.totalUsd).toBe(4);
  });

  it('survives an empty window without dividing by zero', () => {
    const stack = spendStack([]);
    expect(stack).toEqual({ days: [], harnesses: [], maxDayUsd: 0, totalUsd: 0 });
    const zeroed = spendStack([{ day: '2026-08-01', harnessSlug: 'a', costUsd: 0 }]);
    expect(zeroed.days[0].heightPct).toBe(0);
    expect(zeroed.days[0].slices[0].pct).toBe(0);
  });
});

describe('ceilingLine', () => {
  it('reads the ENFORCED spend against the ceiling, with its window', () => {
    const line = ceilingLine({
      id: 'g', title: 't', status: 'active',
      spendUsd: 9_999, spentCents: 31_000, budgetCents: 50_000, budgetWindowSec: 604_800,
    });
    expect(line.text).toBe('$310 of $500 per 7d');
    expect(line.pct).toBe(62);
    expect(line.over).toBe(false);
  });

  it('flags reaching the ceiling — one of only two things that can stop a goal', () => {
    const line = ceilingLine({ id: 'g', title: 't', status: 'active', spentCents: 50_000, budgetCents: 50_000 });
    expect(line.over).toBe(true);
  });

  it('reads an unmeasured level as unmeasured, never as $0 under the ceiling (WI-1074208)', () => {
    const line = ceilingLine({ id: 'g', title: 't', status: 'active', spendUsd: 310, budgetCents: 50_000 });
    expect(line.text).toBe('Unmeasured of $500');
    expect(line.pct).toBeNull();
    expect(line.over).toBe(false);
  });

  it('says so plainly when no ceiling was set', () => {
    const line = ceilingLine({ id: 'g', title: 't', status: 'active', spendUsd: 12 });
    expect(line.text).toBe('$12 — no ceiling set');
    expect(line.pct).toBeNull();
  });
});

describe('agoText', () => {
  const now = Date.parse('2026-08-09T12:00:00Z');

  it('formats a real timestamp', () => {
    expect(agoText('2026-08-09T08:00:00Z', now)).toBe('4h ago');
  });

  it('returns null for absent or unparseable input rather than "NaN ago"', () => {
    expect(agoText(null, now)).toBeNull();
    expect(agoText(undefined, now)).toBeNull();
    expect(agoText('not a date', now)).toBeNull();
  });
});

/* ── The work rail (goals-tab-improvement-2026-08-09 P-019) ────────────────
   Same bar as the cases above: each of these is a way a plausible rail is
   silently WRONG rather than obviously broken. */
describe('workRail', () => {
  const NOW = Date.parse('2026-08-10T00:00:00Z');
  const iso = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();

  /** The shape that matters: an item parked on the owner is returned by BOTH
   *  `waitingOnYou` and `activity`, because the resolver reads the same rows
   *  twice with different filters. */
  const overlapping: GoalDetailInput = {
    goal: null,
    waitingOnYou: [{ id: 'WI-1', title: 'Needs a decision', harnessSlug: 'papercusp', updatedAt: iso(5) }],
    activity: [
      { id: 'WI-1', title: 'Needs a decision', harnessSlug: 'papercusp', status: 'open', updatedAt: iso(5) },
      { id: 'WI-2', title: 'In flight', harnessSlug: 'papercusp', status: 'wip', updatedAt: iso(10) },
      { id: 'WI-3', title: 'Finished', harnessSlug: 'papercusp', closedAt: iso(60), updatedAt: iso(60) },
    ],
  };

  it('never shows one item twice — a needs-you item is SUBTRACTED from open', () => {
    const rail = workRail(overlapping, NOW);
    expect(rail.needsYou.map((i) => i.id)).toEqual(['WI-1']);
    // The bug this pins: WI-1 also arrives in `activity`, so a rail that simply
    // renders both lists shows it under "Needs you" AND "Open" and the reader
    // counts one item as two.
    expect(rail.open.map((i) => i.id)).toEqual(['WI-2']);
    expect(rail.closed.map((i) => i.id)).toEqual(['WI-3']);

    const everyId = [...rail.needsYou, ...rail.open, ...rail.closed].map((i) => i.id);
    expect(everyId).toEqual([...new Set(everyId)]);
  });

  it('splits closed from open by closedAt, not by the status word', () => {
    // A closed item can still carry a non-terminal `status` string; the
    // timestamp is the fact, the word is a label.
    const rail = workRail(
      {
        goal: null,
        activity: [{ id: 'WI-9', title: 'Closed but labelled open', status: 'open', closedAt: iso(1) }],
      },
      NOW,
    );
    expect(rail.open).toHaveLength(0);
    expect(rail.closed.map((i) => i.id)).toEqual(['WI-9']);
    expect(rail.closed[0]!.metaText).toContain('closed');
  });

  it('reports EMPTY only when there is nothing at all — not merely no plans', () => {
    expect(workRail({ goal: null }, NOW).empty).toBe(true);
    expect(workRail(null, NOW).empty).toBe(true);
    // Items but no plans is NOT empty: the rail has rows to show, and rendering
    // the "nothing is under this goal" sentence over them would be a lie.
    expect(workRail(overlapping, NOW).empty).toBe(false);
    expect(
      workRail({ goal: null, plans: [{ planSlug: 'p', harnessSlug: 'h', stamped: false }] }, NOW)
        .empty,
    ).toBe(false);
  });

  it('drops a plan row with no slug rather than rendering a nameless card', () => {
    const rail = workRail(
      {
        goal: null,
        plans: [
          { planSlug: '', harnessSlug: 'h', stamped: false },
          { planSlug: 'real-plan', harnessSlug: 'h', stamped: false },
        ],
      },
      NOW,
    );
    expect(rail.plans.map((p) => p.planSlug)).toEqual(['real-plan']);
  });

  it('carries the age into the meta line, and omits it when unknown', () => {
    const rail = workRail(
      {
        goal: null,
        activity: [
          { id: 'A', title: 'aged', status: 'wip', updatedAt: iso(30) },
          { id: 'B', title: 'no timestamp', status: 'wip' },
        ],
      },
      NOW,
    );
    expect(rail.open[0]!.metaText).toMatch(/wip · /);
    // No fabricated "just now" for a row nothing has dated.
    expect(rail.open[1]!.metaText).toBe('wip');
  });
});

describe('planLabel', () => {
  it('marks a plan whose row no longer resolves instead of passing its slug off as a title', () => {
    // No `harnessSlug` here: planLabel takes only the two fields its answer
    // depends on, so passing more would be noise the excess-property check
    // rightly rejects.
    expect(planLabel({ planSlug: 'my-plan', title: 'My Plan' })).toEqual({
      text: 'My Plan',
      missing: false,
    });
    // The state worth SEEING: live work items pointing at a plan that is gone.
    expect(planLabel({ planSlug: 'my-plan', title: null })).toEqual({
      text: 'my-plan',
      missing: true,
    });
    expect(planLabel({ planSlug: 'my-plan', title: '   ' }).missing).toBe(true);
  });
});

describe('waitingCount', () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `WI-${i}`, title: `t${i}` }));

  it('reports the TOTAL, not the capped row count, and discloses the cap', () => {
    // The defect this helper exists for (D-018): the resolver fetches waiting
    // rows LIMIT 25 but counts unbounded. Rendering the array length as the
    // headline made the card say "31 needs you" and this panel say "25".
    const c = waitingCount({ goal: null, waitingOnYou: rows(25), waitingOnYouTotal: 31 });
    expect(c.shown).toBe(25);
    expect(c.total).toBe(31);
    expect(c.truncated).toBe(true);
    expect(c.label).toBe('31 waiting on you');
    expect(c.note).toBe('showing 25 of 31');
  });

  it('does NOT label an uncapped list as truncated', () => {
    // Equal counts are the ordinary case; a `>=` here would put a "showing 4 of
    // 4" caveat on every healthy goal and teach the reader to ignore the note.
    const c = waitingCount({ goal: null, waitingOnYou: rows(4), waitingOnYouTotal: 4 });
    expect(c.truncated).toBe(false);
    expect(c.note).toBeNull();
    expect(c.label).toBe('4 waiting on you');
  });

  it('treats an ABSENT total as unmeasured rather than substituting the row count', () => {
    // P-004's lesson: an absent reading is not a zero — and here it is not a
    // total either. We still show what we hold, but we say it was not censused
    // instead of dressing a floor up as a count.
    const c = waitingCount({ goal: null, waitingOnYou: rows(3) });
    expect(c.total).toBeNull();
    expect(c.unmeasured).toBe(true);
    expect(c.truncated).toBe(false);
    expect(c.label).toBe('3 waiting on you');
    expect(c.note).toBe('count not measured');
  });

  it('degrades a NaN total to unmeasured instead of rendering NaN', () => {
    const c = waitingCount({ goal: null, waitingOnYou: rows(2), waitingOnYouTotal: Number.NaN });
    expect(c.unmeasured).toBe(true);
    expect(c.label).toBe('2 waiting on you');
  });

  it('stays SILENT at zero — an empty lane is not news', () => {
    // The one clause of P-006's original text that measured correctly.
    expect(waitingCount({ goal: null, waitingOnYou: [], waitingOnYouTotal: 0 }).label).toBe('');
    expect(waitingCount(null).label).toBe('');
    expect(waitingCount(null).note).toBeNull();
  });
});
