/**
 * Pure-half tests for goal-deps (goal-dag-shared-substrate-2026-08-18 P-001/
 * P-002/P-003) — classification, per-blocker verdicts, the readiness fold, the
 * goal→goal graph projection and the acyclicity guard. The SQL half is
 * exercised by the tool integration tests; everything here runs with no
 * database, which is what lets the POLICY (D-002/D-006) be pinned exhaustively.
 */

import { describe, expect, it } from 'vitest';
import {
  GOAL_DEP_KIND,
  ISSUE_DEP_KIND,
  PLAN_DEP_KIND,
  blockerStatusKey,
  classifyGoalBlockerRef,
  goalBlockedByWouldCycle,
  goalBlockerVerdict,
  goalReadiness,
  goalToGoalGraph,
  parsePlanRef,
  planStatusSeverity,
  type GoalBlockerEndpoint,
} from './goal-deps';
import {
  PLAN_INVALIDATING_STATUSES,
  PLAN_SATISFYING_STATUSES,
  PLAN_TERMINAL_STATUSES,
} from './_core';

describe('classifyGoalBlockerRef (D-006 shape classification)', () => {
  it('bare WI-/EI- ids are issue-family', () => {
    expect(classifyGoalBlockerRef('WI-1234')).toEqual({ kind: ISSUE_DEP_KIND, ref: 'WI-1234' });
    expect(classifyGoalBlockerRef('EI-20759031730898750')).toEqual({
      kind: ISSUE_DEP_KIND,
      ref: 'EI-20759031730898750',
    });
  });

  it('goal slug-hex ids are goals', () => {
    expect(classifyGoalBlockerRef('ship-a-paid-app-3f9a1c')).toEqual({
      kind: GOAL_DEP_KIND,
      ref: 'ship-a-paid-app-3f9a1c',
    });
  });

  it('trims whitespace before classifying', () => {
    expect(classifyGoalBlockerRef('  WI-7  ')).toEqual({ kind: ISSUE_DEP_KIND, ref: 'WI-7' });
  });

  it('near-miss issue shapes fall through to goal (the writer then resolve-checks them)', () => {
    // Lowercase / suffixed shapes are NOT silently treated as issues — they
    // classify as goal refs and the writer refuses them when no goal row
    // resolves, rather than minting an inert issue edge.
    expect(classifyGoalBlockerRef('wi-123').kind).toBe(GOAL_DEP_KIND);
    expect(classifyGoalBlockerRef('WI-123x').kind).toBe(GOAL_DEP_KIND);
  });
});

describe('goalBlockerVerdict (D-002 policy)', () => {
  it('absent blocker (null status) is satisfied — absent never deadlocks', () => {
    expect(goalBlockerVerdict(GOAL_DEP_KIND, null)).toBe('satisfied');
    expect(goalBlockerVerdict(ISSUE_DEP_KIND, null)).toBe('satisfied');
  });

  it('goal blockers: achieved satisfies, killed INVALIDATES, active/paused pend', () => {
    expect(goalBlockerVerdict(GOAL_DEP_KIND, 'achieved')).toBe('satisfied');
    expect(goalBlockerVerdict(GOAL_DEP_KIND, 'killed')).toBe('invalidating');
    expect(goalBlockerVerdict(GOAL_DEP_KIND, 'active')).toBe('pending');
    expect(goalBlockerVerdict(GOAL_DEP_KIND, 'paused')).toBe('pending');
  });

  it('issue blockers: plain terminal-satisfies (both unified and legacy spellings), open pends', () => {
    for (const s of ['done', 'dropped', 'resolved', 'closed']) {
      expect(goalBlockerVerdict(ISSUE_DEP_KIND, s)).toBe('satisfied');
    }
    expect(goalBlockerVerdict(ISSUE_DEP_KIND, 'open')).toBe('pending');
    expect(goalBlockerVerdict(ISSUE_DEP_KIND, 'wip')).toBe('pending');
  });
});

