/**
 * swarm-unpaired-announce-escalation.test.ts — EI-18662944242304583.
 *
 * The PRE-ADMISSION blind window. Gate run 20260725-183831 (frames a+b):
 * 188 established connections over 20.5 minutes, 91 announce-channel open
 * attempts, and ZERO inbound frames in either direction — the data path behind
 * each connected socket was dead. Nothing was ever admitted, and because every
 * replication-liveness axis is sampled from `for (const log of
 * admitted.values())` (boot.ts), the detector did not merely stay quiet: it
 * never executed. "Wedged" and "healthy" produced the identical observable
 * (silence) for 20.5 minutes.
 *
 * These pin rung (c) of `joinHarnessSwarm`'s escalation ladder: a topic holding
 * LIVE connections that has never once paired its announce channel must, past
 * `unpairedEscalationMs`,
 *   1. fire a loud, rate-limited health signal (`onUnpairedLink`), and
 *   2. force a topic-level leave()+rejoin() — a FRESH discovery session.
 *
 * The false-positive guards matter as much as the fire (the WI-5686 lesson —
 * an over-eager axis that tears down healthy sessions is worse than a blind
 * one), so most of these cases assert SILENCE.
 *
 * Same injected-swarm seam + fake-timer convention as
 * swarm-severed-link-escalation.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Corestore from 'corestore';
import {
  joinHarnessSwarm,
  announcePairingStateForTopic,
  type HyperswarmLike,
  type SwarmHandle,
  type AnnouncePairingState,
  type UnpairedLinkInfo,
} from './swarm';
import type { SwarmGuard } from './swarm-guard';

const TOPIC = Buffer.alloc(32, 7);
const TOPIC_HEX = TOPIC.toString('hex');

const ALLOW_GUARD: SwarmGuard = {
  firewall: () => false,
  isBannedKey: () => false,
  isBannedIp: () => false,
  banKey: () => {},
  banIp: () => {},
  recordConnection: async () => ({ allow: true }),
};

const STORE = { replicate: () => {} } as unknown as Corestore;

function makeFakeSocket(): unknown {
  return { on: () => {}, once: () => {} };
}

/** A fake swarm tracking join/leave calls (each join returns a FRESH discovery
 *  object so a test can assert a rejoin actually happened). */
