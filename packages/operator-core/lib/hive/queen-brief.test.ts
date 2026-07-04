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

// queen-capacity-aware-dispatch-2026-06-22 P-002 — the inference-capacity panel.
test('renderQueenBrief — capacity panel renders dispatchBudget + advice when present, omitted when absent', () => {
  const withCap = renderQueenBrief({
    floor: {
      frontier: frontier3,
      capacity: { factor: 0.5, dispatchBudget: 7, utilizationPct: 92, paused: false, advice: 'tightening (factor 0.50) → trim low-priority placements; ~7 bee slots free' },
    },
  });
  assert.match(withCap, /Inference capacity:.*~7 bee slot\(s\) free.*util 92%.*factor 0\.50/);
  assert.match(withCap, /tightening.*trim low-priority/);
  // paused pool surfaces the warning marker
  const paused = renderQueenBrief({
    floor: { frontier: frontier3, capacity: { factor: 0, dispatchBudget: 0, utilizationPct: 100, paused: true, advice: 'pool SATURATED' } },
  });
  assert.match(paused, /⚠ POOL PAUSED/);
  // absent ⇒ no panel
  assert.doesNotMatch(renderQueenBrief({ floor: { frontier: frontier3 } }), /Inference capacity:/);
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
        eligibleHives: [],
        includeUnplannedWork: true,
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
    floor: { frontier: frontier3, ownerSteering: { directive: null, eligiblePlans: [], eligibleHives: [], includeUnplannedWork: true, pauseNewWork: true, pausedUntil: null } },
  });
  assert.match(out, /\*\*PAUSED — start NO new work\.\*\*/);
  assert.match(out, /drive existing placements to terminal/i);
});

test('renderQueenBrief — a pausedUntil renders the deadline (deterministic from the floor value, not the clock)', () => {
  const until = Date.parse('2026-06-15T12:00:00.000Z');
  const out = renderQueenBrief({
    floor: { frontier: frontier3, ownerSteering: { directive: null, eligiblePlans: [], eligibleHives: [], includeUnplannedWork: true, pauseNewWork: false, pausedUntil: until } },
  });
  assert.match(out, /PAUSED until 2026-06-15T12:00:00\.000Z — start NO new work/);
});

