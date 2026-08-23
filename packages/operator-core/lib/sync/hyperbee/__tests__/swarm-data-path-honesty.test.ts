/**
 * EI-18682571591024156 regression — `peer_connected` must not report SUCCESS for a
 * connection whose data path never came up.
 *
 * THE BUG. hyperdht completes the Noise handshake as a DHT RPC
 * (`router.peerHandshake`) and hands `@hyperswarm/secret-stream` an
 * ALREADY-FINISHED session attached to a UDX stream that has carried zero bytes.
 * So Hyperswarm's `connection` event — and every `peer_connected` line derived
 * from it — fires on SIGNALLING success and carries no information about whether
 * the data path came up. A connection that sends ~4.9KB, receives NOTHING,
 * retransmits 10× and dies on RTO exhaustion 13s later was logged at birth
 * identically to one that works, and hyperdht's own `relayed` /
 * `serverAddress` / `clientAddress` verdict was discarded. That is why WI-5863
 * spent hours on the wrong layer: every hypothesis took "peer_connect SUCCEEDS,
 * then the connection dies" as its premise.
 *
 * WHAT THIS PINS.
 *  1. The signalling outcome hyperdht already computes IS surfaced (the
 *     `patches/hyperdht+6.32.0` `udx*` props are read, not thrown away).
 *  2. `onPeerConnected` cannot be mistaken for terminal success — it carries
 *     `signallingOnly: true` and an honest tri-state `dataPathProven`.
 *  3. A connection that closes having received ZERO bytes is reported LOUDLY as
 *     "data path never came up" instead of surfacing only as a generic timeout.
 *  4. Absent readings stay ABSENT (`present: false` / `proven: null`) — never
 *     synthesised into a confident `relayed: false` / `bytesReceived: 0`, which
 *     would re-create the same overclaiming failure one layer down.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Corestore from 'corestore';
import {
  joinHarnessSwarm,
  extractConnectionPath,
  flattenPathDiagnostics,
  readWireStats,
  dataPathProven,
  type HyperswarmLike,
  type PeerSignallingInfo,
  type DataPathNeverUpInfo,
} from '../swarm';
import { _setSwarmGuardForTests } from '../swarm-guard';

const HYPERDHT_PATCH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../patches/hyperdht+6.32.0.patch',
);

afterEach(() => {
  _setSwarmGuardForTests(null);
  vi.restoreAllMocks();
});

function topic32(): Buffer {
  return Buffer.from('c'.repeat(64), 'hex');
}

function fakeStore(): Corestore {
  return { replicate: () => ({ pipe: vi.fn() }) } as unknown as Corestore;
}

function fakeSwarm(): {
  swarm: HyperswarmLike;
  emit: (socket: unknown, info?: unknown) => void;
} {
  const listeners: Array<(socket: unknown, info?: unknown) => void> = [];
  const swarm: HyperswarmLike = {
    join: () => ({ flushed: () => Promise.resolve() }),
    leave: () => {},
    on: (_event, listener) => {
      listeners.push(listener);
      return swarm;
    },
    off: () => swarm,
  };
  return {
    swarm,
    emit(socket, info) {
      for (const l of listeners) l(socket, info);
    },
  };
}

interface WireCounters {
  bytesReceived?: number;
  bytesTransmitted?: number;
  packetsReceived?: number;
  rtoCount?: number;
  retransmits?: number;
}

/** A connection socket in the shape hyperswarm hands us: an encrypted stream with
 *  hyperdht's `udx*` signalling verdict + a UDX `rawStream` carrying the counters. */
function fakeSocket(opts: {
  wire?: WireCounters | null;
  udx?: Record<string, unknown> | null;
  remoteHost?: string;
}): { socket: unknown; close: () => void; emitError: (e: unknown) => void } {
  const closeHandlers: Array<() => void> = [];
  const errorHandlers: Array<(e: unknown) => void> = [];
  const socket: Record<string, unknown> = {
    on: (ev: string, fn: (e: unknown) => void) => {
      if (ev === 'error') errorHandlers.push(fn);
      return socket;
    },
    once: (ev: string, fn: () => void) => {
      if (ev === 'close') closeHandlers.push(fn);
      return socket;
    },
    destroy: () => {},
    ...(opts.udx ?? {}),
  };
  if (opts.wire !== null) {
    socket.rawStream = { remoteHost: opts.remoteHost ?? '203.0.113.9', ...(opts.wire ?? {}) };
  }
  return {
    socket,
    close() {
      for (const fn of closeHandlers) fn();
    },
    /** Hyperswarm emits 'error' on the socket before destroying it; the close
     *  handler reads whatever error preceded the teardown. */
    emitError(e: unknown) {
      for (const fn of errorHandlers) fn(e);
    },
  };
}

