/**
 * Hyperswarm join + corestore.replicate plumbing for one harness.
 *
 * Plan: this loop's final substrate piece. The bootHarnessSubstrate
 * comment ("Hyperswarm replication setup [...] intentionally
 * separated") finally getting unwound. Without this, the substrate
 * runs single-engineer-only — local writes federate via the in-
 * process Autobase but never reach another machine.
 *
 * What this does:
 *   1. Constructs a Hyperswarm instance (singleton-per-process via a
 *      shared module-level handle — Hyperswarm is heavy, costs ~50ms
 *      to instantiate, and one swarm can join many topics).
 *   2. Joins the harness's topic (server + client).
 *   3. On every `connection` event, pipes the peer socket through
 *      `corestore.replicate(socket)` so the harness's Hypercores
 *      exchange data with the peer.
 *   4. Returns a handle with `close()` that leaves the topic + drops
 *      the per-harness connection listener (NOT destroying the
 *      shared swarm — other harnesses may still need it).
 *
 * Pure-injectable: the swarm factory + corestore + topic are all
 * parameters so unit tests can fully exercise the join/leave/connect
 * cascade without touching the network. The runtime caller pins the
 * factory to `new Hyperswarm()` from the real module.
 */

import type Corestore from 'corestore';
import { getSwarmGuard, type SwarmGuard } from './swarm-guard';

export interface SwarmHandle {
  /** Leave the topic + detach this harness's connection handler.
   * Idempotent. Does NOT destroy the shared swarm. */
  close(): Promise<void>;
  /** Hex topic, for diagnostics + the substrate dashboard. */
  topicHex: string;
  /** Number of times the connection handler has fired since join. */
  connectionCount: number;
}

/**
 * Minimal Hyperswarm-like surface — matches the holepunch.d.ts shim.
 * Lets us test without depending on the real module.
 */
export interface HyperswarmLike {
  join(topic: Buffer, opts?: { server?: boolean; client?: boolean }): { flushed?: () => Promise<void> };
  leave(topic: Buffer): Promise<void> | void;
  on(event: 'connection', listener: (socket: unknown, info?: unknown) => void): unknown;
  off?(event: 'connection', listener: (socket: unknown, info?: unknown) => void): unknown;
}

export interface JoinHarnessSwarmOpts {
  /** The harness's per-corestore (one per harness, shared with Autobase). */
  store: Corestore;
  /** 32-byte topic — derive via `deriveSwarmTopic`. */
  topic: Buffer;
  /** Test seam: supply a swarm; runtime wrapper auto-instantiates. */
  swarm: HyperswarmLike;
  /** Hook fires every time a peer connects + replicates. Receives the peer's
   *  Noise public key (hex) when Hyperswarm surfaces it (P-002). Useful for the
   *  substrate dashboard, boot-history, and per-peer accounting/rate-limiting. */
  onPeerConnected?: (remotePublicKeyHex?: string) => void;
  /** DoS guard (ban-list + connection rate-limit). Defaults to the process-global
   *  guard (the same one the shared swarm's firewall reads). Injectable for tests. */
  guard?: SwarmGuard;
  /** Fires when a connection is dropped because the peer was already banned
   *  (P-007 observability). NOTE: the constructor firewall rejects most banned
   *  *keys* pre-handshake — those never reach this handler, so this only sees
   *  in-flight/IP-ban drops. */
  onPeerRejected?: (remotePublicKeyHex?: string, remoteIp?: string) => void;
  /** Fires when a connection trips the per-peer connection-rate limit and is
   *  banned + dropped (P-007 observability). */
  onPeerRateLimited?: (remotePublicKeyHex?: string, remoteIp?: string) => void;
}

/**
 * Pull the remote peer's IP out of a Hyperswarm connection socket, defensively
 * — the encrypted stream exposes the underlying UDX stream's `remoteHost`. The
 * DoS guard keys its connection-rate limit on IP when available (robust to a
 * peer rotating its Noise key — see hyperswarm-dos-hardening D-003). Returns
 * undefined for test fakes / shapes that don't expose it.
 */
