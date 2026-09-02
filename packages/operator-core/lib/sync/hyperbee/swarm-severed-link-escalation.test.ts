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

  // WI-5355 (EI-13317 downstream): mirrors topic-gossip.ts's zombie-socket
  // eviction into swarm.ts's forceRejoinNow. Root cause (traced into
  // node_modules/hyperswarm): `connections`/`_allConnections` are only pruned
  // together, synchronously, on a socket's OWN `close` event — a socket that
  // never closes (still "connected" per Hyperswarm, but dead for us) makes
  // `_handlePeer` permanently no-op for that peer, so a plain leave()+join()
  // can never result in a fresh connection attempt. `forceRejoin()`'s own
  // motivating case (a live socket, dead replication) is exactly this shape.
  function makeFakeSocketWithDestroy(): { socket: unknown; destroy: ReturnType<typeof vi.fn> } {
    const destroy = vi.fn();
    const socket = { on: () => {}, once: () => {}, destroy };
    return { socket, destroy };
  }

  it('forceRejoin() destroys a socket that never fired close (the zombie case) before rejoining', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      severedEscalationMs: 10 * 60_000,
    });
    handles.push(handle);

    // Connect a peer that NEVER fires its own 'close' — the zombie shape.
    const { socket, destroy } = makeFakeSocketWithDestroy();
    f.emitConnection(socket);
    expect(destroy).not.toHaveBeenCalled();

    await handle.forceRejoin();

    // The zombie socket is force-destroyed before the leave+rejoin, so
    // Hyperswarm's own bookkeeping is actually cleared this time.
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(f.leaves).toHaveLength(1);
    expect(f.joins).toHaveLength(2);

    // A second forceRejoin() is a no-op on the ALREADY-evicted socket (it was
    // dropped from this join's own tracked-sockets set on the first pass).
    await handle.forceRejoin();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('forceRejoin() never destroys a socket another harness/topic on the same shared swarm still relies on', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const handleA = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      severedEscalationMs: 10 * 60_000,
    });
    handles.push(handleA);
    const TOPIC_B = Buffer.alloc(32, 11);
    const handleB = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC_B,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      severedEscalationMs: 10 * 60_000,
    });
    handles.push(handleB);

    // ONE shared A↔B socket connects — Hyperswarm dedupes per peer, so BOTH
    // harnesses' handlers see the SAME 'connection' event (the module's own
    // documented shared-socket model).
    const { socket, destroy } = makeFakeSocketWithDestroy();
    f.emitConnection(socket);

    // Harness A decides its topic is done with this socket and force-rejoins.
    await handleA.forceRejoin();

    // Harness B never released its own claim — the socket must be left alone.
    expect(destroy).not.toHaveBeenCalled();

    // Once B ALSO force-rejoins (its own claim is now released too), NO other
    // harness holds it — the socket is now genuinely idle and gets evicted.
    await handleB.forceRejoin();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  /** A socket whose UDX counters show bytes ALREADY received — i.e.
   *  `dataPathProven() === true`. Every socket that completed a Noise
   *  handshake looks like this, INCLUDING a zombie that has replicated
   *  nothing since (measured on the WI-6324 repro: br=988 pr=3). */
  function makeFakeSocketWithProvenDataPath() {
    const destroy = vi.fn();
    const socket = {
      on: () => {},
      once: () => {},
      destroy,
      rawStream: { bytesReceived: 988, packetsReceived: 3 },
    };
    return { socket, destroy };
  }

  it('WI-6324: the ESCALATING participant evicts its own socket even when bytes were already received (a zombie has a proven data path — cumulative counters cannot mean "replicating now")', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    const handle = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      severedEscalationMs: 10 * 60_000,
    });
    handles.push(handle);

    // The exact shape that made the repro fail: connected, handshaked (so
    // bytesReceived > 0 forever), then replicating nothing.
    const { socket, destroy } = makeFakeSocketWithProvenDataPath();
    f.emitConnection(socket);

    await handle.forceRejoin();

    // Before this fix the WI-5971 data-path guard skipped it (evicted=0), so
    // Hyperswarm still believed the peer connected, never re-dialled, and the
    // repair ladder detected-but-never-healed.
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(f.leaves).toHaveLength(1);
    expect(f.joins).toHaveLength(2);
  });

  it('P-203 / EI-22137294505377834: the ESCALATING participant SPARES a socket whose bytesReceived kept advancing within the liveness window, and evicts it once the counter freezes for the whole window', async () => {
    // Forensics (tower bg-host, 2026-09-02 08:27:57Z): "role=escalating
    // considered=1 evicted=1 wire=[br=783878 pr=6667]" — the escalating
    // participant destroyed a socket that was busy for OTHER pots on the same
    // peer, purely because ITS topic's channel had gone. Cumulative `proven`
    // cannot tell that socket from a zombie (WI-6324); a RECENT DELTA can, and
    // hyperdht's 5s keepalive guarantees one on every live connection.
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
      severedEscalationMs: 1000, // liveness window = min(120s, 1000ms) = 1000ms
    });
    handles.push(handle);
    const destroy = vi.fn();
    const raw = { bytesReceived: 4096, packetsReceived: 40 };
    const socket = { on: () => {}, once: () => {}, destroy, rawStream: raw };
    f.emitConnection(socket);
    // Live: the counter advances across refresh ticks (replication for another pot).
    const pump = setInterval(() => {
      raw.bytesReceived += 100;
    }, 100);
    await vi.advanceTimersByTimeAsync(400);
    await handle.forceRejoin();
    expect(destroy).not.toHaveBeenCalled(); // spared: recent inbound activity
    expect(f.leaves).toHaveLength(1); // the topic-level leave+rejoin still ran
    expect(f.joins).toHaveLength(2);

    // Then the peer really dies: the counter freezes for longer than the window.
    clearInterval(pump);
    await vi.advanceTimersByTimeAsync(1200);
    await handle.forceRejoin();
    expect(destroy).toHaveBeenCalledTimes(1); // zombie: evicted
  });

  it('WI-5971 preserved: a SIBLING on the same topic keeps its proven-live socket when someone else escalates — and still evicts it once ITS own detector fires', async () => {
    vi.useFakeTimers();
    const f = makeFakeSwarm();
    // Two participants on the SAME topic share ONE TopicRejoinCoordinator, so
    // one's forced rejoin drags the other through eviction too (WI-5923). That
    // is precisely the case WI-5971 protects.
    const handleA = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      severedEscalationMs: 10 * 60_000,
    });
    handles.push(handleA);
    const handleB = await joinHarnessSwarm({
      store: STORE,
      topic: TOPIC,
      swarm: f.swarm,
      guard: ALLOW_GUARD,
      severedEscalationMs: 10 * 60_000,
    });
    handles.push(handleB);

    // The fake swarm keeps only the LAST registered connection listener, so
    // this socket is tracked by B alone — B is the healthy sibling here.
    const { socket, destroy } = makeFakeSocketWithProvenDataPath();
    f.emitConnection(socket);

    // A escalates. B is only a bystander, so its actively-replicating socket
    // must NOT be destroyed just because a co-tenant's link died.
    await handleA.forceRejoin();
    expect(destroy).not.toHaveBeenCalled();

    // When B's OWN detector fires, B is the escalating participant and its
    // link is by definition proven dead — so it evicts. This is why sparing a
    // sibling never strands a zombie: the owner always gets its own pass.
    await handleB.forceRejoin();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('the severed-link ladder (rung a) never attempts a redundant destroy — a genuinely closed socket is already pruned', async () => {
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

    // A socket that closes NORMALLY (fires its own 'close') — rung (a)'s own
    // trigger path — is pruned by the close listener itself; nothing left for
    // forceRejoinNow's eviction sweep to (redundantly) destroy.
    const { socket, fireClose } = makeFakeSocket();
    f.emitConnection(socket);
    fireClose();

    await vi.advanceTimersByTimeAsync(1100);
    expect(onSeveredLink).toHaveBeenCalledTimes(1);
    expect(f.leaves).toHaveLength(1); // the escalation's own leave+rejoin, unaffected
  });
});