describe('goalReadiness (the fold behind actionable / premiseInvalidated)', () => {
  const g = (ref: string, status: string | null) => ({
    kind: GOAL_DEP_KIND as typeof GOAL_DEP_KIND,
    ref,
    status,
  });

  it('no blockers ⇒ actionable', () => {
    const r = goalReadiness([]);
    expect(r.actionable).toBe(true);
    expect(r.premiseInvalidated).toBe(false);
  });

  it('all blockers achieved ⇒ actionable', () => {
    const r = goalReadiness([g('a-1', 'achieved'), g('b-2', 'achieved')]);
    expect(r.actionable).toBe(true);
  });

  it('one active blocker ⇒ not actionable, premise intact', () => {
    const r = goalReadiness([g('a-1', 'achieved'), g('b-2', 'active')]);
    expect(r.actionable).toBe(false);
    expect(r.premiseInvalidated).toBe(false);
  });

  it('a killed blocker ⇒ premiseInvalidated AND not actionable — never silently unblocks', () => {
    const r = goalReadiness([g('a-1', 'killed')]);
    expect(r.actionable).toBe(false);
    expect(r.premiseInvalidated).toBe(true);
    expect(r.blockers[0]!.verdict).toBe('invalidating');
  });

  it('a mixed set: satisfied issue + pending goal ⇒ not actionable', () => {
    const r = goalReadiness([
      { kind: ISSUE_DEP_KIND, ref: 'WI-1', status: 'done' },
      g('b-2', 'paused'),
    ]);
    expect(r.actionable).toBe(false);
    expect(r.blockers.map((b) => b.verdict)).toEqual(['satisfied', 'pending']);
  });
});

describe('goalToGoalGraph + goalBlockedByWouldCycle (writer acyclicity, D-006)', () => {
  const edges = new Map<string, GoalBlockerEndpoint[]>([
    ['b', [{ kind: GOAL_DEP_KIND, ref: 'a' }]],
    ['c', [{ kind: GOAL_DEP_KIND, ref: 'b' }, { kind: ISSUE_DEP_KIND, ref: 'WI-9' }]],
  ]);

  it('projects only goal→goal edges (issue blockers cannot cycle)', () => {
    const graph = goalToGoalGraph(edges);
    expect(graph.get('c')).toEqual(['b']);
    expect(graph.get('b')).toEqual(['a']);
  });

  it('a → c edge would close the a→b→c chain into a cycle', () => {
    expect(goalBlockedByWouldCycle(edges, 'a', ['c'])).toBe(true);
  });

  it('an independent edge does not', () => {
    expect(goalBlockedByWouldCycle(edges, 'a', ['unrelated-goal'])).toBe(false);
  });

  it('replace semantics: re-pointing c away from b clears the old edge before checking', () => {
    // c currently depends on b; replacing c's set with just an issue blocker
    // and then pointing b at c must NOT be judged against the removed edge.
    expect(goalBlockedByWouldCycle(edges, 'c', [])).toBe(false);
  });
});

describe('blockerStatusKey', () => {
  it('is the colon composite both writer-dedupe and status maps key by', () => {
    expect(blockerStatusKey({ kind: GOAL_DEP_KIND, ref: 'x-1' })).toBe('goal:x-1');
    expect(blockerStatusKey({ kind: ISSUE_DEP_KIND, ref: 'WI-2' })).toBe('issue:WI-2');
    expect(blockerStatusKey({ kind: PLAN_DEP_KIND, ref: 'ship-it-2026' })).toBe(
      'plan:ship-it-2026',
    );
  });
});

// ── PLAN blockers (work-on-everything-goal-2026-08-23 P-019 / D-004) ──────────

