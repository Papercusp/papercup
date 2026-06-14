import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { Ranked } from '../queue-ranker';
import type { PlacementCandidate } from './placement-ranker';
import {
  renderQueenBrief,
  floorFromSurvey,
  type QueenBriefFloor,
  type BriefBee,
} from './queen-brief';

// Build a Ranked<PlacementCandidate> fixture with the real RankBreakdown shape
// ({ score, features: FeatureContribution[] }) — the "why" lives per-feature.
function ranked(
  c: Partial<PlacementCandidate> & { id: string; harness: string },
  score: number,
  reasons: string[] = [],
): Ranked<PlacementCandidate> {
  const candidate: PlacementCandidate = {
    view: 'work-item',
    title: c.id,
    importance: 'normal',
    ...c,
  } as PlacementCandidate;
  return {
    ...candidate,
    rank: {
      score,
      features: [
        { feature: 'plan-importance', value: 1, weight: 4, contribution: score, reasons },
      ],
    },
  };
}

const frontier3: Ranked<PlacementCandidate>[] = [
  ranked({ id: 'wi-101', harness: 'papercup', title: 'Fix the deploy', importance: 'urgent' }, 9.5, ['escalation pressure: 1 open']),
  ranked({ id: 'wi-102', harness: 'papercup', title: 'Refactor ranker' }, 4.0, ['aged 3.2d']),
  ranked({ id: 'wi-103', harness: 'member-a', title: 'Add a doc' }, 1.0, []),
];

test('renderQueenBrief — two-part: FLOOR digest + CARRY-NOTE both render (P-004/P-015)', () => {
  const floor: QueenBriefFloor = {
    wokeBy: 'coord:escalate (a bee blocked)',
    headroom: { ceiling: 8, running: 5, headroom: 3 },
    frontier: frontier3,
    frontierBlocked: 2,
    plans: [ranked({ id: 'plan-x', view: 'plan', harness: 'papercup', title: 'Ship X' }, 7.0, ['hottest item: high'])],
    bees: [
      { id: 'bee-alpha', doing: 'wi-090', load: 2, alive: true },
      { id: 'bee-gamma', load: 1, alive: false },
    ],
    inbox: [{ kind: 'escalation', from: 'bee-alpha', summary: 'cannot resolve schema conflict' }],
    changeFeed: ['wi-080 completed by bee-delta', 'plan-y run finished'],
    escalations: [{ id: 'esc-1', severity: 'major', summary: 'staging deploy red' }],
  };
  const out = renderQueenBrief({ floor, carryNote: 'Mid-wave on plan-x: B-03 placed, awaiting B-01. Revisit when wi-101 lands.' });

  // FLOOR — the P-007 instruction to NOT re-run the survey reads.
  assert.match(out, /do NOT re-run `hive:survey`/);
  assert.match(out, /Woke by:.*coord:escalate/);
  assert.match(out, /Spawn headroom:.*3 free \(5\/8 running\)/);
  // Frontier ranked, with id + title + importance + harness + rank + why.
  assert.match(out, /1\. wi-101 — Fix the deploy \(urgent\) \[papercup\] \(rank 9\.50\) · escalation pressure: 1 open/);
  assert.match(out, /2\. wi-102 — Refactor ranker \[papercup\] \(rank 4\.00\) · aged 3\.2d/);
  assert.match(out, /held back by unsatisfied blocked_by/);
  // Plans, bees (incl. DEAD), inbox, change-feed, escalations.
  assert.match(out, /plan-x — Ship X \[papercup\]/);
  assert.match(out, /bee-alpha: load 2, doing wi-090 \[alive\]/);
  assert.match(out, /bee-gamma: load 1 \[DEAD — re-place its unit\]/);
  assert.match(out, /\[escalation\] bee-alpha: cannot resolve schema conflict/);
  assert.match(out, /wi-080 completed by bee-delta/);
  assert.match(out, /esc-1 \(major\): staging deploy red/);
  // CARRY-NOTE — additive second half, clearly labelled as her own intention.
  assert.match(out, /### Your carry-note/);
  assert.match(out, /Mid-wave on plan-x: B-03 placed/);
});

test('renderQueenBrief — floor-only (no carry-note) omits the carry-note section, degrades gracefully', () => {
  const out = renderQueenBrief({ floor: { frontier: frontier3 } });
  assert.doesNotMatch(out, /### Your carry-note/);
  // The floor still renders.
  assert.match(out, /1\. wi-101 — Fix the deploy/);
  // Whitespace-only carry-note is treated as empty.
  const out2 = renderQueenBrief({ floor: { frontier: frontier3 }, carryNote: '   \n  ' });
  assert.doesNotMatch(out2, /### Your carry-note/);
});

test('renderQueenBrief — deterministic: same floor renders byte-identical output (no clock/random leakage)', () => {
  const floor: QueenBriefFloor = { wokeBy: 'timer', frontier: frontier3, bees: [{ id: 'b1', load: 0, alive: true }] };
  const a = renderQueenBrief({ floor, carryNote: 'note' });
  const b = renderQueenBrief({ floor, carryNote: 'note' });
  assert.equal(a, b, 'identical inputs must render identical bytes');
  // No ISO timestamp / epoch leaked into the rendered text.
  assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
});

test('renderQueenBrief — empty frontier renders an explicit "empty" signal, not an omission', () => {
  const out = renderQueenBrief({ floor: { frontier: [] } });
  assert.match(out, /### Frontier — ready to place \(ranked\)/);
  assert.match(out, /_empty — no ready work to place\._/);
});

test('renderQueenBrief — over-cap lists are digested with a "+N more" overflow line (P-004)', () => {
  const many = Array.from({ length: 20 }, (_, i) => ranked({ id: `wi-${i}`, harness: 'papercup' }, 20 - i));
  const out = renderQueenBrief({ floor: { frontier: many }, caps: { frontier: 5 } });
  assert.match(out, /1\. wi-0 /);
  assert.match(out, /5\. wi-4 /);
  assert.doesNotMatch(out, /6\. wi-5 /);
  assert.match(out, /…\+15 more \(work_items:list to drill down\)/);
});

test('renderQueenBrief — most-salient why is the highest-contribution feature reason', () => {
  const r: Ranked<PlacementCandidate> = {
    id: 'wi-9',
    view: 'work-item',
    harness: 'papercup',
    title: 'T',
    importance: 'normal',
    rank: {
      score: 5,
      features: [
        { feature: 'staleness', value: 1, weight: 1, contribution: 1, reasons: ['aged a bit'] },
        { feature: 'escalation', value: 1, weight: 5, contribution: 4, reasons: ['2 escalations waiting'] },
      ],
    },
  };
  const out = renderQueenBrief({ floor: { frontier: [r] } });
  assert.match(out, /· 2 escalations waiting/);
  assert.doesNotMatch(out, /aged a bit/);
});

test('floorFromSurvey — maps survey frontier/plans/blocked and merges watchdog signals (P-005 reuse)', () => {
  const survey = { frontier: frontier3, plans: [], frontierBlocked: 4 };
  const bees: BriefBee[] = [{ id: 'b1', load: 1, alive: true }];
  const floor = floorFromSurvey(survey, { wokeBy: 'timer', bees });
  assert.equal(floor.frontier, frontier3);
  assert.equal(floor.frontierBlocked, 4);
  assert.equal(floor.wokeBy, 'timer');
  assert.deepEqual(floor.bees, bees);
});