/** The exact WI-5863 signature: bytes sent, nothing received, RTO exhaustion. */
const NEVER_CAME_UP: WireCounters = {
  bytesTransmitted: 4921,
  bytesReceived: 0,
  packetsReceived: 0,
  rtoCount: 7,
  retransmits: 10,
};

const PUNCHED_UDX = {
  udxRelayed: false,
  udxServerAddress: { host: '198.51.100.7', port: 49201 },
  udxClientAddress: { host: '192.0.2.44', port: 51820 },
};

describe('EI-18682571591024156 — pure readers keep absent readings absent', () => {
  it('surfaces hyperdht relayed/server/client instead of discarding them', () => {
    const path = extractConnectionPath({ ...PUNCHED_UDX });
    expect(path).toEqual({
      present: true,
      relayed: false,
      serverAddress: '198.51.100.7:49201',
      clientAddress: '192.0.2.44:51820',
    });
  });

  it('surfaces the relayed ACCEPT path (relay host/port)', () => {
    const path = extractConnectionPath({
      udxRelayed: true,
      udxRelayHost: '198.51.100.200',
      udxRelayPort: 3401,
    });
    expect(path.present).toBe(true);
    expect(path.relayed).toBe(true);
    expect(path.relayHost).toBe('198.51.100.200');
    expect(path.relayPort).toBe(3401);
  });

  it('does NOT synthesise a confident relayed:false when the reading is absent', () => {
    // The absent-vs-zero trap: a `relayed: false` fabricated here would read as
    // "hyperdht said not-relayed" to every consumer.
    expect(extractConnectionPath({})).toEqual({ present: false });
    expect(extractConnectionPath(null)).toEqual({ present: false });
    expect(extractConnectionPath({}).relayed).toBeUndefined();
  });

  it('does NOT synthesise bytesReceived:0 for an unreadable stream', () => {
    expect(readWireStats({}).present).toBe(false);
    expect(readWireStats({}).bytesReceived).toBeUndefined();
    // "unknown" must not be graded as a failure — that would alarm on every fake.
    expect(dataPathProven(readWireStats({}))).toBeNull();
  });

  it('grades the data path only on positive evidence', () => {
    expect(dataPathProven(readWireStats({ rawStream: NEVER_CAME_UP }))).toBe(false);
    expect(dataPathProven(readWireStats({ rawStream: { bytesReceived: 1 } }))).toBe(true);
  });
});

/**
 * WI-5980 — WHY the address was wrong, not just that the data path died.
 *
 * hyperdht picks the first NON-BOGON entry of `addresses4` and otherwise falls
 * back to `serverAddress`, which is only ever the OBSERVED SOURCE of an inbound
 * packet (connect.js:139-140) — never a declared listener. On an all-private-
 * subnet deployment every candidate is a bogon, so the fallback is the ONLY
 * path and we dial an address the peer may not own. Separately, the
 * `punches.open` branch (connect.js:219-227) fires `onsocket()` with NO
 * round-trip confirmation and returns before any holepunch is attempted.
 *
 * These are the fields that tell those apart, and the absent-vs-zero rule binds
 * harder here than anywhere: a fabricated `addressFromFallback: false` would
 * quietly deny the exact mechanism this exists to measure, and a fabricated
 * `punchPath: 'open'` would invent the finding outright.
 */
