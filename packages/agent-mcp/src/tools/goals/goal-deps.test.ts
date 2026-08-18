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
  blockerStatusKey,
  classifyGoalBlockerRef,
  goalBlockedByWouldCycle,
  goalBlockerVerdict,
  goalReadiness,
  goalToGoalGraph,
  type GoalBlockerEndpoint,
} from './goal-deps';

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
  });
});
