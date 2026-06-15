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
  // coord:inbox IS now folded into the floor (D-020), so the skip-list MUST include
  // it — she has the recent inbox digest in the brief and shouldn't re-fetch it just
  // to see it. The old "triage it yourself" carve-out (D-017) is gone.
  const skipClause = out.slice(out.indexOf('do NOT re-run'), out.indexOf('act on it'));
  assert.ok(skipClause.includes('`coord:inbox`'), 'coord:inbox must be in the do-not-re-run skip list (folded into the floor)');
  assert.doesNotMatch(out, /is NOT in this brief — triage it yourself/);
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

// overwatch-role-2026-06-15 B-09 / D-004 — the who-watches-the-watcher reverse
// leg: the Queen's brief carries overwatch's liveness.
test('renderQueenBrief — overwatchAlive undefined ⇒ the cross-monitor line is omitted (no noise when overwatch is not in play)', () => {
  const out = renderQueenBrief({ floor: { frontier: frontier3 } });
  assert.doesNotMatch(out, /Cross-monitor/);
  assert.doesNotMatch(out, /OVERWATCH DARK/);
});

test('renderQueenBrief — overwatchAlive true ⇒ a quiet "overwatch alive" line', () => {
  const out = renderQueenBrief({ floor: { frontier: frontier3, overwatchAlive: true } });
  assert.match(out, /### Cross-monitor \(who-watches-the-watcher\)/);
  assert.match(out, /overwatch alive/);
  assert.doesNotMatch(out, /OVERWATCH DARK/);
});

test('renderQueenBrief — overwatchAlive false ⇒ a critical OVERWATCH DARK line telling her to ESCALATE', () => {
  const out = renderQueenBrief({ floor: { frontier: frontier3, overwatchAlive: false } });
  assert.match(out, /OVERWATCH DARK/);
  assert.match(out, /ESCALATE/);
  // She must NOT be told to relaunch it — that is structural (D-002).
  assert.match(out, /cannot relaunch overwatch/i);
});

// ── Owner steering directive (queen-steering-panel-2026-06-15 B-02 / P-002) ──
test('renderQueenBrief — owner steering renders an AUTHORITATIVE section BEFORE the frontier', () => {
  const out = renderQueenBrief({
    floor: {
      frontier: frontier3,
      ownerSteering: {
        directive: 'Finish the in-flight backlog before anything new.',
        eligiblePlans: ['plan-x', 'plan-y'],
        pauseNewWork: false,
        pausedUntil: null,
      },
    },
  });
  assert.match(out, /### Owner steering directive \(AUTHORITATIVE — honor before placement\)/);
  assert.match(out, /Finish the in-flight backlog before anything new\./);
  assert.match(out, /Eligible plans ONLY:.*plan-x, plan-y/);
  // It must come BEFORE the frontier so she reads constraints before placing.
  assert.ok(
    out.indexOf('### Owner steering directive') < out.indexOf('### Frontier'),
    'steering section must precede the frontier',
  );
});

test('renderQueenBrief — pauseNewWork renders a HARD "PAUSED — start NO new work" line', () => {
  const out = renderQueenBrief({
    floor: { frontier: frontier3, ownerSteering: { directive: null, eligiblePlans: [], pauseNewWork: true, pausedUntil: null } },
  });
  assert.match(out, /\*\*PAUSED — start NO new work\.\*\*/);
  assert.match(out, /drive existing placements to terminal/i);
});

test('renderQueenBrief — a pausedUntil renders the deadline (deterministic from the floor value, not the clock)', () => {
  const until = Date.parse('2026-06-15T12:00:00.000Z');
  const out = renderQueenBrief({
    floor: { frontier: frontier3, ownerSteering: { directive: null, eligiblePlans: [], pauseNewWork: false, pausedUntil: until } },
  });
  assert.match(out, /PAUSED until 2026-06-15T12:00:00\.000Z — start NO new work/);
});

test('renderQueenBrief — no ownerSteering ⇒ NO steering section (un-steered Hive is today\'s behaviour)', () => {
  const out = renderQueenBrief({ floor: { frontier: frontier3 } });
  assert.doesNotMatch(out, /### Owner steering directive/);
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

test('renderQueenBrief — open placements (completion mandate) render with counts + items (P-007/P-008)', () => {
  const out = renderQueenBrief({
    floor: {
      frontier: [],
      openPlacements: {
        recovering: 2,
        cursed: 1,
        stranded: 0,
        workingTracked: 3,
        items: [
          { workItemId: 'wi-50', status: 'recovering', failCount: 1, harness: 'papercup' },
          { workItemId: 'wi-51', status: 'cursed', failCount: 3, harness: 'member-a' },
        ],
      },
    },
  });
  assert.match(out, /### Placements — drive to terminal \(your completion mandate\)/);
  assert.match(out, /recovering 2 \(re-place NOW\)/);
  assert.match(out, /cursed 1 \(STOP re-placing\)/);
  assert.match(out, /working 3 \(in flight\)/);
  assert.match(out, /wi-50 \[recovering\] \(papercup\) ×1 fails/);
  assert.match(out, /wi-51 \[cursed\] \(member-a\) ×3 fails/);
});

test('renderQueenBrief — no placement section when nothing is open', () => {
  const out = renderQueenBrief({
    floor: { frontier: [], openPlacements: { recovering: 0, cursed: 0, stranded: 0, workingTracked: 0, items: [] } },
  });
  assert.doesNotMatch(out, /### Placements/);
});

// queen-interactive-brain-fresh-context P-004 — the interactive `psu --brain`
// dock pane runs the SU engineer playbook + this injected brief (it does NOT load
// queen.md), so the fresh-per-launch teaching that queen.md gives the autonomous
// Queen must ride the brief, gated on the interactive-brain wake.
test('renderQueenBrief — interactive-brain wake injects the fresh-per-launch teaching', () => {
  const out = renderQueenBrief({ floor: { wokeBy: 'interactive-brain', frontier: frontier3 } });
  assert.match(out, /Fresh-per-launch \(the dock brain model\)/);
  assert.match(out, /each time the brain pane opens you are a BRAND-NEW session/);
  // The three durable continuity channels are named (brief + carry-note + substrate).
  assert.match(out, /carry-note/);
  assert.match(out, /`blocked_by`/);
  assert.match(out, /decision ledger/);
  // It re-derives, never carries a transcript.
  assert.match(out, /re-derive your\s+working state/);
  assert.match(out, /never a carried transcript/);
});

test('renderQueenBrief — a non-interactive wake does NOT inject the dock teaching (autonomous gets it from queen.md)', () => {
  for (const wokeBy of ['timer', 'coord:escalate (a bee blocked)', 'backstop', undefined]) {
    const out = renderQueenBrief({ floor: { wokeBy, frontier: frontier3 } });
    assert.doesNotMatch(out, /Fresh-per-launch \(the dock brain model\)/);
  }
});

test('renderQueenBrief — the interactive-brain teaching stays deterministic (no clock/random leakage)', () => {
  const floor: QueenBriefFloor = { wokeBy: 'interactive-brain', frontier: frontier3 };
  const a = renderQueenBrief({ floor, carryNote: 'note' });
  const b = renderQueenBrief({ floor, carryNote: 'note' });
  assert.equal(a, b, 'identical inputs must render identical bytes');
  assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
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
