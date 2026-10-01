import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockUpsertConditionWorkItem, mockFindConditionKeyHolder, mockSetWorkItemState } = vi.hoisted(
  () => ({
    mockUpsertConditionWorkItem: vi.fn(),
    mockFindConditionKeyHolder: vi.fn(),
    mockSetWorkItemState: vi.fn(),
  }),
);

vi.mock('../../coord/condition-upsert', () => ({
  upsertConditionWorkItem: mockUpsertConditionWorkItem,
}));
vi.mock('../../coord/condition-bridge', () => ({
  findConditionKeyHolder: mockFindConditionKeyHolder,
}));
vi.mock('../../work-items', () => ({
  setWorkItemState: mockSetWorkItemState,
}));

import {
  ACTIVATION_AUDIT_REPAIR_ACTOR,
  activationAuditRepairConditionKey,
  activationAuditRepairSummary,
  ensureActivationAuditRepairFiling,
  reconcileActivationAuditRepairFiling,
  reconcileActivationAuditRepairFilingForTerminalPlan,
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

/**
 * The half that did not exist before EI-22090432802240306. condition-upsert
 * deliberately has "no auto-settle marker", so a filing whose condition clears
 * stays open forever unless its own filer closes it — measured: 0 machine
 * closes across 13 activation-audit filings, against 72 for the sibling
 * spec-triad lane that owns its close.
 */
describe('activation-audit repair reconciliation', () => {
  const reconcileInput = {
    workspaceId: 'workspace-a',
    harnessSlug: 'papercusp',
    planSlug: 'plan-a',
    auditSeq: 4,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes the open filing through the lifecycle writer with real evidence', async () => {
    mockFindConditionKeyHolder.mockResolvedValue('WI-REPAIR');
    mockSetWorkItemState.mockResolvedValue({ id: 'WI-REPAIR' });

    const result = await reconcileActivationAuditRepairFiling(reconcileInput);

    expect(mockFindConditionKeyHolder).toHaveBeenCalledWith('activation-audit:papercusp/plan-a', {
      workspaceId: 'workspace-a',
    });
    const [id, state, opts] = mockSetWorkItemState.mock.calls[0] ?? [];
    expect(id).toBe('WI-REPAIR');
    // `dropped` + by + completionRef, never skipCompletionGate — the spec-triad
    // precedent: a machine close carries evidence and enters no completion bucket.
    expect(state).toBe('dropped');
    expect(opts).toMatchObject({ harness: 'papercusp', by: ACTIVATION_AUDIT_REPAIR_ACTOR });
    expect(opts?.skipCompletionGate).toBeUndefined();
    expect(opts?.completionRef).toContain('activation audit #4 recorded clean');
    expect(opts?.completionRef).toContain("plan 'plan-a'");
    expect(result).toEqual({ conditionKey: 'activation-audit:papercusp/plan-a', closed: 'WI-REPAIR' });
  });

  it('is idempotent under re-audit: no open filing owns the key, nothing is closed', async () => {
    mockFindConditionKeyHolder.mockResolvedValue(null);

    await expect(reconcileActivationAuditRepairFiling(reconcileInput)).resolves.toEqual({
      conditionKey: 'activation-audit:papercusp/plan-a',
      closed: null,
    });
    expect(mockSetWorkItemState).not.toHaveBeenCalled();
  });

  it('fails soft: a queue write that throws never unwinds the recorded audit', async () => {
    mockFindConditionKeyHolder.mockResolvedValue('WI-REPAIR');
    mockSetWorkItemState.mockRejectedValue(new Error('lifecycle writer unavailable'));

    await expect(reconcileActivationAuditRepairFiling(reconcileInput)).resolves.toEqual({
      conditionKey: 'activation-audit:papercusp/plan-a',
      closed: null,
      error: 'lifecycle writer unavailable',
    });
  });

  it('closes exactly the key its own filing seam mints', async () => {
    mockUpsertConditionWorkItem.mockResolvedValue({
      conditionKey: 'activation-audit:papercusp/plan-a',
      id: 'WI-REPAIR',
      created: true,
    });
    mockFindConditionKeyHolder.mockResolvedValue('WI-REPAIR');
    mockSetWorkItemState.mockResolvedValue({ id: 'WI-REPAIR' });

    const filed = await ensureActivationAuditRepairFiling(input);
    const reconciled = await reconcileActivationAuditRepairFiling(reconcileInput);

    expect(reconciled.conditionKey).toBe(filed.conditionKey);
    expect(mockFindConditionKeyHolder.mock.calls[0]?.[0]).toBe(
      mockUpsertConditionWorkItem.mock.calls[0]?.[0],
    );
  });
});

describe('reconcileActivationAuditRepairFilingForTerminalPlan (EI-24746042684666503)', () => {
  const terminalInput = {
    workspaceId: 'workspace-a',
    harnessSlug: 'papercusp',
    planSlug: 'plan-a',
    terminalStatus: 'shipped' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes the filing of a plan that went terminal without a clean audit, citing the terminal status', async () => {
    mockFindConditionKeyHolder.mockResolvedValue('WI-REPAIR');
    mockSetWorkItemState.mockResolvedValue({ id: 'WI-REPAIR' });

    const result = await reconcileActivationAuditRepairFilingForTerminalPlan(terminalInput);

    expect(mockFindConditionKeyHolder).toHaveBeenCalledWith('activation-audit:papercusp/plan-a', {
      workspaceId: 'workspace-a',
    });
    const [id, state, opts] = mockSetWorkItemState.mock.calls[0] ?? [];
    expect(id).toBe('WI-REPAIR');
    expect(state).toBe('dropped');
    expect(opts).toMatchObject({ harness: 'papercusp', by: ACTIVATION_AUDIT_REPAIR_ACTOR });
    expect(opts?.skipCompletionGate).toBeUndefined();
    expect(opts?.completionRef).toContain("plan 'plan-a' is shipped");
    expect(opts?.completionRef).not.toContain('recorded clean');
    expect(result).toEqual({ conditionKey: 'activation-audit:papercusp/plan-a', closed: 'WI-REPAIR' });
  });

  it('targets the same key the filing seam and the clean-audit reconcile use', async () => {
    mockFindConditionKeyHolder.mockResolvedValue(null);

    await reconcileActivationAuditRepairFilingForTerminalPlan({ ...terminalInput, terminalStatus: 'superseded' });
    await reconcileActivationAuditRepairFiling({ ...terminalInput, auditSeq: 1 });

    expect(mockFindConditionKeyHolder.mock.calls[0]?.[0]).toBe(activationAuditRepairConditionKey(terminalInput));
    expect(mockFindConditionKeyHolder.mock.calls[1]?.[0]).toBe(mockFindConditionKeyHolder.mock.calls[0]?.[0]);
    expect(mockSetWorkItemState).not.toHaveBeenCalled();
  });

  it('fails soft: a lifecycle write that throws is reported, never thrown', async () => {
    mockFindConditionKeyHolder.mockResolvedValue('WI-REPAIR');
    mockSetWorkItemState.mockRejectedValue(new Error('lifecycle writer unavailable'));

    await expect(reconcileActivationAuditRepairFilingForTerminalPlan(terminalInput)).resolves.toEqual({
      conditionKey: 'activation-audit:papercusp/plan-a',
      closed: null,
      error: 'lifecycle writer unavailable',
    });
  });
});
