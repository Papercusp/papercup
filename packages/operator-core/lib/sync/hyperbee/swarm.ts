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
import Protomux from 'protomux';
import c from 'compact-encoding';
import { getSwarmGuard, type SwarmGuard } from './swarm-guard';
import type { SignedAnnounce } from './announce';
import type { AdmissionResult } from './read-admission';

/** Protomux protocol id for the signed-announce exchange (Model B Stage 4b).
 *  Exported for the A-002 multi-hive demonstrator test. */
export const ANNOUNCE_PROTOCOL = 'papercusp/announce';

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
  join(
    topic: Buffer,
    opts?: { server?: boolean; client?: boolean },
  ): {
    flushed?: () => Promise<void>;
    /** Re-run the topic's DHT announce + lookup round. The ONLY driver that
     *  reliably connects a standalone (non-corestore) transport — see
     *  directory-swarm.ts's module header. */
    refresh?: (opts?: object) => unknown;
  };
  leave(topic: Buffer): Promise<void> | void;
  on(event: 'connection', listener: (socket: unknown, info?: unknown) => void): unknown;
  off?(event: 'connection', listener: (socket: unknown, info?: unknown) => void): unknown;
  /** Live peer sockets (real Hyperswarm exposes a Set). A topic joined on a
   *  shared swarm AFTER a socket exists never re-emits 'connection' for it, so
   *  late joiners must attach to these retroactively. */
  connections?: Iterable<unknown>;
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
  /**
   * OUR signed announce — sent to every (non-dropped) peer right after the
   * `papercusp/announce` channel opens, binding our log core to our device
   * identity. Omit on a swarm that only replicates (no announce exchange);
   * then no announce is sent + inbound announces are ignored.
   */
  ourAnnounce?: SignedAnnounce;
  /**
   * Handle an inbound signed announce from a peer. Verifies the sig, runs the
   * read-admission decision, and on admit opens + admits the peer's remote log
   * and triggers a merge (boot.ts wires this to its `onAnnounce`). Required for
   * the announce exchange to do anything; omit alongside `ourAnnounce`.
   */
  onAnnounce?: (frame: SignedAnnounce) => Promise<AdmissionResult> | void;
}

/** Announce-channel opts for one hive on one peer connection. */
export type AnnounceChannelOpts = {
  ourAnnounce?: SignedAnnounce;
  onAnnounce?: JoinHarnessSwarmOpts['onAnnounce'];
};

/**
 * Per-topic announce-channel state on one muxer — keyed by `muxer × topicHex`.
 *
 * A shared-swarm muxer serves MANY topics over one socket. The announce channel
 * is discriminated per topic — protomux keys `createChannel`/`pair` by
 * `(protocol, id)`, so we use the 32-byte topic as the channel `id` (both peers
 * derive the SAME per-hive topic, so they agree on it). Keying this state by
 * `muxer × topicHex` (not `muxer` alone) is the A-002 fix: previously a 2nd hive
 * on the muxer overwrote the 1st's opts + collided on the protocol-only channel
 * key (createChannel → null) → its admission exchange was silently dropped.
 *
 * A-003 (a′) generalizes this from ONE log per topic to MANY: an instance may
 * run more than one local harness on the SAME hive topic (e.g. a hive's MEMBER
 * harness + its HIVE-HOME harness, so hive_members/hive_settings federate). They
 * share one announce channel (one (protocol, topic) channel per muxer), but the
 * channel now carries EVERY local log's announce on that topic — `entries` maps
 * each local harness (keyed by its own `log_core_key`) to its opts. On open (and
 * on a late-joining harness) we flush every not-yet-sent `ourAnnounce`; an
 * inbound announce is delivered to EVERY registered `onAnnounce` on the topic.
 *
 * CALLER CONTRACT: register `onAnnounce` only for harnesses that should ADMIT
 * inbound logs on this topic (the member). A send-only harness (the hive-home,
 * which only needs its own log announced so members admit it) passes
 * `ourAnnounce` WITHOUT `onAnnounce`, so it is never delivered a remote announce
 * to mis-admit. `paired` is the once-per-(muxer,topic) lazy-accept notifier;
 * `sentKeys` dedups sends by log_core_key (idempotent across re-pair/reconnect).
 */