describe('WI-5980 — the address-resolution branch is recorded, and absent stays absent', () => {
  const OPEN_FASTPATH_FALLBACK = {
    udxRelayed: true,
    udxPunchPath: 'open',
    udxAddressFromFallback: true,
    udxAddresses4AllBogon: true,
    udxAddresses4: [
      { host: '10.99.0.12', port: 49737, bogon: true },
      { host: '192.168.1.9', port: 40001, bogon: true },
    ],
    udxRemoteHolepunchable: false,
    udxFirewall: 2,
    udxPunchStats: { open: 7, consistent: 1, random: 0 },
  };

  it('surfaces the branch, the candidates, and their per-entry bogon verdicts', () => {
    const path = extractConnectionPath({ ...OPEN_FASTPATH_FALLBACK });
    expect(path.present).toBe(true);
    expect(path.punchPath).toBe('open');
    expect(path.addressFromFallback).toBe(true);
    expect(path.addresses4AllBogon).toBe(true);
    expect(path.remoteHolepunchable).toBe(false);
    expect(path.firewall).toBe(2);
    expect(path.punchStats).toEqual({ open: 7, consistent: 1, random: 0 });
    // The per-entry verdict is the evidence that the fallback was FORCED rather
    // than chosen — without it, "we fell back" and "there was nothing to fall
    // back from" are indistinguishable.
    expect(path.addresses4).toEqual([
      { host: '10.99.0.12', port: 49737, bogon: true },
      { host: '192.168.1.9', port: 40001, bogon: true },
    ]);
  });

  it('distinguishes every no-punch exit from a real holepunch attempt', () => {
    for (const punchPath of ['open', 'passive', 'lan', 'cannot-holepunch'] as const) {
      expect(extractConnectionPath({ udxPunchPath: punchPath }).punchPath).toBe(punchPath);
    }
    expect(extractConnectionPath({ udxPunchPath: 'holepunch-real' }).punchPath).toBe(
      'holepunch-real',
    );
    // Old diagnostic corpora remain readable, but this legacy value is
    // deliberately named as ambiguous and must not be used as an attempt.
    expect(extractConnectionPath({ udxPunchPath: 'holepunch' }).punchPath).toBe('holepunch');
  });

  it('does NOT synthesise addressFromFallback:false when the reading is absent', () => {
    const path = extractConnectionPath({ udxRelayed: true });
    expect(path.present).toBe(true);
    expect(path.addressFromFallback).toBeUndefined();
    expect(path.addresses4AllBogon).toBeUndefined();
    expect(path.punchPath).toBeUndefined();
    expect(path.addresses4).toBeUndefined();
    expect(path.remoteHolepunchable).toBeUndefined();
    expect(path.punchStats).toBeUndefined();
  });

  it('refuses an unrecognised punchPath rather than passing it through', () => {
    // Only the explicit writer contract is admissible; anything else is an
    // unreadable or future shape and must stay absent.
    expect(extractConnectionPath({ udxPunchPath: 'relayed' }).punchPath).toBeUndefined();
    expect(extractConnectionPath({ udxPunchPath: true }).punchPath).toBeUndefined();
    expect(extractConnectionPath({ udxPunchPath: 'open' }).punchPath).toBe('open');
  });

  it('pins the terminal path marks in the canonical HyperDHT patch', () => {
    const patch = readFileSync(HYPERDHT_PATCH, 'utf8');
    for (const punchPath of ['passive', 'lan', 'cannot-holepunch', 'holepunch-real']) {
      expect(patch).toContain(`mark('udxPunchPath', '${punchPath}')`);
    }

    // The real-attempt mark must immediately precede construction. If it moves
    // above an early-return branch, the denominator becomes ambiguous again.
    const realMark = patch.indexOf("mark('udxPunchPath', 'holepunch-real')");
    const constructor = patch.indexOf('c.puncher = new Holepuncher');
    expect(realMark).toBeGreaterThan(-1);
    expect(constructor).toBeGreaterThan(realMark);
  });

  it('keeps these fields out of the result entirely for a bare socket', () => {
    // Guards the exact-shape assertion above: a socket with none of these props
    // must still deep-equal { present: false }, not gain undefined-valued keys.
    expect(extractConnectionPath({})).toEqual({ present: false });
  });

  it('flattens the diagnostics to SCALARS so util.inspect cannot swallow them', () => {
    // console.* inspects at depth 2. Nested inside `path`, addresses4/punchStats
    // would render as `[Object]` — emitted but unreadable. Every value here must
    // therefore be a primitive, which is what makes them survive the log.
    const flat = flattenPathDiagnostics(extractConnectionPath({ ...OPEN_FASTPATH_FALLBACK }));
    for (const [key, value] of Object.entries(flat)) {
      expect(typeof value, `${key} must be a scalar to survive util.inspect`).not.toBe('object');
    }
    expect(flat.punchPath).toBe('open');
    expect(flat.addrFromFallback).toBe(true);
    expect(flat.addrs4AllBogon).toBe(true);
    expect(flat.addrs4).toBe('10.99.0.12:49737(bogon) 192.168.1.9:40001(bogon)');
    expect(flat.punchStats).toBe('open=7 consistent=1 random=0');
  });

  it('omits absent diagnostics from the flattened form rather than defaulting them', () => {
    // The flattener must not reintroduce the absent-vs-zero trap the extractor
    // avoids: no key at all beats `addrFromFallback: false`.
    expect(flattenPathDiagnostics(extractConnectionPath({ udxRelayed: true }))).toEqual({});
    expect(flattenPathDiagnostics({ present: false })).toEqual({});
  });

  it('renders an EMPTY candidate list distinguishably from an absent one', () => {
    // "hyperdht offered no addresses" and "we could not read the addresses" are
    // different findings and must not both render as nothing.
    const empty = flattenPathDiagnostics(extractConnectionPath({ udxAddresses4: [] }));
    expect(empty.addrs4).toBe('(none)');
    expect(flattenPathDiagnostics(extractConnectionPath({})).addrs4).toBeUndefined();
  });
});

