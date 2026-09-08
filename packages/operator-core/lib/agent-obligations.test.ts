import { describe, expect, it } from 'vitest';
import {
  AGENT_OBLIGATION_SCHEMA_VERSION,
  agentObligationId,
  agentObligationSourceGeneration,
  authorityFromTurnOrigin,
  defineAgentObligation,
  evaluateAgentObligationBoundary,
  evaluateAgentObligationRecoveryBoundary,
  evaluateAgentObligations,
  goalPlanPlacementChangedKey,
  planAcceptanceChangedKey,
  formatAgentObligationLine,
  projectAgentObligationAgenda,
  type AgentObligationInput,
} from './agent-obligations';

describe('obligation material-change event keys', () => {
  it('keeps producer and provider routes subject-scoped', () => {
    expect(goalPlanPlacementChangedKey('goal-1')).toBe('goal:plan-placement:goal-1');
    expect(planAcceptanceChangedKey('plan-a')).toBe('plan:acceptance:plan-a');
  });
});

const NOW = '2026-09-05T20:00:00.000Z';

function input(overrides: Partial<AgentObligationInput> = {}): AgentObligationInput {
  return {
    ruleId: 'owner-report',
    ruleRevision: 'owner-report-v1',
    family: 'owner-report',
    title: 'Owner report is due',
    scope: { workspaceId: 'ws', ownerId: 'su-a', goalId: 'goal-1' },
    responsibleOwnerId: 'su-a',
    episode: '2026-09-05T19:00:00.000Z',
    status: 'due',
    authority: { kind: 'policy', sourceRef: 'modes/registry.ts#goal', revision: 'goal-v4' },
    reason: 'the standing reporting deadline elapsed',
    priority: 'high',
    causalRank: 1,
    applicableDemand: 1,
    sourceGeneration: 'reports:42',
    evidence: [
      {
        ref: 'goal-owner-report:goal-1',
        observedAt: NOW,
        freshness: 'current',
        note: 'no delivery after the current episode baseline',
      },
    ],
    action: {
      kind: 'report',
      summary: 'send MOVED / COST / OWNER-WALLED / KILLED now',
      tool: 'coord:send',
      continuesCurrentWork: false,
    },
    clearsWhen: {
      id: 'canonical-owner-report-delivery',
      summary: 'a canonical owner-facing report delivery is observed',
      evidenceKind: 'delivery',
      sourceRef: 'goal-owner-report-watchdog',
    },
    changeSignal: { nextDeadlineAt: '2026-09-05T20:00:00.000Z' },
    dueAt: '2026-09-05T20:00:00.000Z',
    ageMs: 60 * 60_000,
    ...overrides,
  };
}

describe('agent obligation contract', () => {
  it('derives a stable source generation independent of object key order', () => {
    expect(agentObligationSourceGeneration({ b: 2, a: 1 })).toBe(agentObligationSourceGeneration({ a: 1, b: 2 }));
    expect(agentObligationSourceGeneration({ a: 2 })).not.toBe(agentObligationSourceGeneration({ a: 1 }));
  });

  it('builds a stable episode id independent of scope key insertion order', () => {
    const a = input();
    const b = input({
      scope: {
        goalId: 'goal-1',
        ownerId: 'su-a',
        workspaceId: 'ws',
      },
    });
    expect(agentObligationId(a)).toBe(agentObligationId(b));
    expect(defineAgentObligation(a).id).toMatch(/^obl:owner-report:[a-f0-9]{20}$/);
  });

  it('requires unknown to preserve its concrete measurement failure', () => {
    expect(() => defineAgentObligation(input({ status: 'unknown' }))).toThrow(/measurementFailure/);
    expect(
      defineAgentObligation(
        input({
          status: 'unknown',
          measurementFailure: {
            code: 'report-read-failed',
            detail: 'report union timed out',
            retry: 'retry the union',
          },
        }),
      ).status,
    ).toBe('unknown');
  });

  it('does not let a declaration satisfy a rule without current effect evidence', () => {
    expect(() =>
      defineAgentObligation(
        input({
          status: 'satisfied',
          action: undefined,
          evidence: [{ ref: 'agent-check', observedAt: NOW, freshness: 'current', note: 'agent said done' }],
        }),
      ),
    ).toThrow(/observed-effect/);

    expect(
      defineAgentObligation(
        input({
          status: 'satisfied',
          action: undefined,
          evidence: [
            {
              ref: 'coord-delivery:99',
              observedAt: NOW,
              freshness: 'current',
              effect: 'canonical owner report delivered',
            },
          ],
        }),
      ).status,
    ).toBe('satisfied');
  });

  it('keeps verified owner, possible-owner, and agent origins structurally distinct', () => {
    expect(authorityFromTurnOrigin('turn:1', 'owner-dialog').kind).toBe('owner');
    expect(authorityFromTurnOrigin('turn:2', 'unenrolled-origin').kind).toBe('owner-candidate');
    expect(authorityFromTurnOrigin('turn:3', 'agent-injected').kind).toBe('agent');
  });
});

