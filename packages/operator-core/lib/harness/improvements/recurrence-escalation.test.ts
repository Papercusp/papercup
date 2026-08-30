/**
 * recurrence-escalation tests
 * (learning-system-audit-improvements-2026-06-09 P-053 + P-052 lite).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CANDIDATE_DRAFT_MAX_CHARS,
  RECURRING_SIGNATURE_SCAN_CAP,
  RECURRING_MEMBER_HYDRATION_CAP,
  planRecurrenceEscalation,
  runRecurrenceEscalation,
  type EscalationDeps,
} from './recurrence-escalation';
import type { StageCandidateInput } from '../../knowledge-packs/candidates';
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
    readItems: vi.fn<EscalationDeps['readItems']>(async () => glueItems()),
    // Mirrors projectImprovementItemsForBoundedRead: the phase-1 census runs the
    // caller's projector over the whole corpus. The double reads from `over.readItems`
    // when supplied so a test that stubs the corpus still drives both phases.
    scanCorpus: vi.fn<EscalationDeps['scanCorpus']>(async (_opts, projection) =>
      projection.project(await (over.readItems ?? (async () => glueItems()))()),
    ),
    updateIssue: vi.fn(async () => null),
    commentIssue: vi.fn(async () => null),
    applyTriage: vi.fn(async (input) => ({ ok: true, id: input.id })),
    capture: vi.fn(async () => ({ ok: true as const, created: true, possibleDuplicates: [] })),
    stageCandidate: vi.fn(async () => ({ staged: true as const, id: 'cand-1' })),
    ...over,
  });

  it('WI-1216687: censuses the WHOLE corpus on cheap columns — never a per-scope newest-N window', async () => {
    const scanCorpus = vi.fn<EscalationDeps['scanCorpus']>(async () => []);
    await runRecurrenceEscalation({}, baseDeps({ scanCorpus }));

    // The old read was `{ windowPerScope: true }` with no `limit`, which read-items
    // defaults to 500 PER SCOPE — measured at just 14.1h of history for the scope
    // holding 96.9% of the corpus. WI-9454's per-scope fairness concern is subsumed:
    // there is no window left for a busy scope to crowd a small one out of.
    const [opts, projection] = scanCorpus.mock.calls[0]!;
    expect(opts).toEqual({ includeBody: false, includePayload: false });
    expect(opts).not.toHaveProperty('windowPerScope');
    expect(opts).not.toHaveProperty('limit');
    expect(projection.maxRows).toBe(RECURRING_SIGNATURE_SCAN_CAP);
  });

  it('WI-1216687: hydrates phase 2 by explicit member ids, so counting is a SET read and not a recency window', async () => {
    const readItems = vi.fn<EscalationDeps['readItems']>(async () => glueItems());
    await runRecurrenceEscalation({}, baseDeps({ readItems }));

    // Both glue groups clear the threshold, so every member id is hydrated by id.
    const call = readItems.mock.calls.find((c) => c[0]?.issueIds);
    expect(call, 'phase 2 must re-read by issueIds').toBeTruthy();
    expect([...(call![0]!.issueIds ?? [])].sort()).toEqual(['a', 'b', 'c', 'x1', 'x2', 'x3']);
    // The limit must not silently re-cap the very read that exists to be exact.
    expect(call![0]!.limit).toBe(6);
  });

  it('WI-1216687: a group larger than the hydration budget is skipped WHOLE, never truncated', async () => {
    // A truncated group would under-report `sig.count` — the number that both clears
    // the ≥3 threshold and is quoted to the owner as "recurred N×".
    const huge = Array.from({ length: RECURRING_MEMBER_HYDRATION_CAP + 1 }, (_, i) =>
      cand({ id: `h${i}`, title: 'huge recurring signature group here' }),
    );
    const readItems = vi.fn<EscalationDeps['readItems']>(async () => huge);
    await runRecurrenceEscalation({}, baseDeps({ readItems }));

    const hydration = readItems.mock.calls.find((c) => c[0]?.issueIds);
    expect(hydration, 'an over-budget group must not be hydrated at all').toBeFalsy();
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
    });
    expect([...stagedInputs[0]!.sourceItemIds].sort()).toEqual(['x1', 'x2', 'x3']);
    expect(stagedInputs[0]!.scopes.sort()).toEqual(['harness:papercup', 'harness:sheets', 'operator']);
    expect(stagedInputs[0]!.signature).toBeTruthy();
  });

  it('EI-9170: the suggest-promotion capture must NOT use dedupScope:"open" — a resolved prior promotion has to keep blocking re-file, or the same proposal re-files every tick forever', async () => {
    const captureInputs: Array<{ dedupScope?: 'all' | 'open' }> = [];
    const deps = baseDeps({
      capture: vi.fn(async (input) => {
        captureInputs.push({ dedupScope: input.dedupScope });
        return { ok: true as const, created: true, possibleDuplicates: [] };
      }),
    });
    await runRecurrenceEscalation({}, deps);
    expect(captureInputs).toHaveLength(1);
    // Resolving this capture means the lesson was promoted, not that the friction
    // stopped recurring — a resolved duplicate must still decline the re-create.
    // dedupScope:'open' is the watchdog regression-reopen semantic and is wrong here.
    expect(captureInputs[0]!.dedupScope).not.toBe('open');
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
