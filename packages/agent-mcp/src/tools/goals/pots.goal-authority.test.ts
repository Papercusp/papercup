import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  resolveWorkspace: vi.fn(),
  linkPot: vi.fn(),
  unlinkPot: vi.fn(),
  goalsForPot: vi.fn(),
  potsForGoal: vi.fn(),
  goalSpend: vi.fn(),
}));

vi.mock('@papercusp/db-org', () => ({
  goalSpend: mocks.goalSpend,
  goalsForPot: mocks.goalsForPot,
  linkPot: mocks.linkPot,
  potsForGoal: mocks.potsForGoal,
  unlinkPot: mocks.unlinkPot,
}));
vi.mock('./_workspace', () => ({ resolveGoalWorkspace: mocks.resolveWorkspace }));
vi.mock('@papercusp/operator-core/lib/goals/write-authority', () => ({
  assertGoalWriteAuthorityForCaller: mocks.guard,
}));

const { attachPot, detachPot } = await import('./pots');

const ctx = {
  workspaceId: 'ws-1',
  harnessSlug: 'pot-1',
  tx: {},
  uiClientId: 'ui-1',
};
const superseded = Object.assign(new Error('holder-old is superseded by holder-new'), {
  code: 'goal_holder_superseded',
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveWorkspace.mockResolvedValue('ws-1');
  mocks.guard.mockResolvedValue({ status: 'elected' });
  mocks.linkPot.mockResolvedValue({ goalId: 'goal-1', harnessSlug: 'pot-1', role: 'owner' });
  mocks.unlinkPot.mockResolvedValue(true);
  mocks.goalsForPot.mockResolvedValue([{ goalId: 'goal-1' }]);
});

describe('goals:attach-pot / goals:detach-pot effective-holder fence (WI-1139512)', () => {
  it('refuses an expired predecessor before attach-pot writes the goal edge', async () => {
    mocks.guard.mockRejectedValue(superseded);

    await expect(
      attachPot.handler(
        { goalId: 'goal-1', harnessSlug: 'pot-1', role: 'owner' } as never,
        ctx as never,
      ),
    ).rejects.toBe(superseded);

    expect(mocks.guard).toHaveBeenCalledWith(ctx, 'ws-1', ctx.tx);
    expect(mocks.linkPot).not.toHaveBeenCalled();
    expect(mocks.goalsForPot).not.toHaveBeenCalled();
  });

  it('refuses an expired predecessor before detach-pot tombstones the edge', async () => {
    mocks.guard.mockRejectedValue(superseded);

    await expect(
      detachPot.handler({ goalId: 'goal-1', harnessSlug: 'pot-1' } as never, ctx as never),
    ).rejects.toBe(superseded);

    expect(mocks.guard).toHaveBeenCalledWith(ctx, 'ws-1', ctx.tx);
    expect(mocks.unlinkPot).not.toHaveBeenCalled();
  });

  it('keeps the ordinary elected caller path intact', async () => {
    const result = await attachPot.handler(
      { goalId: 'goal-1', harnessSlug: 'pot-1', role: 'owner' } as never,
      ctx as never,
    );

    expect(mocks.linkPot).toHaveBeenCalledWith(ctx.tx, {
      workspaceId: 'ws-1',
      goalId: 'goal-1',
      harnessSlug: 'pot-1',
      role: 'owner',
      by: 'ui-1',
      note: null,
      killCriterion: null,
    });
    expect(result).toMatchObject({ data: { goalId: 'goal-1', shared: false } });
  });
});
