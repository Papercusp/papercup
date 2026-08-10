/**
 * goal-detail-model tests (goal-mode-2026-08-07 P-021).
 *
 * The cases that earn their place here are the ones where a plausible-looking
 * implementation is silently WRONG rather than obviously broken: an unmeasured
 * tripwire rendered as a confident zero, a killed project quietly dropped, a
 * shared-project count that includes the goal you are already looking at.
 */
import { describe, expect, it } from 'vitest';
import {
  agoText,
  ceilingLine,
  killCriterionLine,
  partitionProjects,
  planLabel,
  spendStack,
  tripwireBar,
  tripwireBars,
  workRail,
  type GoalDetailInput,
  type GoalDetailProjectInput,
} from './goal-detail-model';

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

describe('partitionProjects', () => {
  const base: GoalDetailProjectInput = { harnessSlug: 'alpha', role: 'owner', servesGoals: 1 };

  it('KEEPS killed projects instead of filtering them out', () => {
    // If kills vanish, the page only ever shows growth and "the agent actually
    // closes things" becomes invisible exactly when it is working.
    const { active, removed } = partitionProjects([
      base,
      { ...base, harnessSlug: 'beta', removedAt: '2026-08-01T00:00:00Z', note: 'no traction' },
    ]);
    expect(active.map((p) => p.harnessSlug)).toEqual(['alpha']);
    expect(removed.map((p) => p.harnessSlug)).toEqual(['beta']);
    expect(removed[0].note).toBe('no traction');
    expect(removed[0].removed).toBe(true);
  });

  it('excludes THIS goal from the shared-with count', () => {
    // servesGoals counts every goal the project serves, this one included — so
    // a project serving only this goal (1) must show no badge at all.
    expect(partitionProjects([{ ...base, servesGoals: 1 }]).active[0].sharedBadge).toBeNull();
    expect(partitionProjects([{ ...base, servesGoals: 2 }]).active[0].sharedBadge).toBe('shared with 1 other goal');
    expect(partitionProjects([{ ...base, servesGoals: 3 }]).active[0].sharedBadge).toBe('shared with 2 other goals');
  });

  it('surfaces a project missing its own kill criterion (clause 4)', () => {
    const [withCrit] = partitionProjects([{ ...base, killCriterion: 'ship or stop' }]).active;
    expect(withCrit.killCriterionMissing).toBe(false);
    expect(withCrit.killCriterionText).toBe('ship or stop');

    const [without] = partitionProjects([base]).active;
    expect(without.killCriterionMissing).toBe(true);
  });

  it('handles an absent project list', () => {
    expect(partitionProjects(null)).toEqual({ active: [], removed: [] });
  });
});

describe('spendStack', () => {
  it('stacks each day by project and sizes columns against the tallest day', () => {
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

  it('SUMS a repeated day+project pair rather than keeping only the last', () => {
    // The resolver groups already; this guards the reshape against silently
    // discarding rows if a caller ever passes ungrouped ones.
    const stack = spendStack([
      { day: '2026-08-01', harnessSlug: 'alpha', costUsd: 2 },
      { day: '2026-08-01', harnessSlug: 'alpha', costUsd: 5 },
    ]);
    expect(stack.days[0].totalUsd).toBe(7);
    expect(stack.days[0].slices).toHaveLength(1);
  });

  it('labels an unattributed project rather than dropping its cost', () => {
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
  it('reads spend against the ceiling', () => {
    const line = ceilingLine({ id: 'g', title: 't', status: 'active', spendUsd: 310, budgetCents: 50_000 });
    expect(line.text).toBe('$310 of $500');
    expect(line.pct).toBe(62);
    expect(line.over).toBe(false);
  });

  it('flags reaching the ceiling — one of only two things that can stop a goal', () => {
    const line = ceilingLine({ id: 'g', title: 't', status: 'active', spendUsd: 500, budgetCents: 50_000 });
    expect(line.over).toBe(true);
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
      workRail({ goal: null, plans: [{ planSlug: 'p', harnessSlug: 'h' }] }, NOW).empty,
    ).toBe(false);
  });

  it('drops a plan row with no slug rather than rendering a nameless card', () => {
    const rail = workRail(
      {
        goal: null,
        plans: [
          { planSlug: '', harnessSlug: 'h' },
          { planSlug: 'real-plan', harnessSlug: 'h' },
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
    expect(planLabel({ planSlug: 'my-plan', harnessSlug: 'h', title: 'My Plan' })).toEqual({
      text: 'My Plan',
      missing: false,
    });
    // The state worth SEEING: live work items pointing at a plan that is gone.
    expect(planLabel({ planSlug: 'my-plan', harnessSlug: 'h', title: null })).toEqual({
      text: 'my-plan',
      missing: true,
    });
    expect(planLabel({ planSlug: 'my-plan', harnessSlug: 'h', title: '   ' }).missing).toBe(true);
  });
});