export function extractRemoteIp(socket: unknown): string | undefined {
  const host = (socket as { rawStream?: { remoteHost?: unknown } } | null | undefined)?.rawStream
    ?.remoteHost;
  return typeof host === 'string' && host.length > 0 ? host : undefined;
}

/** Best-effort close of a live peer connection (Hyperswarm's `ban()` prevents
 *  RECONNECT but does NOT close an open connection — D-003). */
function destroySocket(socket: unknown): void {
  try {
    (socket as { destroy?: () => void } | null | undefined)?.destroy?.();
  } catch {
    // best-effort; a peer we're dropping doesn't get to crash us
  }
}

/** Invoke an optional diagnostic callback without letting it crash the handler. */
function fireSafely(
  cb: ((keyHex?: string, ip?: string) => void) | undefined,
  keyHex?: string,
  ip?: string,
): void {
  if (!cb) return;
  try {
    cb(keyHex, ip);
  } catch {
    // diagnostic-only callback; swallow
  }
}

/**
 * Pull the remote peer's Noise public key (hex) out of Hyperswarm's PeerInfo
 * (the 2nd arg of the `connection` event), defensively — the substrate's
 * per-peer accounting + DoS guard key off this. Returns undefined when the
 * shape isn't what we expect (older builds / test fakes).
 */
