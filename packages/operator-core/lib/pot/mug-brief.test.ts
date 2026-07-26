import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { Ranked } from '../queue-ranker';
import type { PlacementCandidate } from './placement-ranker';
import {
  renderMugBrief,
  floorFromSurvey,
  type MugBriefFloor,
  type BriefCup,
} from './mug-brief';

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

test('renderMugBrief — two-part: FLOOR digest + CARRY-NOTE both render (P-004/P-015)', () => {
  const floor: MugBriefFloor = {
    wokeBy: 'coord:escalate (a cup blocked)',
    headroom: { ceiling: 8, running: 5, headroom: 3 },
    frontier: frontier3,
    frontierBlocked: 2,
    plans: [ranked({ id: 'plan-x', view: 'plan', harness: 'papercup', title: 'Ship X' }, 7.0, ['hottest item: high'])],
    cups: [
      { id: 'cup-alpha', doing: 'wi-090', load: 2, alive: true },
      { id: 'cup-gamma', load: 1, alive: false },
    ],
    inbox: [{ kind: 'escalation', from: 'cup-alpha', summary: 'cannot resolve schema conflict' }],
    changeFeed: ['wi-080 completed by cup-delta', 'plan-y run finished'],
    escalations: [{ id: 'esc-1', severity: 'major', summary: 'staging deploy red' }],
  };
  const out = renderMugBrief({ floor, carryNote: 'Mid-wave on plan-x: B-03 placed, awaiting B-01. Revisit when wi-101 lands.' });

  // FLOOR — the P-007 instruction to NOT re-run the survey reads.
  assert.match(out, /do NOT re-run `pot:survey`/);
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
  // Plans, cups (incl. DEAD), inbox, change-feed, escalations.
  assert.match(out, /plan-x — Ship X \[papercup\]/);
  assert.match(out, /cup-alpha: load 2, doing wi-090 \[alive\]/);
  assert.match(out, /cup-gamma: load 1 \[DEAD — re-place its unit\]/);
  assert.match(out, /\[escalation\] cup-alpha: cannot resolve schema conflict/);
  assert.match(out, /wi-080 completed by cup-delta/);
  assert.match(out, /esc-1 \(major\): staging deploy red/);
  // CARRY-NOTE — additive second half, clearly labelled as her own intention.
  assert.match(out, /### Your carry-note/);
  assert.match(out, /Mid-wave on plan-x: B-03 placed/);
});

test('renderMugBrief — floor-only (no carry-note) omits the carry-note section, degrades gracefully', () => {
  const out = renderMugBrief({ floor: { frontier: frontier3 } });
  assert.doesNotMatch(out, /### Your carry-note/);
  // The floor still renders.
  assert.match(out, /1\. wi-101 — Fix the deploy/);
  // Whitespace-only carry-note is treated as empty.
  const out2 = renderMugBrief({ floor: { frontier: frontier3 }, carryNote: '   \n  ' });
  assert.doesNotMatch(out2, /### Your carry-note/);
});

// D-002 Layer 1 (queen-memory-hybrid-2026-07-02 L1c / autonomous-loop-prod-audit
// P-009): the standing-facts fold and the mem0 background-recall fold are both
// pure additive inputs to the renderer — pinned here at the render level (the
// wiring that PRODUCES factsFold/memoryFold is pinned in mug-brief-launch.test.ts).
test('renderMugBrief — standing-facts fold (L1c) renders verbatim, ahead of the carry-journal', () => {
  const out = renderMugBrief({
    floor: { frontier: frontier3 },
    factsFold:
      '### Standing facts (deterministic — assert via facts:assert, retract when stale)\n' +
      '• [role:mug] WI-1439 is owner residue — exclude from frontier (expires ~5d)',
    carryJournal: [{ at: 0, note: 'trajectory note' }],
  });
  assert.match(out, /### Standing facts/);
  assert.match(out, /WI-1439 is owner residue — exclude from frontier/);
  assert.ok(
    out.indexOf('### Standing facts') < out.indexOf('### Your carry-journal'),
    'the facts fold renders before the carry-journal (L1 position fix — the small orientation-critical sections come first)',
  );
});

test('renderMugBrief — no factsFold (absent or blank) ⇒ no Standing facts section (graceful degradation)', () => {
  const out = renderMugBrief({ floor: { frontier: frontier3 } });
  assert.doesNotMatch(out, /### Standing facts/);
  const out2 = renderMugBrief({ floor: { frontier: frontier3 }, factsFold: '   \n  ' });
  assert.doesNotMatch(out2, /### Standing facts/);
});

test('renderMugBrief — mem0 background recall (L1d) renders after the carry-journal/facts, labeled non-authoritative', () => {
  const out = renderMugBrief({
    floor: { frontier: frontier3 },
    factsFold: '### Standing facts (deterministic — assert via facts:assert, retract when stale)\n• [workspace] fact one',
    carryJournal: [{ at: 0, note: 'trajectory note' }],
    memoryFold:
      '### Background recall (fuzzy memory — may be stale; the standing facts above are authoritative)\n\n- recalled convention',
  });
  assert.match(out, /### Background recall/);
  assert.match(out, /recalled convention/);
  assert.ok(
    out.indexOf('### Your carry-journal') < out.indexOf('### Background recall'),
    'the memory fold renders after the carry-journal (facts → journal → memory ordering)',
  );
});

test('renderMugBrief — no memoryFold (absent or blank) ⇒ no Background recall section', () => {
  const out = renderMugBrief({ floor: { frontier: frontier3 } });
  assert.doesNotMatch(out, /### Background recall/);
  const out2 = renderMugBrief({ floor: { frontier: frontier3 }, memoryFold: '  ' });
  assert.doesNotMatch(out2, /### Background recall/);
});

// WI-4563 — an empty frontier must be DIAGNOSABLE in the Mug's own launch brief:
// admission-starvation (federated work withheld by the G2 gate) must read as a
// DEADLOCK, never the bare "no ready work" that looked like a blind spot for 14 wakes.
test('renderMugBrief — WI-4563: an EMPTY frontier caused by admission quarantine renders a LOUD deadlock line, not "no ready work"', () => {
  const out = renderMugBrief({ floor: { frontier: [], frontierQuarantined: 10 } });
  assert.match(out, /ADMISSION-STARVED/);
  assert.match(out, /10 item\(s\) WITHHELD/);
  // The bare "no work" line must NOT appear — that is exactly the mis-read this fixes.
  assert.doesNotMatch(out, /empty — no ready work to place/);
});

test('renderMugBrief — WI-4563: an empty frontier with ZERO quarantined still renders the plain "no ready work" line (genuinely idle)', () => {
  const out = renderMugBrief({ floor: { frontier: [], frontierQuarantined: 0 } });
  assert.match(out, /empty — no ready work to place/);
  assert.doesNotMatch(out, /ADMISSION-STARVED/);
});

// EI-13695 — the reconcile lane: attempted items a dead cup left un-converged are
// rendered with their checkpoint heads and an explicit converge-don't-place rubric,
// NEVER folded into the fresh frontier list.
test('renderMugBrief — reconcile lane renders count + checkpoint heads with the converge rubric (EI-13695)', () => {
  const out = renderMugBrief({
    floor: {
      frontier: [],
      frontierReconcile: 2,
      reconcileRows: [
        {
          feature_id: 'WI-5132',
          harness_slug: 'papercup',
          title: 'finished but un-converged',
          item_kind: 'feature',
          checkpoint_head: '## WI-5132 COMPLETED — VERIFIED COMPLETE, 107/107 tests',
          checkpoint_updated_ts: Date.now() - 5 * 60_000,
        },
      ],
    },
  });
  assert.match(out, /Reconcile — 2 attempted item\(s\)/);
  assert.match(out, /WI-5132/);
  assert.match(out, /COMPLETED — VERIFIED COMPLETE/);
  assert.match(out, /verify \+ `work_items:complete`/);
  // The reconcile item must not leak into the fresh-frontier section.
  assert.match(out, /empty — no ready work to place/);
});

test('renderMugBrief — no reconcile section when the slice is empty (EI-13695)', () => {
  const out = renderMugBrief({ floor: { frontier: [], frontierReconcile: 0, reconcileRows: [] } });
  assert.doesNotMatch(out, /Reconcile — /);
});

test('floorFromSurvey — threads frontierQuarantined through from the survey (WI-4563)', () => {
  const floor = floorFromSurvey({
    frontier: [],
    plans: [],
    frontierBlocked: 0,
    frontierQuarantined: 4,
    frontierReconcile: 0,
    reconcileRows: [],
  });
  assert.equal(floor.frontierQuarantined, 4);
});

// queen-capacity-aware-dispatch-2026-06-22 P-002 — the inference-capacity panel.
test('renderMugBrief — capacity panel renders dispatchBudget + advice when present, omitted when absent', () => {
  const withCap = renderMugBrief({
    floor: {
      frontier: frontier3,
      capacity: { factor: 0.5, dispatchBudget: 7, utilizationPct: 92, paused: false, advice: 'tightening (factor 0.50) → trim low-priority placements; ~7 cup slots free' },
    },
  });
  assert.match(withCap, /Inference capacity:.*~7 cup slot\(s\) free.*util 92%.*factor 0\.50/);
  assert.match(withCap, /tightening.*trim low-priority/);
  // paused pool surfaces the warning marker
  const paused = renderMugBrief({
    floor: { frontier: frontier3, capacity: { factor: 0, dispatchBudget: 0, utilizationPct: 100, paused: true, advice: 'pool SATURATED' } },
  });
  assert.match(paused, /⚠ POOL PAUSED/);
  // absent ⇒ no panel
  assert.doesNotMatch(renderMugBrief({ floor: { frontier: frontier3 } }), /Inference capacity:/);
});

// overwatch-role-2026-06-15 B-09 / D-004 — the who-watches-the-watcher reverse
// leg: the Mug's brief carries overwatch's liveness.
test('renderMugBrief — overwatchAlive undefined ⇒ the cross-monitor line is omitted (no noise when overwatch is not in play)', () => {
  const out = renderMugBrief({ floor: { frontier: frontier3 } });
  assert.doesNotMatch(out, /Cross-monitor/);
  assert.doesNotMatch(out, /OVERWATCH DARK/);
});

test('renderMugBrief — overwatchAlive true ⇒ a quiet "overwatch alive" line', () => {
  const out = renderMugBrief({ floor: { frontier: frontier3, overwatchAlive: true } });
  assert.match(out, /### Cross-monitor \(who-watches-the-watcher\)/);
  assert.match(out, /overwatch alive/);
  assert.doesNotMatch(out, /OVERWATCH DARK/);
});

test('renderMugBrief — overwatchAlive false ⇒ a critical OVERWATCH DARK line telling her to ESCALATE', () => {
  const out = renderMugBrief({ floor: { frontier: frontier3, overwatchAlive: false } });
  assert.match(out, /OVERWATCH DARK/);
  assert.match(out, /ESCALATE/);
  // She must NOT be told to relaunch it — that is structural (D-002).
  assert.match(out, /cannot relaunch overwatch/i);
});

// ── Owner steering directive (queen-steering-panel-2026-06-15 B-02 / P-002) ──
test('renderMugBrief — owner steering renders an AUTHORITATIVE section BEFORE the frontier', () => {
  const out = renderMugBrief({
    floor: {
      frontier: frontier3,
      ownerSteering: {
        directive: 'Finish the in-flight backlog before anything new.',
        eligiblePlans: ['plan-x', 'plan-y'],
        eligibleHives: [],
        createWakeSuppressPlans: [],
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

test('renderMugBrief — pauseNewWork renders a HARD "PAUSED — start NO new work" line', () => {
  const out = renderMugBrief({
    floor: { frontier: frontier3, ownerSteering: { directive: null, eligiblePlans: [], eligibleHives: [], createWakeSuppressPlans: [], includeUnplannedWork: true, pauseNewWork: true, pausedUntil: null } },
  });
  assert.match(out, /\*\*PAUSED — start NO new work\.\*\*/);
  assert.match(out, /drive existing placements to terminal/i);
});

test('renderMugBrief — EI-8277: a resume-sounding directive with pauseNewWork still true renders the inconsistency nudge', () => {
  const out = renderMugBrief({
    floor: {
      frontier: frontier3,
      ownerSteering: {
        directive: 'Gate hold lifted at 2026-07-05T21:36Z; resume normal autonomous placement',
        eligiblePlans: [],
        eligibleHives: [],
        createWakeSuppressPlans: [],
        includeUnplannedWork: true,
        pauseNewWork: true,
        pausedUntil: null,
      },
    },
  });
  assert.match(out, /Steering looks inconsistent \(EI-8277\)/);
  assert.match(out, /pot:set-steering \{ pauseNewWork:false \}/);
});

test('renderMugBrief — EI-8277: no nudge when pauseNewWork already matches the resume directive', () => {
  const out = renderMugBrief({
    floor: {
      frontier: frontier3,
      ownerSteering: {
        directive: 'Gate hold lifted; resume normal autonomous placement',
        eligiblePlans: [],
        eligibleHives: [],
        createWakeSuppressPlans: [],
        includeUnplannedWork: true,
        pauseNewWork: false,
        pausedUntil: null,
      },
    },
  });
  assert.doesNotMatch(out, /Steering looks inconsistent/);
});

test('renderMugBrief — a pausedUntil renders the deadline (deterministic from the floor value, not the clock)', () => {
  const until = Date.parse('2026-06-15T12:00:00.000Z');
  const out = renderMugBrief({
    floor: { frontier: frontier3, ownerSteering: { directive: null, eligiblePlans: [], eligibleHives: [], createWakeSuppressPlans: [], includeUnplannedWork: true, pauseNewWork: false, pausedUntil: until } },
  });
  assert.match(out, /PAUSED until 2026-06-15T12:00:00\.000Z — start NO new work/);
});

test('renderMugBrief — eligiblePots renders the placement-scope line (B-04 round-2)', () => {
  const out = renderMugBrief({
    floor: { frontier: frontier3, ownerSteering: { directive: null, eligiblePlans: [], eligibleHives: ['pot-a', 'pot-b'], createWakeSuppressPlans: [], includeUnplannedWork: true, pauseNewWork: false, pausedUntil: null } },
  });
  assert.match(out, /### Owner steering directive/);
  assert.match(out, /Eligible hives ONLY:.*pot-a, pot-b/);
});

test('renderMugBrief — no ownerSteering ⇒ NO steering section (un-steered Pot is today\'s behaviour)', () => {
  const out = renderMugBrief({ floor: { frontier: frontier3 } });
  assert.doesNotMatch(out, /### Owner steering directive/);
});

test('renderMugBrief — throttle knobs (P-006/P-009) render a self-governance envelope', () => {
  const out = renderMugBrief({
    floor: {
      frontier: frontier3,
      ownerSteering: {
        directive: null,
        eligiblePlans: [],
        eligibleHives: [],
        createWakeSuppressPlans: [],
        includeUnplannedWork: true,
        pauseNewWork: false,
        pausedUntil: null,
        cadenceFloorSec: 420,
        maxBees: 5,
        tierCeilings: { cup: 'opus:xhigh' },
        idleActivities: { gym: false, curation: false },
        autoScaleOut: false,
        decomposition: 'serial',
      },
    },
  });
  assert.match(out, /Throttle \+ self-governance \(owner-set/);
  assert.match(out, /≥420s between wakes/);
  assert.match(out, /≤5 cups/);
  assert.match(out, /cup→opus:xhigh/);
  assert.match(out, /Idle activities OFF: \*\*gym, curation\*\*/);
  assert.match(out, /Auto-scale-out DISABLED/);
  assert.match(out, /Decomposition \(advisory\): prefer \*\*serial\*\*/);
});

test('renderMugBrief — a throttle-only steering still renders the section (no directive/pause needed)', () => {
  const out = renderMugBrief({
    floor: {
      frontier: frontier3,
      ownerSteering: {
        directive: null,
        eligiblePlans: [],
        eligibleHives: [],
        createWakeSuppressPlans: [],
        includeUnplannedWork: true,
        pauseNewWork: false,
        pausedUntil: null,
        maxBees: 3,
      },
    },
  });
  assert.match(out, /Throttle \+ self-governance/);
  assert.match(out, /≤3 cups/);
  // No directive/pause/plans ⇒ those lines are absent, but the throttle section is present.
  assert.doesNotMatch(out, /PAUSED/);
});

test('renderMugBrief — deterministic: same floor renders byte-identical output (no clock/random leakage)', () => {
  const floor: MugBriefFloor = { wokeBy: 'timer', frontier: frontier3, cups: [{ id: 'b1', load: 0, alive: true }] };
  const a = renderMugBrief({ floor, carryNote: 'note' });
  const b = renderMugBrief({ floor, carryNote: 'note' });
  assert.equal(a, b, 'identical inputs must render identical bytes');
  // No ISO timestamp / epoch leaked into the rendered text.
  assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
});

test('renderMugBrief — empty frontier renders an explicit "empty" signal, not an omission', () => {
  const out = renderMugBrief({ floor: { frontier: [] } });
  assert.match(out, /### Frontier — ready to place \(ranked\)/);
  assert.match(out, /_empty — no ready work to place\._/);
});

test('renderMugBrief — over-cap lists are digested with a "+N more" overflow line (P-004)', () => {
  const many = Array.from({ length: 20 }, (_, i) => ranked({ id: `wi-${i}`, harness: 'papercup' }, 20 - i));
  const out = renderMugBrief({ floor: { frontier: many }, caps: { frontier: 5 } });
  assert.match(out, /1\. wi-0 /);
  assert.match(out, /5\. wi-4 /);
  assert.doesNotMatch(out, /6\. wi-5 /);
  assert.match(out, /…\+15 more \(work_items:list to drill down\)/);
});

// EI-18666217180294576 (D-002 follow-up): `frontier` is now a PROTECTED
// section (see below) so it is never sacrificed to the total-budget cut —
// this test exercises the total cap against genuinely ELASTIC content
// (`changeFeed`, an ambient digest) instead, so "respects the total cap"
// still holds for the content that's actually supposed to absorb the cut.
test('renderMugBrief — text caps prevent prompt-admission blowups from long lines and elastic sections', () => {
  const longLine = `- because ${'very-long-reason '.repeat(80)}`;
  const manyChangeFeed = Array.from({ length: 20 }, (_, i) => `${longLine} (${i})`);
  const out = renderMugBrief({
    floor: { frontier: [], changeFeed: manyChangeFeed },
    carryNote: 'carry '.repeat(300),
    textCaps: { totalChars: 1_200, lineChars: 160, carryNoteChars: 120 },
  });

  assert.ok(out.length <= 1_200, `brief length ${out.length} should respect total cap`);
  assert.match(out, /line truncated/);
  assert.match(out, /ambient line\(s\) omitted/);
  assert.doesNotMatch(out, new RegExp('very-long-reason '.repeat(20)));
});

// ── EI-18666217180294576: the Mug wake-brief blind-tail-slice bug ──
// Root cause #1 (per-line fairness): a pre-rendered MULTI-LINE block (e.g. the
// standing-facts fold — one physical line per fact) was pushed as a SINGLE
// `out` element, so the per-line cap truncated the WHOLE block as if it were
// one line — silently dropping most facts even though each individual fact
// easily fit. Root cause #2 (section-aware budget): the old total-budget cut
// blind-sliced the TAIL of the joined string with no regard for which section
// that tail belonged to. Both are fixed together; these tests pin the fix as
// the recurrence guard the original report asked for.
test('renderMugBrief — EI-18666217180294576: a many-entry standing-facts fold survives verbatim, per-line fairness (not clipped as one blob)', () => {
  const facts = Array.from(
    { length: 15 },
    (_, i) => `• [role:mug] fact-${i} is a standing conclusion that must survive verbatim (expires ~5d)`,
  );
  const factsFold = `### Standing facts (deterministic — assert via facts:assert, retract when stale)\n${facts.join('\n')}`;
  const out = renderMugBrief({
    floor: { frontier: [] },
    factsFold,
    // Elastic content big enough to force a total-budget cut on its own.
    carryJournal: Array.from({ length: 30 }, (_, i) => ({ at: 0, note: `ambient trajectory note ${i} `.repeat(10) })),
    memoryFold: `### Background recall\n${'ambient fuzzy recall filler. '.repeat(200)}`,
    textCaps: { totalChars: 2_000, lineChars: 900, carryNoteChars: 700 },
  });

  // Every individual fact renders verbatim — the old bug clipped the fold to
  // ~2 facts (whatever fit in one 900-char "line").
  for (const fact of facts) {
    assert.ok(out.includes(fact), `expected fact to survive verbatim: ${fact}`);
  }
  // The cut landed on the elastic content instead, and it's announced, not silent.
  assert.match(out, /ambient line\(s\) omitted/);
});

test('renderMugBrief — EI-18666217180294576: even when PROTECTED content alone exceeds the total budget, the cut is a visible countable marker, never a silent byte-slice', () => {
  const facts = Array.from({ length: 40 }, (_, i) => `• [role:mug] fact-${i} ${'x'.repeat(80)} (expires ~5d)`);
  const factsFold = `### Standing facts (deterministic — assert via facts:assert, retract when stale)\n${facts.join('\n')}`;
  const out = renderMugBrief({
    floor: { frontier: [] },
    factsFold,
    textCaps: { totalChars: 1_000, lineChars: 900, carryNoteChars: 120 },
  });

  assert.match(out, /PROTECTED line\(s\) also omitted/);
  // Render order is preserved — the earliest facts survive, never a byte-level
  // mid-line slice.
  assert.ok(out.includes(facts[0]), 'the first fact should survive intact');
  assert.doesNotMatch(out, /…\[line truncated;/);
});

test('renderMugBrief — carry-note is capped even when the full brief has room', () => {
  const out = renderMugBrief({
    floor: { frontier: [] },
    carryNote: 'carry '.repeat(200),
    textCaps: { totalChars: 5_000, lineChars: 1_000, carryNoteChars: 90 },
  });

  assert.match(out, /carry-note truncated/);
  assert.doesNotMatch(out, new RegExp('carry '.repeat(40)));
});

test('renderMugBrief — most-salient why is the highest-contribution feature reason', () => {
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
  const out = renderMugBrief({ floor: { frontier: [r] } });
  assert.match(out, /· 2 escalations waiting/);
  assert.doesNotMatch(out, /aged a bit/);
});

test('renderMugBrief — open placements (completion mandate) render with counts + items (P-007/P-008)', () => {
  const out = renderMugBrief({
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

test('renderMugBrief — no placement section when nothing is open', () => {
  const out = renderMugBrief({
    floor: { frontier: [], openPlacements: { recovering: 0, cursed: 0, stranded: 0, workingTracked: 0, items: [] } },
  });
  assert.doesNotMatch(out, /### Placements/);
});

// EI-6104 — placements is a wake-time snapshot; an empty Frontier alongside
// nonzero placement counts is exactly the "phantom completion pressure" shape
// reported (brief said working=3/cursed=15, live survey/scheduler showed 0).
// The reconciliation caveat should fire on that combination, never when the
// frontier still has real work (no need to second-guess an already-consistent
// picture) or when nothing is open at all.
test('renderMugBrief — placements + empty frontier renders a reconcile-before-acting caveat', () => {
  const out = renderMugBrief({
    floor: {
      frontier: [],
      openPlacements: {
        recovering: 0,
        cursed: 15,
        stranded: 0,
        workingTracked: 3,
        items: [{ workItemId: 'wi-60', status: 'cursed', failCount: 2, harness: 'papercusp' }],
      },
    },
  });
  assert.match(out, /snapshot at wake-time/);
  assert.match(out, /pot:survey/);
});

test('renderMugBrief — placements + non-empty frontier omits the reconcile caveat', () => {
  const r: Ranked<PlacementCandidate> = {
    id: 'wi-9',
    view: 'work-item',
    harness: 'papercup',
    title: 'T',
    importance: 'normal',
    rank: { score: 1, features: [] },
  };
  const out = renderMugBrief({
    floor: {
      frontier: [r],
      openPlacements: { recovering: 0, cursed: 1, stranded: 0, workingTracked: 0, items: [] },
    },
  });
  assert.match(out, /### Placements/);
  assert.doesNotMatch(out, /snapshot at wake-time/);
});

// mug-interactive-brain-fresh-context P-004 — the interactive `psu --brain`
// dock pane runs the SU engineer playbook + this injected brief (it does NOT load
// mug.md), so the fresh-per-launch teaching that mug.md gives the autonomous
// Mug must ride the brief, gated on the interactive-brain wake.
test('renderMugBrief — interactive-brain wake injects the fresh-per-launch teaching', () => {
  const out = renderMugBrief({ floor: { wokeBy: 'interactive-brain', frontier: frontier3 } });
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

test('renderMugBrief — a non-interactive wake does NOT inject the dock teaching (autonomous gets it from mug.md)', () => {
  for (const wokeBy of ['timer', 'coord:escalate (a cup blocked)', 'backstop', undefined]) {
    const out = renderMugBrief({ floor: { wokeBy, frontier: frontier3 } });
    assert.doesNotMatch(out, /Fresh-per-launch \(the dock brain model\)/);
  }
});

test('renderMugBrief — the interactive-brain teaching stays deterministic (no clock/random leakage)', () => {
  const floor: MugBriefFloor = { wokeBy: 'interactive-brain', frontier: frontier3 };
  const a = renderMugBrief({ floor, carryNote: 'note' });
  const b = renderMugBrief({ floor, carryNote: 'note' });
  assert.equal(a, b, 'identical inputs must render identical bytes');
  assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
});

test('renderMugBrief — EI-3419: the pot anchor renders before "Woke by", and the carry-journal/note gets a scope caveat naming it', () => {
  const floor: MugBriefFloor = { potSlug: 'papercusp', wokeBy: 'timer', frontier: frontier3 };
  const withJournal = renderMugBrief({ floor, carryJournal: [{ at: 0, note: 'still mid-fix on the ranker' }] });
  assert.match(withJournal, /\*\*Pot \(this wake\):\*\* papercusp/);
  // The pot line precedes the wokeBy line (ordering matters — it's the anchor).
  assert.ok(withJournal.indexOf('**Pot (this wake):**') < withJournal.indexOf('**Woke by:**'));
  assert.match(withJournal, /shared across every pot this Mug operates/);
  assert.match(withJournal, /if it names a different pot than \*\*papercusp\*\* above, IGNORE it/);

  const withLegacyNote = renderMugBrief({ floor, carryNote: 'stale note from another pot' });
  assert.match(withLegacyNote, /Your carry-note \(you wrote this last wake.*shared across every pot this Mug operates.*papercusp.*\)/s);
});

test('renderMugBrief — no potSlug: the anchor line and the scope caveat are both omitted (no ground truth to anchor against)', () => {
  const floor: MugBriefFloor = { wokeBy: 'timer', frontier: frontier3 };
  const out = renderMugBrief({ floor, carryJournal: [{ at: 0, note: 'in flight' }] });
  assert.doesNotMatch(out, /\*\*Pot \(this wake\):\*\*/);
  assert.doesNotMatch(out, /shared across every pot this Mug operates/);
});

test('floorFromSurvey — maps survey frontier/plans/blocked and merges watchdog signals (P-005 reuse)', () => {
  const survey = {
    frontier: frontier3,
    plans: [],
    frontierBlocked: 4,
    frontierQuarantined: 0,
    frontierReconcile: 0,
    reconcileRows: [],
  };
  const cups: BriefCup[] = [{ id: 'b1', load: 1, alive: true }];
  const floor = floorFromSurvey(survey, { wokeBy: 'timer', cups });
  assert.equal(floor.frontier, frontier3);
  assert.equal(floor.frontierBlocked, 4);
  assert.equal(floor.wokeBy, 'timer');
  assert.deepEqual(floor.cups, cups);
});