describe('agenda evaluation and ranking', () => {
  it('ranks an upstream blocker before a more urgent downstream symptom', () => {
    const upstream = defineAgentObligation(
      input({
        ruleId: 'launch-budget',
        family: 'plan-placement',
        title: 'Budget attribution is blocked',
        status: 'blocked',
        causalRank: 0,
        priority: 'normal',
        episode: 'launch-1',
        action: { kind: 'repair', summary: 'restore measurable goal spend attribution' },
      }),
    );
    const downstream = defineAgentObligation(
      input({
        ruleId: 'launch-now',
        family: 'plan-placement',
        title: 'Launch is overdue',
        causalRank: 2,
        priority: 'critical',
        episode: 'launch-2',
      }),
    );
    expect(evaluateAgentObligations([downstream, upstream], NOW).primary.map((entry) => entry.id)).toEqual([
      upstream.id,
      downstream.id,
    ]);
  });

  it('prefers continuing current work inside the same causal/status/priority tier', () => {
    const fresh = defineAgentObligation(input({ ruleId: 'fresh', episode: 'fresh' }));
    const current = defineAgentObligation(
      input({
        ruleId: 'current',
        episode: 'current',
        action: { kind: 'continue', summary: 'finish the held verification', continuesCurrentWork: true },
      }),
    );
    expect(evaluateAgentObligations([fresh, current], NOW).primary[0]?.id).toBe(current.id);
  });

  it('keeps satisfied and not-applicable controls in evaluations but out of primary', () => {
    const satisfied = defineAgentObligation(
      input({
        ruleId: 'satisfied',
        episode: 'satisfied',
        status: 'satisfied',
        action: undefined,
        evidence: [{ ref: 'effect:1', observedAt: NOW, freshness: 'current', effect: 'independent verdict recorded' }],
      }),
    );
    const notApplicable = defineAgentObligation(
      input({
        ruleId: 'n-a',
        episode: 'n-a',
        status: 'not-applicable',
        applicableDemand: 0,
        action: undefined,
      }),
    );
    const agenda = evaluateAgentObligations([satisfied, notApplicable], NOW);
    expect(agenda.schemaVersion).toBe(AGENT_OBLIGATION_SCHEMA_VERSION);
    expect(agenda.evaluations).toHaveLength(2);
    expect(agenda.primary).toEqual([]);
  });

  it('deduplicates identical results and turns provider disagreement into explicit unknown', () => {
    const due = defineAgentObligation(input());
    expect(evaluateAgentObligations([due, due], NOW).evaluations).toHaveLength(1);

    const satisfied = defineAgentObligation(
      input({
        status: 'satisfied',
        action: undefined,
        evidence: [{ ref: 'effect:2', observedAt: NOW, freshness: 'current', effect: 'report delivered' }],
      }),
    );
    const conflicted = evaluateAgentObligations([due, satisfied], NOW);
    expect(conflicted.conflicts).toEqual([due.id]);
    expect(conflicted.primary[0]).toMatchObject({
      status: 'unknown',
      measurementFailure: { code: 'conflicting-provider-results' },
      action: { kind: 'inspect' },
    });
  });

  it('is deterministic for input order and derives the earliest deadline', () => {
    const first = defineAgentObligation(
      input({
        ruleId: 'a',
        episode: 'a',
        dueAt: '2026-09-05T20:05:00Z',
        changeSignal: { nextDeadlineAt: '2026-09-05T20:05:00Z' },
      }),
    );
    const second = defineAgentObligation(
      input({
        ruleId: 'b',
        episode: 'b',
        dueAt: '2026-09-05T20:10:00Z',
        changeSignal: { nextDeadlineAt: '2026-09-05T20:10:00Z' },
      }),
    );
    const a = evaluateAgentObligations([second, first], NOW);
    const b = evaluateAgentObligations([first, second], NOW);
    expect(a.sourceGeneration).toBe(b.sourceGeneration);
    expect(a.primary.map((entry) => entry.id)).toEqual(b.primary.map((entry) => entry.id));
    expect(a.nextDeadlineAt).toBe('2026-09-05T20:05:00Z');
  });
});

