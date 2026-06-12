/**
 * decay tests — the recurrence-decay verification sweep
 * (learning-system-audit-improvements-2026-06-09 P-013; self-learning P-030/D-003).
 */

import { describe, it, expect, vi } from 'vitest';
import { planDecaySweep, runDecaySweep, type DecaySweepDeps } from './decay';
import type { ImprovementCandidate } from './policy';
import type { IdeaLifecyclePayload } from './lifecycle';

const NOW = Date.parse('2026-06-09T12:00:00Z');
const daysAgo = (d: number): string => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();

function cand(p: Partial<ImprovementCandidate> & { id: string }): ImprovementCandidate {
  return {
    kind: 'bug',
    scope: 'operator',
    title: 'memory search errors on long queries',
    state: 'open',
    createdAt: daysAgo(30),
    updatedAt: daysAgo(30),
    ...p,
  };
}

const applied = (over: Partial<IdeaLifecyclePayload> = {}): IdeaLifecyclePayload => ({
  state: 'applied',
  stateUpdatedAt: daysAgo(20),
  ideaType: 'product',
  ...over,
});

describe('planDecaySweep — pure grading of resolved+applied items', () => {
  it('verifies a product item quiet ≥14 days post-resolution', () => {
    const actions = planDecaySweep(
      [cand({ id: 'a', state: 'resolved', updatedAt: daysAgo(20), ideaLifecycle: applied() })],
      { nowMs: NOW },
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('verified');
    expect(actions[0].lifecycle.state).toBe('verified');
    expect(actions[0].lifecycle.decayResult).toBe('worked');
  });

  it('marks recurred when a same-signature capture POST-DATES the resolution (any class)', () => {
    const actions = planDecaySweep(
      [
        cand({
          id: 'fixed',
          state: 'resolved',
          updatedAt: daysAgo(10),
          ideaLifecycle: applied({ ideaType: 'process-prompt' }),
        }),
        // Same signature (token-set of the title), captured AFTER the fix.
        cand({ id: 'regression', title: 'errors on long queries — memory search', createdAt: daysAgo(2) }),
      ],
      { nowMs: NOW },
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe('fixed');
    expect(actions[0].kind).toBe('recurred');
    expect(actions[0].recurrences).toBe(1);
  });

  it('PRE-resolution duplicates do NOT count as regression', () => {
    const actions = planDecaySweep(
      [
        cand({ id: 'fixed', state: 'resolved', updatedAt: daysAgo(15), ideaLifecycle: applied() }),
        // Same signature but captured BEFORE the resolution — the old dup cluster.
        cand({ id: 'old-dup', title: 'memory search errors on long queries', createdAt: daysAgo(25), state: 'closed' }),
      ],
      { nowMs: NOW },
    );
    // Quiet since resolution + product → verified, NOT recurred. (old-dup itself
    // is closed with no lifecycle → it retro-initializes.)
    const byId = Object.fromEntries(actions.map((a) => [a.id, a.kind]));
    expect(byId['fixed']).toBe('verified');
    expect(byId['old-dup']).toBe('init-applied');
  });

  it('process-prompt class quiet ≥14 days stays silent (no decay-verify for the prompt class — D-003)', () => {
    const actions = planDecaySweep(
      [
        cand({
          id: 'p',
          state: 'resolved',
          updatedAt: daysAgo(20),
          ideaLifecycle: applied({ ideaType: 'process-prompt' }),
        }),
      ],
      { nowMs: NOW },
    );
    expect(actions).toHaveLength(0);
  });

  it('quiet but <14 days → no action yet', () => {
    const actions = planDecaySweep(
      [cand({ id: 'a', state: 'resolved', updatedAt: daysAgo(5), ideaLifecycle: applied({ stateUpdatedAt: daysAgo(5) }) })],
      { nowMs: NOW },
    );
    expect(actions).toHaveLength(0);
  });

  it('legacy resolved item without lifecycle retro-enters as applied, anchored at resolution time', () => {
    const actions = planDecaySweep([cand({ id: 'legacy', state: 'resolved', updatedAt: daysAgo(40) })], {
      nowMs: NOW,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('init-applied');
    expect(actions[0].lifecycle.state).toBe('applied');
    expect(actions[0].lifecycle.stateUpdatedAt).toBe(daysAgo(40));
  });

  it('open items and non-applied lifecycles are never graded; maxActions caps the sweep', () => {
    const items = [
      cand({ id: 'open1' }), // open — skipped
      cand({ id: 'v', state: 'resolved', updatedAt: daysAgo(20), ideaLifecycle: { state: 'verified', stateUpdatedAt: daysAgo(1) } }),
      ...Array.from({ length: 5 }, (_, i) =>
        cand({ id: `legacy${i}`, title: `distinct legacy friction number ${i}`, state: 'closed', updatedAt: daysAgo(30) }),
      ),
    ];
    expect(planDecaySweep(items, { nowMs: NOW }).every((a) => a.id.startsWith('legacy'))).toBe(true);
    expect(planDecaySweep(items, { nowMs: NOW, maxActions: 2 })).toHaveLength(2);
  });
});

describe('runDecaySweep — persistence glue', () => {
  it('merges each action and comments verified/recurred but not init-applied', async () => {
    const merged: string[] = [];
    const comments: string[] = [];
    const deps: DecaySweepDeps = {
      readItems: vi.fn(async () => [
        cand({ id: 'v', state: 'resolved', updatedAt: daysAgo(20), ideaLifecycle: applied() }),
        cand({ id: 'legacy', title: 'an entirely different friction', state: 'closed', updatedAt: daysAgo(30) }),
      ]),
      mergeIssuePayload: vi.fn(async (id) => {
        merged.push(id);
        return null;
      }),
      commentIssue: vi.fn(async (id, body) => {
        comments.push(`${id}:${body.slice(0, 1)}`);
        return null;
      }),
    };
    const res = await runDecaySweep({ nowMs: NOW }, deps);
    expect(res).toEqual({ scanned: 2, verified: 1, recurred: 0, initialized: 1 });
    expect(merged.sort()).toEqual(['legacy', 'v']);
    expect(comments).toEqual(['v:✓']); // init-applied is silent bookkeeping
  });
});
