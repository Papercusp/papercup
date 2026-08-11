/**
 * cadence-signals.test.ts — Scout P-008 idle/friction signal readers.
 * Unit-tests the idle-ratio math + friction passthrough over injected deps (no PG).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { countLiveAgents, readHiveIdleRatio, readFrictionSignalCount, scoutFleetCapacity } from './cadence-signals';

describe('countLiveAgents', () => {
  const NOW = Date.parse('2026-08-11T20:00:00Z');

  it('counts distinct fresh su/fleet presence and excludes stale or invalid rows', async () => {
    const seen: { workspaceId?: string } = {};
    const count = await countLiveAgents('workspace-a', {
      listPresence: async (opts) => {
        seen.workspaceId = opts.workspaceId;
        return [
          { ownerId: 'su-1', heartbeatAt: new Date(NOW - 1_000).toISOString() },
          { ownerId: 'su-1', heartbeatAt: new Date(NOW - 2_000).toISOString() },
          { ownerId: 'su-2', heartbeatAt: new Date(NOW - 59_999).toISOString() },
          { ownerId: 'stale', heartbeatAt: new Date(NOW - 60_000).toISOString() },
          { ownerId: 'invalid', heartbeatAt: 'not-a-date' },
        ];
      },
      now: () => NOW,
      staleMs: 60_000,
    });

    expect(seen.workspaceId).toBe('workspace-a');
    expect(count).toBe(2);
  });
});

describe('readHiveIdleRatio', () => {
  const ws = 'w';
  it('1.0 when nothing is running', async () => {
    expect(await readHiveIdleRatio({ workspaceId: ws, capacity: 12 }, { countLive: async () => 0 })).toBe(1);
  });
  it('0.5 at half capacity', async () => {
    expect(await readHiveIdleRatio({ workspaceId: ws, capacity: 12 }, { countLive: async () => 6 })).toBeCloseTo(0.5, 9);
  });
  it('clamps to 0 at/over capacity', async () => {
    expect(await readHiveIdleRatio({ workspaceId: ws, capacity: 12 }, { countLive: async () => 12 })).toBe(0);
    expect(await readHiveIdleRatio({ workspaceId: ws, capacity: 12 }, { countLive: async () => 30 })).toBe(0);
  });
  it('uses the default capacity when none/invalid given', async () => {
    // PAPERCUSP_SCOUT_FLEET_CAPACITY default = 12 → running 0 → idle 1.
    expect(await readHiveIdleRatio({ workspaceId: ws, capacity: 0 }, { countLive: async () => 0 })).toBe(1);
  });

  it('a NEGATIVE capacity falls back to the default too (ratio stays sane)', async () => {
    // 0 running ⇒ fully idle regardless of which positive capacity applies.
    expect(await readHiveIdleRatio({ workspaceId: ws, capacity: -4 }, { countLive: async () => 0 })).toBe(1);
  });

  it('a non-finite running count fails SAFE to 0 (never idle-fires the cadence gate)', async () => {
    expect(await readHiveIdleRatio({ workspaceId: ws, capacity: 12 }, { countLive: async () => Number.NaN })).toBe(0);
  });

  it('fractional load: 9 of 12 running → 0.25 idle', async () => {
    expect(await readHiveIdleRatio({ workspaceId: ws, capacity: 12 }, { countLive: async () => 9 })).toBeCloseTo(0.25, 9);
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