type TopicAnnounceState = {
  /** Local harnesses on this topic, keyed by their own log_core_key (dedup). */
  entries: Map<string, AnnounceChannelOpts>;
  /** Lazy-accept pair-notifier registered for this (muxer, topic). */
  paired: boolean;
  /** The live channel's message sink, set once the channel is created. */
  message: { send(value: SignedAnnounce): void } | null;
  /** Whether the channel's `onopen` has fired (safe to send late announces). */
  opened: boolean;
  /** log_core_keys already sent on the wire — guards double-send. */
  sentKeys: Set<string>;
};

const announceTopicStateByMuxer = new WeakMap<object, Map<string, TopicAnnounceState>>();

/** Get-or-create the per-topic announce-state map for a muxer. */
function announceTopicStatesFor(mux: object): Map<string, TopicAnnounceState> {
  let m = announceTopicStateByMuxer.get(mux);
  if (!m) {
    m = new Map();
    announceTopicStateByMuxer.set(mux, m);
  }
  return m;
}

/** Create + open the announce channel on a muxer (returns silently when the
 *  channel already exists on it). Split from openAnnounceChannel so the
 *  protomux pair-notifier can re-create the channel synchronously. */
/** Flush every not-yet-sent local `ourAnnounce` on a topic over its live
 *  channel. Idempotent via `state.sentKeys` — a duplicate onopen, a re-pair, or
 *  a late-joining harness can call this without double-sending. */
function flushTopicAnnounces(state: TopicAnnounceState): void {
  if (!state.message) return;
  for (const entry of state.entries.values()) {
    const ann = entry.ourAnnounce;
    if (!ann || state.sentKeys.has(ann.log_core_key)) continue;
    state.sentKeys.add(ann.log_core_key);
    try {
      state.message.send(ann);
    } catch {
      // best-effort — replication still proceeds
    }
  }
}

/** Create + open the single announce channel for a topic on a muxer (one
 *  `(protocol, topic)` channel), then drive it from the per-topic `state`:
 *  every local log's announce is sent on `onopen` (Protomux fires it only once
 *  the channel is fully PAIRED — sending before that drops the frame, and
 *  announces aren't re-sent), and each inbound announce is delivered to every
 *  registered `onAnnounce`. Returns silently when the channel already exists on
 *  the muxer (the lazy-accept re-create / a 2nd harness on the same topic). */
function createAnnounceChannel(
  mux: ReturnType<typeof Protomux.from>,
  channelId: Buffer,
  state: TopicAnnounceState,
): void {
  const channel = mux.createChannel({
    protocol: ANNOUNCE_PROTOCOL,
    // Discriminate the announce channel PER TOPIC by the hive topic (A-002).
    // Without an id, a 2nd hive on the same muxer collides on the protocol-only
    // key and createChannel returns null — dropping its admission exchange.
    id: channelId,
    onopen: () => {
      state.opened = true;
      flushTopicAnnounces(state); // send ALL local logs' announces on this topic
    },
  });
  if (!channel) return; // already open on this muxer for this topic — nothing to do
  const message = channel.addMessage<SignedAnnounce>({
    encoding: c.json,
    onmessage: (frame: SignedAnnounce) => {
      // A-003 (a′): deliver an inbound announce to EVERY local harness that
      // admits on this topic (send-only harnesses register no onAnnounce).
      for (const entry of state.entries.values()) {
        if (!entry.onAnnounce) continue;
        try {
          // onAnnounce may be async; never let a rejection crash the muxer.
          void Promise.resolve(entry.onAnnounce(frame)).catch(() => {});
        } catch {
          // synchronous throw — swallow
        }
      }
    },
  });
  state.message = message;
  channel.open();
}