export function extractPublicKeyHex(peerInfo: unknown): string | undefined {
  const pk = (peerInfo as { publicKey?: { toString?: (enc: string) => string } } | null | undefined)
    ?.publicKey;
  if (pk && typeof pk.toString === 'function') {
    try {
      return pk.toString('hex');
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function joinHarnessSwarm(
  opts: JoinHarnessSwarmOpts,
): Promise<SwarmHandle> {
  if (!opts.store) throw new Error('joinHarnessSwarm: store required');
  if (!opts.topic || opts.topic.length !== 32) {
    throw new Error('joinHarnessSwarm: topic must be a 32-byte Buffer');
  }
  if (!opts.swarm) throw new Error('joinHarnessSwarm: swarm required');

  const guard = opts.guard ?? getSwarmGuard();
  let connectionCount = 0;
  const handler = (socket: unknown, peerInfo?: unknown): void => {
    connectionCount++;
    const remotePublicKeyHex = extractPublicKeyHex(peerInfo);
    const remoteIp = extractRemoteIp(socket);

    // Drop an already-banned peer BEFORE replicating (sync). The constructor
    // firewall rejects banned *keys* pre-handshake, but two cases land here: a
    // connection already in flight when the ban took effect, and any connect
    // from a banned IP (the key-only firewall can't see IPs). ban() doesn't
    // close a live connection (P-004 / D-003), so we destroy the socket.
    if (
      (remotePublicKeyHex && guard.isBannedKey(remotePublicKeyHex)) ||
      (remoteIp && guard.isBannedIp(remoteIp))
    ) {
      destroySocket(socket);
      fireSafely(opts.onPeerRejected, remotePublicKeyHex, remoteIp);
      return;
    }

    // Per-connection rate-limit (P-005). Over the ceiling → the guard bans the
    // key + IP (future connects are firewall-/handler-rejected) and we drop this
    // tripping connection. Fire-and-forget: the in-memory limiter is a microtask,
    // and we don't block replication of legitimate peers on it.
    void guard
      .recordConnection(remotePublicKeyHex, remoteIp)
      .then((v) => {
        if (v.allow) return;
        destroySocket(socket);
        const cb = v.reason === 'rate_limited' ? opts.onPeerRateLimited : opts.onPeerRejected;
        fireSafely(cb, remotePublicKeyHex, remoteIp);
      })
      .catch(() => {});

    try {
      // corestore.replicate(stream) connects the corestore to the
      // peer's stream. Returns a stream we pipe nothing else through;
      // corestore.replicate handles the lifecycle.
      const peerStream = socket as { pipe?: (s: unknown) => unknown };
      const local = opts.store.replicate(true) as { pipe?: (s: unknown) => unknown };
      if (
        peerStream &&
        typeof peerStream.pipe === 'function' &&
        local &&
        typeof local.pipe === 'function'
      ) {
        // Bidirectional pipe: local→peer, peer→local.
        local.pipe(peerStream);
        peerStream.pipe(local);
      }
    } catch {
      // Replication failures shouldn't crash the swarm handler; the
      // peer will reconnect if relevant. Diagnostic counters could
      // be added here later.
    }
    if (opts.onPeerConnected) {
      try {
        opts.onPeerConnected(remotePublicKeyHex);
      } catch {
        // Diagnostic-only callback; swallow.
      }
    }
  };

  opts.swarm.on('connection', handler);
  const discovery = opts.swarm.join(opts.topic, { server: true, client: true });
  // Best-effort flush — some Hyperswarm builds expose this, some
  // don't. Either way, returning before flush is fine because peers
  // can connect any time after the join call returns.
  if (discovery && typeof discovery.flushed === 'function') {
    void discovery.flushed().catch(() => {});
  }

  const handle: SwarmHandle = {
    topicHex: opts.topic.toString('hex'),
    get connectionCount() {
      return connectionCount;
    },
    async close() {
      if (opts.swarm.off) opts.swarm.off('connection', handler);
      try {
        await opts.swarm.leave(opts.topic);
      } catch {
        // Leaving a non-joined topic is a no-op in Hyperswarm; safe.
      }
    },
  };
  return handle;
}

// ─── shared singleton swarm (process-level) ────────────────────────

let _sharedSwarm: HyperswarmLike | null = null;

/** Default total-connection ceiling. Hyperswarm's own default is unlimited;
 *  this bounds a connection-flood DoS regardless of the data layer. Generous
 *  for the dogfood scale (a few peers × a few harnesses); override for larger
 *  topologies via PAPERCUSP_SWARM_MAX_PEERS. */
const DEFAULT_MAX_PEERS = 256;

/**
 * Constructor options for the shared Hyperswarm — the DoS resource ceiling
 * (P-001 of hyperswarm-dos-hardening). `maxPeers` caps total concurrent peer
 * connections. Pure + exported so the wiring is unit-testable without
 * constructing the real (network-touching) swarm.
 */
export function swarmConstructorOpts(): { maxPeers: number } {
  const raw = Number.parseInt(process.env.PAPERCUSP_SWARM_MAX_PEERS ?? '', 10);
  const maxPeers = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_PEERS;
  return { maxPeers };
}

/**
 * Lazy-construct ONE Hyperswarm for the entire process. Hyperswarm
 * is heavy (~50ms cold start + a UDP socket + DHT bootstrapping);
 * sharing it across harnesses cuts that cost to once per process.
 *
 * Tests override via `_setSharedSwarmForTests` so they never touch
 * the real module.
 */
export async function getSharedSwarm(): Promise<HyperswarmLike> {
  if (_sharedSwarm) return _sharedSwarm;
  const mod = await import('hyperswarm');
  const Swarm = (
    mod as {
      default: new (opts?: {
        maxPeers?: number;
        firewall?: (remotePublicKey: Buffer) => boolean;
      }) => HyperswarmLike;
    }
  ).default;
  const guard = getSwarmGuard();
  // P-003: the firewall runs BEFORE the Noise handshake completes — it cheaply
  // rejects banned keys without spending handshake CPU. Hyperswarm only hands
  // the firewall the remote public key, so IP-level bans are enforced in the
  // connection handler instead.
  _sharedSwarm = new Swarm({
    ...swarmConstructorOpts(),
    firewall: (remotePublicKey: Buffer) => guard.firewall(remotePublicKey),
  });
  return _sharedSwarm;
}

export function _setSharedSwarmForTests(s: HyperswarmLike | null): void {
  _sharedSwarm = s;
}

export function _peekSharedSwarmForTests(): HyperswarmLike | null {
  return _sharedSwarm;
}