describe('EI-18700336768867234 — the flattened log also carries the patch\'s own udx* names', () => {
  const OPEN_FASTPATH_FALLBACK = {
    udxRelayed: true,
    udxPunchPath: 'open',
    udxAddressFromFallback: true,
    udxAddresses4AllBogon: true,
    udxAddresses4: [{ host: '10.99.0.12', port: 49737, bogon: true }],
    udxRemoteHolepunchable: false,
    udxFirewall: 2,
    udxPunchStats: { open: 7, consistent: 1, random: 0 },
  };

  it('emits BOTH the short flattened key and the raw udx* key for every present field', () => {
    // Before this fix, `grep -c udxPunchPath <serve.log>` returned 0 on a FULLY
    // instrumented run — the rename (udxPunchPath -> punchPath) happened at
    // extractConnectionPath and was never undone, so a name-keyed stale-bundle
    // detector could not tell "absent" from "renamed", and manufactured a false
    // STALE-BUNDLE refusal against real data (the bug this test guards).
    const flat = flattenPathDiagnostics(extractConnectionPath({ ...OPEN_FASTPATH_FALLBACK }));
    expect(flat.punchPath).toBe('open');
    expect(flat.udxPunchPath).toBe('open');
    expect(flat.addrFromFallback).toBe(true);
    expect(flat.udxAddressFromFallback).toBe(true);
    expect(flat.addrs4AllBogon).toBe(true);
    expect(flat.udxAddresses4AllBogon).toBe(true);
    expect(flat.remoteHolepunchable).toBe(false);
    expect(flat.udxRemoteHolepunchable).toBe(false);
    expect(flat.firewall).toBe(2);
    expect(flat.udxFirewall).toBe(2);
    expect(flat.addrs4).toBe(flat.udxAddresses4);
    expect(flat.punchStats).toBe(flat.udxPunchStats);
  });

  it('never fabricates a udx* alias for an absent field', () => {
    const flat = flattenPathDiagnostics(extractConnectionPath({ udxRelayed: true }));
    expect(flat).toEqual({});
    for (const key of Object.keys(flat)) expect(key.startsWith('udx')).toBe(false);
  });
});

describe('EI-18682571591024156 — onPeerConnected cannot overclaim success', () => {
  it('reports signalling-only + an honest tri-state, and carries the DHT path', async () => {
    const { swarm, emit } = fakeSwarm();
    const seen: PeerSignallingInfo[] = [];
    await joinHarnessSwarm({
      store: fakeStore(),
      topic: topic32(),
      swarm,
      refreshMs: 0,
      onPeerConnected: (_keyHex, info) => {
        if (info) seen.push(info);
      },
    });

    const { socket } = fakeSocket({ wire: { bytesTransmitted: 0, bytesReceived: 0 }, udx: PUNCHED_UDX });
    emit(socket, undefined);

    expect(seen).toHaveLength(1);
    // The whole point: the callback states what it PROVES.
    expect(seen[0]!.signallingOnly).toBe(true);
    // Zero bytes received at fire time ⇒ the data path is NOT demonstrated.
    expect(seen[0]!.dataPathProven).not.toBe(true);
    // And hyperdht's verdict is available rather than discarded.
    expect(seen[0]!.path.present).toBe(true);
    expect(seen[0]!.path.relayed).toBe(false);
    expect(seen[0]!.path.serverAddress).toBe('198.51.100.7:49201');
  });
});

