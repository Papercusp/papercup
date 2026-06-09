/**
 * triage-core tests — the persistence edge of Queen-turn triage
 * (learning-system-audit-improvements-2026-06-09 P-010/P-011).
 */

import { describe, it, expect, vi } from 'vitest';
import { applyTriageDecision, selectUntriaged, type TriageCoreDeps } from './triage-core';
import type { EngineerIssue } from '../../issues-engineer';
import type { ScoredItem } from './digest';

function issueOf(p: Partial<EngineerIssue> & { id: string }): EngineerIssue {
  return {
    id: p.id,
    title: p.title ?? 'memory:search errors out on long queries',
    scope: p.scope ?? 'operator',
    state: p.state ?? 'open',
    severity: p.severity ?? 'major',
    kind: p.kind ?? 'bug',
    payload: p.payload,
  } as EngineerIssue;
}

function depsOf(issue: EngineerIssue | null): TriageCoreDeps & {
  merged: Record<string, unknown>[];
  states: string[];
  comments: string[];
} {
  const merged: Record<string, unknown>[] = [];
  const states: string[] = [];
  const comments: string[] = [];
  return {
    merged,
    states,
    comments,
    getIssue: vi.fn(async () => issue),
    setIssueState: vi.fn(async (_id, state) => {
      states.push(state);
      return issue;
    }),
    commentIssue: vi.fn(async (_id, body) => {
      comments.push(body);
      return null;
    }),
    mergeIssuePayload: vi.fn(async (_id, patch) => {
      merged.push(patch);
      return issue;
    }),
  };
}

describe('applyTriageDecision — the decision PERSISTS (the G1 fix)', () => {
  it('writes payload.ideaLifecycle with the decision + reason + ideaType', async () => {
    const deps = depsOf(issueOf({ id: 'i1', scope: 'operator' }));
    const res = await applyTriageDecision({ id: 'i1', decision: 'gate', reason: 'touches the release gate' }, deps);
    expect(res.ok).toBe(true);
    expect(deps.merged).toHaveLength(1);
    const lc = deps.merged[0].ideaLifecycle as Record<string, unknown>;
    expect(lc.state).toBe('triaged');
    expect(lc.triageDecision).toBe('gate');
    expect(lc.triageReason).toBe('touches the release gate');
    expect(lc.ideaType).toBe('process'); // operator scope → process class
    expect(res.closed).toBe(false);
  });

  it('reject CLOSES the issue and records decidedReason (queue-as-memory recall)', async () => {
    const deps = depsOf(issueOf({ id: 'i2' }));
    const res = await applyTriageDecision({ id: 'i2', decision: 'reject', reason: 'duplicate of EI-12' }, deps);
    expect(res.ok).toBe(true);
    expect(res.closed).toBe(true);
    expect(deps.states).toEqual(['closed']);
    expect(deps.merged[0].decidedReason).toBe('duplicate of EI-12');
  });

  it('re-triage is allowed (triaged → triaged: the Queen revises a scheduled-pass decision)', async () => {
    const deps = depsOf(
      issueOf({
        id: 'i3',
        payload: {
          ideaLifecycle: {
            state: 'triaged',
            stateUpdatedAt: '2026-06-01T00:00:00Z',
            triageDecision: 'gate',
          },
        },
      }),
    );
    const res = await applyTriageDecision({ id: 'i3', decision: 'gym', reason: 'verify by A/B first', by: 'Queen' }, deps);
    expect(res.ok).toBe(true);
    expect((deps.merged[0].ideaLifecycle as Record<string, unknown>).triageDecision).toBe('gym');
  });

  it('refuses to triage from a terminal lifecycle state (applied)', async () => {
    const deps = depsOf(
      issueOf({
        id: 'i4',
        payload: { ideaLifecycle: { state: 'applied', stateUpdatedAt: '2026-06-01T00:00:00Z' } },
      }),
    );
    const res = await applyTriageDecision({ id: 'i4', decision: 'place', reason: 'x' }, deps);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('applied');
    expect(deps.merged).toHaveLength(0);
  });

  it('refuses non-open issues and unknown ids', async () => {
    const resolvedDeps = depsOf(issueOf({ id: 'i5', state: 'resolved' }));
    expect((await applyTriageDecision({ id: 'i5', decision: 'place', reason: 'x' }, resolvedDeps)).ok).toBe(false);
    const missingDeps = depsOf(null);
    expect((await applyTriageDecision({ id: 'nope', decision: 'place', reason: 'x' }, missingDeps)).ok).toBe(false);
  });

  it('legacy item without a lifecycle initializes at open and triages cleanly', async () => {
    const deps = depsOf(issueOf({ id: 'i6', payload: { paths: ['lib/x.ts'] } }));
    const res = await applyTriageDecision({ id: 'i6', decision: 'place', reason: 'product fix' }, deps);
    expect(res.ok).toBe(true);
    expect(res.lifecycle?.state).toBe('triaged');
  });

  it('comment is written by default and suppressed for the batch pass (comment:false)', async () => {
    const a = depsOf(issueOf({ id: 'i7' }));
    await applyTriageDecision({ id: 'i7', decision: 'gate', reason: 'r' }, a);
    expect(a.comments).toHaveLength(1);
    const b = depsOf(issueOf({ id: 'i8' }));
    await applyTriageDecision({ id: 'i8', decision: 'gate', reason: 'r', comment: false }, b);
    expect(b.comments).toHaveLength(0);
  });
});

describe('selectUntriaged — the scheduled pass picker (P-011)', () => {
  const scored = (p: Partial<ScoredItem> & { id: string }): ScoredItem =>
    ({
      kind: 'bug',
      title: 't',
      scope: 'operator',
      tier: 'human',
      score: 10,
      ageDays: 1,
      tierReason: '',
      ...p,
    }) as ScoredItem;

  it('picks no-lifecycle (legacy), open, and recurred items; skips triaged/applied', () => {
    const picked = selectUntriaged(
      [
        scored({ id: 'legacy' }),
        scored({ id: 'open', ideaLifecycleState: 'open' }),
        scored({ id: 'recurred', ideaLifecycleState: 'recurred' }),
        scored({ id: 'triaged', ideaLifecycleState: 'triaged' }),
        scored({ id: 'applied', ideaLifecycleState: 'applied' }),
      ],
      10,
    );
    expect(picked.map((i) => i.id).sort()).toEqual(['legacy', 'open', 'recurred']);
  });

  it('caps at max, highest score first; max=0 picks nothing', () => {
    const items = [scored({ id: 'a', score: 5 }), scored({ id: 'b', score: 50 }), scored({ id: 'c', score: 20 })];
    expect(selectUntriaged(items, 2).map((i) => i.id)).toEqual(['b', 'c']);
    expect(selectUntriaged(items, 0)).toEqual([]);
  });
});
