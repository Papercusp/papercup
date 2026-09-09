import { describe, expect, it, vi } from 'vitest';
import type { SystemActionCtx } from '../harness/routines/system-actions';
import type { DreamCycleResult } from './dream-cycle';
import { makeDreamCycleAction, parseDreamCycleActionConfig } from './dream-cycle-action';

const CTX: SystemActionCtx = {
  installSlug: 'papercusp',
  workspaceId: 'ws-1',
  triggerConfig: { cron: '0 */5 * * * *' },
  payloadTemplate: null,
};

function result(overrides: Partial<DreamCycleResult> = {}): DreamCycleResult {
  return {
    fired: true,
    reason: 'completed',
    cycleId: 'cycle-1',
    attempts: 1,
    accepted: 0,
    costUsd: 0.02,
    newSpendUsd: 0.02,
    runs: [],
    ...overrides,
  };
}

describe('parseDreamCycleActionConfig', () => {
  it('refuses a declared pilot without its frozen protocol rather than treating it as an ordinary manual cycle', () => {
    expect(() => parseDreamCycleActionConfig({ mode: 'manual', pilot: null })).toThrow();
    expect(() => parseDreamCycleActionConfig({ mode: 'manual', pilot: { arm: 'structured-pair' } })).toThrow();
  });

  it('defaults the Start/Pause routine to manual mode and preserves bounded overrides', () => {
    expect(parseDreamCycleActionConfig(null)).toEqual({ mode: 'manual' });
    expect(
      parseDreamCycleActionConfig({
        mode: 'auto',
        cycle: { maxDreamsPerCycle: 1 },
        sampler: { arity: 2 },
      }),
    ).toEqual({
      mode: 'auto',
      cycle: { maxDreamsPerCycle: 1 },
      sampler: { arity: 2 },
    });
  });

  it('rejects an unknown mode instead of silently turning it into automatic spend', () => {
    expect(() => parseDreamCycleActionConfig({ mode: 'background' })).toThrow('unsupported dream-cycle mode');
  });
  it('rejects legacy sampler knobs, invalid money and attempts above the fixed ceiling', () => {
    expect(() => parseDreamCycleActionConfig({ sampler: { randomPartnerRate: 1 } })).toThrow('Unsupported');
    expect(() => parseDreamCycleActionConfig({ cycle: { maxCostUsd: -1 } })).toThrow('finite');
    expect(() => parseDreamCycleActionConfig({ cycle: { rolling24hCostUsd: Infinity } })).toThrow('finite');
    expect(() => parseDreamCycleActionConfig({ cycle: { maxDreamsPerCycle: 4 } })).toThrow('ceiling');
  });
  it('preserves explicitly configured larger monetary limits for the production governor', () => {
    expect(parseDreamCycleActionConfig({ cycle: { maxCostUsd: 10, rolling24hCostUsd: 200 } })).toMatchObject({
      mode: 'manual', cycle: { maxCostUsd: 10, rolling24hCostUsd: 200 },
    });
  });
});

describe('makeDreamCycleAction', () => {
  it('gates the whole surface on DREAM_CYCLE', async () => {
    const runCycle = vi.fn(async () => result());
    const idleAllowed = vi.fn(async () => true);
    const readIdleRatio = vi.fn(async () => 1);
    const log = vi.fn();
    const action = makeDreamCycleAction({
      featureEnabled: vi.fn(async () => false),
      idleAllowed,
      readIdleRatio,
      runCycle,
      log,
    });

    await action(CTX);

    expect(runCycle).not.toHaveBeenCalled();
    expect(idleAllowed).not.toHaveBeenCalled();
    expect(readIdleRatio).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('DREAM_CYCLE feature flag is OFF'));
  });

  it('runs a manual Start/Pause fire without consulting automatic-idle gates', async () => {
    const runCycle = vi.fn(async () => result());
    const idleAllowed = vi.fn(async () => false);
    const readIdleRatio = vi.fn(async () => 0);
    const action = makeDreamCycleAction({
      featureEnabled: vi.fn(async () => true),
      idleAllowed,
      readIdleRatio,
      runCycle,
      log: vi.fn(),
    });

    await action({ ...CTX, payloadTemplate: { mode: 'manual' } });

    expect(runCycle).toHaveBeenCalledWith(expect.objectContaining({ installSlug: 'papercusp' }), { mode: 'manual' });
    expect(idleAllowed).not.toHaveBeenCalled();
    expect(readIdleRatio).not.toHaveBeenCalled();
  });

  it('keeps automatic dreaming dark when the separate owner steering toggle is off', async () => {
    const runCycle = vi.fn(async () => result());
    const readIdleRatio = vi.fn(async () => 1);
    const action = makeDreamCycleAction({
      featureEnabled: vi.fn(async () => true),
      idleAllowed: vi.fn(async () => false),
      readIdleRatio,
      runCycle,
      log: vi.fn(),
    });

    await action({ ...CTX, payloadTemplate: { mode: 'auto' } });

    expect(runCycle).not.toHaveBeenCalled();
    expect(readIdleRatio).not.toHaveBeenCalled();
  });

  it('requires measured idle headroom before an enabled auto routine can spend', async () => {
    const runCycle = vi.fn(async () => result());
    const readIdleRatio = vi.fn().mockResolvedValueOnce(0.49).mockResolvedValueOnce(0.5);
    const action = makeDreamCycleAction({
      featureEnabled: vi.fn(async () => true),
      idleAllowed: vi.fn(async () => true),
      readIdleRatio,
      runCycle,
      log: vi.fn(),
    });
    const auto = { ...CTX, payloadTemplate: { mode: 'auto', cycle: { autoIdleRatioFloor: 0.5 } } };

    await action(auto);
    expect(runCycle).not.toHaveBeenCalled();

    await action(auto);
    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(runCycle).toHaveBeenCalledWith(auto, {
      mode: 'auto',
      cycle: { autoIdleRatioFloor: 0.5 },
    });
  });
});
