import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/flags', () => ({ FLAGS: { CALIBRATION_MARKETS: 'papercusp-calibration-markets' } }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn() }));

// Importing the module registers the `calibration-resolve` system action.
import { setCalibrationGovernorGate, setCalibrationSweepDeps } from './calibration-action';
import { getSystemAction } from './system-actions';
import { getFlag } from '@papercusp/flags/server';
import type { Sql } from 'postgres';
import type { CalibrationSweepDeps } from '../../calibration/resolve-sweep';

const ctx = (over: Record<string, unknown> = {}) => ({
  installSlug: 'pot',
  workspaceId: 'ws-1',
  triggerConfig: {},
  payloadTemplate: null,
  ...over,
});
const run = (over: Record<string, unknown> = {}) =>
  getSystemAction('calibration-resolve')!(ctx(over) as never);

function spyDeps(): CalibrationSweepDeps & { list: ReturnType<typeof vi.fn> } {
  return {
    sql: {} as Sql,
    probes: {
      fixSurvived: vi.fn(async () => true),
      planShipped: vi.fn(async () => true),
      flakeRecurred: vi.fn(async () => false),
    },
    list: vi.fn(async () => []),
    resolve: vi.fn(async () => true),
    voidBet: vi.fn(async () => true),
    log: () => {},
  };
}

let deps: ReturnType<typeof spyDeps>;
beforeEach(() => {
  deps = spyDeps();
  setCalibrationSweepDeps(deps);
  // Governor allows by default — the gate's own verdicts live in
  // lib/calibration/governor.test.ts; here we pin the action's wiring.
  setCalibrationGovernorGate(async () => ({ allow: true, remainingUsd: 0 }));
  vi.mocked(getFlag).mockResolvedValue(true as never);
});
afterEach(() => {
  setCalibrationSweepDeps(null);
  setCalibrationGovernorGate(null);
  vi.clearAllMocks();
});

describe('system:calibration-resolve (self-learning-frontier P-041 / FB-13)', () => {
  it('registers as a system action', () => {
    expect(getSystemAction('calibration-resolve')).toBeTypeOf('function');
  });

  it('flag OFF → no sweep (the frontier D-001 arming gate)', async () => {
    vi.mocked(getFlag).mockResolvedValue(false as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.list).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('governor refusal → no sweep (D-004 unattended-refusal)', async () => {
    setCalibrationGovernorGate(async () => ({ allow: false, reason: 'unbudgeted', remainingUsd: null }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.list).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('armed → sweeps with the default batch cap', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.list).toHaveBeenCalledTimes(1);
      expect(deps.list.mock.calls[0][1]).toMatchObject({ workspaceId: 'ws-1', limit: 200 });
    } finally {
      log.mockRestore();
    }
  });

  it('payload maxPerTick caps the sweep batch', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run({ payloadTemplate: { maxPerTick: 25 } });
      expect(deps.list.mock.calls[0][1]).toMatchObject({ limit: 25 });
    } finally {
      log.mockRestore();
    }
  });

  it('a failing sweep never throws out of the durable step', async () => {
    deps.list.mockRejectedValue(new Error('pg down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(run()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});
