/**
 * swarm-shared-refresh-loop.test.ts — P-007: `joinHarnessSwarm` must multiplex
 * every join's self-heal tick onto ONE shared refresh loop per swarm, instead of
 * arming one `managedSetInterval` per join.
 *
 * Why this matters: boot.ts calls `joinHarnessSwarm` once per MEMBER HARNESS
 * against the process-singleton shared swarm (`getSharedSwarm` — "one Hyperswarm
 * per process"), so the old per-join timer meant N shared hives = N timers, each
 * waking the event loop on its own phase to run a full per-topic tick. That is
 * the per-topic refresh storm the plan targets at the 10k-hive scale.
 *
 * Consolidating a loop is easy to get subtly WRONG, so these pin the invariants
 * that make the consolidation behavior-preserving rather than just cheaper:
 *   1. N joins on one swarm arm exactly ONE timer (the actual P-007 claim);
 *   2. joins with DIFFERENT cadences each still tick at their OWN rate — the
 *      shared timer runs at the finest base with per-entry due-ness, never one
 *      shared cadence;
 *   3. the escalation ladder is still evaluated on EVERY one of a join's ticks,
 *      independent of that join's refresh-cadence gate — a topic must be
 *      detectable as severed while sitting in the "dead zone" after its fast
 *      window lapsed and long before its slow keepalive is due;
 *   4. one join closing must not stop a sibling harness's ticks;
 *   5. the last join closing must stop the shared timer (no orphaned loop).
 *
 * Same injected-swarm seam + fake-timer convention as
 * swarm-severed-link-escalation.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Corestore from 'corestore';
import { getManaged } from '@papercusp/scheduled-registry';
import { joinHarnessSwarm, type HyperswarmLike, type SwarmHandle } from './swarm';
import type { SwarmGuard } from './swarm-guard';

const REFRESH_TIMER_NAME = 'hyperbee-swarm-refresh';

const TOPIC_A = Buffer.alloc(32, 1);
const TOPIC_B = Buffer.alloc(32, 2);
const TOPIC_C = Buffer.alloc(32, 3);

const ALLOW_GUARD: SwarmGuard = {
  firewall: () => false,
  isBannedKey: () => false,
  isBannedIp: () => false,
  banKey: () => {},
  banIp: () => {},
  recordConnection: async () => ({ allow: true }),
};

const STORE = { replicate: () => {} } as unknown as Corestore;

function makeFakeSocket(): { socket: unknown; fireClose: () => void } {
  let closeCb: (() => void) | null = null;
  const socket = {
    on: () => {},
    once: (ev: string, fn: () => void) => {
      if (ev === 'close') closeCb = fn;
    },
  };
  return { socket, fireClose: () => closeCb?.() };
}

/**
 * A fake swarm that tags every `discovery.refresh()` with the topic it belongs
 * to, so a test can attribute refreshes to the individual JOIN that produced
 * them (the whole point when many joins share one loop).
 */
function makeFakeSwarm() {
  const refreshedTopics: string[] = [];
  const leaves: Buffer[] = [];
  let connHandler: ((socket: unknown, info?: unknown) => void) | null = null;
  const swarm: HyperswarmLike = {
    join: (topic: Buffer) => {
      const hex = topic.toString('hex');
      return {
        flushed: async () => {},
        refresh: () => {
          refreshedTopics.push(hex);
        },
      };
    },
    leave: (topic: Buffer) => {
      leaves.push(topic);
    },
    on: (_ev: 'connection', listener: (socket: unknown, info?: unknown) => void) => {
      connHandler = listener;
    },
    off: () => {},
    connections: [],
  };
  return {
    swarm,
    leaves,
    emitConnection: (socket: unknown) => connHandler?.(socket),
    refreshCountFor: (topic: Buffer) =>
      refreshedTopics.filter((h) => h === topic.toString('hex')).length,
  };
}

const handles: SwarmHandle[] = [];
afterEach(async () => {
  while (handles.length) {
    try {
      await handles.pop()!.close();
    } catch {
      /* best-effort */
    }
  }
  vi.useRealTimers();
});

/** The live instance count for the shared refresh timer (0 when unarmed). */
function refreshTimerInstances(): number {
  return getManaged(REFRESH_TIMER_NAME)?.instances ?? 0;
}

