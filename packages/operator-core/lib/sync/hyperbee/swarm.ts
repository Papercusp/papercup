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
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import Protomux from 'protomux';
import c from 'compact-encoding';
import { getSwarmGuard, type SwarmGuard } from './swarm-guard';
import { getResourceProfile } from '../../resource-profile';
import type { SignedAnnounce } from './announce';
import type { AdmissionResult } from './read-admission';
import { wireHiveGitServe, type HiveGitServeConfig } from '../hive-git/serve-wiring';
import { wireHiveGitDial, resolveVerifiedDevicePubkeyForSocket } from '../hive-git/peer-dial-registry';

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
  /**
   * Number of currently-OPEN peer connections on this handle (incremented on
   * connect, decremented on socket close). Feeds the replication-liveness
   * `connected_never_replicated` axis (WI-183/WI-1840): swarm-level
   * connectivity is the discriminator between "peer offline" (never alarms)
   * and "connected-but-dead replication" (the zombie-connection class).
   */
  liveConnectionCount: number;
}

/** Snapshot of the shared swarm's peer-budget pressure at a near-cap crossing
 *  (P-004). Carried by {@link JoinHarnessSwarmOpts.onNearPeerCap}. */
export interface PeerCapInfo {
  /** Live peer connections on the shared swarm at the moment of the signal. */
  liveConnections: number;
  /** The process-global `maxPeers` ceiling the swarm was constructed with. */
  maxPeers: number;
  /** True once `liveConnections` has actually REACHED the ceiling — Hyperswarm
   *  will now silently refuse further peers until a slot frees. */
  atCap: boolean;
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
  /** The process-global total-connection ceiling this swarm was constructed with
   *  (Hyperswarm stores its `maxPeers` here). Read for the near-cap pressure
   *  signal (P-004); undefined on minimal test fakes. */
  maxPeers?: number;
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
   * P-004 observability: fires when the SHARED swarm's live peer count crosses
   * into the near-cap zone (>= {@link PEER_CAP_NEAR_RATIO} × the process-global
   * `maxPeers`). Hyperswarm SILENTLY stops accepting/opening connections once
   * `maxPeers` is reached — so peer N+1 just never connects, with no signal. This
   * makes that pressure VISIBLE before (and at) the cap so the caller can wire a
   * metric/alert. Best-effort + rate-limited (fires once per crossing via
   * hysteresis, re-arms after the count drops back below the threshold).
   */
  onNearPeerCap?: (info: PeerCapInfo) => void;
  /**
   * OUR signed announce — sent to every (non-dropped) peer right after the
   * `papercusp/announce` channel opens, binding our log core to our device
   * identity. Omit on a swarm that only replicates (no announce exchange);
   * then no announce is sent + inbound announces are ignored.
   */
  ourAnnounce?: SignedAnnounce;
  /**
   * WI-559 issue-2 — a FACTORY that builds a FRESH signed announce (current `ts`, re-signed) for
   * EACH connection's channel-open. A single frozen-`ts` frame (built once at boot and reused) is
   * rejected by the peer's `verifyAnnounce` once it is >5min old (DEFAULT_ANNOUNCE_WINDOW_MS), so a
   * post-window / post-reconnect connection sent a stale announce → 0 admitted → own-only set. When
   * supplied, the channel-open flush builds a fresh frame per send via this; `ourAnnounce` is kept
   * for the static `log_core_key` (the swarm entry key) and as the fallback when no factory is set.
   */
  buildOurAnnounce?: () => Promise<SignedAnnounce>;
  /**
   * Handle an inbound signed announce from a peer. Verifies the sig, runs the
   * read-admission decision, and on admit opens + admits the peer's remote log
   * and triggers a merge (boot.ts wires this to its `onAnnounce`). Required for
   * the announce exchange to do anything; omit alongside `ourAnnounce`.
   */
  onAnnounce?: (
    frame: SignedAnnounce,
    ctx?: AnnounceConnectionContext,
  ) => Promise<AdmissionResult> | void;
  /**
   * SUBSTRATE_SIDECAR Option B (WI-604) replication-offload seam. When supplied,
   * the connection handler calls this with each accepted peer socket INSTEAD of
   * `store.replicate(socket)`. A truthy return means the offload claimed the
   * socket (it is being handed to / replicated by the sidecar) so the in-process
   * `store.replicate` is SKIPPED — handing the merkle-verify CPU + replication
   * RSS off the main event loop (the EI-79 win). A falsy return means the offload
   * declined (no sidecar / not wired) and the handler replicates in-process as
   * usual. OMITTED (the default + the flag-OFF path) ⇒ byte-identical in-process
   * replication. MUST be synchronous + non-throwing (a throw is treated as
   * declined → in-process fallback).
   */
  offloadReplication?: (socket: unknown, peerInfo?: unknown) => boolean;
  /**
   * WI-752 / FED-2 self-heal: FAST per-topic `discovery.refresh()` cadence (ms)
   * during the post-join / post-peer-loss window. Default
   * `DEFAULT_SUBSTRATE_REFRESH_MS`. `0` DISABLES the self-heal loop entirely
   * (byte-identical to the pre-WI-752 join — tests that drive refresh by hand).
   */
  refreshMs?: number;
  /** How long the FAST cadence runs after a join / losing the last peer (ms).
   *  Default `DEFAULT_SUBSTRATE_FAST_WINDOW_MS`. */
  fastWindowMs?: number;
  /** Steady-state keepalive cadence once the fast window lapses (ms).
   *  Default `DEFAULT_SUBSTRATE_SLOW_REFRESH_MS`. */
  slowRefreshMs?: number;
  /**
   * WI-1534 anti-entropy: best-effort predicate — true when at least one
   * ADMITTED remote log on this harness currently shows ZERO live replicator
   * peers (attached-but-dead OR never-attached), i.e. the merge pass has
   * something it cannot pull. On a QUIESCENT hive (no connection churn to
   * naturally re-arm the FAST post-join/post-peer-loss window) the self-heal
   * loop otherwise settles into the 60s `slowRefreshMs` keepalive and stays
   * there indefinitely — observed as an 80+min stall until an unrelated event
   * (the next owner append) happens to coincide with a working DHT/holepunch
   * retry (known-limitations §NAT, WI-1534). Polled once per refresh tick
   * (cheap — a Map scan, no I/O); a throw is treated as false (never blocks
   * the keepalive). Omitted ⇒ byte-identical pre-WI-1534 behavior (fast window
   * only, then flat 60s slow cadence).
   */
  hasStalledLogs?: () => boolean;
  /**
   * P-201 (p2p-git-live-activation-2026-07-09): register this harness's
   * connections to SERVE `papercusp/hive-git` fetch requests (a peer member
   * fetching our namespace) — omitted for a non-hive harness (the common
   * case), so byte-for-byte unchanged when not set. Actual serving is further
   * mode-gated PER REQUEST inside the wiring (a legacy-mode hive always
   * refuses, re-checked live — no re-seed needed on a mode flip).
   */
  hiveGitServe?: HiveGitServeConfig;
  /**
   * WI-3583 (p2p-git-live-activation-2026-07-09 Phase-3 prerequisite):
   * register this connection on the hive-git dial-hello channel, so a
   * device-pubkey → live-socket registry (`peer-dial-registry.ts`) can
   * resolve "which live connection reaches device X" for a REAL cross-
   * machine `openDuplex` (worktree-bridge-tick.ts / ref-announce-tick.ts's
   * own `openDuplex` seam — currently omitted/local-mirror-only without
   * this). Omitted for a non-hive-git harness, so byte-for-byte unchanged
   * when not set. Independent of `hiveGitServe` — either can be set alone.
   */
  hiveGitDial?: {
    selfDevicePubkeyBase64: string;
    /** WI-3641: signs OUR hello frame (Ed25519 over the hello sign-context)
     *  so the peer's `wireHiveGitServe` can verify it owns `selfDevicePubkeyBase64`
     *  before binding it to this socket. Required — a dial registration with no
     *  signer can announce a device_pubkey without proving it, which is exactly
     *  what the signed-hello handshake exists to prevent. */
    sign: (bytes: Buffer) => Promise<Buffer> | Buffer;
  };
}