function makeFakeSwarm() {
  const joins: number[] = [];
  const leaves: Buffer[] = [];
  let connHandler: ((socket: unknown, info?: unknown) => void) | null = null;
  const swarm: HyperswarmLike = {
    join: () => {
      joins.push(joins.length);
      return { flushed: async () => {}, refresh: () => {} };
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
    joins,
    leaves,
    emitConnection: (socket: unknown) => connHandler?.(socket),
  };
}

/**
 * A stub pairing probe standing in for the live module tracker.
 *
 * `firstAttemptMs` is captured ONCE here rather than re-read per call — the
 * probe is invoked on every escalation tick, so a fresh `Date.now()` each time
 * would hold `unpairedMs` at ~0 forever and the rung could never trip.
 */
function makeProbe(over: Partial<AnnouncePairingState> = {}): () => AnnouncePairingState {
  const firstAttemptMs = Date.now();
  const state: AnnouncePairingState = {
    attempts: 8,
    everPaired: false,
    firstAttemptMs,
    ...over,
  };
  return () => state;
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

describe('joinHarnessSwarm never-paired escalation, rung (c) (EI-18662944242304583)', () => {
  it('escalates (leave+rejoin + loud signal) when live connections never pair an announce channel', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const onUnpairedLink = vi.fn();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 500,
      severedEscalationMs: 0, // isolate rung (c) from rung (a)
      unpairedEscalationMs: 1000,
      announcePairingState: makeProbe(),
      onUnpairedLink,
    });
    handles.push(handle);

    // A live connection exists (so this is NOT the "peer offline" case)...
    f.emitConnection(makeFakeSocket());
    // ...but it has never paired. Before the threshold: silence.
    await vi.advanceTimersByTimeAsync(500);
    expect(onUnpairedLink).not.toHaveBeenCalled();
    expect(f.leaves).toHaveLength(0);

    // Past the threshold: loud signal + a forced fresh discovery session.
    await vi.advanceTimersByTimeAsync(1000);
    expect(onUnpairedLink).toHaveBeenCalledTimes(1);
    const info = onUnpairedLink.mock.calls[0]![0] as UnpairedLinkInfo;
    expect(info.topicHex).toBe(TOPIC_HEX);
    expect(info.attempts).toBe(8);
    expect(info.unpairedMs).toBeGreaterThanOrEqual(1000);
    expect(f.leaves).toHaveLength(1);
    // initial join + the forced rejoin
    expect(f.joins).toHaveLength(2);
  });

  it('never escalates a topic that has PAIRED at least once (disarmed permanently)', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const onUnpairedLink = vi.fn();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 500,
      severedEscalationMs: 0,
      unpairedEscalationMs: 1000,
      // Paired once — churn after this belongs to the downstream detector,
      // which by then can genuinely observe it.
      announcePairingState: makeProbe({ everPaired: true }),
      onUnpairedLink,
    });
    handles.push(handle);

    f.emitConnection(makeFakeSocket());
    await vi.advanceTimersByTimeAsync(5000);
    expect(onUnpairedLink).not.toHaveBeenCalled();
    expect(f.leaves).toHaveLength(0);
  });

  it('never escalates when there are NO live connections (a genuinely offline peer must not page)', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const onUnpairedLink = vi.fn();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 500,
      severedEscalationMs: 0,
      unpairedEscalationMs: 1000,
      announcePairingState: makeProbe(),
      onUnpairedLink,
    });
    handles.push(handle);

    // No connection ever emitted — nothing to diagnose, so no repair.
    await vi.advanceTimersByTimeAsync(5000);
    expect(onUnpairedLink).not.toHaveBeenCalled();
    expect(f.leaves).toHaveLength(0);
  });

  it('never escalates below MIN_UNPAIRED_ATTEMPTS (one slow pairing still in flight)', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const onUnpairedLink = vi.fn();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 500,
      severedEscalationMs: 0,
      unpairedEscalationMs: 1000,
      announcePairingState: makeProbe({ attempts: 2 }),
      onUnpairedLink,
    });
    handles.push(handle);

    f.emitConnection(makeFakeSocket());
    await vi.advanceTimersByTimeAsync(5000);
    expect(onUnpairedLink).not.toHaveBeenCalled();
    expect(f.leaves).toHaveLength(0);
  });

  it('never escalates a topic that opens no announce channel at all (attempts stay 0)', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const onUnpairedLink = vi.fn();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 500,
      severedEscalationMs: 0,
      unpairedEscalationMs: 1000,
      announcePairingState: makeProbe({ attempts: 0, firstAttemptMs: null }),
      onUnpairedLink,
    });
    handles.push(handle);

    f.emitConnection(makeFakeSocket());
    await vi.advanceTimersByTimeAsync(5000);
    expect(onUnpairedLink).not.toHaveBeenCalled();
    expect(f.leaves).toHaveLength(0);
  });

  it('is disabled by unpairedEscalationMs: 0', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const onUnpairedLink = vi.fn();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 500,
      severedEscalationMs: 0,
      unpairedEscalationMs: 0,
      announcePairingState: makeProbe(),
      onUnpairedLink,
    });
    handles.push(handle);

    f.emitConnection(makeFakeSocket());
    await vi.advanceTimersByTimeAsync(5000);
    expect(onUnpairedLink).not.toHaveBeenCalled();
    expect(f.leaves).toHaveLength(0);
  });

  it('rate-limits, and caps repair attempts so an un-pairable peer cannot rejoin-loop forever', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const onUnpairedLink = vi.fn();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 500,
      severedEscalationMs: 0,
      unpairedEscalationMs: 1000,
      announcePairingState: makeProbe(),
      onUnpairedLink,
    });
    handles.push(handle);

    f.emitConnection(makeFakeSocket());
    // Long past the point where an uncapped rung would have fired ~30 times.
    await vi.advanceTimersByTimeAsync(30_000);
    // MAX_UNPAIRED_ESCALATIONS === 5.
    expect(onUnpairedLink).toHaveBeenCalledTimes(5);
    expect(f.leaves).toHaveLength(5);
  });

  it('a throwing observer never blocks the repair', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 500,
      severedEscalationMs: 0,
      unpairedEscalationMs: 1000,
      announcePairingState: makeProbe(),
      onUnpairedLink: () => {
        throw new Error('observer blew up');
      },
    });
    handles.push(handle);

    f.emitConnection(makeFakeSocket());
    await vi.advanceTimersByTimeAsync(1500);
    // The forced rejoin still happened.
    expect(f.leaves).toHaveLength(1);
  });

  it('a throwing pairing probe is treated as no-signal, never a fire', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const onUnpairedLink = vi.fn();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 500,
      severedEscalationMs: 0,
      unpairedEscalationMs: 1000,
      announcePairingState: () => {
        throw new Error('probe blew up');
      },
      onUnpairedLink,
    });
    handles.push(handle);

    f.emitConnection(makeFakeSocket());
    await vi.advanceTimersByTimeAsync(5000);
    expect(onUnpairedLink).not.toHaveBeenCalled();
    expect(f.leaves).toHaveLength(0);
  });
});

describe('announcePairingStateForTopic (EI-18662944242304583 telemetry)', () => {
  it('reports a never-attempted topic as a clean zero (the disarmed default)', () => {
    const st = announcePairingStateForTopic('deadbeef'.repeat(8));
    expect(st).toEqual({ attempts: 0, everPaired: false, firstAttemptMs: null });
  });
});
