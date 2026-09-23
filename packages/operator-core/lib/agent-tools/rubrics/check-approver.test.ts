import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ check: vi.fn() }));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'router-agent', workspaceId: 'workspace-test' }),
}));
vi.mock('../../rubrics', () => ({
  checkAcceptanceBarApproverEligibility: mocks.check,
}));
vi.mock('../../workspace-als', () => ({
  runWithWorkspaceIfConcrete: (_workspaceId: string | undefined, run: () => unknown) => run(),
}));

import checkApproverTool from './check-approver';

describe('rubrics:check-approver', () => {
  it('screens one candidate without requiring amendment fields', async () => {
    mocks.check.mockResolvedValue({
      rubricId: 'acceptance-example',
      subjectPlan: 'plan-example',
      ownerId: 'candidate-agent',
      eligible: true,
      reason: 'eligible',
      eligibleWithUnrelatedApplier: true,
    });

    const result = await checkApproverTool.handler(
      { rubricRef: 'plan:acceptance-example', ownerId: 'candidate-agent' } as never,
      {} as never,
    );

    expect(mocks.check).toHaveBeenCalledWith({ rubricId: 'acceptance-example', ownerId: 'candidate-agent' });
    expect(result).toEqual({
      data: {
        ok: true,
        rubricRef: 'plan:acceptance-example',
        rubricId: 'acceptance-example',
        subjectPlan: 'plan-example',
        ownerId: 'candidate-agent',
        eligible: true,
        reason: 'eligible',
        eligibleWithUnrelatedApplier: true,
      },
    });
  });
});