describe('joinHarnessSwarm shared refresh loop (P-007)', () => {
  it('arms exactly ONE timer for MANY joins on the same swarm', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    for (const topic of [TOPIC_A, TOPIC_B, TOPIC_C]) {
      handles.push(
        await joinHarnessSwarm({
          store: STORE,
          topic,
          swarm: f.swarm,
          guard: ALLOW_GUARD,
          refreshMs: 50,
          fastWindowMs: 10_000,
          slowRefreshMs: 500,
        }),
      );
    }

    // The regression this pins: one timer per JOIN would report 3 instances.
    expect(refreshTimerInstances()).toBe(1);

    // …and the single loop really does drive EVERY join, not just the first.
    await vi.advanceTimersByTimeAsync(100);
    expect(f.refreshCountFor(TOPIC_A)).toBeGreaterThan(0);
    expect(f.refreshCountFor(TOPIC_B)).toBeGreaterThan(0);
    expect(f.refreshCountFor(TOPIC_C)).toBeGreaterThan(0);
  });

  it('honors each join\'s OWN cadence on the shared loop (fine base + per-entry due-ness)', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    // Same swarm, deliberately DIFFERENT cadences: a single shared cadence would
    // make the slow join tick 4x too often (or the fast one 4x too rarely).
    handles.push(
      await joinHarnessSwarm({
        store: STORE,
        topic: TOPIC_A,
        swarm: f.swarm,
        guard: ALLOW_GUARD,
        refreshMs: 50,
        fastWindowMs: 10_000,
        slowRefreshMs: 10_000,
      }),
    );
    handles.push(
      await joinHarnessSwarm({
        store: STORE,
        topic: TOPIC_B,
        swarm: f.swarm,
        guard: ALLOW_GUARD,
        refreshMs: 200,
        fastWindowMs: 10_000,
        slowRefreshMs: 10_000,
      }),
    );

    expect(refreshTimerInstances()).toBe(1);

    // Both are inside their fast window, so every DUE tick refreshes: A is due
    // every 50ms (4x), B every 200ms (1x).
    await vi.advanceTimersByTimeAsync(200);
    expect(f.refreshCountFor(TOPIC_A)).toBe(4);
    expect(f.refreshCountFor(TOPIC_B)).toBe(1);
  });

  it('still evaluates the severed ladder on every tick while refresh() is NOT due (dead zone)', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const onSeveredLink = vi.fn();
    // fastWindowMs is short and slowRefreshMs is effectively never — so after
    // 100ms the refresh-cadence gate short-circuits every tick. The ladder must
    // NOT be gated behind it (a topic can cross the severed threshold in exactly
    // this dead zone, and that gap must not delay detection).
    handles.push(
      await joinHarnessSwarm({
        store: STORE,
        topic: TOPIC_A,
        swarm: f.swarm,
        guard: ALLOW_GUARD,
        refreshMs: 50,
        fastWindowMs: 100,
        slowRefreshMs: 1_000_000,
        severedEscalationMs: 500,
        onSeveredLink,
      }),
    );

    // Had a peer, then lost it: the genuinely-severed shape.
    const { socket, fireClose } = makeFakeSocket();
    f.emitConnection(socket);
    fireClose();

    await vi.advanceTimersByTimeAsync(600);

    expect(onSeveredLink).toHaveBeenCalledTimes(1);
    expect(f.leaves).toHaveLength(1);
    // Proof we really were in the dead zone: refresh() stopped being due after
    // the 100ms fast window, so it fired only a handful of times, NOT once per
    // 50ms tick across the whole 600ms.
    expect(f.refreshCountFor(TOPIC_A)).toBeLessThan(5);
  });

  it('closing one join keeps the shared loop serving its siblings', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const a = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC_A,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 10_000,
      slowRefreshMs: 10_000,
    });
    const b = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC_B,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 10_000,
      slowRefreshMs: 10_000,
    });
    handles.push(b);

    await a.close();
    const aAfterClose = f.refreshCountFor(TOPIC_A);
    const bBeforeAdvance = f.refreshCountFor(TOPIC_B);

    await vi.advanceTimersByTimeAsync(200);

    // A is gone (its entry was deregistered, not merely idle)…
    expect(f.refreshCountFor(TOPIC_A)).toBe(aAfterClose);
    // …while B keeps ticking on the still-armed shared loop.
    expect(f.refreshCountFor(TOPIC_B)).toBeGreaterThan(bBeforeAdvance);
    expect(refreshTimerInstances()).toBe(1);
  });

  it('stops the shared loop once the LAST join on the swarm closes', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const a = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC_A,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 10_000,
      slowRefreshMs: 10_000,
    });
    const b = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC_B,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 10_000,
      slowRefreshMs: 10_000,
    });

    expect(refreshTimerInstances()).toBe(1);
    await a.close();
    expect(refreshTimerInstances()).toBe(1); // b still holds it
    await b.close();

    // No orphaned loop left ticking for a swarm with no joins.
    expect(refreshTimerInstances()).toBe(0);
    const before = f.refreshCountFor(TOPIC_B);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.refreshCountFor(TOPIC_B)).toBe(before);
  });

  it('gives each swarm its OWN loop (no cross-swarm coupling)', async () => {
    vi.useFakeTimers();
    const f1 = makeFakeSwarm();
    const f2 = makeFakeSwarm();
    handles.push(
      await joinHarnessSwarm({
        store: STORE,
        topic: TOPIC_A,
        swarm: f1.swarm,
        guard: ALLOW_GUARD,
        refreshMs: 50,
        fastWindowMs: 10_000,
        slowRefreshMs: 10_000,
      }),
    );
    const second = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC_B,
      swarm: f2.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 10_000,
      slowRefreshMs: 10_000,
    });

    // Two swarms ⇒ two loops (aggregated under one inventory name).
    expect(refreshTimerInstances()).toBe(2);

    // Closing swarm 2's only join must not disturb swarm 1's loop.
    await second.close();
    expect(refreshTimerInstances()).toBe(1);
    const before = f1.refreshCountFor(TOPIC_A);
    await vi.advanceTimersByTimeAsync(200);
    expect(f1.refreshCountFor(TOPIC_A)).toBeGreaterThan(before);
  });
});
