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
  MID_TURN_MEMORY_HEARTBEAT_INTERVAL_MS,
  MID_TURN_MEMORY_MAX_HOLDERS,
  type MidTurnAdmissionLocalState,
  type MidTurnAdmissionStore,
} from './mid-turn-admission';
import { MemoryTimeoutError, runWithTrackedMemoryTimeouts, withMemoryTimeout } from './op-deadline';
import { coalesceEmbedFn } from '../../../../libs/generic/memory/src/embed-coalesce';

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
  const heartbeatOwners: string[] = [];
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
    async heartbeat(ownerId, lockId) {
      heartbeatOwners.push(ownerId);
      if (active.get(ownerId) !== lockId) throw new Error('wrong lock heartbeat');
    },
    async release(ownerId, lockId) {
      releaseOwners.push(ownerId);
      if (active.get(ownerId) !== lockId) throw new Error('wrong lock release');
      active.delete(ownerId);
    },
  };
  return { store, active, acquireOwners, heartbeatOwners, releaseOwners };
}

const workerState = (): MidTurnAdmissionLocalState => ({ inFlight: false });

describe('mid-turn host admission — independent worker realms', () => {
  it('retains the host slot after coalesced cancellation until non-cooperative inference settles', async () => {
    const shared = sharedStore(1);
    const state = workerState();
    const raw = deferred<number[]>();
    let upstream!: AbortSignal;
    const embed = coalesceEmbedFn((_text, signal) => {
      upstream = signal!;
      return raw.promise;
    });
    const lifetime = new AbortController();
    const result = await guardMidTurnMemoryAdmission({
      ownerId: 'worker-a', state, store: shared.store, trackRun: runWithTrackedMemoryTimeouts,
    }, async () => {
      try {
        await withMemoryTimeout(embed('q', lifetime.signal), 'search', 5, lifetime);
      } catch (error) {
        expect(error).toBeInstanceOf(MemoryTimeoutError);
      }
      return 'fail-soft';
    });
    expect(result).toEqual({ admitted: true, value: 'fail-soft' });
    expect(upstream.aborted).toBe(true);
    expect(state.inFlight).toBe(true);
    expect(shared.active.size).toBe(1);
    const next = vi.fn(async () => 'must-not-run');
    await expect(guardMidTurnMemoryAdmission({
      ownerId: 'worker-b', state: workerState(), store: shared.store,
    }, next)).resolves.toEqual({ admitted: false, reason: 'at_capacity' });
    expect(next).not.toHaveBeenCalled();
    raw.resolve([1]);
    await vi.waitFor(() => {
      expect(state.inFlight).toBe(false);
      expect(shared.active.size).toBe(0);
    });
  });

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
      guardMidTurnMemoryAdmission({ ownerId: 'worker-c', state: thirdState, store: shared.store }, async () => 'c'),
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
    const first = guardMidTurnMemoryAdmission({ ownerId: 'worker-a', state, store: shared.store }, async () => {
      started.resolve();
      await hold.promise;
      return 'first';
    });
    await started.promise;

    await expect(
      guardMidTurnMemoryAdmission({ ownerId: 'worker-a', state, store: shared.store }, async () => 'second'),
    ).resolves.toEqual({ admitted: false, reason: 'local_in_flight' });
    expect(shared.acquireOwners).toEqual(['worker-a']);

    hold.resolve();
    await expect(first).resolves.toEqual({ admitted: true, value: 'first' });
  });

  it('releases the host slot when the guarded memory build throws', async () => {
    const shared = sharedStore(1);
    const state = workerState();
    await expect(
      guardMidTurnMemoryAdmission({ ownerId: 'worker-a', state, store: shared.store }, async () => {
        throw new Error('memory build failed');
      }),
    ).rejects.toThrow('memory build failed');
    expect(shared.active.size).toBe(0);
    expect(shared.releaseOwners).toEqual(['worker-a']);
    expect(state.inFlight).toBe(false);
  });

  it('keeps the host and worker slots while a timed-out raw search remains active', async () => {
    const shared = sharedStore(1);
    const firstState = workerState();
    const underlying = deferred<string>();
    let underlyingActive = 1;
    void underlying.promise.then(
      () => {
        underlyingActive -= 1;
      },
      () => {
        underlyingActive -= 1;
      },
    );

    const first = await guardMidTurnMemoryAdmission(
      {
        ownerId: 'worker-a',
        state: firstState,
        store: shared.store,
        trackRun: runWithTrackedMemoryTimeouts,
      },
      async () => {
        try {
          return await withMemoryTimeout(underlying.promise, 'search', 5);
        } catch (error) {
          expect(error).toBeInstanceOf(MemoryTimeoutError);
          return 'fail-soft';
        }
      },
    );

    expect(first).toEqual({ admitted: true, value: 'fail-soft' });
    expect(underlyingActive).toBe(1);
    expect(firstState.inFlight).toBe(true);
    expect(shared.active.size).toBe(1);
    await expect(
      guardMidTurnMemoryAdmission(
        { ownerId: 'worker-b', state: workerState(), store: shared.store },
        async () => 'must-not-run',
      ),
    ).resolves.toEqual({ admitted: false, reason: 'at_capacity' });

    underlying.resolve('late-result');
    await vi.waitFor(() => {
      expect(underlyingActive).toBe(0);
      expect(firstState.inFlight).toBe(false);
      expect(shared.active.size).toBe(0);
    });
  });

  it('renews the crash-safe lease while timed-out underlying work drains', async () => {
    vi.useFakeTimers();
    try {
      const shared = sharedStore(1);
      const pending = deferred();
      const state = workerState();
      await expect(
        guardMidTurnMemoryAdmission(
          {
            ownerId: 'worker-a',
            state,
            store: shared.store,
            trackRun: async (run) => ({
              outcome: { ok: true, value: await run() },
              pending: pending.promise,
            }),
          },
          async () => 'fail-soft',
        ),
      ).resolves.toEqual({ admitted: true, value: 'fail-soft' });

      await vi.advanceTimersByTimeAsync(MID_TURN_MEMORY_HEARTBEAT_INTERVAL_MS);
      expect(shared.heartbeatOwners).toEqual(['worker-a']);
      expect(shared.active.size).toBe(1);

      pending.resolve();
      await vi.runAllTimersAsync();
      expect(shared.active.size).toBe(0);
      expect(state.inFlight).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails soft and does not run optional work when admission storage is unavailable', async () => {
    const run = vi.fn(async () => 'memory');
    const store = sharedStore().store;
    store.ensureRegistered = async () => {
      throw new Error('locks db unavailable');
    };
    await expect(
      guardMidTurnMemoryAdmission({ ownerId: 'worker-a', state: workerState(), store }, run),
    ).resolves.toEqual({ admitted: false, reason: 'admission_unavailable' });
    expect(run).not.toHaveBeenCalled();
  });
});