describe('EI-18682571591024156 — a data path that never came up is reported LOUDLY', () => {
  it('fires onDataPathNeverUp + warns when a connection closes with zero bytes received', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { swarm, emit } = fakeSwarm();
    const dead: DataPathNeverUpInfo[] = [];
    await joinHarnessSwarm({
      store: fakeStore(),
      topic: topic32(),
      swarm,
      refreshMs: 0,
      onDataPathNeverUp: (info) => dead.push(info),
    });

    const { socket, close } = fakeSocket({ wire: NEVER_CAME_UP, udx: PUNCHED_UDX });
    emit(socket, undefined);
    // Before this fix the ONLY symptom of this close was a generic ~13s
    // UV_ETIMEDOUT with nothing pointing at the layer that failed.
    close();

    expect(dead).toHaveLength(1);
    expect(dead[0]!.wire.bytesReceived).toBe(0);
    expect(dead[0]!.wire.bytesTransmitted).toBe(4921);
    expect(dead[0]!.wire.rtoCount).toBe(7);
    expect(dead[0]!.path.relayed).toBe(false);
    expect(dead[0]!.topicHex).toBe(topic32().toString('hex'));

    // Loud + unconditional (not behind the churn-debug env gate).
    expect(warn).toHaveBeenCalled();
    const msg = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toMatch(/data path NEVER came up/i);
  });

  it('stays silent for a connection that actually carried data', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { swarm, emit } = fakeSwarm();
    const dead: DataPathNeverUpInfo[] = [];
    await joinHarnessSwarm({
      store: fakeStore(),
      topic: topic32(),
      swarm,
      refreshMs: 0,
      onDataPathNeverUp: (info) => dead.push(info),
    });

    const { socket, close } = fakeSocket({
      wire: { bytesTransmitted: 4921, bytesReceived: 8123, packetsReceived: 44 },
      udx: PUNCHED_UDX,
    });
    emit(socket, undefined);
    close();

    expect(dead).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * EI-18686573849858243 / EI-18684689702957309 regression — the loud warn must
   * NOT fire for hyperswarm's OWN duplicate-connection dedupe.
   *
   * THE BUG THIS PINS. Hyperswarm destroys the LOSING side of a race-connected
   * duplicate with the exact error `Duplicate connection` (`ERR_DUPLICATE` in
   * node_modules/hyperswarm/index.js) the instant it spots two live connections
   * to one peer. By construction that socket never carries a byte — so it trips
   * `dataPathProven() === false` and, unguarded, fired the loud unconditional
   * warn. That is a benign, EXPECTED outcome of ordinary reconnect churn, not
   * WI-5863's "false success" defect (whose signature is a 13000ms+ death, not a
   * 1–19ms teardown). Unguarded it (a) red-ed swarm-chaos.test.ts under
   * vitest-fail-on-console 13× in a row, 23/23 warns from this one cause, and
   * (b) fed `onDataPathNeverUp` → boot-history `replication_stalled`, inflating
   * any stall count read from that log under churn.
   */
  it('stays silent for hyperswarm\'s own duplicate-connection teardown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { swarm, emit } = fakeSwarm();
    const dead: DataPathNeverUpInfo[] = [];
    await joinHarnessSwarm({
      store: fakeStore(),
      topic: topic32(),
      swarm,
      refreshMs: 0,
      onDataPathNeverUp: (info) => dead.push(info),
    });

    // The real chaos-churn shape: zero bytes EVER crossed, because hyperswarm
    // killed the losing side of the dedupe race before any data could flow.
    const { socket, close, emitError } = fakeSocket({
      wire: { bytesTransmitted: 0, bytesReceived: 0, packetsReceived: 0 },
      udx: PUNCHED_UDX,
    });
    emit(socket, undefined);
    emitError(new Error('Duplicate connection'));
    close();

    // Benign dedupe ⇒ neither the loud warn nor the defect callback (which would
    // otherwise land a bogus `replication_stalled` in boot-history).
    expect(warn).not.toHaveBeenCalled();
    expect(dead).toHaveLength(0);
  });

  it('still warns for a genuinely dead data path preceded by an UNRELATED error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { swarm, emit } = fakeSwarm();
    const dead: DataPathNeverUpInfo[] = [];
    await joinHarnessSwarm({
      store: fakeStore(),
      topic: topic32(),
      swarm,
      refreshMs: 0,
      onDataPathNeverUp: (info) => dead.push(info),
    });

    // The guard must be NARROW: only hyperswarm's dedupe is exempt. A socket that
    // died of RTO exhaustion (WI-5863's actual signature) must stay loud, or the
    // fix for the false positive would silence the real defect it was built for.
    const { socket, close, emitError } = fakeSocket({ wire: NEVER_CAME_UP, udx: PUNCHED_UDX });
    emit(socket, undefined);
    emitError(new Error('ETIMEDOUT'));
    close();

    expect(dead).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/data path NEVER came up/i);
  });

  it('stays silent when the counters are UNREADABLE (unknown is not a failure)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { swarm, emit } = fakeSwarm();
    const dead: DataPathNeverUpInfo[] = [];
    await joinHarnessSwarm({
      store: fakeStore(),
      topic: topic32(),
      swarm,
      refreshMs: 0,
      onDataPathNeverUp: (info) => dead.push(info),
    });

    const { socket, close } = fakeSocket({ wire: null });
    emit(socket, undefined);
    close();

    expect(dead).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * WI-5863 gate (p2p-release plan, 2026-07-26): "confirm the landed udx*
   * fields actually REACH the rig-side close blocks." WI-5943's `remoteHost`/
   * `remotePort` — the address the UDX stream is ACTUALLY pointed at, read
   * straight off `rawStream` (no hyperdht patch required) — is the field the
   * plan's sharpened question hinges on. It was readable via
   * `extractConnectionPath` but had NO assertion proving it survives all the
   * way to `onDataPathNeverUp`'s `path` (the callback boot-history + the loud
   * console.warn both consume) rather than being dropped somewhere in
   * `closePath`/`flattenPathDiagnostics`. Pin it end-to-end so a future refactor
   * that drops it fails HERE, not on a live 2-machine rig run.
   */
  it('carries remoteHost/remotePort (WI-5943 — what address the UDX stream is actually pointed at) through to the callback AND the warn payload', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { swarm, emit } = fakeSwarm();
    const dead: DataPathNeverUpInfo[] = [];
    await joinHarnessSwarm({
      store: fakeStore(),
      topic: topic32(),
      swarm,
      refreshMs: 0,
      onDataPathNeverUp: (info) => dead.push(info),
    });

    const { socket, close } = fakeSocket({
      wire: NEVER_CAME_UP,
      udx: PUNCHED_UDX,
      remoteHost: '10.99.0.12',
    });
    // fakeSocket only sets rawStream.remoteHost; remotePort needs its own prop.
    (socket as { rawStream: Record<string, unknown> }).rawStream.remotePort = 49737;
    emit(socket, undefined);
    close();

    expect(dead).toHaveLength(1);
    expect(dead[0]!.path.remoteHost).toBe('10.99.0.12');
    expect(dead[0]!.path.remotePort).toBe(49737);

    // The warn payload is what triage greps on a live rig run — the field must
    // reach it too, not just the typed callback.
    expect(warn).toHaveBeenCalled();
    const warnedWith = warn.mock.calls[0]![1] as Record<string, unknown>;
    const warnedPath = warnedWith.path as Record<string, unknown>;
    expect(warnedPath.remoteHost).toBe('10.99.0.12');
    expect(warnedPath.remotePort).toBe(49737);
  });
});

