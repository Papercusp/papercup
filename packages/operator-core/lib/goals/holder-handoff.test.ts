import { describe, expect, it, vi } from 'vitest';
import { notifyGoalHolderHandoff, type GoalHolderHandoffDeps } from './holder-handoff';

describe('notifyGoalHolderHandoff', () => {
  it('disarms, messages, and wakes exactly the named predecessor', async () => {
    const deactivate = vi.fn(async () => true);
    const notifyOrders = vi.fn(async () => {});
    const message = vi.fn(async () => {});
    const wake = vi.fn(async () => ({ woken: 1, staged: 0 }));
    const deps: GoalHolderHandoffDeps = { deactivate, notifyOrders, message, wake };

    const result = await notifyGoalHolderHandoff(
      'workspace-1',
      {
        ownerId: 'holder-new',
        goalId: 'goal-1',
        epoch: 4,
        predecessorOwnerId: 'holder-old',
        handoffExpiresAt: '2026-08-30T08:00:00.000Z',
      },
      deps,
    );

    expect(deactivate).toHaveBeenCalledWith('holder-old', expect.stringContaining('epoch 4'));
    expect(notifyOrders).toHaveBeenCalledWith('holder-old');
    expect(message).toHaveBeenCalledWith(
      'holder-old',
      expect.stringContaining('holder-new'),
      expect.stringContaining('goal-scoped context, mutations, and launches refuse'),
    );
    expect(wake).toHaveBeenCalledWith(
      'holder-old',
      expect.any(String),
      expect.objectContaining({ action: 'stand-down', electedOwnerId: 'holder-new' }),
      'workspace-1',
    );
    expect(result).toMatchObject({ loopDeactivated: true, woken: 1, staged: 0 });
  });

  it('does nothing for the first holder because there is no predecessor', async () => {
    const deps: GoalHolderHandoffDeps = {
      deactivate: vi.fn(),
      notifyOrders: vi.fn(),
      message: vi.fn(),
      wake: vi.fn(),
    };
    await expect(
      notifyGoalHolderHandoff(
        'workspace-1',
        {
          ownerId: 'holder-first',
          goalId: 'goal-1',
          epoch: 1,
          predecessorOwnerId: null,
          handoffExpiresAt: null,
        },
        deps,
      ),
    ).resolves.toBeNull();
    expect(deps.deactivate).not.toHaveBeenCalled();
  });
});
