/**
 * recurrence-escalation tests
 * (learning-system-audit-improvements-2026-06-09 P-053 + P-052 lite).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  planRecurrenceEscalation,
  runRecurrenceEscalation,
  type EscalationDeps,
} from './recurrence-escalation';
import type { ImprovementCandidate } from './policy';

const daysAgo = (d: number): string => new Date(Date.now() - d * 86400000).toISOString();

function cand(p: Partial<ImprovementCandidate> & { id: string }): ImprovementCandidate {
  return {
    kind: 'bug',
    scope: 'operator',
    title: 'memory search keeps timing out badly',
    state: 'open',
    severity: 'minor',
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    ...p,
  };
}

/** Three same-signature members (the ≥3 threshold). */
const trio = (over: Partial<ImprovementCandidate> = {}) => [
  cand({ id: 'a', createdAt: daysAgo(5), state: 'resolved', ...over }),
  cand({ id: 'b', createdAt: daysAgo(3), ...over }),
  cand({ id: 'c', createdAt: daysAgo(1), ...over }),
];

describe('planRecurrenceEscalation', () => {
  it('≥3 recurrence: escalates the newest open minor to major AND routes process-class to gym', () => {
    const actions = planRecurrenceEscalation(trio());
    const esc = actions.find((a) => a.kind === 'escalate-severity');
    const gym = actions.find((a) => a.kind === 'route-gym');
    expect(esc).toMatchObject({ id: 'c', from: 'minor', to: 'major', count: 3 });
    expect(gym).toMatchObject({ id: 'c' }); // operator scope → process class
  });

  it('below threshold, already-major, claimed, or already-gym-routed → no duplicate pressure', () => {
    const below = planRecurrenceEscalation([cand({ id: 'x' }), cand({ id: 'y', createdAt: daysAgo(2) })]);
    expect(below).toHaveLength(0);

    const major = planRecurrenceEscalation(trio({ severity: 'major' }));
    expect(major.find((a) => a.kind === 'escalate-severity')).toBeUndefined();

    const claimed = planRecurrenceEscalation(trio({ assignee: 'runner' }));
    expect(claimed.filter((a) => a.kind !== 'suggest-promotion')).toHaveLength(0);

    const routed = planRecurrenceEscalation(
      trio({
        ideaLifecycle: { state: 'triaged', stateUpdatedAt: daysAgo(1), triageDecision: 'gym' },
      }),
    );
    expect(routed.find((a) => a.kind === 'route-gym')).toBeUndefined();
  });

  it('product-class (harness:*) recurrence escalates severity but does NOT route to gym', () => {
    const actions = planRecurrenceEscalation(trio({ scope: 'harness:sheets' }));
    expect(actions.find((a) => a.kind === 'escalate-severity')).toBeDefined();
    expect(actions.find((a) => a.kind === 'route-gym')).toBeUndefined();
  });

  it('cross-scope recurrence proposes ONE shared-lesson promotion (P-052 lite)', () => {
    const actions = planRecurrenceEscalation([
      cand({ id: 'op', scope: 'operator', createdAt: daysAgo(4) }),
      cand({ id: 'h1', scope: 'harness:sheets', createdAt: daysAgo(3) }),
      cand({ id: 'h2', scope: 'harness:papercup', createdAt: daysAgo(2) }),
    ]);
    const promos = actions.filter((a) => a.kind === 'suggest-promotion');
    expect(promos).toHaveLength(1);
    expect(promos[0]).toMatchObject({ count: 3 });
    expect(promos[0].kind === 'suggest-promotion' && promos[0].scopes.length).toBe(3);
  });

  it('respects maxActions', () => {
    const many = Array.from({ length: 4 }, (_, g) =>
      [0, 1, 2].map((i) =>
        cand({
          id: `g${g}-${i}`,
          title: `distinct recurring friction group number ${g} token${g}`,
          createdAt: daysAgo(3 - i),
        }),
      ),
    ).flat();
    expect(planRecurrenceEscalation(many, { maxActions: 3 })).toHaveLength(3);
  });
});

describe('runRecurrenceEscalation — glue', () => {
  it('applies each action through the right edge', async () => {
    const updated: string[] = [];
    const triaged: string[] = [];
    const captured: string[] = [];
    const deps: EscalationDeps = {
      readItems: vi.fn(async () => [
        ...trio(),
        cand({ id: 'x1', title: 'cross scope pain everywhere always', scope: 'operator', createdAt: daysAgo(4) }),
        cand({ id: 'x2', title: 'cross scope pain everywhere always', scope: 'harness:sheets', createdAt: daysAgo(3) }),
        cand({ id: 'x3', title: 'cross scope pain everywhere always', scope: 'harness:papercup', createdAt: daysAgo(2) }),
      ]),
      updateIssue: vi.fn(async (id) => {
        updated.push(id);
        return null;
      }),
      commentIssue: vi.fn(async () => null),
      applyTriage: vi.fn(async (input) => {
        triaged.push(input.id);
        return { ok: true, id: input.id };
      }),
      capture: vi.fn(async (input) => {
        captured.push(input.title);
        return { ok: true as const, created: true, possibleDuplicates: [] };
      }),
    };
    const res = await runRecurrenceEscalation({}, deps);
    expect(res.escalated).toBe(2); // both signature groups have a minor newest-open
    expect(res.gymRouted).toBe(2); // both newest-open are process-class (operator/harness mix → newest per sig)
    expect(res.promotionsSuggested).toBe(1);
    expect(captured[0]).toContain('promote a shared lesson');
  });
});
