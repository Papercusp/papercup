import { describe, expect, it, vi } from 'vitest';
import type { GoalLaunchResolution, GoalPortfolioBrief } from '../../goal-launch-settings';
import {
  launchGoalHolderSession,
  neutralizeGoalHolderSession,
  runGoalHolderLaunchAction,
  type GoalHolderLaunchDeps,
} from './goal-holder-launch-action';

function resolution(overrides: Partial<GoalLaunchResolution> = {}): GoalLaunchResolution {
  return {
    goalId: 'goal-1',
    settings: null,
    goalBrief: {
      title: 'Keep the queue moving',
      body: 'Own the unclaimed frontier and keep work moving.',
      killCriterion: 'the stewardship goal is explicitly stopped',
      budgetCents: 1_000,
      budgetWindowSec: 604_800,
      standing: true,
    },
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

function portfolio(): GoalPortfolioBrief {
  return {
    schemaVersion: 1,
    assembledAt: '2026-08-28T02:30:00.000Z',
    goal: {
      id: 'goal-1',
      title: 'Keep the queue moving',
      status: 'active',
      body: null,
      killCriterion: null,
      standing: true,
      parentId: null,
    },
    worklist: [],
    pots: [],
    drainFleet: {
      slug: null,
      exists: null,
      controlState: null,
      leaderOwnerId: null,
      live: null,
      working: null,
    },
    queue: {
      total: 1,
      terminal: 0,
      inFlight: 0,
      blocked: 0,
      needsHuman: 0,
      claimable: 1,
      claimabilityScope: 'issue-family',
    },
    launch: {
      settings: null,
      ceilings: { maxAgents: 12, maxPerFleet: 5 },
      headcount: { total: 1, fleet: null },
    },
    budget: {
      budgetCents: 1_000,
      spentCents: 0,
      spentCentsAt: null,
      spentCentsSource: null,
      budgetWindowSec: 604_800,
    },
    tripwires: [],
    pending: { blenderIdeas: 0, acceptanceRubric: null },
    continuity: { checkpoint: null, lastOwnerReportAt: null },
    priorities: ['Delegate the next item.'],
    degradedReasons: [],
  };
}

function deps(resolved: GoalLaunchResolution = resolution()): GoalHolderLaunchDeps & {
  resolveGoalLaunch: ReturnType<typeof vi.fn>;
  launch: ReturnType<typeof vi.fn>;
} {
  return {
    resolveGoalLaunch: vi.fn(async () => resolved),
    launch: vi.fn(async () => ({ ok: true, ownerId: 'su-new-holder' })),
    readHistory: vi.fn(
      async (goalId: string) =>
        ({
          status: 'available',
          brief: { fingerprint: `history-for-${goalId}` },
          recovery: { tool: 'goals:get', args: { id: goalId, detail: 'full' } },
        }) as never,
    ),
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
    expect(d.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'hive-1',
        agent: 'codex',
        model: 'gpt-5.6-sol:xhigh',
        account: 'auto',
        contextSize: 'trimmed',
        headless: true,
        mode: 'auto',
        deferSpawn: false,
      }),
    );
    const kickoff = d.launch.mock.calls[0]?.[0]?.kickoffPrompt as string;
    expect(kickoff).toContain('You are in GOAL mode on goal `goal-1`');
    expect(kickoff).toContain('OUTCOME — Keep the queue moving');
    expect(kickoff).toContain('KILL THIS IF — the stewardship goal is explicitly stopped');
    expect(kickoff).toContain('CEILING — $10.00 per week');
  });

  it('threads the kickoff brief to launch-su as the first turn (P-017)', async () => {
    const d = deps();
    await launchGoalHolderSession(
      { workspaceId: 'workspace-1', goalId: 'goal-1', harnessSlug: 'hive-1', kickoffPrompt: 'first-turn brief' },
      d,
    );
    const kickoff = d.launch.mock.calls[0]?.[0]?.kickoffPrompt as string;
    expect(kickoff).toContain('first-turn brief');
    expect(kickoff).toContain('GOAL HISTORY — own and bounded descendant evidence');
    expect(kickoff).toContain('history-for-goal-1');
  });

  it('appends the canonical portfolio to an explicit recovery kickoff exactly once', async () => {
    const base = resolution().goalBrief!;
    const d = deps(resolution({ goalBrief: { ...base, portfolio: portfolio() } }));

    await launchGoalHolderSession(
      { workspaceId: 'workspace-1', goalId: 'goal-1', harnessSlug: 'hive-1', kickoffPrompt: 'recovery context' },
      d,
    );

    const kickoff = d.launch.mock.calls[0]?.[0]?.kickoffPrompt as string;
    expect(kickoff).toContain('recovery context');
    expect(kickoff).toContain('GOAL PORTFOLIO SNAPSHOT — assembled 2026-08-28T02:30:00.000Z');
    expect(kickoff.match(/GOAL PORTFOLIO SNAPSHOT —/g)).toHaveLength(1);
  });

  it('uses an activation-supplied resolution without performing a second policy/portfolio read', async () => {
    const resolved = resolution({
      goalBrief: { ...resolution().goalBrief!, portfolio: portfolio() },
    });
    const d = deps(resolution());

    await launchGoalHolderSession(
      {
        workspaceId: 'workspace-1',
        goalId: 'goal-1',
        harnessSlug: 'hive-1',
        resolvedLaunch: resolved,
      },
      d,
    );

    expect(d.resolveGoalLaunch).not.toHaveBeenCalled();
    expect(d.launch.mock.calls[0]?.[0]?.kickoffPrompt).toContain(
      'GOAL PORTFOLIO SNAPSHOT — assembled 2026-08-28T02:30:00.000Z',
    );
  });

  it('rejects a supplied resolution for a different goal before launch', async () => {
    const d = deps();

    await expect(
      launchGoalHolderSession(
        {
          workspaceId: 'workspace-1',
          goalId: 'goal-1',
          harnessSlug: 'hive-1',
          resolvedLaunch: resolution({ goalId: 'other-goal' }),
        },
        d,
      ),
    ).rejects.toThrow('supplied launch resolution targets other-goal');
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('refuses to launch a mute holder when neither an override nor stored goal brief is available', async () => {
    const d = deps(resolution({ goalBrief: null }));
    await expect(
      launchGoalHolderSession({ workspaceId: 'workspace-1', goalId: 'goal-1', harnessSlug: 'hive-1' }, d),
    ).rejects.toThrow('without the goal fields needed to build a canonical first-turn kickoff');
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('surfaces a resolver refusal and never calls launch-su', async () => {
    const d = deps(
      resolution({
        refusal: {
          reason: 'goal_budget_exceeded',
          limit: 100,
          current: 100,
          requested: 1,
          currentScope: 'inside-goal-pots:authoritative',
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
    expect(warn).toHaveBeenCalledWith('[goal-holder-launch] goal-1: launch policy degraded: headcount unavailable');
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

  it('neutralizes a launched replacement whose holder attach CAS loses', async () => {
    const deactivate = vi.fn(async () => true);
    const clearAuto = vi.fn(async () => true);
    const notifyOrders = vi.fn(async () => {});
    const message = vi.fn(async () => {});
    const wake = vi.fn(async () => ({ woken: 1, staged: 0 }));

    const result = await neutralizeGoalHolderSession(
      {
        workspaceId: 'workspace-1',
        goalId: 'goal-1',
        ownerId: 'su-stale-replacement',
        reason: 'expected epoch 3, found epoch 4',
      },
      { deactivate, clearAuto, notifyOrders, message, wake },
    );

    expect(deactivate).toHaveBeenCalledWith('su-stale-replacement', expect.stringContaining('epoch 4'));
    expect(clearAuto).toHaveBeenCalledWith('workspace-1', 'su-stale-replacement', expect.stringContaining('epoch 4'));
    expect(message).toHaveBeenCalledWith(
      'su-stale-replacement',
      expect.any(String),
      expect.stringContaining('AUTO and the recurring loop were disabled'),
    );
    expect(wake).toHaveBeenCalledWith('su-stale-replacement', expect.any(String), 'workspace-1');
    expect(result).toEqual({ loopDeactivated: true, autoCleared: true, woken: 1, staged: 0 });
  });
});
