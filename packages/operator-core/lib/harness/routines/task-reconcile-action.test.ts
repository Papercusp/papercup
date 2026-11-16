/**
 * WI-6554700010050197 — the `task-reconcile` routine's kernel pass must keep its
 * own cadence while the maintenance passes run.
 *
 * The routine runs under `concurrency: skip`. When the action awaited its
 * maintenance passes (5-45 minutes under load), every lost-watcher close — and
 * the exact `task:terminal:<id>` wake it publishes — waited for the whole long
 * tick. A managed test that exited at 10:52:54Z was closed at 11:02:49Z, two
 * seconds after its waiter timed out. These tests block maintenance forever and
 * prove that the next kernel pass still runs and publishes the
 * `task:terminal:<id>` wake.
 *
 * The module is imported ONCE (statically, during collection): its graph is
 * heavy, and a per-test dynamic import consumed most of a test's timeout under
 * load. The in-flight run is per-process state, so the case that leaves a
 * deliberately blocked run must stay LAST in this file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemActionCtx } from './system-actions';
import type { ReconcileTickResult } from '../../task-manager/reconcile-tick';

const kernel = vi.hoisted(() => ({
  reconcileTick: vi.fn(),
  collectStaleFailedTaskUnits: vi.fn(),
}));

vi.mock('../../task-manager/enabled', () => ({ isTaskManagerEnabled: vi.fn(async () => true) }));
vi.mock('../../task-manager/reconcile-tick', () => ({
  reconcileTick: kernel.reconcileTick,
  createReconcileStageReporter: () => ({ stage() {}, stop() {} }),
}));
vi.mock('../../task-manager/failed-unit-collector', () => ({
  collectStaleFailedTaskUnits: kernel.collectStaleFailedTaskUnits,
}));

import {
  dispatchTaskReconcileMaintenance,
  taskReconcileMaintenanceInFlight,
  taskReconcileSubPassFailures,
} from './task-reconcile-action';
import { getSystemAction } from './system-actions';

const ctx = {
  installSlug: 'papercusp',
  workspaceId: 'ws-task-reconcile-test',
  triggerConfig: { interval_sec: 30 },
  payloadTemplate: null,
} as SystemActionCtx;

const tick = {
  confirmedUnaccounted: [],
  scan: { userManagerRoot: null },
  result: { alive: [] },
} as unknown as ReconcileTickResult;

type Settled<T> = { settled: true; value: T } | { settled: false };

async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms);
  });
  try {
    return await Promise.race([promise.then((value): Settled<T> => ({ settled: true, value })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe('task-reconcile routine: the kernel pass never waits for maintenance (WI-6554700010050197)', () => {
  beforeEach(() => {
    kernel.reconcileTick.mockReset();
    kernel.collectStaleFailedTaskUnits.mockReset();
  });

  it('runs one maintenance at a time, starts again once it settles, and reports a failed run on the following ticks', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let finish!: () => void;
      const blocked = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
      expect(dispatchTaskReconcileMaintenance(ctx, tick, blocked)).toBe(true);
      expect(dispatchTaskReconcileMaintenance(ctx, tick, blocked)).toBe(false);
      await vi.waitFor(() => expect(blocked).toHaveBeenCalledTimes(1));
      finish();
      await taskReconcileMaintenanceInFlight();
      expect(taskReconcileMaintenanceInFlight()).toBeNull();

      // A synchronous throw from a pass is recorded rather than escaping the tick.
      const failing = vi.fn((): Promise<void> => { throw new Error('residue census exploded'); });
      expect(dispatchTaskReconcileMaintenance(ctx, tick, failing)).toBe(true);
      await taskReconcileMaintenanceInFlight();
      expect(taskReconcileSubPassFailures()).toEqual([
        expect.objectContaining({ name: 'task-reconcile-maintenance', message: expect.stringContaining('residue census exploded') }),
      ]);

      // The next successful run clears it.
      expect(dispatchTaskReconcileMaintenance(ctx, tick, async () => {})).toBe(true);
      await taskReconcileMaintenanceInFlight();
      expect(taskReconcileSubPassFailures()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  // Keep LAST: it leaves its maintenance run blocked for the rest of the process.
  it('returns after the kernel pass while a maintenance pass is still blocked, and the next tick publishes the lost-watcher terminal', async () => {
    const action = getSystemAction('task-reconcile');
    if (!action) throw new Error('task-reconcile action was not registered');
    const terminalWakes: string[] = [];
    kernel.reconcileTick
      .mockImplementationOnce(async () => tick)
      // The child exits after tick 1 snapshotted; tick 2 is the first pass that
      // can close the row and publish its exact terminal wake.
      .mockImplementationOnce(async () => {
        terminalWakes.push('task:terminal:0mwj551kt70zm341ck5');
        return tick;
      });
    // The first maintenance pass never finishes during this test.
    kernel.collectStaleFailedTaskUnits.mockImplementation(() => new Promise(() => {}));

    const first = await settleWithin(action(ctx), 5_000);
    expect(first.settled).toBe(true);
    await vi.waitFor(() => expect(kernel.collectStaleFailedTaskUnits).toHaveBeenCalledTimes(1));
    expect(taskReconcileMaintenanceInFlight()).not.toBeNull();

    const second = await settleWithin(action(ctx), 5_000);
    expect(second.settled).toBe(true);
    expect(kernel.reconcileTick).toHaveBeenCalledTimes(2);
    expect(terminalWakes).toEqual(['task:terminal:0mwj551kt70zm341ck5']);
    // Single-flight: the blocked run is not duplicated by the second tick.
    expect(kernel.collectStaleFailedTaskUnits).toHaveBeenCalledTimes(1);
  });
});
