import { describe, expect, it, vi } from 'vitest';
import {
  DEAD_TARGET_REAPER_SWEEP,
  SCOUT_SIGNAL_ACCUMULATOR_SWEEP,
  makeDeadTargetReaperSweepAction,
  makeScoutSignalAccumulatorSweepAction,
} from './heavy-maintenance-sweep-actions';
import { getSystemAction, type SystemActionCtx } from './system-actions';

const CTX: SystemActionCtx = {
  installSlug: 'papercusp',
  workspaceId: 'papercusp-workspace',
  triggerConfig: {},
  payloadTemplate: null,
};

describe('heavy maintenance sweep actions', () => {
  it('registers both extracted sweeps on the canonical system-action seam', () => {
    expect(getSystemAction(SCOUT_SIGNAL_ACCUMULATOR_SWEEP)).toBeTypeOf('function');
    expect(getSystemAction(DEAD_TARGET_REAPER_SWEEP)).toBeTypeOf('function');
  });

  it('sheds the signal recount before it performs any work and records the reason durably', async () => {
    const run = vi.fn(async () => []);
    const warn = vi.fn();
    const action = makeScoutSignalAccumulatorSweepAction({ shouldShed: () => true, run, warn });

    await expect(action(CTX)).resolves.toEqual({
      diagnostics: { action: SCOUT_SIGNAL_ACCUMULATOR_SWEEP, outcome: 'shed' },
    });
    expect(run).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('shed'));
  });

  it('retains signal coverage without double-counting workspace-wide backlog across scopes', async () => {
    const warn = vi.fn();
    const action = makeScoutSignalAccumulatorSweepAction({
      shouldShed: () => false,
      warn,
      run: async () => [
        {
          workspaceId: 'ws-a',
          installSlug: 'hive-a',
          outcome: 'swept',
          evaluatedWorkspaceCount: 2,
          evaluatedScopeCount: 3,
          eligibleBacklogCount: 5,
          score: 8,
          reason: 'ok',
        },
        {
          workspaceId: 'ws-a',
          installSlug: 'hive-b',
          outcome: 'swept',
          evaluatedWorkspaceCount: 2,
          evaluatedScopeCount: 3,
          eligibleBacklogCount: 5,
          score: 8,
          reason: 'ok',
        },
        {
          workspaceId: 'ws-b',
          installSlug: 'hive-c',
          outcome: 'error',
          evaluatedWorkspaceCount: 2,
          evaluatedScopeCount: 3,
          eligibleBacklogCount: 3,
          score: 4,
          reason: 'read failed',
        },
      ],
    });

    const result = await action(CTX);
    expect(result).toMatchObject({
      diagnostics: {
        action: SCOUT_SIGNAL_ACCUMULATOR_SWEEP,
        outcome: 'ran',
        resultCount: 3,
        errorCount: 1,
        evaluatedWorkspaceCount: 2,
        evaluatedScopeCount: 3,
        eligibleBacklogCount: 8,
      },
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('keeps the reaper quiet for healthy/protected rows and surfaces actionable outcomes', async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const action = makeDeadTargetReaperSweepAction({
      shouldShed: () => false,
      info,
      warn,
      run: async () => [
        { installSlug: 'home', outcome: 'protected', state: 'not-probed', reason: 'home' },
        { installSlug: 'good', outcome: 'healthy', state: 'ok', reason: 'readable' },
        { installSlug: 'maybe', outcome: 'confirming', state: 'root-missing', reason: 'first sighting' },
        { installSlug: 'dead', outcome: 'parked', state: 'git-corrupt', reason: 'confirmed' },
        { installSlug: 'bad-read', outcome: 'error', state: 'not-probed', reason: 'query failed' },
      ],
    });

    const result = await action(CTX);
    expect(result).toMatchObject({
      diagnostics: {
        action: DEAD_TARGET_REAPER_SWEEP,
        outcome: 'ran',
        resultCount: 5,
        errorCount: 1,
        outcomeCounts: { protected: 1, healthy: 1, confirming: 1, parked: 1, error: 1 },
      },
    });
    expect(info).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