describe('classifyGoalBlockerRef: plan refs (D-004 shape rule)', () => {
  it('a `plan:` prefixed ref is a plan, and the prefix is STRIPPED from the stored ref', () => {
    // The prefix is caller syntax; `blocker_kind` already carries the family, so
    // storing it would double-encode and break blockerStatusKey round-tripping.
    expect(classifyGoalBlockerRef('plan:work-on-everything-goal-2026-08-23')).toEqual({
      kind: PLAN_DEP_KIND,
      ref: 'work-on-everything-goal-2026-08-23',
    });
  });

  it('accepts the harness-qualified form, keeping `<harness>/<slug>` as the ref', () => {
    expect(classifyGoalBlockerRef('plan:papercusp/goal-live-holder-guarantee-2026-08-18')).toEqual({
      kind: PLAN_DEP_KIND,
      ref: 'papercusp/goal-live-holder-guarantee-2026-08-18',
    });
  });

  it('trims around AND inside the prefix', () => {
    expect(classifyGoalBlockerRef('  plan:  my-plan-2026  ')).toEqual({
      kind: PLAN_DEP_KIND,
      ref: 'my-plan-2026',
    });
  });

  it('THE TRAP: a bare plan slug (no prefix) classifies as a GOAL, not a plan', () => {
    // This is why D-004 mandates the prefix: a plan slug is shape-indistinguishable
    // from a goal id (`slug-hex6`), so the `else ⇒ goal` fallback swallows it. The
    // writer then refuses it (no goal row resolves) instead of minting an inert edge.
    expect(classifyGoalBlockerRef('work-on-everything-goal-2026-08-23').kind).toBe(GOAL_DEP_KIND);
    // ...including one that genuinely looks like a goal id.
    expect(classifyGoalBlockerRef('some-plan-a1b2c3').kind).toBe(GOAL_DEP_KIND);
  });

  it('a bare `plan:` with no slug is NOT a plan ref (the regex requires a remainder)', () => {
    expect(classifyGoalBlockerRef('plan:').kind).toBe(GOAL_DEP_KIND);
  });
});

describe('parsePlanRef (D-004 qualifier split)', () => {
  it('a bare slug has no harness qualifier — it matches any harness in the workspace', () => {
    expect(parsePlanRef('my-plan-2026')).toEqual({
      ref: 'my-plan-2026',
      harness: null,
      slug: 'my-plan-2026',
    });
  });

  it('splits on the FIRST slash so a slug may not be silently truncated', () => {
    expect(parsePlanRef('papercusp/my-plan-2026')).toEqual({
      ref: 'papercusp/my-plan-2026',
      harness: 'papercusp',
      slug: 'my-plan-2026',
    });
  });
});

describe('goalBlockerVerdict: plan policy (D-004)', () => {
  it('shipped SATISFIES', () => {
    expect(goalBlockerVerdict(PLAN_DEP_KIND, 'shipped')).toBe('satisfied');
  });

  it('superseded INVALIDATES — it never silently unblocks', () => {
    // The whole point: a superseded plan will never ship (its substance moved to
    // the successor), so treating it as satisfied would open a gate on a premise
    // that no longer exists. Same rule as a killed goal blocker.
    expect(goalBlockerVerdict(PLAN_DEP_KIND, 'superseded')).toBe('invalidating');
  });

  it('draft / ready / active pend', () => {
    for (const s of ['draft', 'ready', 'active']) {
      expect(goalBlockerVerdict(PLAN_DEP_KIND, s)).toBe('pending');
    }
  });

  it('an absent plan row is satisfied — absent never deadlocks', () => {
    expect(goalBlockerVerdict(PLAN_DEP_KIND, null)).toBe('satisfied');
  });

  it('an UNKNOWN plan status pends rather than defaulting to satisfied', () => {
    expect(goalBlockerVerdict(PLAN_DEP_KIND, 'some-future-status')).toBe('pending');
  });
});

describe('PLAN status partition invariant (mirrors the goal partition in _core)', () => {
  it('satisfying and invalidating are DISJOINT', () => {
    for (const s of PLAN_SATISFYING_STATUSES) {
      expect(PLAN_INVALIDATING_STATUSES.has(s)).toBe(false);
    }
  });

  it('together they exhaust the terminal set — a new terminal status cannot slip through unclassified', () => {
    const union = new Set([...PLAN_SATISFYING_STATUSES, ...PLAN_INVALIDATING_STATUSES]);
    expect([...union].sort()).toEqual([...PLAN_TERMINAL_STATUSES].sort());
  });
});