describe('bounded projection', () => {
  it('places the actionable instruction before reason and provenance', () => {
    const line = formatAgentObligationLine(defineAgentObligation(input()));
    expect(line.indexOf('send MOVED')).toBeLessThan(line.indexOf('why:'));
    expect(line).toContain('authority: policy');
  });

  it('truncates only at whole-entry boundaries and returns a delivery receipt', () => {
    const entries = ['a', 'b', 'c', 'd'].map((ruleId) =>
      defineAgentObligation(input({ ruleId, episode: ruleId, title: `Obligation ${ruleId}` })),
    );
    const agenda = evaluateAgentObligations(entries, NOW);
    const projection = projectAgentObligationAgenda({
      agenda,
      sink: 'turn-start',
      mode: 'truncate',
      maxEntries: 3,
      maxChars: 10_000,
    });
    expect(projection.entries).toHaveLength(3);
    expect(projection.receipt).toMatchObject({
      entriesAvailable: 4,
      entriesDelivered: 3,
      entriesOmitted: 1,
      bodyTruncated: true,
      refused: false,
      reason: 'entry-cap',
    });
  });

  it('delivers a complete action within a narrow slot while retaining its full recovery data', () => {
    const obligation = defineAgentObligation(input({ reason: 'Detailed reporting history. '.repeat(50) }));
    const agenda = evaluateAgentObligations([obligation], NOW);
    const full = projectAgentObligationAgenda({ agenda, sink: 'full', mode: 'truncate', maxChars: 400 });
    expect(full.receipt.entriesDelivered).toBe(0);
    const compact = projectAgentObligationAgenda({
      agenda, sink: 'turn-start', mode: 'truncate', detail: 'action', maxChars: 400,
    });
    expect(compact.text).toContain('[DUE]');
    expect(compact.text).toContain(obligation.action!.summary);
    expect(compact.text.length).toBeLessThanOrEqual(400);
    expect(compact.receipt).toMatchObject({ entriesAvailable: 1, entriesDelivered: 1, entriesOmitted: 0 });
    expect(compact.entries[0]).toEqual(obligation);
    expect(compact.entries[0]!.reason).toBe(obligation.reason);
    expect(compact.entries[0]!.authority).toEqual(obligation.authority);
  });

  it('distinguishes a refusing sink from a truncating sink', () => {
    const agenda = evaluateAgentObligations([defineAgentObligation(input())], NOW);
    const refused = projectAgentObligationAgenda({
      agenda,
      sink: 'fact',
      mode: 'refuse',
      maxChars: 10,
    });
    expect(refused).toMatchObject({ text: '', entries: [], receipt: { refused: true, bodyTruncated: false } });

    const truncated = projectAgentObligationAgenda({
      agenda,
      sink: 'coord',
      mode: 'truncate',
      maxChars: 10,
    });
    expect(truncated).toMatchObject({ text: '', entries: [], receipt: { refused: false, bodyTruncated: true } });
  });

  it('honours the conservative 400-token ceiling even with a larger character cap', () => {
    const veryLong = defineAgentObligation(input({ action: { kind: 'report', summary: 'x'.repeat(1_700) } }));
    const projected = projectAgentObligationAgenda({
      agenda: evaluateAgentObligations([veryLong], NOW),
      sink: 'leader-brief',
      mode: 'truncate',
      maxChars: 10_000,
      maxEstimatedTokens: 400,
    });
    expect(projected.receipt.bodyDeliveredChars).toBeLessThanOrEqual(1_600);
    expect(projected.receipt.estimatedTokens).toBeLessThanOrEqual(400);
  });
});

describe('operation/admission parity', () => {
  it('uses the same required predicate at assignment and mutation time', () => {
    const obligation = defineAgentObligation(
      input({
        boundary: {
          boundary: 'fleet:launch-on-plan',
          refusalCode: 'goal-plan-launch-prerequisite',
          enforcement: 'required',
          unknown: 'refuse',
        },
      }),
    );
    const admission = evaluateAgentObligationBoundary({
      obligation,
      boundary: 'fleet:launch-on-plan',
      phase: 'admission',
    });
    const operation = evaluateAgentObligationBoundary({
      obligation,
      boundary: 'fleet:launch-on-plan',
      phase: 'operation',
    });
    expect(admission.allowed).toBe(false);
    expect({ ...admission, phase: 'operation' }).toEqual(operation);
    expect(operation).toMatchObject({
      code: 'goal-plan-launch-prerequisite',
      recovery: { kind: 'report' },
    });
  });

  it('allows only a current observed effect to clear a required boundary', () => {
    const obligation = defineAgentObligation(
      input({
        status: 'satisfied',
        action: undefined,
        evidence: [{ ref: 'launch:receipt', observedAt: NOW, freshness: 'current', effect: 'launch admitted' }],
        boundary: {
          boundary: 'fleet:launch-on-plan',
          refusalCode: 'goal-plan-launch-prerequisite',
          enforcement: 'required',
          unknown: 'refuse',
        },
      }),
    );
    expect(
      evaluateAgentObligationBoundary({
        obligation,
        boundary: 'fleet:launch-on-plan',
        phase: 'operation',
      }),
    ).toMatchObject({ allowed: true, warning: false });
  });

  it('preserves explicit unknown while permitting an existing fail-open advisory', () => {
    const obligation = defineAgentObligation(
      input({
        status: 'unknown',
        measurementFailure: {
          code: 'telemetry-sparse',
          detail: 'native activity is not measured',
          retry: 'read source',
        },
        boundary: {
          boundary: 'activity:report',
          refusalCode: 'activity-unmeasured',
          enforcement: 'required',
          unknown: 'allow-with-warning',
        },
      }),
    );
    expect(
      evaluateAgentObligationBoundary({ obligation, boundary: 'activity:report', phase: 'operation' }),
    ).toMatchObject({ allowed: true, warning: true, reason: 'native activity is not measured' });
  });
});

