/**
 * recurrence-escalation tests
 * (learning-system-audit-improvements-2026-06-09 P-053 + P-052 lite).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CANDIDATE_DRAFT_MAX_CHARS,
  planRecurrenceEscalation,
  runRecurrenceEscalation,
  type EscalationDeps,
} from './recurrence-escalation';
import type { StageCandidateInput } from '../../learning-packs/candidates';
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
  it('≥3 recurrence: escalates the newest open minor to major AND routes the prompt class to gym', () => {
    const actions = planRecurrenceEscalation(trio());
    const esc = actions.find((a) => a.kind === 'escalate-severity');
    expect(esc).toMatchObject({ id: 'c', from: 'minor', to: 'major', count: 3 });
    // D-005: a chronic code-bug (operator scope, no prompt markers) gets severity
    // pressure but NOT the gym — the gym A/Bs prompt variants, not code fixes.
    expect(actions.find((a) => a.kind === 'route-gym')).toBeUndefined();

    // The gym route fires for the process-prompt class.
    const promptActions = planRecurrenceEscalation(trio({ title: 'queen persona wording keeps over-instructing' }));
    expect(promptActions.find((a) => a.kind === 'route-gym')).toMatchObject({ id: 'c' });
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
        title: 'queen persona wording keeps over-instructing',
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

  it('suggest-promotion carries candidate provenance: member ids + a capped draft body (P-032)', () => {
    const longBody = 'lesson '.repeat(200); // > CANDIDATE_DRAFT_MAX_CHARS
    const actions = planRecurrenceEscalation([
      cand({ id: 'op', scope: 'operator', createdAt: daysAgo(4) }),
      cand({ id: 'h1', scope: 'harness:sheets', createdAt: daysAgo(3), body: longBody }),
      cand({ id: 'h2', scope: 'harness:papercup', createdAt: daysAgo(2) }),
    ]);
    const promo = actions.find((a) => a.kind === 'suggest-promotion');
    if (promo?.kind !== 'suggest-promotion') throw new Error('expected a suggest-promotion');
    expect([...promo.sourceItemIds].sort()).toEqual(['h1', 'h2', 'op']);
    expect(promo.draftText.length).toBeLessThanOrEqual(CANDIDATE_DRAFT_MAX_CHARS);
    expect(promo.draftText.startsWith('lesson ')).toBe(true); // newest member WITH a body wins

    // No member body anywhere → the title is the draft.
    const bare = planRecurrenceEscalation([
      cand({ id: 'a1', scope: 'operator', createdAt: daysAgo(4) }),
      cand({ id: 'a2', scope: 'harness:sheets', createdAt: daysAgo(3) }),
      cand({ id: 'a3', scope: 'harness:papercup', createdAt: daysAgo(2) }),
    ]).find((a) => a.kind === 'suggest-promotion');
    if (bare?.kind !== 'suggest-promotion') throw new Error('expected a suggest-promotion');
    expect(bare.draftText).toBe(bare.sampleTitle);
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
  const glueItems = () => [
    // Prompt-class trio so the gym edge of the glue stays exercised (D-005:
    // only process-prompt routes to gym).
    ...trio({ title: 'queen persona wording keeps over-instructing' }),
    cand({ id: 'x1', title: 'cross scope pain everywhere always', scope: 'operator', createdAt: daysAgo(4) }),
    cand({ id: 'x2', title: 'cross scope pain everywhere always', scope: 'harness:sheets', createdAt: daysAgo(3) }),
    cand({ id: 'x3', title: 'cross scope pain everywhere always', scope: 'harness:papercup', createdAt: daysAgo(2) }),
  ];

  const baseDeps = (over: Partial<EscalationDeps> = {}): EscalationDeps => ({
    readItems: vi.fn(async () => glueItems()),
    updateIssue: vi.fn(async () => null),
    commentIssue: vi.fn(async () => null),
    applyTriage: vi.fn(async (input) => ({ ok: true, id: input.id })),
    capture: vi.fn(async () => ({ ok: true as const, created: true, possibleDuplicates: [] })),
    stageCandidate: vi.fn(async () => ({ staged: true as const, id: 'cand-1' })),
    ...over,
  });

  it('applies each action through the right edge', async () => {
    const updated: string[] = [];
    const captured: string[] = [];
    const stagedInputs: StageCandidateInput[] = [];
    const deps = baseDeps({
      updateIssue: vi.fn(async (id) => {
        updated.push(id);
        return null;
      }),
      capture: vi.fn(async (input) => {
        captured.push(input.title);
        return { ok: true as const, created: true, possibleDuplicates: [] };
      }),
      stageCandidate: vi.fn(async (input) => {
        stagedInputs.push(input);
        return { staged: true, id: 'cand-1' };
      }),
    });
    const res = await runRecurrenceEscalation({}, deps);
    expect(res.escalated).toBe(2); // both signature groups have a minor newest-open
    expect(res.gymRouted).toBe(1); // only the prompt-class trio routes to gym (the cross-scope group is code-bug, D-005)
    expect(res.promotionsSuggested).toBe(1);
    expect(captured[0]).toContain('promote a shared lesson');

    // P-032: the cross-scope promotion ALSO staged one candidate, with provenance.
    expect(res.candidatesStaged).toBe(1);
    expect(stagedInputs).toHaveLength(1);
    expect(stagedInputs[0]).toMatchObject({
      title: 'cross scope pain everywhere always',
      recurrenceCount: 3,
      sourceItemIds: ['x3', 'x2', 'x1'],
    });
    expect(stagedInputs[0]!.scopes.sort()).toEqual(['harness:papercup', 'harness:sheets', 'operator']);
    expect(stagedInputs[0]!.signature).toBeTruthy();
  });

  it('a deduped/capped stage does not count; a throwing stage never aborts the pass', async () => {
    const dup = await runRecurrenceEscalation(
      {},
      baseDeps({ stageCandidate: vi.fn(async () => ({ staged: false as const, reason: 'duplicate-signature' as const })) }),
    );
    expect(dup.candidatesStaged).toBe(0);
    expect(dup.promotionsSuggested).toBe(1); // the capture leg is independent

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const boom = await runRecurrenceEscalation(
        {},
        baseDeps({
          stageCandidate: vi.fn(async () => {
            throw new Error('pg down');
          }),
        }),
      );
      expect(boom.candidatesStaged).toBe(0);
      expect(boom.escalated).toBe(2); // best-effort: the rest of the pass completed
      expect(warn).toHaveBeenCalledWith(
        '[recurrence-escalation] candidate staging failed:',
        'pg down',
      );
    } finally {
      warn.mockRestore();
    }
  });
});
