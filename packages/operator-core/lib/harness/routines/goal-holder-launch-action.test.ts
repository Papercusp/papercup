import { describe, expect, it, vi } from 'vitest';
import type { GoalLaunchResolution } from '../../goal-launch-settings';
import {
  launchGoalHolderSession,
  runGoalHolderLaunchAction,
  type GoalHolderLaunchDeps,
} from './goal-holder-launch-action';

function resolution(overrides: Partial<GoalLaunchResolution> = {}): GoalLaunchResolution {
  return {
    goalId: 'goal-1',
    settings: null,
    effective: {},
    ceilings: { maxAgents: 12, maxPerFleet: 5 },
    headcount: { total: 1, fleet: null },
    budget: null,
    refusal: null,
    degraded: false,
    degradedReasons: [],
    ...overrides,
  };
}

function deps(resolved: GoalLaunchResolution = resolution()): GoalHolderLaunchDeps & {
  resolveGoalLaunch: ReturnType<typeof vi.fn>;
  launch: ReturnType<typeof vi.fn>;
} {
  return {
    resolveGoalLaunch: vi.fn(async () => resolved),
    launch: vi.fn(async () => ({ ok: true, ownerId: 'su-new-holder' })),
  };
}

describe('goal holder system launch (goal-live-holder-guarantee P-007)', () => {
  it('resolves the existing goal and launches a headless AUTO holder with the stored profile', async () => {
    const d = deps(
      resolution({
        effective: {
          agent: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'xhigh',
          account: 'auto',
          contextSize: 'trimmed',
        },
      }),
    );

    await expect(
      launchGoalHolderSession(
        { workspaceId: 'workspace-1', goalId: 'goal-1', harnessSlug: 'hive-1', launcherOwnerId: 'system-watchdog' },
        d,
      ),
    ).resolves.toEqual({ ownerId: 'su-new-holder', warnings: [] });

    expect(d.resolveGoalLaunch).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      goalId: 'goal-1',
      launcherOwnerId: 'system-watchdog',
      goalRole: 'goal',
      requested: {},
    });
    expect(d.launch).toHaveBeenCalledWith({
      slug: 'hive-1',
      agent: 'codex',
      model: 'gpt-5.6-sol:xhigh',
      account: 'auto',
      contextSize: 'trimmed',
      headless: true,
      mode: 'auto',
      deferSpawn: false,
    });
  });

  it('surfaces a resolver refusal and never calls launch-su', async () => {
    const d = deps(
      resolution({
        refusal: {
          reason: 'goal_budget_exceeded',
          limit: 100,
          current: 100,
          requested: 1,
          message: 'budget exhausted',
        },
      }),
    );

    await expect(
      launchGoalHolderSession({ workspaceId: 'workspace-1', goalId: 'goal-1', harnessSlug: 'hive-1' }, d),
    ).rejects.toThrow('goal-holder-launch refused for goal-1: budget exhausted');
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('returns every degraded-policy and launch-su warning', async () => {
    const d = deps(
      resolution({
        degraded: true,
        degradedReasons: ['headcount read failed', 'settings malformed'],
      }),
    );
    d.launch.mockResolvedValue({ ok: true, ownerId: 'su-new-holder', warning: 'process liveness unconfirmed' });

    await expect(
      launchGoalHolderSession({ workspaceId: 'workspace-1', goalId: 'goal-1', harnessSlug: 'hive-1' }, d),
    ).resolves.toEqual({
      ownerId: 'su-new-holder',
      warnings: [
        'launch policy degraded: headcount read failed',
        'launch policy degraded: settings malformed',
        'launch-su warning: process liveness unconfirmed',
      ],
    });
  });

  it('requires launch-su to return the owner id the reconciler must attach', async () => {
    const d = deps();
    d.launch.mockResolvedValue({ ok: true });

    await expect(
      launchGoalHolderSession({ workspaceId: 'workspace-1', goalId: 'goal-1', harnessSlug: 'hive-1' }, d),
    ).rejects.toThrow('succeeded without the pre-pinned ownerId');
  });

  it('reads goal identity from the system action payload and logs degradations', async () => {
    const d = deps(resolution({ degraded: true, degradedReasons: ['headcount unavailable'] }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      runGoalHolderLaunchAction(
        {
          workspaceId: 'workspace-1',
          installSlug: 'hive-1',
          triggerConfig: {},
          payloadTemplate: { goalId: 'goal-1', launcherOwnerId: 'system-watchdog' },
        },
        d,
      ),
    ).resolves.toMatchObject({ ownerId: 'su-new-holder' });
    expect(warn).toHaveBeenCalledWith(
      '[goal-holder-launch] goal-1: launch policy degraded: headcount unavailable',
    );
    warn.mockRestore();
  });

  it('refuses a system fire with no goal id', async () => {
    await expect(
      runGoalHolderLaunchAction(
        { workspaceId: 'workspace-1', installSlug: 'hive-1', triggerConfig: {}, payloadTemplate: null },
        deps(),
      ),
    ).rejects.toThrow('goal-holder-launch requires goalId');
  });
});
