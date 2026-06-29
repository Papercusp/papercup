/**
 * ephemeral-executor — P-012 unit tests. Drives the executor over the
 * @papercusp/scheduled-registry configure-seam (a captured fake setInterval) so ticks fire
 * deterministically, with stub list/fire/recordFire deps. Proves: one managed timer per active
 * ephemeral routine (category 'ephemeral-harness'), the floor clamp, fire→liveness recording
 * (incl. the error path), event-driven sync/unarm, and disarm.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  configureScheduledRegistry,
  resetScheduledRegistry,
  listManaged,
  getManaged,
} from '@papercusp/scheduled-registry';
import {
  armEphemeralExecutor,
  disarmEphemeralExecutor,
  ephemeralExecutorArmed,
  armedEphemeralIds,
  syncEphemeralRoutine,
  unarmEphemeralRoutine,
  type EphemeralExecutorDeps,
  type EphemeralRoutineSpec,
} from './ephemeral-executor';

const spec = (over: Partial<EphemeralRoutineSpec> = {}): EphemeralRoutineSpec => ({
  id: 'r1',
  workspaceId: 'ws',
  installSlug: 'papercup',
  name: 'sweep',
  targetRole: 'system:foo',
  intervalSec: 5,
  payloadTemplate: null,
  triggerConfig: { interval_sec: 5 },
  ...over,
});

// Captured registry ticks (the registry's makeTick wrapper + the intervalMs it was armed with).
let ticks: Array<{ cb: () => void; ms: number }>;
function installFakeRegistry(): void {
  ticks = [];
  configureScheduledRegistry({
    setIntervalImpl: (cb, ms) => {
      ticks.push({ cb, ms });
      return { unref() {} };
    },
    clearIntervalImpl: () => {},
    // fireOnArm uses setTimeout(0); the executor doesn't set fireOnArm, but stub it anyway.
    setTimeoutImpl: () => ({ unref() {} }),
  });
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const mkDeps = (over: Partial<EphemeralExecutorDeps> = {}): { deps: EphemeralExecutorDeps; fired: EphemeralRoutineSpec[]; recorded: Array<{ id: string; error: string | null }> } => {
  const fired: EphemeralRoutineSpec[] = [];
  const recorded: Array<{ id: string; error: string | null }> = [];
  const deps: EphemeralExecutorDeps = {
    list: async () => [spec()],
    fire: async (r) => {
      fired.push(r);
    },
    recordFire: async (r, error) => {
      recorded.push({ id: r.id, error });
    },
    log: () => {},
    ...over,
  };
  return { deps, fired, recorded };
};

afterEach(() => {
  disarmEphemeralExecutor();
  resetScheduledRegistry();
});

describe('armEphemeralExecutor', () => {
  it('arms ONE managed timer per active ephemeral routine (category ephemeral-harness)', async () => {
    installFakeRegistry();
    const { deps } = mkDeps({ list: async () => [spec({ id: 'a' }), spec({ id: 'b' })] });
    await armEphemeralExecutor(deps);
    expect(ephemeralExecutorArmed()).toBe(true);
    expect(armedEphemeralIds().sort()).toEqual(['a', 'b']);
    const names = listManaged().map((e) => e.name).sort();
    expect(names).toEqual(['ephemeral:a', 'ephemeral:b']);
    expect(getManaged('ephemeral:a')?.category).toBe('ephemeral-harness');
    expect(getManaged('ephemeral:a')?.shed).toBe(true);
  });

  it('is idempotent — a second arm is a no-op', async () => {
    installFakeRegistry();
    const { deps } = mkDeps();
    await armEphemeralExecutor(deps);
    const firstCount = ticks.length;
    await armEphemeralExecutor(deps);
    expect(ticks.length).toBe(firstCount); // no new timers
  });

  it('clamps a sub-floor interval up to the 1s floor; passes a normal cadence through', async () => {
    installFakeRegistry();
    const { deps } = mkDeps({ list: async () => [spec({ id: 'tiny', intervalSec: 0.4 }), spec({ id: 'norm', intervalSec: 5 })] });
    await armEphemeralExecutor(deps);
    expect(ticks.find((t) => t.ms === 1000)).toBeTruthy(); // tiny (0.4s) clamped up to the 1000ms floor
    expect(ticks.find((t) => t.ms === 5000)).toBeTruthy(); // norm (5s) passes through
  });
});

describe('tick → fire + durable liveness', () => {
  it('a tick fires the action then records liveness (no error on success)', async () => {
    installFakeRegistry();
    const { deps, fired, recorded } = mkDeps();
    await armEphemeralExecutor(deps);
    ticks[0].cb(); // simulate the interval firing
    await flush();
    expect(fired.map((f) => f.id)).toEqual(['r1']);
    expect(recorded).toEqual([{ id: 'r1', error: null }]);
  });

  it('records the error when the action throws (liveness still updates — never crashes the tick)', async () => {
    installFakeRegistry();
    const { deps, recorded } = mkDeps({
      fire: async () => {
        throw new Error('boom');
      },
    });
    await armEphemeralExecutor(deps);
    ticks[0].cb();
    await flush();
    expect(recorded).toEqual([{ id: 'r1', error: 'boom' }]);
  });
});

describe('event-driven sync / unarm / disarm', () => {
  it('syncEphemeralRoutine re-arms one routine in place; unarmEphemeralRoutine drops it', async () => {
    installFakeRegistry();
    const { deps } = mkDeps({ list: async () => [spec({ id: 'a' })] });
    await armEphemeralExecutor(deps);
    expect(armedEphemeralIds()).toEqual(['a']);

    syncEphemeralRoutine(spec({ id: 'b' }));
    expect(armedEphemeralIds().sort()).toEqual(['a', 'b']);

    unarmEphemeralRoutine('a');
    expect(armedEphemeralIds()).toEqual(['b']);
    expect(listManaged().some((e) => e.name === 'ephemeral:a')).toBe(false);
  });

  it('disarm stops every timer + deregisters from the inventory', async () => {
    installFakeRegistry();
    const { deps } = mkDeps({ list: async () => [spec({ id: 'a' }), spec({ id: 'b' })] });
    await armEphemeralExecutor(deps);
    disarmEphemeralExecutor();
    expect(ephemeralExecutorArmed()).toBe(false);
    expect(armedEphemeralIds()).toEqual([]);
    expect(listManaged().some((e) => e.name.startsWith('ephemeral:'))).toBe(false);
  });

  it('syncEphemeralRoutine is a no-op when the executor is not armed on this host', () => {
    installFakeRegistry();
    expect(ephemeralExecutorArmed()).toBe(false);
    syncEphemeralRoutine(spec({ id: 'x' }));
    expect(ephemeralExecutorArmed()).toBe(false);
    expect(armedEphemeralIds()).toEqual([]);
  });
});
