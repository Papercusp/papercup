/**
 * swarm-severed-link-escalation.test.ts — EI-13317: refresh() alone does not
 * recover a topic link severed by a ONE-SIDE RESTART (tower↔VM rig forensics,
 * 2026-07-16/17: fast-window refresh ticks fire every ~2.5s with zero paired
 * peers for 20+ minutes; only a fresh process/swarm.join ever reconnects).
 *
 * These pin the escalation LADDER added to `joinHarnessSwarm`'s self-heal
 * loop: once a topic that HAD a live peer sits at zero live peers for
 * `severedEscalationMs` despite refresh() ticking, it must
 *   1. fire a loud, rate-limited health signal (`onSeveredLink`), and
 *   2. force a topic-level leave()+rejoin() — a FRESH discovery session —
 *      rather than trusting the same (possibly stale) discovery handle's
 *      refresh() forever.
 *
 * A topic that has NEVER connected (no peer online yet, the common/benign
 * case) must NOT escalate — only a topic that regresses from "had a peer" to
 * "has none" is genuinely severed.
 *
 * Same injected-swarm seam + fake-timer convention as swarm-self-heal.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Corestore from 'corestore';
import {
  joinHarnessSwarm,
  type HyperswarmLike,
  type SwarmHandle,
  type SeveredLinkInfo,
  DEFAULT_SUBSTRATE_SEVERED_ESCALATION_MS,
} from './swarm';
import type { SwarmGuard } from './swarm-guard';

const TOPIC = Buffer.alloc(32, 9);

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

/** A fake swarm tracking join/leave calls (each join returns a FRESH
 *  discovery object so a test can assert a rejoin actually happened). */
