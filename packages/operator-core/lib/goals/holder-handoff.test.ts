import { describe, expect, it, vi } from 'vitest';
import { notifyGoalHolderHandoff, type GoalHolderHandoffDeps } from './holder-handoff';

describe('notifyGoalHolderHandoff', () => {
  it('disarms, messages, and wakes exactly the named predecessor', async () => {
    const deactivate = vi.fn(async () => true);
    const notifyOrders = vi.fn(async () => {});
    const message = vi.fn(async () => {});
    const wake = vi.fn(async () => ({ woken: 1, staged: 0 }));
    const vacateDrainFleet = vi.fn(async () => ({
      fleetSlug: 'goal-drain-demo',
      vacated: true,
      reason: 'vacated' as const,
    }));
    const deps: GoalHolderHandoffDeps = {
      deactivate,
      notifyOrders,
      message,
      wake,
      vacateDrainFleet,
    };

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

    // EI-22402152554463916: the seat is vacated for the OUTGOING holder. Passing the elected
    // holder here instead would re-seat the drain fleet on the portfolio manager — the exact
    // fix the goal steward ruled out, so this argument is the constraint made executable.
    expect(vacateDrainFleet).toHaveBeenCalledWith('workspace-1', 'goal-1', 'holder-old');
    expect(vacateDrainFleet).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'holder-new',
    );
    expect(result).toMatchObject({ drainFleet: { vacated: true, fleetSlug: 'goal-drain-demo' } });
    // The stood-down agent must be TOLD, or it cannot know not to reclaim the seat.
    expect(message).toHaveBeenCalledWith(
      'holder-old',
      expect.any(String),
      expect.stringContaining("drain fleet 'goal-drain-demo'"),
    );
  });

  it('leaves the stand-down body unchanged when there was no seat to vacate', async () => {
    const message = vi.fn(async () => {});
    const deps: GoalHolderHandoffDeps = {
      deactivate: vi.fn(async () => true),
      notifyOrders: vi.fn(async () => {}),
      message,
      wake: vi.fn(async () => ({ woken: 1, staged: 0 })),
      vacateDrainFleet: vi.fn(async () => ({
        fleetSlug: null,
        vacated: false,
        reason: 'no-drain-fleet' as const,
      })),
    };

    const result = await notifyGoalHolderHandoff(
      'workspace-1',
      {
        ownerId: 'holder-new',
        goalId: 'goal-1',
        epoch: 2,
        predecessorOwnerId: 'holder-old',
        handoffExpiresAt: null,
      },
      deps,
    );

    expect(message).toHaveBeenCalledWith(
      'holder-old',
      expect.any(String),
      expect.not.stringContaining('drain fleet'),
    );
    expect(result).toMatchObject({ drainFleet: { vacated: false, reason: 'no-drain-fleet' } });
  });

  it('does nothing for the first holder because there is no predecessor', async () => {
    const deps: GoalHolderHandoffDeps = {
      deactivate: vi.fn(),
      notifyOrders: vi.fn(),
      message: vi.fn(),
      wake: vi.fn(),
      vacateDrainFleet: vi.fn(),
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
    // A first acquisition supersedes nobody, so no seat is in question.
    expect(deps.vacateDrainFleet).not.toHaveBeenCalled();
  });
});
