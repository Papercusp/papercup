import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockUpsertConditionWorkItem } = vi.hoisted(() => ({
  mockUpsertConditionWorkItem: vi.fn(),
}));

vi.mock('../../coord/condition-upsert', () => ({
  upsertConditionWorkItem: mockUpsertConditionWorkItem,
}));

import {
  activationAuditRepairConditionKey,
  activationAuditRepairSummary,
  ensureActivationAuditRepairFiling,
  type ActivationAuditRepairFilingInput,
} from './activation-audit-repair';

const input: ActivationAuditRepairFilingInput = {
  workspaceId: 'workspace-a',
  harnessSlug: 'papercusp',
  planSlug: 'plan-a',
  activation: {
    sourceRanges: [{ sourceKind: 'codex', sessionId: 'session-a', fromTurn: 1, toTurn: 4 }],
    mappings: [
      {
        id: 'M-001',
        sourceRefs: ['session_turn:codex:session-a:1'],
        requirement: 'Keep activation coverage complete.',
        planTargets: ['P-001'],
        disposition: 'open',
      },
      {
        id: 'M-002',
        sourceRefs: ['session_turn:codex:session-a:2'],
        requirement: 'Preserve the current revision anchor.',
        planTargets: ['P-002'],
        disposition: 'covered',
      },
    ],
    repairedOmissions: [],
    rejectedOrSuperseded: [],
    unresolvedBlockers: ['Resolve the owner constraint before activation.'],
  },
};

describe('activation-audit repair filing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('derives a stable plan-scoped condition key and actionable summary', () => {
    expect(activationAuditRepairConditionKey(input)).toBe('activation-audit:papercusp/plan-a');
    expect(activationAuditRepairSummary(input)).toContain(
      'Open mappings: M-001: Keep activation coverage complete.',
    );
    expect(activationAuditRepairSummary(input)).toContain(
      'Unresolved blockers: Resolve the owner constraint before activation.',
    );
    expect(activationAuditRepairSummary(input)).toContain(
      "rerun plans:audit with phase:'activation'",
    );
  });

  it('delegates the filing payload and returns the condition-upsert outcome', async () => {
    mockUpsertConditionWorkItem.mockResolvedValue({
      conditionKey: 'activation-audit:papercusp/plan-a',
      id: 'EI-REPAIR',
      created: true,
      duplicateLeftOpen: 'EI-DUPLICATE',
    });

    const result = await ensureActivationAuditRepairFiling(input);
    const [conditionKey, workItem] = mockUpsertConditionWorkItem.mock.calls[0] ?? [];

    expect(conditionKey).toBe('activation-audit:papercusp/plan-a');
    expect(workItem).toMatchObject({
      kind: 'task',
      harness: 'papercusp',
      workspaceId: 'workspace-a',
      createdBy: 'system:plans-audit',
      title: "Repair activation audit for plan 'plan-a'",
      payload: {
        activationAuditRepair: {
          planSlug: 'plan-a',
          openMappingIds: ['M-001'],
          unresolvedBlockers: ['Resolve the owner constraint before activation.'],
        },
      },
    });
    expect(result).toEqual({
      conditionKey: 'activation-audit:papercusp/plan-a',
      id: 'EI-REPAIR',
      created: true,
      duplicateLeftOpen: 'EI-DUPLICATE',
    });
  });

  it('fails soft when the repair queue is unavailable', async () => {
    mockUpsertConditionWorkItem.mockRejectedValue(new Error('condition store unavailable'));

    await expect(ensureActivationAuditRepairFiling(input)).resolves.toEqual({
      conditionKey: 'activation-audit:papercusp/plan-a',
      id: null,
      created: false,
      error: 'condition store unavailable',
    });
  });
});