function makeFakeSwarm() {
  const refreshed: Array<object | undefined> = [];
  const joins: number[] = [];
  const leaves: Buffer[] = [];
  let connHandler: ((socket: unknown, info?: unknown) => void) | null = null;
  const swarm: HyperswarmLike = {
    join: () => {
      const joinIndex = joins.length;
      joins.push(joinIndex);
      return {
        flushed: async () => {},
        refresh: (o?: object) => {
          refreshed.push(o);
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
    refreshed,
    joins,
    leaves,
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

describe('joinHarnessSwarm severed-link escalation ladder (EI-13317)', () => {
  it('never escalates a topic that has NOT yet had any peer (no live-until-severed regression)', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const onSeveredLink = vi.fn();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 500,
      severedEscalationMs: 1000,
      onSeveredLink,
    });
    handles.push(handle);

    // No peer ever connected — well past the escalation threshold.
    await vi.advanceTimersByTimeAsync(5000);
    expect(onSeveredLink).not.toHaveBeenCalled();
    expect(f.leaves).toHaveLength(0);
    // The one join call was the initial joinHarnessSwarm join — no rejoin.
    expect(f.joins).toHaveLength(1);
  });

  it('escalates (leave+rejoin + loud signal) once a topic that HAD a peer sits severed past the threshold', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const onSeveredLink = vi.fn();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 500,
      severedEscalationMs: 1000,
      onSeveredLink,
    });
    handles.push(handle);

    // Connect a peer (marks connectionCount > 0), then it drops — the
    // ONE-SIDE-RESTART shape: had a peer, now genuinely severed.
    const { socket, fireClose } = makeFakeSocket();
    f.emitConnection(socket);
    fireClose();
    expect(f.joins).toHaveLength(1); // just the initial join so far

    // Still under the severed threshold — no escalation yet.
    await vi.advanceTimersByTimeAsync(700);
    expect(onSeveredLink).not.toHaveBeenCalled();
    expect(f.leaves).toHaveLength(0);

    // Cross the threshold (fastWindowStartMs was re-armed at fireClose()).
    await vi.advanceTimersByTimeAsync(400);
    expect(onSeveredLink).toHaveBeenCalledTimes(1);
    const info = onSeveredLink.mock.calls[0]![0] as SeveredLinkInfo;
    expect(info.topicHex).toBe(TOPIC.toString('hex'));
    expect(info.severedMs).toBeGreaterThanOrEqual(1000);
    expect(f.leaves).toHaveLength(1);
    expect(f.leaves[0]).toBe(TOPIC);
    // The rejoin fires a SECOND join call — a fresh discovery session.
    await vi.advanceTimersByTimeAsync(0);
    expect(f.joins).toHaveLength(2);
  });

  it('rate-limits repeated escalations to once per severedEscalationMs', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const onSeveredLink = vi.fn();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 300,
      severedEscalationMs: 1000,
      onSeveredLink,
    });
    handles.push(handle);

    const { socket, fireClose } = makeFakeSocket();
    f.emitConnection(socket);
    fireClose();

    await vi.advanceTimersByTimeAsync(1100);
    expect(onSeveredLink).toHaveBeenCalledTimes(1);

    // The rejoin re-arms the fast window, so the NEXT escalation needs a
    // full fresh severedEscalationMs from that point, not an immediate re-fire.
    await vi.advanceTimersByTimeAsync(500);
    expect(onSeveredLink).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(600);
    expect(onSeveredLink).toHaveBeenCalledTimes(2);
  });

  it('severedEscalationMs: 0 disables the escalation entirely (byte-identical pre-EI-13317)', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const onSeveredLink = vi.fn();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 300,
      severedEscalationMs: 0,
      onSeveredLink,
    });
    handles.push(handle);

    const { socket, fireClose } = makeFakeSocket();
    f.emitConnection(socket);
    fireClose();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(onSeveredLink).not.toHaveBeenCalled();
    expect(f.leaves).toHaveLength(0);
    expect(f.joins).toHaveLength(1);
  });

  it('exports a sane default escalation threshold', () => {
    expect(DEFAULT_SUBSTRATE_SEVERED_ESCALATION_MS).toBeGreaterThan(0);
    // Matches the EI-13317 "correct state" requirement: a persistent >5min
    // severed link should raise a loud signal.
    expect(DEFAULT_SUBSTRATE_SEVERED_ESCALATION_MS).toBe(5 * 60_000);
  });

  it('a throwing onSeveredLink callback never crashes the refresh loop', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      refreshMs: 50,
      fastWindowMs: 200,
      slowRefreshMs: 300,
      severedEscalationMs: 1000,
      onSeveredLink: () => {
        throw new Error('boom');
      },
    });
    handles.push(handle);

    const { socket, fireClose } = makeFakeSocket();
    f.emitConnection(socket);
    fireClose();

    await expect(vi.advanceTimersByTimeAsync(1200)).resolves.not.toThrow();
    // The escalation (and rejoin) still proceeded despite the callback throwing.
    expect(f.leaves).toHaveLength(1);
  });

  // EI-13317 rung (b): `forceRejoin()` extracts the escalation ladder's own
  // leave+rejoin action onto the handle so an EXTERNAL caller (boot.ts's
  // WI-3684 repair-exhaustion path) can invoke the identical lever WITHOUT
  // waiting for — or being gated by — the zero-live-peers severed-link timer
  // above. Covered independently of boot.ts's wiring (see boot.test.ts's
  // "EI-13317 rung (b)" case for the end-to-end repair-exhaustion trigger).
  it('handle.forceRejoin() performs the SAME leave+rejoin NOW, independent of severedEscalationMs / the fast-window clock', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const onSeveredLink = vi.fn();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      // A LONG severed threshold — if forceRejoin() were secretly routed
      // through the timer-gated ladder this would never fire within the test.
      severedEscalationMs: 10 * 60_000,
      onSeveredLink,
    });
    handles.push(handle);

    expect(f.joins).toHaveLength(1); // just the initial join
    expect(f.leaves).toHaveLength(0);

    await handle.forceRejoin();

    expect(f.leaves).toHaveLength(1);
    expect(f.leaves[0]).toBe(TOPIC);
    expect(f.joins).toHaveLength(2); // a fresh discovery session
    // The severed-link callback is NOT involved — forceRejoin is a raw lever,
    // not a re-implementation of the ladder's own signal.
    expect(onSeveredLink).not.toHaveBeenCalled();

    // Callable repeatedly — no internal rate-limit of its own (the CALLER is
    // expected to pace it; boot.ts's repair-exhaustion path applies its own
    // harness-wide cooldown on top).
    await handle.forceRejoin();
    expect(f.leaves).toHaveLength(2);
    expect(f.joins).toHaveLength(3);
  });
});
