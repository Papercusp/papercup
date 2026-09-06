import { describe, expect, it } from 'vitest';
import {
  buildAgentObligationAgenda,
  independentVerificationObligation,
  ownerReportObligation,
  planPlacementObligation,
  type IndependentVerificationProviderInput,
  type OwnerReportProviderInput,
  type PlanPlacementProviderInput,
} from './agent-obligation-providers';

const NOW = '2026-09-05T20:00:00.000Z';
const base = { workspaceId: 'ws', ownerId: 'su-goal', observedAt: NOW, sourceGeneration: 'rev-42' };
const failure = { code: 'read-failed', detail: 'canonical writer timed out', retry: 'retry the canonical writer' };

function planInput(value: PlanPlacementProviderInput['read']): PlanPlacementProviderInput {
  return { ...base, goalId: 'goal-1', read: value };
}

function reportInput(value: OwnerReportProviderInput['read']): OwnerReportProviderInput {
  return { ...base, goalId: 'goal-1', read: value };
}

function verifyInput(value: IndependentVerificationProviderInput['read']): IndependentVerificationProviderInput {
  return { ...base, planSlug: 'plan-a', read: value };
}

const planAlert = (reason: 'started-plan-no-live-targeting-fleet' | 'started-plan-targeting-fleet-zero-live-claims') => ({
  goalId: 'goal-1',
  workspaceId: 'ws',
  title: 'Goal',
  reason,
  planSlug: 'plan-a',
  harnessSlug: 'papercusp',
  itemIds: ['P-001'],
  targetingFleets: [],
  liveHolders: ['su-goal'],
});

describe('frozen provider matrix: plan placement (6 opportunities)', () => {
  it.each([
    ['due', planInput({ status: 'known', value: { applicablePlanCount: 1, alert: planAlert('started-plan-no-live-targeting-fleet'), evidenceRef: 'cohort:1' } }), 'delegate'],
    ['blocked', planInput({ status: 'known', value: { applicablePlanCount: 1, alert: planAlert('started-plan-targeting-fleet-zero-live-claims'), evidenceRef: 'cohort:2' } }), 'repair'],
    ['satisfied', planInput({ status: 'known', value: { applicablePlanCount: 2, alert: null, evidenceRef: 'cohort:3' } }), undefined],
    ['not-applicable', planInput({ status: 'known', value: { applicablePlanCount: 0, alert: null, evidenceRef: 'cohort:4' } }), undefined],
    ['unknown', planInput({ status: 'unknown', failure }), 'inspect'],
    ['due', planInput({ status: 'known', value: { applicablePlanCount: 1, alert: planAlert('started-plan-no-live-targeting-fleet'), evidenceRef: 'cohort:recovered', ageMs: 9_000 } }), 'delegate'],
  ] as const)('%s', (status, input, action) => {
    const result = planPlacementObligation(input);
    expect(result.status).toBe(status);
    expect(result.action?.kind).toBe(action);
  });
});

describe('frozen provider matrix: owner reporting (6 opportunities)', () => {
  const report = (obligation: 'overdue' | 'due-now' | 'not-due', lastReportAt: string | null = null) => ({
    lastReportAt,
    ageMin: obligation === 'overdue' ? 75 : 20,
    floorMin: 60,
    dueInMin: obligation === 'overdue' ? -15 : obligation === 'due-now' ? 3 : 40,
    standing: true,
    obligation,
    instruction: obligation,
  });

  it.each([
    ['due', reportInput({ status: 'known', value: report('overdue') }), 'report'],
    ['due', reportInput({ status: 'known', value: report('due-now') }), 'report'],
    ['satisfied', reportInput({ status: 'known', value: report('not-due', '2026-09-05T19:40:00.000Z') }), undefined],
    ['not-applicable', reportInput({ status: 'known', value: report('not-due') }), undefined],
    ['not-applicable', reportInput({ status: 'known', value: null }), undefined],
    ['unknown', reportInput({ status: 'unknown', failure }), 'inspect'],
  ] as const)('%s', (status, input, action) => {
    const result = ownerReportObligation(input);
    expect(result.status).toBe(status);
    expect(result.action?.kind).toBe(action);
  });
});

describe('frozen provider matrix: independent verification (6 opportunities)', () => {
  const gate = (satisfied: boolean, code?: NonNullable<Parameters<typeof independentVerificationObligation>[0]['read']> extends never ? never : string) => ({
    satisfied,
    ...(code ? { code: code as never } : {}),
    message: code ? `refused: ${code}` : 'accepted',
    rubricId: 'acceptance-plan-a',
    gradedBy: satisfied ? 'su-independent' : null,
  });
  const known = (g: ReturnType<typeof gate>, gradeable = true): IndependentVerificationProviderInput['read'] => ({
    status: 'known',
    value: { gate: g, evidenceRef: `gate:${g.code ?? 'pass'}`, reviewAgeMs: 3_600_000, gradeable },
  });

  it.each([
    ['due', verifyInput(known(gate(false, 'acceptance_ungraded'))), 'delegate'],
    ['due', verifyInput(known(gate(false, 'self_graded_only'))), 'delegate'],
    ['blocked', verifyInput(known(gate(false, 'acceptance_rubric_missing'))), 'repair'],
    ['satisfied', verifyInput(known(gate(true))), undefined],
    ['not-applicable', verifyInput(known(gate(false, 'plan_items_unfinished'), false)), undefined],
    ['unknown', verifyInput({ status: 'unknown', failure }), 'inspect'],
  ] as const)('%s', (status, input, action) => {
    const result = independentVerificationObligation(input);
    expect(result.status).toBe(status);
    expect(result.action?.kind).toBe(action);
  });
});

describe('shared agenda composition', () => {
  it('returns one deterministic generation and ranks author repair ahead of grader dispatch', () => {
    const agenda = buildAgentObligationAgenda(
      {
        ownerReport: reportInput({
          status: 'known',
          value: { lastReportAt: null, ageMin: 75, floorMin: 60, dueInMin: -15, standing: true, obligation: 'overdue', instruction: 'report now' },
        }),
        independentVerification: [
          verifyInput({
            status: 'known',
            value: {
              gate: { satisfied: false, code: 'acceptance_rubric_missing', message: 'author the rubric' },
              evidenceRef: 'gate:missing-rubric',
              gradeable: true,
            },
          }),
        ],
      },
      NOW,
    );
    expect(agenda.evaluations).toHaveLength(2);
    expect(agenda.primary[0]?.family).toBe('independent-verification');
    expect(agenda.sourceGeneration).toMatch(/^[a-f0-9]{20}$/);
  });

  it('never mistakes unknown or no-demand cases for due work', () => {
    const agenda = buildAgentObligationAgenda(
      {
        planPlacement: planInput({ status: 'unknown', failure }),
        ownerReport: reportInput({ status: 'known', value: null }),
      },
      NOW,
    );
    expect(agenda.evaluations.map((entry) => entry.status).sort()).toEqual(['not-applicable', 'unknown']);
    expect(agenda.evaluations.some((entry) => entry.status === 'due')).toBe(false);
  });
});