describe('planStatusSeverity (the D-004 worst-verdict fold ordering)', () => {
  it('ranks invalidating above pending above satisfied', () => {
    expect(planStatusSeverity('superseded')).toBeGreaterThan(planStatusSeverity('active'));
    expect(planStatusSeverity('active')).toBeGreaterThan(planStatusSeverity('shipped'));
  });

  it('so a bare slug matching a shipped AND a superseded plan folds to superseded', () => {
    // The ambiguity case: harness_plans' PK allows one slug in several harnesses.
    // Picking arbitrarily could open a gate because an UNRELATED harness shipped a
    // same-named plan; the worst-verdict fold makes that impossible.
    const matches = ['shipped', 'superseded'];
    const worst = matches.reduce((a, b) => (planStatusSeverity(b) > planStatusSeverity(a) ? b : a));
    expect(worst).toBe('superseded');
    expect(goalBlockerVerdict(PLAN_DEP_KIND, worst)).toBe('invalidating');
  });

  it('and a shipped + active pair folds to active (pending), never to shipped', () => {
    const matches = ['shipped', 'active'];
    const worst = matches.reduce((a, b) => (planStatusSeverity(b) > planStatusSeverity(a) ? b : a));
    expect(worst).toBe('active');
    expect(goalBlockerVerdict(PLAN_DEP_KIND, worst)).toBe('pending');
  });
});

describe('goalReadiness with plan blockers', () => {
  const plan = (ref: string, status: string | null) => ({
    kind: PLAN_DEP_KIND as typeof PLAN_DEP_KIND,
    ref,
    status,
  });

  it('a shipped plan blocker makes the goal actionable', () => {
    const r = goalReadiness([plan('p1', 'shipped')]);
    expect(r.actionable).toBe(true);
    expect(r.premiseInvalidated).toBe(false);
  });

  it('an unshipped plan blocker holds the goal', () => {
    const r = goalReadiness([plan('p1', 'active')]);
    expect(r.actionable).toBe(false);
    expect(r.premiseInvalidated).toBe(false);
  });

  it('a superseded plan blocker flags premiseInvalidated for review', () => {
    const r = goalReadiness([plan('p1', 'superseded')]);
    expect(r.actionable).toBe(false);
    expect(r.premiseInvalidated).toBe(true);
  });

  it('mixes with goal and issue blockers in one fold', () => {
    const r = goalReadiness([
      { kind: GOAL_DEP_KIND, ref: 'g-aaaaaa', status: 'achieved' },
      { kind: ISSUE_DEP_KIND, ref: 'WI-1', status: 'done' },
      plan('p1', 'shipped'),
    ]);
    expect(r.actionable).toBe(true);
    expect(r.blockers.map((b) => b.verdict)).toEqual(['satisfied', 'satisfied', 'satisfied']);
  });
});

describe('goalToGoalGraph excludes plan blockers (no phantom cycle nodes)', () => {
  it('a plan blocker never enters the acyclicity graph', () => {
    const edges = new Map<string, GoalBlockerEndpoint[]>([
      [
        'g-aaaaaa',
        [
          { kind: GOAL_DEP_KIND, ref: 'g-bbbbbb' },
          { kind: PLAN_DEP_KIND, ref: 'some-plan-2026' },
          { kind: ISSUE_DEP_KIND, ref: 'WI-9' },
        ],
      ],
    ]);
    expect(goalToGoalGraph(edges).get('g-aaaaaa')).toEqual(['g-bbbbbb']);
  });

  it('so a plan sharing a name with a goal cannot fabricate a cycle', () => {
    // `g-aaaaaa` blocked by a PLAN literally named `g-aaaaaa` is not a self-cycle:
    // different families, different namespaces.
    const edges = new Map<string, GoalBlockerEndpoint[]>([
      ['g-aaaaaa', [{ kind: PLAN_DEP_KIND, ref: 'g-aaaaaa' }]],
    ]);
    expect(goalBlockedByWouldCycle(edges, 'g-aaaaaa', [])).toBe(false);
  });
});