describe('EI-18682571591024156 — dataPathSnapshot is what a UI/health check should read', () => {
  it('distinguishes a live-but-dead peer from a genuinely replicating one', async () => {
    const { swarm, emit } = fakeSwarm();
    const handle = await joinHarnessSwarm({
      store: fakeStore(),
      topic: topic32(),
      swarm,
      refreshMs: 0,
    });

    const zombie = fakeSocket({ wire: NEVER_CAME_UP, udx: PUNCHED_UDX });
    const healthy = fakeSocket({
      wire: { bytesTransmitted: 512, bytesReceived: 2048 },
      udx: { udxRelayed: true },
    });
    emit(zombie.socket, undefined);
    emit(healthy.socket, undefined);

    const snap = handle.dataPathSnapshot();
    // Both sockets are LIVE and both fired `peer_connected`; only the snapshot
    // can tell them apart, which is the false-state fix for any UI/health read.
    expect(handle.liveConnectionCount).toBe(2);
    expect(snap.map((e) => e.proven).sort()).toEqual([false, true]);
    const provenFalse = snap.find((e) => e.proven === false);
    expect(provenFalse?.wire.bytesReceived).toBe(0);
    expect(provenFalse?.path.relayed).toBe(false);
    expect(snap.find((e) => e.proven === true)?.path.relayed).toBe(true);
  });
});