/**
 * Per-connection context handed to `onAnnounce` alongside each inbound frame
 * (P-006 §5.2/§5.3). Lets the admission layer act on THIS specific connection:
 *   - `send` a DIRECTED follow-up announce back to only this peer (the scoped-
 *     log disclosure rides a follow-up frame after the peer's identity is known,
 *     since the first announce is identity-blind);
 *   - `muxer` is the shared Protomux for this connection — the object scoped
 *     cores attach to (`session.replicate(muxer)`) so the §5.3 serve gate serves
 *     a scope on exactly the connections whose peer is in its roster.
 * OPTIONAL 2nd arg: pre-§5.2 `onAnnounce` implementations ignore it, unchanged.
 */
export interface AnnounceConnectionContext {
  /** Send a signed frame to THIS peer on the announce channel (directed). */
  send(frame: SignedAnnounce): void;
  /** The shared Protomux muxer for this connection (scoped-core attach target). */
  muxer: object;
}

/** Announce-channel opts for one hive on one peer connection. */
export type AnnounceChannelOpts = {
  ourAnnounce?: SignedAnnounce;
  /** WI-559 issue-2: fresh-announce-per-connection factory (see JoinHarnessSwarmOpts). */
  buildOurAnnounce?: () => Promise<SignedAnnounce>;
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
const announcePairedMuxers = new WeakSet<object>();
const guardCountedSockets = new WeakSet<object>();

// ── WI-1544 (defect iii): periodic announce re-flush ──
// The announce exchange is ONE-SHOT per (muxer, topic): `sentKeys` dedups
// forever, and the receive side never re-requests. So any single loss — a
// send that raced the channel teardown, a receiver whose admission threw once,
// a topic rejoin over a surviving connection — permanently suppressed this
// log's announce until a process restart (the WI-1544 m-run A→B stall class).
// A slow sweep clears each LIVE topic state's dedup set and re-flushes fresh
// signed frames. Receivers are idempotent (an already-admitted log is a cheap
// map hit; a pending one re-buffers with its grace clock preserved), so the
// steady-state cost is one small frame per log per interval — and every
// one-shot-loss failure mode self-heals in ≤ the interval.
const ANNOUNCE_REFLUSH_MS = (() => {
  const raw = Number(process.env.PAPERCUSP_ANNOUNCE_REFLUSH_MS);
  return Number.isFinite(raw) ? raw : 5 * 60 * 1000;
})();
type AnnounceReflushEntry = {
  state: TopicAnnounceState;
  stream: { destroyed?: boolean };
};
const announceReflushEntries = new Set<AnnounceReflushEntry>();
let announceReflushTimer: ManagedHandle | null = null;
function sweepAnnounceReflush(): void {
  for (const entry of announceReflushEntries) {
    if (entry.stream.destroyed === true) {
      announceReflushEntries.delete(entry);
      continue;
    }
    if (!entry.state.opened || !entry.state.message) continue;
    entry.state.sentKeys.clear();
    flushTopicAnnounces(entry.state);
  }
  if (announceReflushEntries.size === 0 && announceReflushTimer) {
    announceReflushTimer.stop();
    announceReflushTimer = null;
  }
}
function trackAnnounceReflush(entry: AnnounceReflushEntry): void {
  if (ANNOUNCE_REFLUSH_MS <= 0) return; // env kill-switch (tests / diagnostics)
  announceReflushEntries.add(entry);
  if (!announceReflushTimer) {
    announceReflushTimer = managedSetInterval(
      'hyperbee-announce-reflush',
      ANNOUNCE_REFLUSH_MS,
      () => sweepAnnounceReflush(),
      { category: 'lifecycle' },
    );
  }
}

function announceDebug(message: string): void {
  if (process.env.PAPERCUSP_ANNOUNCE_DEBUG !== '1') return;
   
  console.info(`[announce-debug] ${message}`);
}

const announceMuxDebugIds = new WeakMap<object, number>();
let nextAnnounceMuxDebugId = 1;

function announceMuxDebugId(mux: object): number {
  let id = announceMuxDebugIds.get(mux);
  if (!id) {
    id = nextAnnounceMuxDebugId++;
    announceMuxDebugIds.set(mux, id);
  }
  return id;
}

function announceDebugCtor(value: unknown): string {
  return (
    (value as { constructor?: { name?: unknown } } | null | undefined)?.constructor?.name as
      | string
      | undefined
  ) ?? typeof value;
}

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
  const msg = state.message;
  if (!msg) return;
  for (const entry of state.entries.values()) {
    // WI-559 issue-2 — send a FRESH announce (current ts, re-signed) per connection when a factory
    // is supplied: a frozen-ts frame is rejected by the peer's verifyAnnounce once it is >5min old,
    // so a reconnect after the window admitted nothing → own-only set. Dedup by log_core_key so a
    // re-pair / late-join on the SAME channel doesn't double-send; a NEW connection gets a fresh
    // `state` (fresh sentKeys) → re-flushes → a fresh frame, which IS the per-connection refresh.
    if (entry.buildOurAnnounce) {
      const key = entry.ourAnnounce?.log_core_key;
      if (!key || state.sentKeys.has(key)) continue;
      state.sentKeys.add(key);
      void entry
        .buildOurAnnounce()
        .then((fresh) => {
          try {
            msg.send(fresh);
            announceDebug(`sent fresh log=${fresh.log_core_key.slice(0, 12)}...`);
          } catch (e) {
            // best-effort — replication still proceeds. WI-1544: this drop is
            // one-shot per connection (sentKeys already marked) — make it loud.
            announceDebug(
              `send-failed log=${fresh.log_core_key.slice(0, 12)}... err=${e instanceof Error ? e.message : String(e)}`,
            );
          }
        })
        .catch((e: unknown) => {
          // a build/sign failure must never crash the swarm handler — but it
          // silently suppresses this core's announce for the whole connection
          // (WI-1544 round-1 candidate), so trace it.
          announceDebug(
            `build-failed log=${key.slice(0, 12)}... err=${e instanceof Error ? e.message : String(e)}`,
          );
        });
      continue;
    }
    const ann = entry.ourAnnounce;
    if (!ann || state.sentKeys.has(ann.log_core_key)) continue;
    state.sentKeys.add(ann.log_core_key);
    try {
      msg.send(ann);
      announceDebug(`sent static log=${ann.log_core_key.slice(0, 12)}...`);
    } catch (e) {
      // best-effort — replication still proceeds (loud: one-shot per connection)
      announceDebug(
        `send-failed static log=${ann.log_core_key.slice(0, 12)}... err=${e instanceof Error ? e.message : String(e)}`,
      );
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
  const muxId = announceMuxDebugId(mux as object);
  const channel = mux.createChannel({
    protocol: ANNOUNCE_PROTOCOL,
    // Discriminate the announce channel PER TOPIC by the hive topic (A-002).
    // Without an id, a 2nd hive on the same muxer collides on the protocol-only
    // key and createChannel returns null — dropping its admission exchange.
    id: channelId,
    onopen: () => {
      state.opened = true;
      announceDebug(
        `open topic=${channelId.toString('hex').slice(0, 16)} entries=${state.entries.size}`,
      );
      flushTopicAnnounces(state); // send ALL local logs' announces on this topic
    },
    onclose: () => {
      announceDebug(`close mux=${muxId} topic=${channelId.toString('hex').slice(0, 16)}`);
    },
  });
  if (!channel) {
    announceDebug(`create-null mux=${muxId} topic=${channelId.toString('hex').slice(0, 16)}`);
    return; // already open on this muxer for this topic — nothing to do
  }
  announceDebug(
    `create mux=${muxId} topic=${channelId.toString('hex').slice(0, 16)} entries=${state.entries.size}`,
  );
  const message = channel.addMessage<SignedAnnounce>({
    encoding: c.json,
    onmessage: (frame: SignedAnnounce) => {
      announceDebug(
        `recv topic=${channelId.toString('hex').slice(0, 16)} log=${frame.log_core_key.slice(0, 12)}...`,
      );
      // A-003 (a′): deliver an inbound announce to EVERY local harness that
      // admits on this topic (send-only harnesses register no onAnnounce).
      // P-006 §5.2/§5.3: hand each a per-connection context — `send` for a
      // DIRECTED scoped-log follow-up back to this peer, `muxer` for the
      // scoped-core serve gate. `mux` is the shared Protomux for this
      // connection; `state.message` is this (muxer,topic) channel's sink, so a
      // send reaches ONLY this peer.
      const ctx: AnnounceConnectionContext = {
        muxer: mux as object,
        send: (f: SignedAnnounce) => {
          try {
            state.message?.send(f);
          } catch {
            // best-effort — replication still proceeds if a follow-up drops
          }
        },
      };
      for (const entry of state.entries.values()) {
        if (!entry.onAnnounce) continue;
        try {
          // onAnnounce may be async; never let a rejection crash the muxer.
          void Promise.resolve(entry.onAnnounce(frame, ctx)).catch(() => {});
        } catch {
          // synchronous throw — swallow
        }
      }
    },
  });
  state.message = message;
  channel.open();
  announceDebug(`open-request mux=${muxId} topic=${channelId.toString('hex').slice(0, 16)}`);
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
    // Corestore/Hypercore attaches Protomux to the NoiseSecretStream, not always
    // the outer Hyperswarm socket. Use `socket.noiseStream` when present so the
    // announce channel shares the same muxer as Hypercore replication; otherwise
    // live peers connect but never exchange announce/admission frames.
    const muxStream = ((socket as { noiseStream?: unknown } | null)?.noiseStream ?? socket) as {
      userData?: unknown;
      isProtomux?: unknown;
    };
    const beforeUserData = muxStream.userData;
    const mux = Protomux.from(muxStream);
    const muxId = announceMuxDebugId(mux as object);
    if (!muxStream.userData) muxStream.userData = mux;
    announceDebug(
      `mux mux=${muxId} topic=${topic
        .toString('hex')
        .slice(0, 16)} stream=${announceDebugCtor(muxStream)} streamIsMux=${muxStream.isProtomux === true} userData=${announceDebugCtor(
        beforeUserData,
      )} userDataIsMux=${(beforeUserData as { isProtomux?: unknown } | null | undefined)?.isProtomux === true}`,
    );
    // Per-topic state, keyed by topicHex (A-002). A-003 (a′): MULTIPLE local
    // harnesses can share one topic — accumulate each (keyed by its own log
    // core) so the single topic channel carries every local log's announce.
    const topicHex = topic.toString('hex');
    const states = announceTopicStatesFor(mux);
    let state = states.get(topicHex);
    if (!state) {
      state = { entries: new Map(), paired: false, message: null, opened: false, sentKeys: new Set() };
      states.set(topicHex, state);
      // WI-1544 (defect iii): enroll this live topic state in the slow
      // announce re-flush sweep so a one-shot announce loss self-heals.
      trackAnnounceReflush({ state, stream: muxStream as { destroyed?: boolean } });
    }
    // Register/refresh THIS harness's entry, keyed by its own log_core_key so a
    // reconnect/replay on the same muxer de-dups rather than double-registering.
    // (A send-only harness with no ourAnnounce falls back to a positional key.)
    const entryKey = opts.ourAnnounce?.log_core_key ?? `__reader-${state.entries.size}`;
    // WI-1544 (defect iii): a RE-registration of an already-known log on this
    // (muxer, topic) means the harness re-joined the topic over a surviving
    // connection (rekey / join-retry). The peer may have missed (or dropped)
    // the original announce, and sentKeys would suppress it forever — clear
    // this log's dedup mark so the flush below re-sends a fresh signed frame
    // (receivers are idempotent).
    if (state.entries.has(entryKey)) state.sentKeys.delete(entryKey);
    state.entries.set(entryKey, opts);
    // LAZY-ACCEPT pair-notifier, ONCE per muxer. Register at protocol scope and
    // dispatch by the incoming topic id, matching directory-swarm.ts. Live
    // Protomux delivers late remote opens to the protocol-level pair notifier;
    // registering pair({ protocol, id: topic }) leaves the pending open
    // unaccepted, so the channel never reaches onopen and announces never send.
    if (!announcePairedMuxers.has(mux)) {
      announcePairedMuxers.add(mux);
      try {
        mux.pair({ protocol: ANNOUNCE_PROTOCOL }, (id: Buffer | null) => {
          if (!id) {
            announceDebug(`pair mux=${muxId} topic=<null>`);
            return;
          }
          const cur = states.get(id.toString('hex'));
          announceDebug(
            `pair mux=${muxId} topic=${id.toString('hex').slice(0, 16)} hasState=${Boolean(
              cur,
            )} entries=${cur?.entries.size ?? 0}`,
          );
          if (cur) {
            try {
              createAnnounceChannel(mux, id, cur);
            } catch {
              // best-effort — a failed lazy accept degrades to the old reject
            }
          }
        });
      } catch {
        // pair() unsupported on this muxer build — connect-time channels still pair
      }
    }
    // Create the topic channel once the underlying Noise stream is open. This
    // mirrors corestore's own `noiseStream.opened.then(uncork)` timing: opening
    // our app channel before the transport is ready can leave the local open
    // frame corked forever on packaged shared-swarm sockets, so the peer never
    // sees it and `onopen` never fires.
    const createWhenReady = () => {
      createAnnounceChannel(mux, topic, state);
      // If the channel had already opened, flush this late-joining harness's
      // announce now (the onopen flush already fired and won't re-run for it).
      if (state.opened) flushTopicAnnounces(state);
    };
    const opened = (muxStream as { opened?: Promise<unknown> } | null | undefined)?.opened;
    if (opened && typeof opened.then === 'function') {
      announceDebug(`defer-open mux=${muxId} topic=${topic.toString('hex').slice(0, 16)}`);
      void opened.then(createWhenReady, createWhenReady);
    } else {
      createWhenReady();
    }
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
 * P-004 near-cap signal. Hyperswarm's `maxPeers` is a PROCESS-GLOBAL ceiling on
 * total live connections across every joined topic; once it's reached Hyperswarm
 * SILENTLY stops opening/accepting — so peer N+1 just never connects, with no
 * log/event. This fraction of `maxPeers` is the threshold at which we emit a
 * LOUD, rate-limited signal so that silent drop is VISIBLE before (and at) the
 * cap. 0.9 leaves ~10% headroom to act (raise the budget / scale the box).
 */
export const PEER_CAP_NEAR_RATIO = 0.9;

/** Hysteresis state, keyed by swarm: have we already warned for the CURRENT
 *  approach to the cap? Re-armed once the live count drops back below threshold
 *  so a later re-approach warns again, but a steady stream of connections at the
 *  cap doesn't spam the log/event on every single `connection`. */
const peerCapNearState = new WeakMap<object, boolean>();

/** Count live peer sockets on a swarm. Real Hyperswarm exposes a Set (cheap
 *  `.size`); fakes may expose any Iterable or nothing. Returns undefined when
 *  the count is unknowable (no `connections`). */
export function countLiveConnections(swarm: HyperswarmLike): number | undefined {
  const conns = swarm.connections;
  if (!conns) return undefined;
  const size = (conns as { size?: unknown }).size;
  if (typeof size === 'number') return size;
  let n = 0;
  for (const _ of conns) n++;
  return n;
}

/** Fire the near-cap callback without letting a diagnostic throw crash the handler. */
function fireNearCapSafely(cb: ((info: PeerCapInfo) => void) | undefined, info: PeerCapInfo): void {
  if (!cb) return;
  try {
    cb(info);
  } catch {
    // diagnostic-only callback; swallow
  }
}

/**
 * P-004: emit the near-cap pressure signal (a loud `console.warn` + the optional
 * `onNearPeerCap` event) when the shared swarm's live peer count first crosses
 * into the near-cap zone, so the otherwise-SILENT refusal of peer N+1 is
 * observable. Hysteresis (via {@link peerCapNearState}) makes it fire ONCE per
 * approach and re-arm after the count recedes, so it can be called on every
 * `connection` without spamming. No-op (returns null) when `maxPeers` or the
 * live count can't be read (minimal fakes). Exported for unit testing.
 */
export function reportPeerCapPressure(
  swarm: HyperswarmLike,
  onNearPeerCap?: (info: PeerCapInfo) => void,
): PeerCapInfo | null {
  const maxPeers =
    typeof swarm.maxPeers === 'number' && swarm.maxPeers > 0 ? swarm.maxPeers : undefined;
  if (!maxPeers) return null;
  const live = countLiveConnections(swarm);
  if (live === undefined) return null;
  const key = swarm as unknown as object;
  const near = live >= Math.ceil(maxPeers * PEER_CAP_NEAR_RATIO);
  if (!near) {
    // Re-arm so the NEXT approach to the cap warns again.
    if (peerCapNearState.get(key)) peerCapNearState.set(key, false);
    return null;
  }
  if (peerCapNearState.get(key)) return null; // already warned for this approach
  peerCapNearState.set(key, true);
  const atCap = live >= maxPeers;
  const info: PeerCapInfo = { liveConnections: live, maxPeers, atCap };
  // console.warn (a genuine defect/pressure signal — never fires in clean tests,
  // which stay well below 90% of maxPeers; same convention as the DHT-bootstrap
  // misconfig warn above).
  console.warn(
    `[swarm] ⚠ peer cap pressure: ${live}/${maxPeers} live peer connections ` +
      `(>= ${Math.round(PEER_CAP_NEAR_RATIO * 100)}% of the process-global maxPeers). ` +
      (atCap
        ? 'AT CAP — Hyperswarm will SILENTLY refuse further peers until a slot frees.'
        : 'Approaching cap — further peers will be silently refused once full.') +
      ' Raise PAPERCUSP_SWARM_MAX_PEERS or run on a larger host to grow the budget.',
  );
  fireNearCapSafely(onNearPeerCap, info);
  return info;
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

/**
 * SELF-HEAL re-peer cadence (WI-752 / FED-2). The per-harness substrate swarm
 * joins its topic ONCE; if an established peer connection later dies (idle /
 * timeout / reset / mid-replication death) or the topic's DHT announce ages out,
 * NOTHING re-announces + re-looks-up the topic, so the peer is never
 * rediscovered and federation stays DEAD until an operator restart re-runs the
 * whole join (the WI-559/WI-752 "federation sat dead ~7h" symptom). So
 * `joinHarnessSwarm` runs the SAME two-speed `discovery.refresh()` loop the
 * hive-directory gossip already uses (directory-swarm.ts):
 *
 *   - FAST cadence (`DEFAULT_SUBSTRATE_REFRESH_MS`) inside the post-join /
 *     post-peer-loss window (`DEFAULT_SUBSTRATE_FAST_WINDOW_MS`). The first DHT
 *     announce/lookup round reliably MISSES on a fresh node and nothing internal
 *     retries for minutes — `discovery.refresh()` is empirically the ONLY
 *     reliable reconnect driver (see directory-swarm.ts's module header + the
 *     swarm-chaos test, which only converges because it calls refresh itself).
 *   - SLOW keepalive (`DEFAULT_SUBSTRATE_SLOW_REFRESH_MS`) otherwise, so the
 *     topic stays announced (a FUTURE drop can always re-pair) without hammering
 *     the public DHT forever.
 *
 * Losing the last peer re-arms the fast window (the connection handler's socket
 * `close` listener) so reconnection is snappy. `refreshMs: 0` disables the loop
 * entirely — the byte-identical pre-WI-752 join (used by tests that drive
 * refresh by hand). The timer is `unref()`d (never holds the process open) and
 * cleared on `close()`.
 */
export const DEFAULT_SUBSTRATE_REFRESH_MS = 2500;
// D-045 (shared-hive-member-content-federation): widened 30_000 → 120_000. A
// freshly-SPAWNED sidecar process joining over the PUBLIC DHT reliably misses the
// first several announce/lookup rounds (cold start); with the old 30s fast window
// the next announce after 30s fell to the 60s SLOW cadence → a ~90s dead zone where
// two genuinely-separate machines never peer_connected (live run-12 'no peer in
// ~90s'; local testnet peers instantly so it was invisible to tests). 120s of 2.5s
// re-announces keeps a cold node aggressively discoverable until it pairs, then drops
// to the bounded SLOW keepalive — a real join-latency fix for a user joining a hive,
// still bounded (no forever-hammering). Re-armed on last-peer-loss for snappy reheal.
export const DEFAULT_SUBSTRATE_FAST_WINDOW_MS = 120_000;
export const DEFAULT_SUBSTRATE_SLOW_REFRESH_MS = 60_000;

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
  let liveConnectionCount = 0;
  // WI-752 self-heal state: the start of the current FAST-refresh window (join
  // time; re-armed on every peer-socket `close`) and the last refresh tick (for
  // the slow keepalive). Declared before `handler` so the close listener can
  // re-arm the window.
  let fastWindowStartMs = Date.now();
  let lastRefreshMs = 0;
  const handler = (socket: unknown, peerInfo?: unknown): void => {
    connectionCount++;
    liveConnectionCount++;
    // An unclean peer disconnect (reset / timeout / mid-replication death)
    // emits 'error' on the connection socket; with no listener Node escalates
    // it to an UNCAUGHT EXCEPTION — i.e. a remote peer dying could crash this
    // whole host process. Found by the P-004 swarm-chaos test
    // (coord-system-e2e-testing-2026-06-10); hyperswarm's own docs require the
    // consumer to handle connection errors. The reconnect path is discovery's
    // job — the error itself is just churn.
    (socket as { on?: (ev: string, fn: (e: unknown) => void) => unknown })?.on?.('error', () => {});
    // WI-752 self-heal: re-arm the FAST refresh window when this peer socket
    // closes, so a dropped peer re-pairs snappily (the DHT round after a loss
    // reliably needs several refreshes — see directory-swarm.ts). Best-effort;
    // counting ALL peer closes (the shared swarm dedups one socket per peer
    // across topics) only ever schedules a few extra harmless refreshes.
    (socket as { once?: (ev: string, fn: () => void) => unknown })?.once?.('close', () => {
      fastWindowStartMs = Date.now();
      liveConnectionCount = Math.max(0, liveConnectionCount - 1);
    });
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
    const socketObj = typeof socket === 'object' && socket !== null ? (socket as object) : null;
    if (!socketObj || !guardCountedSockets.has(socketObj)) {
      if (socketObj) guardCountedSockets.add(socketObj);
      void guard
        .recordConnection(remotePublicKeyHex, remoteIp)
        .then((v) => {
          if (v.allow) return;
          destroySocket(socket);
          const cb = v.reason === 'rate_limited' ? opts.onPeerRateLimited : opts.onPeerRejected;
          fireSafely(cb, remotePublicKeyHex, remoteIp);
        })
        .catch(() => {});
    }

    try {
      // SUBSTRATE_SIDECAR Option B (WI-604): offer the raw socket to the sidecar
      // for replication. When it CLAIMS the socket (truthy), the merkle-verify
      // CPU + replication RSS run in the sidecar and we MUST NOT also replicate
      // in-process. When it declines (no sidecar / not wired) — or the seam is
      // omitted (flag OFF, the default) — fall through to the byte-identical
      // in-process path. A throw is treated as declined (fail-safe to local).
      let offloaded = false;
      if (opts.offloadReplication) {
        try {
          offloaded = opts.offloadReplication(socket, peerInfo) === true;
        } catch {
          offloaded = false; // fail-safe → in-process replication below
        }
      }
      if (!offloaded) {
        // corestore.replicate(socket) plugs the corestore into the peer's
        // connection as an EXTERNAL stream (replaces the old replicate(true) +
        // manual bidi pipe). This both starts Hypercore replication AND attaches
        // the shared muxer at `socket.userData` — which the announce channel then
        // rides (spike Step 5). corestore handles the stream lifecycle.
        opts.store.replicate(socket);
      }
      // Open the announce channel on the SAME connection's muxer: exchange
      // signed announces so admitted peer logs get aggregated (Model B Stage 4b).
      // NOTE (Option B caveat): when `offloaded` is true the raw socket has been
      // handed to the sidecar, so this in-process announce channel cannot ride
      // it — admission must move to / be driven from the sidecar in the full
      // cutover. See substrate-replication-offload.ts "KNOWN LIMITATION".
      openAnnounceChannel(socket, opts.topic, {
        ourAnnounce: opts.ourAnnounce,
        buildOurAnnounce: opts.buildOurAnnounce,
        onAnnounce: opts.onAnnounce,
      });
      // P-201: register the hive-git serve plane on the SAME connection/muxer
      // the announce channel just rode — additive, never-throwing, no-op when
      // `hiveGitServe` is omitted (every non-hive-git harness, unchanged).
      if (opts.hiveGitServe) {
        // WI-3641: default the scope-repo authorization resolver to the
        // signed-hello registry's verified-device lookup unless the caller
        // already supplied one — every real caller wants this; only a
        // hermetic test wiring its own resolver would ever override it.
        wireHiveGitServe(socket, opts.topic, {
          ...opts.hiveGitServe,
          resolvePeerDevicePubkey:
            opts.hiveGitServe.resolvePeerDevicePubkey ?? resolveVerifiedDevicePubkeyForSocket,
        });
      }
      // WI-3583: register the dial-hello handshake on the SAME connection so
      // this device's live socket becomes resolvable by device_pubkey for a
      // REAL cross-machine fetch (additive, never-throwing — see
      // peer-dial-registry.ts's header for why this rides its own channel
      // rather than extending wireHiveGitServe's wire format).
      if (opts.hiveGitDial) {
        wireHiveGitDial(socket, opts.topic, opts.hiveGitDial.selfDevicePubkeyBase64, opts.hiveGitDial.sign);
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
    // P-004: now that this peer is live, check the process-global peer budget and
    // loudly surface near-cap pressure BEFORE the next peer is silently refused.
    reportPeerCapPressure(opts.swarm, opts.onNearPeerCap);
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
  // Brief 10 / WI-1089 — exception-safe setup after the 'connection' listener is
  // registered (above). swarm.join() / the refresh-timer setup can throw — most
  // plausibly on a degraded long-running federated node (e.g. EMFILE when the
  // DHT opens its announce socket). If one does, the listener we just added
  // would be ORPHANED on the process-singleton shared swarm with no handle to
  // remove it, and boot.ts's join-retry loop (armSwarmJoinRetry) re-calls
  // joinHarnessSwarm on every failed attempt — so a flapping join would
  // accumulate one leaked 'connection' listener per retry, unbounded, with
  // setMaxListeners(0) hiding the count. Undo the listener (+ any timer) on any
  // setup failure so a failed join leaks nothing.
  let refreshTimer: ManagedHandle | null = null;
  try {
    const discovery = opts.swarm.join(opts.topic, { server: true, client: true });
    // Best-effort flush — some Hyperswarm builds expose this, some
    // don't. Either way, returning before flush is fine because peers
    // can connect any time after the join call returns.
    if (discovery && typeof discovery.flushed === 'function') {
      void discovery.flushed().catch(() => {});
    }

    // ── WI-752 / FED-2 self-heal re-peer loop ──
    // Re-run this topic's DHT announce+lookup on a two-speed cadence so a dropped
    // peer / aged-out announce re-pairs WITHOUT an operator restart (see the
    // constant block above + directory-swarm.ts). FAST inside the post-join /
    // post-peer-loss window, then a SLOW keepalive. `refreshMs: 0` disables it.
    const refreshMs = opts.refreshMs ?? DEFAULT_SUBSTRATE_REFRESH_MS;
    const fastWindowMs = opts.fastWindowMs ?? DEFAULT_SUBSTRATE_FAST_WINDOW_MS;
    const slowRefreshMs = opts.slowRefreshMs ?? DEFAULT_SUBSTRATE_SLOW_REFRESH_MS;
    if (refreshMs > 0) {
      refreshTimer = managedSetInterval('hyperbee-swarm-refresh', refreshMs, () => {
        const now = Date.now();
        const inFastWindow = now - fastWindowStartMs < fastWindowMs;
        // WI-1534: a stalled admitted log re-arms the FAST cadence exactly
        // like a fresh join/peer-loss would — best-effort, never throws past
        // this call (a caller predicate that throws is treated as "no stall").
        let stalled = false;
        if (opts.hasStalledLogs) {
          try {
            stalled = opts.hasStalledLogs();
          } catch {
            stalled = false;
          }
        }
        const slowDue = now - lastRefreshMs >= slowRefreshMs;
        if (!inFastWindow && !stalled && !slowDue) return;
        lastRefreshMs = now;
        try {
          // Re-announce (server) + re-lookup (client) — the same call the
          // swarm-chaos test uses as its deterministic reconnect driver. A throw
          // / rejection must never crash the host.
          void Promise.resolve(discovery?.refresh?.({ client: true, server: true })).catch(() => {});
        } catch {
          // best-effort — refresh is keepalive, not load-bearing for this tick
        }
      }, { category: 'lifecycle', instanced: true });
    }
  } catch (e) {
    // Setup failed after the listener was registered — undo it (and any timer)
    // so a failed/flapping join never orphan-accumulates 'connection' listeners.
    if (refreshTimer) {
      try { refreshTimer.stop(); } catch { /* no-op */ }
      refreshTimer = null;
    }
    try {
      opts.swarm.off?.('connection', handler);
    } catch {
      /* no-op — best-effort listener cleanup on the error path */
    }
    throw e;
  }

  const handle: SwarmHandle = {
    topicHex: opts.topic.toString('hex'),
    get connectionCount() {
      return connectionCount;
    },
    get liveConnectionCount() {
      // Prefer the shared swarm's OWN live socket set (real Hyperswarm exposes
      // a Set). The per-join counter below only sees 'connection' events fired
      // AFTER this join registered — a socket that pre-dates the join is
      // INVISIBLE to it (the shared swarm dedups one socket per peer across
      // topics, and rekey() replaces the handle with a fresh zero counter), so
      // the counter read 0 on live rigs while a peer was demonstrably
      // replicating, silently disarming the connected_never_replicated axis on
      // exactly the WI-183 zombie class it exists for (rig run m1783120511:
      // registry sampling every ~1s, axis silent for 20min). The swarm's set
      // has no such blind spot. Counter kept as the fallback for minimal test
      // fakes that don't expose `connections`.
      const set = opts.swarm.connections;
      if (set) {
        const size = (set as { size?: number }).size;
        if (typeof size === 'number') return size;
        let n = 0;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const _ of set) n++;
        return n;
      }
      return liveConnectionCount;
    },
    async close() {
      // WI-752: stop the self-heal loop FIRST so no refresh fires after leave.
      if (refreshTimer) {
        refreshTimer.stop();
        refreshTimer = null;
      }
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

/** FLOOR for the total-connection ceiling, and the fallback when the host's
 *  resource profile can't be read. Hyperswarm's own default is unlimited; this
 *  bounds a connection-flood DoS regardless of the data layer. 256 so a single
 *  shared hive can fill to its full 256 peers even on the smallest host (P-004);
 *  the EFFECTIVE default scales UP from here with cores/RAM (see
 *  {@link resolveDefaultMaxPeers}), and PAPERCUSP_SWARM_MAX_PEERS overrides both. */
const DEFAULT_MAX_PEERS = 256;

/**
 * P-004: the effective default `maxPeers` for the shared swarm, DERIVED from the
 * host's resource profile (`resource-profile.maxSwarmPeers` — cores/RAM, floored
 * at 256, ceiled at 2048) instead of a hardcoded constant. So a single shared
 * hive can actually reach 256 peers AND a capable box gets headroom for its
 * OTHER topics rather than starving them. Falls back to the 256 floor if the
 * profile can't be read (best-effort — a swarm must never fail to construct over
 * a host-detection hiccup). `PAPERCUSP_SWARM_MAX_PEERS` still wins in
 * {@link swarmConstructorOpts}.
 */
export function resolveDefaultMaxPeers(): number {
  try {
    const derived = getResourceProfile().maxSwarmPeers;
    return Number.isFinite(derived) && derived > 0 ? derived : DEFAULT_MAX_PEERS;
  } catch {
    return DEFAULT_MAX_PEERS;
  }
}

/** One DHT bootstrap node (host + UDP port). */
export interface DhtBootstrapNode {
  host: string;
  port: number;
}

/** Parse `PAPERCUSP_DHT_HOST` — an optional local bind/advertise host for
 * hyperdht. Hyperswarm does not forward `host` to HyperDHT, so callers that
 * need an explicit interface (notably the fed-a/fed-b VM rig, whose default
 * route can be duplicate/unreachable while the private L2 is stable) need us to
 * construct HyperDHT directly and pass it through Hyperswarm's `dht` option. */
export function parseDhtHost(raw: string | undefined): string | undefined {
  const host = raw?.trim();
  return host || undefined;
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
 * WI-3604 (split-DHT-universe recurrence guard). The DHT universe this
 * process's shared swarm actually resolved to, at construction time:
 * `'isolated'` (a custom bootstrap list, e.g. the fed-a/fed-b rig DHT),
 * `'public'` (no `PAPERCUSP_DHT_BOOTSTRAP` set — the real public DHT), or
 * `'misconfigured'` (the env var WAS set but resolved to zero usable
 * bootstrap nodes — {@link parseDhtBootstrap}'s all-malformed case — which
 * silently falls back to the PUBLIC DHT, the exact "isolated federation
 * quietly breaks" failure this guards against).
 */
export type DhtUniverseState =
  | { mode: 'isolated'; bootstrap: DhtBootstrapNode[] }
  | { mode: 'public' }
  | { mode: 'misconfigured'; envValue: string };

/** Pure classifier: given the raw `PAPERCUSP_DHT_BOOTSTRAP` value, resolve
 * which DHT universe a swarm constructed with it would join. Exported for
 * unit testing (no I/O). */
export function resolveDhtUniverseState(envBootstrapRaw: string | undefined): DhtUniverseState {
  const trimmed = envBootstrapRaw?.trim();
  if (!trimmed) return { mode: 'public' };
  const bootstrap = parseDhtBootstrap(trimmed);
  if (bootstrap?.length) return { mode: 'isolated', bootstrap };
  return { mode: 'misconfigured', envValue: trimmed };
}

/** Result of comparing this process's resolved {@link DhtUniverseState}
 * against the operator's DECLARED expectation (see
 * {@link readExpectedDhtBootstrap}). `ok:true` also covers "no expectation
 * configured" — an unconfigured expectation can't be violated. */
export interface DhtUniverseAssertion {
  ok: boolean;
  detail: string;
}

function bootstrapKey(nodes: DhtBootstrapNode[]): string {
  return nodes
    .map((n) => `${n.host}:${n.port}`)
    .sort()
    .join(',');
}

/**
 * Pure comparator: does `actual` (this process's resolved DHT universe)
 * match `expectedBootstrapRaw` (the operator's declared expectation, e.g.
 * "this box should always join the isolated rig DHT")? This is the WI-3604
 * recurrence guard for the 2026-07-09 Mac VM incident: a Server.app instance
 * launched WITHOUT `PAPERCUSP_DHT_BOOTSTRAP` (a macOS LaunchAgent's
 * `EnvironmentVariables` are not inherited by a manual app relaunch) silently
 * joined the PUBLIC DHT while every peer expected the isolated rig DHT —
 * severing the federation plane with no loud error. Exported for unit
 * testing (no I/O — callers read the expected value via
 * {@link readExpectedDhtBootstrap} first).
 */
export function assertDhtUniverse(
  actual: DhtUniverseState,
  expectedBootstrapRaw: string | undefined,
): DhtUniverseAssertion {
  const expectedTrimmed = expectedBootstrapRaw?.trim();
  if (!expectedTrimmed) {
    return { ok: true, detail: 'no expected DHT bootstrap configured — assertion skipped' };
  }
  const expected = parseDhtBootstrap(expectedTrimmed);
  if (!expected?.length) {
    // The EXPECTATION itself is unparsable — don't false-positive on a bad
    // config; just say so.
    return {
      ok: true,
      detail: `expected DHT bootstrap ("${expectedTrimmed}") is unparsable — assertion skipped`,
    };
  }
  const expectedKey = bootstrapKey(expected);
  if (actual.mode === 'public') {
    return {
      ok: false,
      detail:
        `expected isolated DHT bootstrap ${expectedKey} but this process resolved to the ` +
        `PUBLIC DHT — PAPERCUSP_DHT_BOOTSTRAP is likely unset/not-inherited on this host`,
    };
  }
  if (actual.mode === 'misconfigured') {
    return {
      ok: false,
      detail:
        `expected isolated DHT bootstrap ${expectedKey} but PAPERCUSP_DHT_BOOTSTRAP resolved to ` +
        `no usable nodes ("${actual.envValue}") — this process fell back to the PUBLIC DHT`,
    };
  }
  const actualKey = bootstrapKey(actual.bootstrap);
  if (actualKey !== expectedKey) {
    return {
      ok: false,
      detail: `expected isolated DHT bootstrap ${expectedKey} but this process resolved to ${actualKey}`,
    };
  }
  return { ok: true, detail: `DHT bootstrap matches expected isolated universe (${expectedKey})` };
}

/**
 * Read the operator's DECLARED expected DHT bootstrap, independent of
 * whatever `PAPERCUSP_DHT_BOOTSTRAP` this process happened to actually
 * inherit. An env-var-only "expected" value can't catch a whole env block
 * being skipped by a non-LaunchAgent-mediated launch (the 2026-07-09
 * incident) — if the real var can silently go missing, an "expected" var set
 * the SAME way would too. So this prefers `PAPERCUSP_EXPECTED_DHT_BOOTSTRAP`
 * but falls back to a marker FILE
 * (`PAPERCUSP_EXPECTED_DHT_BOOTSTRAP_FILE` or `~/.papercusp/expected-dht-bootstrap`)
 * that a provisioning/install script writes independently of this process's
 * own launch-time environment — the one detection path that would have
 * caught that incident. Best-effort: a missing file is not an error.
 */
export function readExpectedDhtBootstrap(): string | undefined {
  const envVal = process.env.PAPERCUSP_EXPECTED_DHT_BOOTSTRAP?.trim();
  if (envVal) return envVal;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('node:os') as typeof import('node:os');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const filePath =
      process.env.PAPERCUSP_EXPECTED_DHT_BOOTSTRAP_FILE?.trim() ||
      path.join(os.homedir(), '.papercusp', 'expected-dht-bootstrap');
    const contents = fs.readFileSync(filePath, 'utf8').trim();
    return contents || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the EFFECTIVE `PAPERCUSP_DHT_BOOTSTRAP` value this process should join —
 * the raw string, preferring the env var but falling back to a marker FILE
 * (`PAPERCUSP_DHT_BOOTSTRAP_FILE` or `~/.papercusp/dht-bootstrap`) when the env
 * is unset/empty. This is the input to {@link parseDhtBootstrap} everywhere the
 * swarm actually resolves its bootstrap (see {@link swarmConstructorOpts} and
 * {@link getSharedSwarm}), so a file-provided value drives BOTH the real
 * hyperdht bootstrap AND the boot banner / {@link assertDhtUniverse} guard.
 *
 * EI-8893 (durable fix — kills the whole env-inheritance failure class): on
 * macOS a Server.app that SELF-RELAUNCHES via LaunchServices (update/restart
 * path) does NOT inherit its LaunchAgent's `EnvironmentVariables`, so the
 * relaunched process comes up env-less and silently joins the PUBLIC DHT
 * instead of the isolated testnet — severing federation with no loud error,
 * and the `launchctl setenv` mitigation does not survive reboot. Reading the
 * bootstrap from a file that a provisioning/install script writes independently
 * of this process's launch-time environment makes the isolated-DHT selection
 * immune to the relaunch path entirely (the same file-fallback trick
 * {@link readExpectedDhtBootstrap} uses for the DECLARED expectation). The env
 * var still WINS when present, so nothing changes for env-configured hosts.
 * Best-effort: a missing/unreadable file is not an error. Exported for unit
 * testing (I/O redirectable via `PAPERCUSP_DHT_BOOTSTRAP_FILE`).
 */
export function readEffectiveDhtBootstrapRaw(): string | undefined {
  const envVal = process.env.PAPERCUSP_DHT_BOOTSTRAP?.trim();
  if (envVal) return envVal;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('node:os') as typeof import('node:os');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const filePath =
      process.env.PAPERCUSP_DHT_BOOTSTRAP_FILE?.trim() ||
      path.join(os.homedir(), '.papercusp', 'dht-bootstrap');
    const contents = fs.readFileSync(filePath, 'utf8').trim();
    return contents || undefined;
  } catch {
    return undefined;
  }
}

let _dhtUniverseAssertion: DhtUniverseAssertion | null = null;

/** The DHT-universe assertion computed once, alongside the shared swarm's
 * construction (see {@link getSharedSwarm}). `null` before the shared swarm
 * has been constructed at least once in this process. */
export function getDhtUniverseAssertion(): DhtUniverseAssertion | null {
  return _dhtUniverseAssertion;
}

export function _resetDhtUniverseAssertionForTests(): void {
  _dhtUniverseAssertion = null;
}

/**
 * Constructor options for the shared Hyperswarm — the DoS resource ceiling
 * (P-001 of hyperswarm-dos-hardening). `maxPeers` caps total concurrent peer
 * connections; `bootstrap` (when `PAPERCUSP_DHT_BOOTSTRAP` is set) points the
 * underlying hyperdht at a custom/isolated DHT instead of the public one.
 * Exported so the wiring is unit-testable without constructing the real
 * (network-touching) swarm.
 *
 * `maxPeers` precedence (P-004): `PAPERCUSP_SWARM_MAX_PEERS` > the host-derived
 * default ({@link resolveDefaultMaxPeers} — cores/RAM, ≥256). Pass
 * `defaultMaxPeers` to inject the host-derived value (keeps the function pure
 * for unit tests); omitted, it reads the real resource profile.
 */
export function swarmConstructorOpts(args?: {
  defaultMaxPeers?: number;
}): { maxPeers: number; bootstrap?: DhtBootstrapNode[]; dhtHost?: string } {
  const raw = Number.parseInt(process.env.PAPERCUSP_SWARM_MAX_PEERS ?? '', 10);
  const fallback = args?.defaultMaxPeers ?? resolveDefaultMaxPeers();
  const maxPeers = Number.isFinite(raw) && raw > 0 ? raw : fallback;
  // EI-8893: resolve the bootstrap via the env→file fallback so a
  // self-relaunched macOS Server.app (whose LaunchAgent env is stripped by
  // LaunchServices) still reads its isolated-DHT bootstrap from
  // ~/.papercusp/dht-bootstrap instead of silently defaulting to the public DHT.
  const bootstrap = parseDhtBootstrap(readEffectiveDhtBootstrapRaw());
  const dhtHost = parseDhtHost(process.env.PAPERCUSP_DHT_HOST);
  return {
    maxPeers,
    ...(bootstrap ? { bootstrap } : {}),
    ...(dhtHost ? { dhtHost } : {}),
  };
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
        dht?: unknown;
        firewall?: (remotePublicKey: Buffer) => boolean;
      }) => HyperswarmLike;
    }
  ).default;
  const guard = getSwarmGuard();
  const opts = swarmConstructorOpts();
  // B-FED-DHT observability (2026-06-24, su-34db4): make the effective DHT visible at
  // construction. Without this, "did this process join the ISOLATED testnet or the PUBLIC
  // DHT?" required tcpdump archaeology — and the silent-fallback failure mode (env set but
  // resolved bootstrap empty → hyperdht's `opts.bootstrap || BOOTSTRAP_NODES` quietly uses
  // the public DHT → isolated 2-machine federation breaks via public-DHT NAT hairpin) was
  // invisible. Loud-warn that exact case so it never has to be re-diagnosed by packet capture.
  // EI-8893: classify against the SAME env→file effective value swarmConstructorOpts
  // resolves, so a file-provided bootstrap (relaunch-immune) is reported ISOLATED, not
  // a false PUBLIC, and the assertDhtUniverse guard checks the value actually used.
  const dhtUniverse = resolveDhtUniverseState(readEffectiveDhtBootstrapRaw());
  if (dhtUniverse.mode === 'isolated') {
    // Informational (console.info, not warn) so the fail-on-console test gate stays
    // a defect signal — still captured in the operator's stdout log for observability.
    console.info(`[swarm] DHT bootstrap = ISOLATED ${bootstrapKey(dhtUniverse.bootstrap)}`);
  } else if (dhtUniverse.mode === 'misconfigured') {
    // The genuine misconfig (env set but resolved empty) — keep this LOUD (console.warn):
    // it is a real defect signal, and it never fires in clean tests (they don't set the var).
    console.warn(
      `[swarm] ⚠ PAPERCUSP_DHT_BOOTSTRAP is set ("${dhtUniverse.envValue}") but resolved to NO bootstrap — ` +
        `this swarm will join the PUBLIC DHT, so isolated 2-machine federation is BROKEN ` +
        `(public-DHT NAT hairpin). Check parseDhtBootstrap + that the var reaches THIS process before first swarm use.`,
    );
  } else {
    console.info('[swarm] DHT bootstrap = PUBLIC DHT (no PAPERCUSP_DHT_BOOTSTRAP set)');
  }
  // WI-3604: compute + memoize the split-DHT-universe recurrence-guard
  // assertion once, alongside the shared swarm's construction — reflects the
  // actual env this process resolved at THIS boot.
  _dhtUniverseAssertion = assertDhtUniverse(dhtUniverse, readExpectedDhtBootstrap());
  if (!_dhtUniverseAssertion.ok) {
    console.warn(`[swarm] ⚠ DHT universe mismatch: ${_dhtUniverseAssertion.detail}`);
  }
  let dht: unknown;
  if (opts.dhtHost) {
    const dhtMod = await import('hyperdht');
    const DHT = (
      dhtMod as {
        default?: new (opts?: { bootstrap?: DhtBootstrapNode[]; host?: string }) => unknown;
      }
    ).default;
    if (!DHT) throw new Error('hyperdht default export missing');
    dht = new DHT({ bootstrap: opts.bootstrap, host: opts.dhtHost });
    console.info(`[swarm] DHT host = ${opts.dhtHost}`);
  }
  // P-003: the firewall runs BEFORE the Noise handshake completes — it cheaply
  // rejects banned keys without spending handshake CPU. Hyperswarm only hands
  // the firewall the remote public key, so IP-level bans are enforced in the
  // connection handler instead.
  _sharedSwarm = new Swarm({
    maxPeers: opts.maxPeers,
    ...(dht ? { dht } : opts.bootstrap ? { bootstrap: opts.bootstrap } : {}),
    firewall: (remotePublicKey: Buffer) => guard.firewall(remotePublicKey),
  });
  // P-005 (bg-host-freeze-eventloop-stall-2026-06-30): with 25+ harnesses each
  // adding ONE 'connection' listener (via joinHarnessSwarm) plus the hive-directory
  // gossip listener (createDirectoryGossip), the process-global shared swarm
  // accumulates N+1 listeners — all intentional, all permanent for the process
  // lifetime, none of them leaks. Node.js's default maxListeners=10 fires a
  // MaxListenersExceededWarning at the 11th harness, a false-positive alarm. Call
  // setMaxListeners(0) (= unlimited) to silence it. This does NOT hide a genuine
  // leak: every joinHarnessSwarm returns a SwarmHandle whose close() removes the
  // listener via swarm.off('connection', handler), and the listener-count test
  // (swarm-listener-count.test.ts) asserts bounded count after boot + close.
  (_sharedSwarm as { setMaxListeners?: (n: number) => void })?.setMaxListeners?.(0);
  return _sharedSwarm;
}

export function _setSharedSwarmForTests(s: HyperswarmLike | null): void {
  _sharedSwarm = s;
}

export function _peekSharedSwarmForTests(): HyperswarmLike | null {
  return _sharedSwarm;
}
