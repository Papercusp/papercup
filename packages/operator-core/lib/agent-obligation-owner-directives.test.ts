/**
 * agent-obligation-owner-directives.test.ts — P-006 of plan
 * `turn-start-memory-two-class-2026-09-21`.
 *
 * WHAT THIS EXISTS TO CATCH. WI-10002186 measured the `orders:record`
 * instruction reaching 0 of 334 live su renders: owner-directive capture was
 * dead and nothing failed. The repair is to make an undispositioned directive a
 * first-class OBLIGATION rather than a line in a block — so it is evaluated,
 * ranked and re-injected until dispositioned, on the same rail as every other
 * standing duty.
 *
 * The properties asserted below are the ones whose silent loss would recreate
 * that hole: one row per directive (never an aggregate count), the row's own
 * disposition VERB, the `orders:get` recovery pointer, a VERBATIM excerpt, a
 * stable id across turns, provenance that never upgrades an agent's claim into
 * owner authority, and — most important — a failed read that becomes an
 * explicit `unknown` instead of an empty queue.
 */
import { describe, expect, it, vi } from 'vitest';
import { agentObligationIsActionable, evaluateAgentObligations } from './agent-obligations';
import {
  ownerDirectiveObligations,
  OWNER_DIRECTIVE_OBLIGATION_REVISION,
  type OwnerDirectiveObligationRow,
  type OwnerDirectivesProviderInput,
} from './agent-obligation-providers';
import { readAgentObligationAgenda, type AgentObligationReaderDeps } from './agent-obligation-reader';
import { ownerDirectiveExcerpt, OWNER_DIRECTIVE_WHOLE_MAX } from './owner-directives';

const OBSERVED_AT = '2026-09-21T16:00:00.000Z';

const PENDING_ROW: OwnerDirectiveObligationRow = {
  id: 17,
  state: 'pending',
  excerpt: 'Implement owner-directive capture as HYBRID',
  recordedAt: '2026-09-21T15:27:44.000Z',
  recordedBy: 'su-c03852cb',
  capturedByHook: true,
};

const OPEN_ROW: OwnerDirectiveObligationRow = {
  id: 18,
  state: 'open',
  excerpt: 'carry this plan to shipped status yourself now',
  recordedAt: '2026-09-21T15:27:44.000Z',
  recordedBy: 'su-c03852cb',
  capturedByHook: false,
};

function input(read: OwnerDirectivesProviderInput['read']): OwnerDirectivesProviderInput {
  return {
    workspaceId: 'papercusp-workspace',
    ownerId: 'su-test',
    observedAt: OBSERVED_AT,
    sourceGeneration: 'gen-1',
    read,
  };
}

function known(rows: OwnerDirectiveObligationRow[]): OwnerDirectivesProviderInput {
  return input({ status: 'known', value: rows });
}

describe('ownerDirectiveObligations', () => {
  it('emits ONE obligation per directive, not one aggregate count', () => {
    const obligations = ownerDirectiveObligations(known([PENDING_ROW, OPEN_ROW]));
    expect(obligations).toHaveLength(2);
    expect(new Set(obligations.map((entry) => entry.id)).size).toBe(2);
    // An aggregate could be acknowledged without acting on any single row.
    expect(obligations.map((entry) => entry.applicableDemand)).toEqual([1, 1]);
  });

  it('routes a pending row to orders:resolve-pending and an open row to orders:disposition', () => {
    const [pending, open] = ownerDirectiveObligations(known([PENDING_ROW, OPEN_ROW]));
    expect(pending!.action?.tool).toBe('orders:resolve-pending');
    expect(open!.action?.tool).toBe('orders:disposition');
    expect(pending!.action?.summary).toMatch(/promote or dismiss/i);
    expect(open!.action?.summary).toMatch(/orders:disposition/);
  });

  it('carries the orders:get recovery pointer for every row', () => {
    const obligations = ownerDirectiveObligations(known([PENDING_ROW, OPEN_ROW]));
    expect(obligations.map((entry) => entry.action?.targetRef)).toEqual(['orders:get #17', 'orders:get #18']);
  });

  it('carries the VERBATIM excerpt, never a paraphrase', () => {
    const [pending] = ownerDirectiveObligations(known([PENDING_ROW]));
    expect(pending!.reason).toContain(PENDING_ROW.excerpt);
  });

  it('stays actionable so it re-injects until dispositioned', () => {
    const obligations = ownerDirectiveObligations(known([PENDING_ROW, OPEN_ROW]));
    expect(obligations.every((entry) => entry.status === 'due')).toBe(true);
    expect(obligations.every(agentObligationIsActionable)).toBe(true);
    const agenda = evaluateAgentObligations(obligations, OBSERVED_AT);
    expect(agenda.primary).toHaveLength(2);
  });

  it('keeps a STABLE id for the same undispositioned row across turns', () => {
    // A churning id would read as a brand-new obligation on every warm turn and
    // defeat the unchanged-agenda dedup the reader depends on.
    const first = ownerDirectiveObligations(known([PENDING_ROW]));
    const later = ownerDirectiveObligations({
      ...known([PENDING_ROW]),
      observedAt: '2026-09-21T18:00:00.000Z',
    });
    expect(later[0]!.id).toBe(first[0]!.id);
    expect(later[0]!.ageMs).toBeGreaterThan(first[0]!.ageMs!);
  });

  it('changes the id when the SAME row is promoted from pending to open', () => {
    // Promotion changes which verb clears it, so it must not be dedup-equal to
    // the pending row it replaces.
    const [pending] = ownerDirectiveObligations(known([PENDING_ROW]));
    const [promoted] = ownerDirectiveObligations(known([{ ...PENDING_ROW, state: 'open' }]));
    expect(promoted!.id).not.toBe(pending!.id);
  });

  it('never upgrades an agent-recorded claim into verified owner authority', () => {
    const [hookCaptured] = ownerDirectiveObligations(known([PENDING_ROW]));
    const [agentRecorded] = ownerDirectiveObligations(known([OPEN_ROW]));
    expect(hookCaptured!.authority).toMatchObject({ kind: 'owner', turnOrigin: 'owner-typed' });
    // orders:record is an AGENT asserting the owner said it — real evidence,
    // not proof. Representing it as `owner` is how a note-to-self becomes an
    // owner directive.
    expect(agentRecorded!.authority).toMatchObject({ kind: 'owner-candidate', turnOrigin: 'unknown' });
  });

  it('sorts ahead of policy-sourced duties (an owner directive outranks the loop agenda)', () => {
    const [pending] = ownerDirectiveObligations(known([PENDING_ROW]));
    expect(pending!.causalRank).toBe(0);
    expect(pending!.priority).toBe('critical');
  });

  it('reports an empty queue as not-applicable, which never reaches the prompt', () => {
    const obligations = ownerDirectiveObligations(known([]));
    expect(obligations).toHaveLength(1);
    expect(obligations[0]!.status).toBe('not-applicable');
    expect(evaluateAgentObligations(obligations, OBSERVED_AT).primary).toEqual([]);
  });

  it('reports a FAILED read as unknown with a concrete retry, not as an empty queue', () => {
    // The whole point: "no directives" and "I could not read the directives"
    // must never render identically.
    const obligations = ownerDirectiveObligations(
      input({
        status: 'unknown',
        failure: {
          code: 'canonical-owner-directive-read-failed',
          detail: 'owner directives timed out after 900ms',
          retry: 'retry listOwnerDirectives for the pending and open states',
        },
      }),
    );
    expect(obligations).toHaveLength(1);
    expect(obligations[0]!.status).toBe('unknown');
    expect(obligations[0]!.measurementFailure?.retry).toMatch(/listOwnerDirectives/);
    expect(obligations[0]!.ruleRevision).toBe(OWNER_DIRECTIVE_OBLIGATION_REVISION);
  });
});

