/**
 * cadence-signals.test.ts — Scout P-008 idle/friction signal readers.
 * Unit-tests the idle-ratio math + friction passthrough over injected deps (no PG).
 */
import { describe, it, expect } from 'vitest';
import { readHiveIdleRatio, readFrictionSignalCount } from './cadence-signals';

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
