/**
 * Recurrence coverage for EI-21270032782365521.
 *
 * The incident existed only because independent operator workers each had
 * correct-looking process-local limits. These tests therefore use separate
 * local-state objects (worker realms) against one shared fake resource store;
 * a one-Map test in the endpoint module cannot prove the cross-worker bound.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  guardMidTurnMemoryAdmission,
  MID_TURN_MEMORY_MAX_HOLDERS,
  type MidTurnAdmissionLocalState,
  type MidTurnAdmissionStore,
} from './mid-turn-admission';

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

function sharedStore(capacity = MID_TURN_MEMORY_MAX_HOLDERS) {
  const active = new Map<string, string>();
  const acquireOwners: string[] = [];
  const releaseOwners: string[] = [];
  let lockSeq = 0;
  const store: MidTurnAdmissionStore = {
    ensureRegistered: async () => true,
    async tryAcquire(ownerId) {
      acquireOwners.push(ownerId);
      if (active.size >= capacity && !active.has(ownerId)) {
        return { ok: false, reason: 'at_capacity' };
      }
      const lockId = active.get(ownerId) ?? `lock-${++lockSeq}`;
      active.set(ownerId, lockId);
      return { ok: true, lockId };
    },
    async release(ownerId, lockId) {
      releaseOwners.push(ownerId);
      if (active.get(ownerId) !== lockId) throw new Error('wrong lock release');
      active.delete(ownerId);
    },
  };
  return { store, active, acquireOwners, releaseOwners };
}

const workerState = (): MidTurnAdmissionLocalState => ({ inFlight: false });

describe('mid-turn host admission — independent worker realms', () => {
  it('admits at most two workers host-wide, then admits the next after release', async () => {
    const shared = sharedStore(2);
    const holdA = deferred();
    const holdB = deferred();
    const startedA = deferred();
    const startedB = deferred();

    const a = guardMidTurnMemoryAdmission(
      { ownerId: 'worker-a', state: workerState(), store: shared.store },
      async () => {
        startedA.resolve();
        await holdA.promise;
        return 'a';
      },
    );
    const b = guardMidTurnMemoryAdmission(
      { ownerId: 'worker-b', state: workerState(), store: shared.store },
      async () => {
        startedB.resolve();
        await holdB.promise;
        return 'b';
      },
    );
    await Promise.all([startedA.promise, startedB.promise]);
    expect(shared.active.size).toBe(2);

    const thirdState = workerState();
    await expect(
      guardMidTurnMemoryAdmission(
        { ownerId: 'worker-c', state: thirdState, store: shared.store },
        async () => 'should-not-run',
      ),
    ).resolves.toEqual({ admitted: false, reason: 'at_capacity' });

    holdA.resolve();
    await expect(a).resolves.toEqual({ admitted: true, value: 'a' });
    await expect(
      guardMidTurnMemoryAdmission(
        { ownerId: 'worker-c', state: thirdState, store: shared.store },
        async () => 'c',
      ),
    ).resolves.toEqual({ admitted: true, value: 'c' });

    holdB.resolve();
    await expect(b).resolves.toEqual({ admitted: true, value: 'b' });
    expect(shared.active.size).toBe(0);
  });

  it('drops a same-worker overlap before shared-store I/O', async () => {
    const shared = sharedStore(2);
    const state = workerState();
    const hold = deferred();
    const started = deferred();
    const first = guardMidTurnMemoryAdmission(
      { ownerId: 'worker-a', state, store: shared.store },
      async () => {
        started.resolve();
        await hold.promise;
        return 'first';
      },
    );
    await started.promise;

    await expect(
      guardMidTurnMemoryAdmission(
        { ownerId: 'worker-a', state, store: shared.store },
        async () => 'second',
      ),
    ).resolves.toEqual({ admitted: false, reason: 'local_in_flight' });
    expect(shared.acquireOwners).toEqual(['worker-a']);

    hold.resolve();
    await expect(first).resolves.toEqual({ admitted: true, value: 'first' });
  });

  it('releases the host slot when the guarded memory build throws', async () => {
    const shared = sharedStore(1);
    const state = workerState();
    await expect(
      guardMidTurnMemoryAdmission(
        { ownerId: 'worker-a', state, store: shared.store },
        async () => {
          throw new Error('memory build failed');
        },
      ),
    ).rejects.toThrow('memory build failed');
    expect(shared.active.size).toBe(0);
    expect(shared.releaseOwners).toEqual(['worker-a']);
    expect(state.inFlight).toBe(false);
  });

  it('fails soft and does not run optional work when admission storage is unavailable', async () => {
    const run = vi.fn(async () => 'memory');
    const store = sharedStore().store;
    store.ensureRegistered = async () => {
      throw new Error('locks db unavailable');
    };
    await expect(
      guardMidTurnMemoryAdmission(
        { ownerId: 'worker-a', state: workerState(), store },
        run,
      ),
    ).resolves.toEqual({ admitted: false, reason: 'admission_unavailable' });
    expect(run).not.toHaveBeenCalled();
  });
});