describe('ownerDirectiveExcerpt', () => {
  it('returns a short directive whole', () => {
    expect(ownerDirectiveExcerpt('  do the thing  ')).toBe('do the thing');
  });

  it('truncates a long directive to a strictly shorter excerpt', () => {
    const long = 'x'.repeat(OWNER_DIRECTIVE_WHOLE_MAX + 50);
    const excerpt = ownerDirectiveExcerpt(long);
    expect(excerpt.length).toBeLessThan(long.length);
    expect(excerpt.endsWith('…')).toBe(true);
    // substr, never summarization: the kept prefix is byte-identical.
    expect(long.startsWith(excerpt.slice(0, -1))).toBe(true);
  });
});

function readerDeps(
  ownerDirectives: AgentObligationReaderDeps['ownerDirectives'],
): Partial<AgentObligationReaderDeps> {
  return {
    ownerDirectives,
    goalSubject: async () => null,
    planSlugs: async () => [],
  };
}

describe('readAgentObligationAgenda owner-directive wiring', () => {
  it('emits the class for a session with NO goal and NO plan', async () => {
    // Gating this on an active goal would recreate the measured hole for every
    // session that holds neither.
    const read = await readAgentObligationAgenda({
      workspaceId: 'papercusp-workspace',
      ownerId: 'su-test',
      goalId: null,
      planSlugs: [],
      deps: readerDeps(async () => [PENDING_ROW]),
    });
    const directive = read.agenda.evaluations.find((entry) => entry.family === 'owner-directive');
    expect(directive, 'the owner-directive class must reach the agenda without a goal').toBeDefined();
    expect(directive!.status).toBe('due');
    expect(read.agenda.primary[0]!.family).toBe('owner-directive');
  });

  it('degrades a throwing read to unknown rather than dropping the class', async () => {
    // The degrade is deliberately LOUD: bounded-timeout warns on the way past.
    // Asserting the warning rather than silencing it keeps the operator-visible
    // half of this behaviour measured too.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const read = await readAgentObligationAgenda({
        workspaceId: 'papercusp-workspace',
        ownerId: 'su-test',
        goalId: null,
        planSlugs: [],
        deps: readerDeps(async () => {
          throw new Error('directive store unreachable');
        }),
      });
      const directive = read.agenda.evaluations.find((entry) => entry.family === 'owner-directive');
      expect(directive?.status).toBe('unknown');
      expect(directive?.measurementFailure?.code).toBe('canonical-owner-directive-read-failed');
      expect(read.degradedSources.join(' ')).toMatch(/owner directives/);
      expect(warn.mock.calls.flat().join(' ')).toMatch(/agent-obligations:owner-directives failed/);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps an unchanged queue at an unchanged sourceGeneration across turns', async () => {
    const dep = vi.fn(async () => [PENDING_ROW]);
    const args = {
      workspaceId: 'papercusp-workspace',
      ownerId: 'su-test',
      goalId: null,
      planSlugs: [],
      deps: readerDeps(dep),
    } as const;
    const first = await readAgentObligationAgenda({ ...args, now: new Date('2026-09-21T16:00:00.000Z') });
    const second = await readAgentObligationAgenda({ ...args, now: new Date('2026-09-21T17:00:00.000Z') });
    const generationOf = (agenda: typeof first.agenda) =>
      agenda.evaluations.find((entry) => entry.family === 'owner-directive')!.sourceGeneration;
    expect(generationOf(second.agenda)).toBe(generationOf(first.agenda));
    expect(dep).toHaveBeenCalledTimes(2);
  });
});