/** Open the `papercusp/announce` channel on the shared muxer for one peer
 *  connection, wire inbound announces to `onAnnounce`, and send `ourAnnounce`.
 *  Defensive: any protomux error is swallowed — a peer that can't speak the
 *  announce protocol still replicates over the same connection. */
export function openAnnounceChannel(
  socket: unknown,
  topic: Buffer,
  opts: AnnounceChannelOpts,
): void {
  if (!opts.onAnnounce && !opts.ourAnnounce) return;
  try {
    // Protomux.from REUSES socket.userData when corestore.replicate(socket)
    // already attached it, so the announce shares the replication muxer. Pin
    // the muxer on the stream when unset (the hypercore convention) so every
    // later protocol on this socket reuses it instead of double-muxing.
    const mux = Protomux.from(socket);
    const s = socket as { userData?: unknown };
    if (!s.userData) s.userData = mux;
    // Per-topic state, keyed by topicHex (A-002). A-003 (a′): MULTIPLE local
    // harnesses can share one topic — accumulate each (keyed by its own log
    // core) so the single topic channel carries every local log's announce.
    const topicHex = topic.toString('hex');
    const states = announceTopicStatesFor(mux);
    let state = states.get(topicHex);
    if (!state) {
      state = { entries: new Map(), paired: false, message: null, opened: false, sentKeys: new Set() };
      states.set(topicHex, state);
    }
    // Register/refresh THIS harness's entry, keyed by its own log_core_key so a
    // reconnect/replay on the same muxer de-dups rather than double-registering.
    // (A send-only harness with no ourAnnounce falls back to a positional key.)
    const entryKey = opts.ourAnnounce?.log_core_key ?? `__reader-${state.entries.size}`;
    state.entries.set(entryKey, opts);
    // LAZY-ACCEPT pair-notifier, ONCE per (muxer, topic). Registered with
    // id = topic so protomux dispatches a remote announce-open for THIS topic to
    // THIS notifier (_requestSession keys _notify by toKey(protocol, id), with a
    // null-id fallback). On a SHARED swarm the two ends attach to an existing
    // socket at different times (the socket may predate both, opened by the
    // hive-directory gossip). The earlier end's channel-open reaches the later
    // end before any matching channel exists, and protomux REJECTS it —
    // permanently, opens are never re-sent — so the earlier end could never
    // pair. The notifier accepts a pending open by creating our channel
    // SYNCHRONOUSLY (the directory-gossip late-join lesson — see
    // directory-swarm.ts).
    if (!state.paired) {
      state.paired = true;
      try {
        mux.pair({ protocol: ANNOUNCE_PROTOCOL, id: topic }, () => {
          const cur = states.get(topicHex);
          if (cur) {
            try {
              createAnnounceChannel(mux, topic, cur);
            } catch {
              // best-effort — a failed lazy accept degrades to the old reject
            }
          }
        });
      } catch {
        // pair() unsupported on this muxer build — connect-time channels still pair
      }
    }
    // Create the topic channel once (the FIRST harness); a later harness's
    // createChannel returns null (channel exists) — its entry is already in
    // `state`, so it rides the same channel. If the channel has already opened,
    // flush this late-joining harness's announce now (the onopen flush already
    // fired and won't re-run for it).
    createAnnounceChannel(mux, topic, state);
    if (state.opened) flushTopicAnnounces(state);
  } catch {
    // Announce channel is best-effort; replication still proceeds.
  }
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
    // An unclean peer disconnect (reset / timeout / mid-replication death)
    // emits 'error' on the connection socket; with no listener Node escalates
    // it to an UNCAUGHT EXCEPTION — i.e. a remote peer dying could crash this
    // whole host process. Found by the P-004 swarm-chaos test
    // (coord-system-e2e-testing-2026-06-10); hyperswarm's own docs require the
    // consumer to handle connection errors. The reconnect path is discovery's
    // job — the error itself is just churn.
    (socket as { on?: (ev: string, fn: (e: unknown) => void) => unknown })?.on?.('error', () => {});
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
      // corestore.replicate(socket) plugs the corestore into the peer's
      // connection as an EXTERNAL stream (replaces the old replicate(true) +
      // manual bidi pipe). This both starts Hypercore replication AND attaches
      // the shared muxer at `socket.userData` — which the announce channel then
      // rides (spike Step 5). corestore handles the stream lifecycle.
      opts.store.replicate(socket);
      // Open the announce channel on the SAME connection's muxer: exchange
      // signed announces so admitted peer logs get aggregated (Model B Stage 4b).
      openAnnounceChannel(socket, opts.topic, {
        ourAnnounce: opts.ourAnnounce,
        onAnnounce: opts.onAnnounce,
      });
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
  // Shared-swarm late join: a socket opened by an EARLIER topic's join (the
  // hive-directory gossip, another harness) never re-emits 'connection', so a
  // topic joined later must attach replication + the announce channel to the
  // EXISTING sockets itself — otherwise two peers already connected via the
  // directory silently never federate the harness (found by the packaged
  // browse→join→federate smoke).
  try {
    for (const socket of opts.swarm.connections ?? []) {
      const pk = (socket as { remotePublicKey?: unknown } | null)?.remotePublicKey;
      try {
        handler(socket, pk ? { publicKey: pk } : undefined);
      } catch {
        // per-socket best-effort — a bad existing socket can't block the join
      }
    }
  } catch {
    // connections iteration is best-effort (absent on minimal fakes)
  }
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

/** One DHT bootstrap node (host + UDP port). */
export interface DhtBootstrapNode {
  host: string;
  port: number;
}

/**
 * Parse `PAPERCUSP_DHT_BOOTSTRAP` — a comma-separated `host:port` list — into
 * hyperdht bootstrap nodes. Returns undefined when unset/empty/all-malformed
 * (→ the swarm uses the real public DHT, the default). When set, every peer
 * that shares the value joins the SAME isolated DHT — which is how two
 * instances on ONE box deterministically discover each other without relying on
 * public-DHT NAT hairpinning (the same trick the in-process p079 live test uses
 * via `hyperdht/testnet`). Exported for unit testing.
 */
export function parseDhtBootstrap(raw: string | undefined): DhtBootstrapNode[] | undefined {
  if (!raw) return undefined;
  const nodes = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s): DhtBootstrapNode | null => {
      const i = s.lastIndexOf(':'); // lastIndexOf tolerates IPv6-ish hosts minimally
      if (i <= 0) return null;
      const host = s.slice(0, i);
      const port = Number.parseInt(s.slice(i + 1), 10);
      return host && Number.isFinite(port) && port > 0 ? { host, port } : null;
    })
    .filter((n): n is DhtBootstrapNode => n !== null);
  return nodes.length ? nodes : undefined;
}

/**
 * Constructor options for the shared Hyperswarm — the DoS resource ceiling
 * (P-001 of hyperswarm-dos-hardening). `maxPeers` caps total concurrent peer
 * connections; `bootstrap` (when `PAPERCUSP_DHT_BOOTSTRAP` is set) points the
 * underlying hyperdht at a custom/isolated DHT instead of the public one. Pure
 * + exported so the wiring is unit-testable without constructing the real
 * (network-touching) swarm.
 */
export function swarmConstructorOpts(): { maxPeers: number; bootstrap?: DhtBootstrapNode[] } {
  const raw = Number.parseInt(process.env.PAPERCUSP_SWARM_MAX_PEERS ?? '', 10);
  const maxPeers = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_PEERS;
  const bootstrap = parseDhtBootstrap(process.env.PAPERCUSP_DHT_BOOTSTRAP);
  return bootstrap ? { maxPeers, bootstrap } : { maxPeers };
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
        bootstrap?: DhtBootstrapNode[];
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
