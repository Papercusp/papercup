/**
 * swarm-self-heal.test.ts — WI-752 / FED-2: the per-harness substrate swarm
 * must RE-PEER itself without an operator restart.
 *
 * Pre-WI-752, `joinHarnessSwarm` joined its topic ONCE and never re-ran
 * `discovery.refresh()`. So when an established peer connection died, or the
 * topic's DHT announce aged out, nothing re-announced + re-looked-up the topic
 * and the peer was never rediscovered — federation stayed dead until an operator
 * restart (the WI-559/WI-752 "federation sat dead ~7h" symptom; the swarm-chaos
 * test only converges because the TEST drives refresh itself).
 *
 * These are fast unit tests over the injected-swarm seam (no network, no PG, no
 * real timers): a fake swarm whose `join()` returns a `discovery.refresh` spy +
 * `vi` fake timers. They pin:
 *   1. the FAST cadence inside the post-join window,
 *   2. the SLOW keepalive after the window lapses (no DHT hammering),
 *   3. a peer-socket `close` RE-ARMS the fast window (snappy reconnect),
 *   4. `close()` stops the loop (no leaked timer),
 *   5. `refreshMs: 0` DISABLES the loop (byte-identical pre-WI-752 join).
 *
 * Mirrors directory-swarm.test.ts's refresh-loop tests — the substrate now runs
 * the SAME two-speed self-heal the hive-directory gossip already had.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Corestore from 'corestore';
import {
  joinHarnessSwarm,
  type HyperswarmLike,
  type SwarmHandle,
  DEFAULT_SUBSTRATE_REFRESH_MS,
} from './swarm';
import type { SwarmGuard } from './swarm-guard';

const TOPIC = Buffer.alloc(32, 7);

/** Allow-all guard — these tests exercise the re-peer loop, not the DoS gate. */
const ALLOW_GUARD: SwarmGuard = {
  firewall: () => false,
  isBannedKey: () => false,
  isBannedIp: () => false,
  banKey: () => {},
  banIp: () => {},
  recordConnection: async () => ({ allow: true }),
};

/** A corestore stub — the connection handler only calls `.replicate(socket)`. */
const STORE = { replicate: () => {} } as unknown as Corestore;

/** A fake peer socket whose `once('close', …)` callback the test can fire. */
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

/** A fake swarm capturing `discovery.refresh()` calls + the connection handler. */
function makeFakeSwarm() {
  const refreshed: Array<object | undefined> = [];
  let connHandler: ((socket: unknown, info?: unknown) => void) | null = null;
  const swarm: HyperswarmLike = {
    join: () => ({
      flushed: async () => {},
      refresh: (o?: object) => {
        refreshed.push(o);
      },
    }),
    leave: () => {},
    on: (_ev: 'connection', listener: (socket: unknown, info?: unknown) => void) => {
      connHandler = listener;
    },
    off: () => {},
    connections: [],
  };
  return {
    swarm,
    refreshed,
    /** Simulate the shared swarm emitting a peer connection. */
    emitConnection: (socket: unknown) => connHandler?.(socket),
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

describe('joinHarnessSwarm self-heal re-peer loop (WI-752 / FED-2)', () => {
  it('drives discovery.refresh() on the FAST cadence inside the post-join window', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 1000,
      slowRefreshMs: 10_000,
    });
    handles.push(handle);

    expect(f.refreshed).toHaveLength(0); // nothing before the first tick
    await vi.advanceTimersByTimeAsync(220);
    expect(f.refreshed.length).toBeGreaterThanOrEqual(3); // 50ms cadence → ~4 ticks
    // Re-announce + re-lookup is requested (the proven reconnect driver).
    expect(f.refreshed[0]).toEqual({ client: true, server: true });
  });

  it('backs off to the SLOW keepalive once the fast window lapses', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 1000,
    });
    handles.push(handle);

    await vi.advanceTimersByTimeAsync(200); // burn the fast window
    const afterFast = f.refreshed.length;
    expect(afterFast).toBeGreaterThanOrEqual(3);

    // DEAD ZONE: window lapsed, slow keepalive not yet due → no new refreshes.
    await vi.advanceTimersByTimeAsync(700);
    expect(f.refreshed.length).toBe(afterFast);

    // Slow keepalive fires (≥1000ms since the last refresh).
    await vi.advanceTimersByTimeAsync(400);
    expect(f.refreshed.length).toBe(afterFast + 1);
  });

  it('re-arms the FAST window when a peer socket closes (snappy reconnect)', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 100_000, // slow keepalive far away — isolate the re-arm
    });
    handles.push(handle);

    // Connect a peer, then let the fast window lapse into the dead zone.
    const { socket, fireClose } = makeFakeSocket();
    f.emitConnection(socket);
    await vi.advanceTimersByTimeAsync(300);
    const beforeDrop = f.refreshed.length;
    await vi.advanceTimersByTimeAsync(300); // still dead (window lapsed, slow far off)
    expect(f.refreshed.length).toBe(beforeDrop);

    // The peer drops → fast window RE-ARMS → fast refreshes resume immediately.
    fireClose();
    await vi.advanceTimersByTimeAsync(160);
    expect(f.refreshed.length).toBeGreaterThanOrEqual(beforeDrop + 3);
  });

  it('close() stops the loop (no leaked timer)', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 10_000,
    });
    await vi.advanceTimersByTimeAsync(120);
    expect(f.refreshed.length).toBeGreaterThan(0);

    await handle.close();
    const n = f.refreshed.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(f.refreshed.length).toBe(n); // no refresh after close
  });

  it('refreshMs: 0 disables the loop entirely (pre-WI-752 join)', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 0,
    });
    handles.push(handle);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.refreshed).toHaveLength(0);
  });

  it('exports a sane default fast cadence', () => {
    expect(DEFAULT_SUBSTRATE_REFRESH_MS).toBeGreaterThan(0);
    expect(DEFAULT_SUBSTRATE_REFRESH_MS).toBeLessThanOrEqual(5000);
  });
});
