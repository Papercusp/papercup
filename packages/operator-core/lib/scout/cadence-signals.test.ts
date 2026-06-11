/**
 * cadence-signals.test.ts — Scout P-008 idle/friction signal readers.
 * Unit-tests the idle-ratio math + friction passthrough over injected deps (no PG).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readHiveIdleRatio, readFrictionSignalCount, scoutFleetCapacity } from './cadence-signals';

describe('readHiveIdleRatio', () => {
  const ws = 'w';
  it('1.0 when nothing is running', async () => {
    expect(await readHiveIdleRatio({ workspaceId: ws, capacity: 12 }, { countRunning: async () => 0 })).toBe(1);
  });
  it('0.5 at half capacity', async () => {
    expect(await readHiveIdleRatio({ workspaceId: ws, capacity: 12 }, { countRunning: async () => 6 })).toBeCloseTo(0.5, 9);
  });
  it('clamps to 0 at/over capacity', async () => {
    expect(await readHiveIdleRatio({ workspaceId: ws, capacity: 12 }, { countRunning: async () => 12 })).toBe(0);
    expect(await readHiveIdleRatio({ workspaceId: ws, capacity: 12 }, { countRunning: async () => 30 })).toBe(0);
  });
  it('uses the default capacity when none/invalid given', async () => {
    // PAPERCUSP_SCOUT_FLEET_CAPACITY default = 12 → running 0 → idle 1.
    expect(await readHiveIdleRatio({ workspaceId: ws, capacity: 0 }, { countRunning: async () => 0 })).toBe(1);
  });

  it('a NEGATIVE capacity falls back to the default too (ratio stays sane)', async () => {
    // 0 running ⇒ fully idle regardless of which positive capacity applies.
    expect(await readHiveIdleRatio({ workspaceId: ws, capacity: -4 }, { countRunning: async () => 0 })).toBe(1);
  });

  it('a non-finite running count fails SAFE to 0 (never idle-fires the cadence gate)', async () => {
    expect(await readHiveIdleRatio({ workspaceId: ws, capacity: 12 }, { countRunning: async () => Number.NaN })).toBe(0);
  });

  it('fractional load: 9 of 12 running → 0.25 idle', async () => {
    expect(await readHiveIdleRatio({ workspaceId: ws, capacity: 12 }, { countRunning: async () => 9 })).toBeCloseTo(0.25, 9);
  });
});

describe('scoutFleetCapacity (env knob — scout-loop-test-plan P-005)', () => {
  const KEY = 'PAPERCUSP_SCOUT_FLEET_CAPACITY';
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[KEY];
    delete process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('defaults to 12 with no override', () => {
    expect(scoutFleetCapacity()).toBe(12);
  });

  it('honors a positive override', () => {
    process.env[KEY] = '5';
    expect(scoutFleetCapacity()).toBe(5);
  });

  it('rejects zero / negative / garbage overrides → default 12', () => {
    for (const v of ['0', '-3', 'abc']) {
      process.env[KEY] = v;
      expect(scoutFleetCapacity()).toBe(12);
    }
  });
});

describe('readFrictionSignalCount', () => {
  it('returns the open-backlog count', async () => {
    const n = await readFrictionSignalCount({ harnessSlug: 'h' }, { readOpenImprovements: async () => ({ length: 7 }) });
    expect(n).toBe(7);
  });
  it('passes the harness scope through', async () => {
    let scope: string | undefined;
    await readFrictionSignalCount(
      { harnessSlug: 'papercup' },
      { readOpenImprovements: async (h) => { scope = h; return { length: 0 }; } },
    );
    expect(scope).toBe('papercup');
  });
});
