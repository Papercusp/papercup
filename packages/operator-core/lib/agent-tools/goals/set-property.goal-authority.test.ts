import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apply: vi.fn(),
  guard: vi.fn(),
  emit: vi.fn(),
  identity: vi.fn(() => ({ ownerId: 'holder-old' })),
}));

vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-1') }));
vi.mock('../../typed-properties-db', () => ({ applyGoalPropertyWrite: mocks.apply }));
vi.mock('../coordination/identity', () => ({
  ADMIN_COORD_UI_OWNER: 'pc-admin-coord-ui',
  resolveAgentIdentity: mocks.identity,
}));
vi.mock('../coordination/plan-events', () => ({ emitPlanEventForCaller: mocks.emit }));
vi.mock('../../goals/write-authority', () => ({
  assertGoalWriteAuthorityForCaller: mocks.guard,
}));
vi.mock('../../modes/goal-context', () => ({
  isGoalHolderAuthorityError: (error: unknown) =>
    Boolean(error && typeof error === 'object' && (error as { name?: string }).name === 'GoalHolderAuthorityError'),
}));

const tool = (await import('./set-property')).default;

const args = {
  goalId: 'goal-42',
  property: 'worklist',
  value: ['docs'],
  expectedVersion: 1,
};
const ctx = { workspaceId: 'ws-1', tx: {} };
type Out = { isError?: boolean; content: Array<{ text: string }> };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.identity.mockReturnValue({ ownerId: 'holder-old' });
  mocks.guard.mockResolvedValue({ status: 'elected' });
  mocks.apply.mockResolvedValue({
    ok: true,
    priorValue: ['tests'],
    entry: { value: ['docs'], version: 2 },
  });
});

describe('goals:set-property effective-holder fence', () => {
  it('checks the caller before the typed-property writer runs', async () => {
    const out = (await tool.handler({ ...args, confirmShrink: true } as never, ctx as never)) as Out;
    expect(out.isError).toBeUndefined();
    expect(mocks.guard).toHaveBeenCalledWith(ctx, 'ws-1', ctx.tx);
    expect(mocks.apply).toHaveBeenCalledOnce();
    expect(mocks.apply).toHaveBeenCalledWith(
      ctx.tx,
      expect.objectContaining({ confirmShrink: true }),
    );
  });

  it('refuses an expired predecessor without calling the property writer', async () => {
    const error = Object.assign(new Error('holder-old is superseded by holder-new'), {
      name: 'GoalHolderAuthorityError',
      code: 'goal_holder_superseded',
      authority: {
        status: 'superseded',
        goalId: 'goal-42',
        electedOwnerId: 'holder-new',
        electedEpoch: 2,
        handoffExpiresAt: null,
      },
    });
    mocks.guard.mockRejectedValue(error);

    const out = (await tool.handler(args as never, ctx as never)) as Out;
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content[0]!.text)).toMatchObject({
      error: 'goal_holder_superseded',
      goalId: 'goal-42',
      authority: { electedOwnerId: 'holder-new' },
    });
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});