describe('provider recovery operation boundary', () => {
  const placement = (overrides: Partial<AgentObligationInput> = {}) =>
    defineAgentObligation(
      input({
        ruleId: 'goal-plan-placement',
        family: 'plan-placement',
        status: 'due',
        reason: 'plan-a is the highest-priority eligible placement',
        action: {
          kind: 'delegate',
          summary: 'launch the provider-selected plan fleet',
          tool: 'fleet:launch-on-plan',
          args: {
            name: 'plan-a-fleet',
            plan: 'plan-a',
            harness: 'papercusp',
            leader: 'spawn',
            headless: true,
          },
        },
        boundary: {
          boundary: 'fleet:launch-on-plan',
          refusalCode: 'goal-plan-placement-prerequisite',
          enforcement: 'required',
          unknown: 'allow-with-warning',
        },
        ...overrides,
      }),
    );

  const operation = (overrides: Record<string, unknown> = {}) => ({
    tool: 'fleet:launch-on-plan',
    args: {
      name: 'plan-a-fleet',
      plan: 'plan-a',
      harness: 'papercusp',
      leader: 'spawn',
      headless: true,
      count: 3,
      model: 'gpt-5.6-sol:high',
      ...overrides,
    },
  });

  it('admits the exact provider action while preserving additional resource choices', () => {
    expect(
      evaluateAgentObligationRecoveryBoundary({
        obligation: placement(),
        boundary: 'fleet:launch-on-plan',
        phase: 'operation',
        operation: operation(),
      }),
    ).toMatchObject({ allowed: true, warning: false, recovery: { kind: 'delegate' } });
  });

  it('refuses a wrong plan, fleet, leadership shape, or visibility choice', () => {
    for (const mismatch of [{ plan: 'plan-b' }, { name: 'other-fleet' }, { leader: 'caller' }, { headless: false }]) {
      expect(
        evaluateAgentObligationRecoveryBoundary({
          obligation: placement(),
          boundary: 'fleet:launch-on-plan',
          phase: 'operation',
          operation: operation(mismatch),
        }),
      ).toMatchObject({ allowed: false, code: 'goal-plan-placement-prerequisite' });
    }
  });

  it('refuses an extra launch when no placement demand is eligible', () => {
    for (const status of ['satisfied', 'not-applicable'] as const) {
      const obligation = placement({
        status,
        action: undefined,
        reason: 'the worklist is covered or empty',
        evidence:
          status === 'satisfied'
            ? [{ ref: 'placement:receipt', observedAt: NOW, freshness: 'current', effect: 'independent fleet live' }]
            : [],
      });
      expect(
        evaluateAgentObligationRecoveryBoundary({
          obligation,
          boundary: 'fleet:launch-on-plan',
          phase: 'operation',
          operation: operation(),
        }),
      ).toMatchObject({ allowed: false, reason: expect.stringContaining('no canonical recovery operation') });
    }
  });

  it('preserves the provider policy for unreadable evidence', () => {
    const obligation = placement({
      status: 'unknown',
      action: { kind: 'inspect', summary: 'refresh placement evidence' },
      measurementFailure: { code: 'read-failed', detail: 'portfolio read unavailable', retry: 'retry' },
    });
    expect(
      evaluateAgentObligationRecoveryBoundary({
        obligation,
        boundary: 'fleet:launch-on-plan',
        phase: 'operation',
        operation: operation(),
      }),
    ).toMatchObject({ allowed: true, warning: true, reason: 'portfolio read unavailable' });
  });
});