describe('EI-18694945517907886 — churn diagnostics print once per socket, not once per joined harness', () => {
  /**
   * THE BUG. `joinHarnessSwarm`'s connection handler is registered once PER
   * JOINED HARNESS on the SAME process-global shared swarm (25+ harnesses in
   * production, `setMaxListeners(0)` near the bottom of swarm.ts documents
   * it). A single physical peer connection therefore invokes every joined
   * harness's handler for the SAME socket, and the churn diagnostics
   * (`[swarm-churn] open/error/close`, `[swarm] ⚠ data path NEVER came up`)
   * were printed unconditionally in each — i.e. (joined harnesses + 1)x per
   * real connection/close. That silently inflated every log-derived
   * connection metric and corrupted the WI-5980 corpus analysis, which counts
   * these printed lines directly (measured live: 78 close records / 39
   * distinct sockets == 2 harnesses joined).
   */
  it('prints "data path NEVER came up" once for two harnesses sharing one connection, but still fires onDataPathNeverUp per harness', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { swarm, emit } = fakeSwarm();
    const deadA: DataPathNeverUpInfo[] = [];
    const deadB: DataPathNeverUpInfo[] = [];

    // Two harnesses joined on the SAME shared swarm — the real deployment
    // shape (one process-global swarm, N per-harness listeners).
    await joinHarnessSwarm({
      store: fakeStore(),
      topic: topic32(),
      swarm,
      refreshMs: 0,
      onDataPathNeverUp: (info) => deadA.push(info),
    });
    await joinHarnessSwarm({
      store: fakeStore(),
      topic: topic32(),
      swarm,
      refreshMs: 0,
      onDataPathNeverUp: (info) => deadB.push(info),
    });

    const { socket, close } = fakeSocket({ wire: NEVER_CAME_UP, udx: PUNCHED_UDX });
    // ONE physical connection — the shared swarm broadcasts it to BOTH
    // harnesses' listeners, exactly like a real hyperswarm 'connection' event.
    emit(socket, undefined);
    close();

    // The printed diagnostic is the log-derived corpus WI-5980 counted — it
    // must appear exactly once per socket, never once per joined harness.
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toMatch(/data path NEVER came up/i);

    // Each harness's OWN functional callback still fires exactly as before —
    // a separate per-harness signal into boot-history, unaffected by the
    // log-print dedup (symmetric with the unconditional per-harness
    // `onPeerConnected`).
    expect(deadA).toHaveLength(1);
    expect(deadB).toHaveLength(1);
  });

  it('the churn-debug open/close text lines are also printed once per socket across harnesses', async () => {
    const prevDebug = process.env.PAPERCUSP_SWARM_CHURN_DEBUG;
    process.env.PAPERCUSP_SWARM_CHURN_DEBUG = '1';
    try {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { swarm, emit } = fakeSwarm();

      // Three harnesses joined on the same shared swarm.
      await joinHarnessSwarm({ store: fakeStore(), topic: topic32(), swarm, refreshMs: 0 });
      await joinHarnessSwarm({ store: fakeStore(), topic: topic32(), swarm, refreshMs: 0 });
      await joinHarnessSwarm({ store: fakeStore(), topic: topic32(), swarm, refreshMs: 0 });

      const { socket, close } = fakeSocket({
        wire: { bytesTransmitted: 512, bytesReceived: 2048 },
      });
      emit(socket, undefined);
      close();

      const opens = errSpy.mock.calls.filter((c) => c[1] === 'open').length;
      const closes = errSpy.mock.calls.filter((c) => c[1] === 'close').length;
      // Before the fix this would be 3 opens / 3 closes for one physical
      // socket (one per joined harness); it must now be 1 / 1.
      expect(opens).toBe(1);
      expect(closes).toBe(1);
    } finally {
      if (prevDebug === undefined) delete process.env.PAPERCUSP_SWARM_CHURN_DEBUG;
      else process.env.PAPERCUSP_SWARM_CHURN_DEBUG = prevDebug;
    }
  });
});