test('renderQueenBrief — eligibleHives renders the placement-scope line (B-04 round-2)', () => {
  const out = renderQueenBrief({
    floor: { frontier: frontier3, ownerSteering: { directive: null, eligiblePlans: [], eligibleHives: ['hive-a', 'hive-b'], includeUnplannedWork: true, pauseNewWork: false, pausedUntil: null } },
  });
  assert.match(out, /### Owner steering directive/);
  assert.match(out, /Eligible hives ONLY:.*hive-a, hive-b/);
});

test('renderQueenBrief — no ownerSteering ⇒ NO steering section (un-steered Hive is today\'s behaviour)', () => {
  const out = renderQueenBrief({ floor: { frontier: frontier3 } });
  assert.doesNotMatch(out, /### Owner steering directive/);
});

test('renderQueenBrief — throttle knobs (P-006/P-009) render a self-governance envelope', () => {
  const out = renderQueenBrief({
    floor: {
      frontier: frontier3,
      ownerSteering: {
        directive: null,
        eligiblePlans: [],
        eligibleHives: [],
        includeUnplannedWork: true,
        pauseNewWork: false,
        pausedUntil: null,
        cadenceFloorSec: 420,
        maxBees: 5,
        tierCeilings: { bee: 'opus:xhigh' },
        idleActivities: { gym: false, curation: false },
        autoScaleOut: false,
        decomposition: 'serial',
      },
    },
  });
  assert.match(out, /Throttle \+ self-governance \(owner-set/);
  assert.match(out, /≥420s between wakes/);
  assert.match(out, /≤5 bees/);
  assert.match(out, /bee→opus:xhigh/);
  assert.match(out, /Idle activities OFF: \*\*gym, curation\*\*/);
  assert.match(out, /Auto-scale-out DISABLED/);
  assert.match(out, /Decomposition \(advisory\): prefer \*\*serial\*\*/);
});

test('renderQueenBrief — a throttle-only steering still renders the section (no directive/pause needed)', () => {
  const out = renderQueenBrief({
    floor: {
      frontier: frontier3,
      ownerSteering: {
        directive: null,
        eligiblePlans: [],
        eligibleHives: [],
        includeUnplannedWork: true,
        pauseNewWork: false,
        pausedUntil: null,
        maxBees: 3,
      },
    },
  });
  assert.match(out, /Throttle \+ self-governance/);
  assert.match(out, /≤3 bees/);
  // No directive/pause/plans ⇒ those lines are absent, but the throttle section is present.
  assert.doesNotMatch(out, /PAUSED/);
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

test('renderQueenBrief — text caps prevent prompt-admission blowups from long lines and carry-notes', () => {
  const longTitle = `Investigate ${'very-long-title '.repeat(80)}`;
  const longReason = `because ${'very-long-reason '.repeat(80)}`;
  const many = Array.from({ length: 12 }, (_, i) =>
    ranked({ id: `wi-${i}`, harness: 'papercup', title: longTitle }, 20 - i, [longReason]),
  );
  const out = renderQueenBrief({
    floor: { frontier: many },
    carryNote: 'carry '.repeat(300),
    textCaps: { totalChars: 1_200, lineChars: 160, carryNoteChars: 120 },
  });

  assert.ok(out.length <= 1_200, `brief length ${out.length} should respect total cap`);
  assert.match(out, /line truncated/);
  assert.match(out, /brief truncated to 1200 chars/);
  assert.doesNotMatch(out, new RegExp('very-long-title '.repeat(20)));
});

test('renderQueenBrief — carry-note is capped even when the full brief has room', () => {
  const out = renderQueenBrief({
    floor: { frontier: [] },
    carryNote: 'carry '.repeat(200),
    textCaps: { totalChars: 5_000, lineChars: 1_000, carryNoteChars: 90 },
  });

  assert.match(out, /carry-note truncated/);
  assert.doesNotMatch(out, new RegExp('carry '.repeat(40)));
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

test('renderQueenBrief — EI-3419: the hive anchor renders before "Woke by", and the carry-journal/note gets a scope caveat naming it', () => {
  const floor: QueenBriefFloor = { hiveSlug: 'papercusp', wokeBy: 'timer', frontier: frontier3 };
  const withJournal = renderQueenBrief({ floor, carryJournal: [{ at: 0, note: 'still mid-fix on the ranker' }] });
  assert.match(withJournal, /\*\*Hive \(this wake\):\*\* papercusp/);
  // The hive line precedes the wokeBy line (ordering matters — it's the anchor).
  assert.ok(withJournal.indexOf('**Hive (this wake):**') < withJournal.indexOf('**Woke by:**'));
  assert.match(withJournal, /shared across every hive this Queen operates/);
  assert.match(withJournal, /if it names a different hive than \*\*papercusp\*\* above, IGNORE it/);

  const withLegacyNote = renderQueenBrief({ floor, carryNote: 'stale note from another hive' });
  assert.match(withLegacyNote, /Your carry-note \(you wrote this last wake.*shared across every hive this Queen operates.*papercusp.*\)/s);
});

test('renderQueenBrief — no hiveSlug: the anchor line and the scope caveat are both omitted (no ground truth to anchor against)', () => {
  const floor: QueenBriefFloor = { wokeBy: 'timer', frontier: frontier3 };
  const out = renderQueenBrief({ floor, carryJournal: [{ at: 0, note: 'in flight' }] });
  assert.doesNotMatch(out, /\*\*Hive \(this wake\):\*\*/);
  assert.doesNotMatch(out, /shared across every hive this Queen operates/);
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
