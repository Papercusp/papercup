/**
 * topic-gossip.ts — the GENERIC per-topic Protomux gossip chassis
 * (cross-machine-coord-parity-and-trust-2026-07-01 P-004, D-008).
 *
 * Extracted mechanically from directory-swarm.ts (p2p-hive-directory-2026-06-06
 * P-003), which pioneered the pattern for `SignedHiveAnnounce` frames; that
 * module is now the announce INSTANTIATION of this one, and presence-gossip is
 * the second (ephemeral presence frames — beat-like data that must NOT ride the
 * append-only peer-log). Everything load-bearing here is the original design,
 * verbatim:
 *
 *   - Gossip, not log-replication: peers join topics and exchange typed frames
 *     over a dedicated Protomux protocol. NO corestore replication.
 *   - ONE instance manages ALL its topics, because Hyperswarm dedupes
 *     connections per peer: a single A↔B socket serves every topic both ends
 *     share, so per-topic connection handlers are wrong twice over — a topic
 *     joined after the socket exists would never see it, and two same-
 *     `(protocol, id)` channels on one muxer collide (Protomux `unique` returns
 *     null for the second). Instead: one `connection` handler tracks live
 *     sockets; ONE muxer per Noise stream (`Protomux.from` + the
 *     `noiseStream.userData` convention, so corestore replication and every
 *     other protocol share it in either attach order); one channel PER TOPIC
 *     per socket, keyed `{ protocol, id: topic }` — Protomux pairing IS the
 *     scoping: a channel only opens once BOTH ends joined that topic, so a
 *     scoped topic's frame is never written to a peer that didn't join it.
 *   - Joining a topic retroactively opens its channel on every existing socket
 *     (the join-after-boot case), and creation seeds from the swarm's EXISTING
 *     connections (WI-647: the shared substrate socket never re-emits
 *     'connection').
 *   - Discovery is driven by a per-topic `discovery.refresh()` LOOP —
 *     empirically the ONLY driver that connects a standalone (non-corestore)
 *     transport on the current hyperswarm/hyperdht (see directory-swarm's
 *     original probe notes). Two-speed cadence: fast inside a post-join window,
 *     then a slow keepalive; losing a topic's last peer re-arms its fast window.
 *
 * Pure over an injected `HyperswarmLike` (the same test seam swarm.ts uses), so
 * join/pair/send/receive/broadcast all unit-test with a fake swarm.
 */

import Protomux from 'protomux';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import c from 'compact-encoding';
import type { HyperswarmLike } from './swarm';

/** FAST per-topic discovery-refresh cadence — re-runs the DHT announce + lookup
 *  round so peers converge even when the first round misses (it reliably does
 *  on a fresh node; see the module header). Active during the post-join window. */
export const DEFAULT_REFRESH_MS = 2500;
/** How long after a topic join (or after losing its last peer) the FAST cadence
 *  runs before backing off — long enough for several full DHT rounds. */
export const DEFAULT_FAST_WINDOW_MS = 30_000;
/** Steady-state keepalive cadence — re-announces + re-looks-up each topic so a
 *  late-arriving peer still finds us, without hammering the public DHT forever. */
export const DEFAULT_SLOW_REFRESH_MS = 60_000;

type FrameMessage<Frame> = { send(value: Frame): void };

/** What swarm.join returns — flushed is legacy; refresh re-runs announce+lookup. */
type DiscoveryLike = { flushed?: () => Promise<void>; refresh?: (opts?: object) => unknown } | undefined;

interface TopicState<Frame> {
  topic: Buffer;
  /** The swarm.join handle — its refresh() drives discovery for this topic. */
  discovery: DiscoveryLike;
  /** Paired channels for THIS topic (one per socket whose peer also joined it). */
  channels: Set<FrameMessage<Frame>>;
  /** Start of the topic's FAST-refresh window (join time; re-armed when the
   *  topic loses its last paired channel, so reconnection is snappy too). */
  fastWindowStartMs: number;
  /** Last refresh tick for this topic (drives the slow keepalive). */
  lastRefreshMs: number;
  /** EI-13317: has this topic EVER had a paired channel? Distinguishes
   *  "genuinely severed" (had a peer, now has none) from "no peer has ever
   *  joined yet" — only the former is worth escalating. */
  everPaired: boolean;
  /** EI-13317: last time the severed-link escalation fired for this topic
   *  (rate-limits repeated escalations to once per severedEscalationMs). */
  lastEscalationMs: number;
}

/** EI-13317: one topic's severed-link escalation event, carried by
 *  {@link CreateTopicGossipOpts.onSeveredLink}. */
export interface GossipSeveredLinkInfo {
  /** Hex topic that tripped the escalation. */
  topicHex: string;
  /** How long (ms) the topic had zero paired channels before escalating. */
  severedMs: number;
  /** WI-5211: true when the topic has NEVER paired — a fresh join stuck in
   *  stale-DHT limbo (escalated at 2× the severed threshold), not a formed
   *  link that broke. */
  neverPaired?: boolean;
}

/**
 * EI-13317: how long a topic that previously had a paired channel must sit at
 * ZERO paired channels — despite the refresh() self-heal loop actively
 * ticking — before escalating to a forced topic leave+rejoin (a fresh
 * discovery session/DHT announce). Mirrors swarm.ts's
 * `DEFAULT_SUBSTRATE_SEVERED_ESCALATION_MS` — see that constant's doc for the
 * forensics (refresh() alone does not recover a one-side-restart severed
 * link). `0` disables the escalation (status-quo pre-EI-13317 behavior).
 */
export const DEFAULT_SEVERED_ESCALATION_MS = 5 * 60_000;

export interface TopicGossipHandle<Frame> {
  /** Join a gossip topic. Opens the topic's channel on every existing
   *  connection too (the join-after-boot case). Idempotent. */
  joinTopic(topic: Buffer): void;
  /** Leave a topic + forget its channels. Idempotent. */
  leaveTopic(topic: Buffer): Promise<void>;
  /** Send a frame to every currently-paired channel of ONE topic (best-effort).
   *  Pairing guarantees only peers that joined that topic receive it. */
  broadcast(topicHex: string, frame: Frame): void;
  /** Leave every topic + detach the connection handler + stop re-flush. Idempotent. */
  close(): Promise<void>;
  /** Hex of every joined topic (diagnostics). */
  readonly topicsJoined: string[];
  /** Connections seen since creation (diagnostics). */
  readonly connectionCount: number;
  /** Currently-paired channels — for one topic, or all topics (diagnostics). */
  openChannelCount(topicHex?: string): number;
}

export interface CreateTopicGossipOpts<Frame> {
  /** The shared process swarm (getSharedSwarm()); a fake in tests. */
  swarm: HyperswarmLike;
  /** Protomux protocol id — one gossip family per id (e.g.
   *  'papercusp/hive-directory', 'papercusp/hive-presence'). */
  protocol: string;
  /** Handle an inbound frame. `topicHex` is the topic whose channel carried it
   *  (pairing scoping guarantees the sender joined that topic) — consumers that
   *  gate per-topic (e.g. presence's per-hive membership check) key on it. */
  onFrame: (frame: Frame, topicHex: string) => void | Promise<unknown>;
  /** The frames to send a freshly-paired peer on ONE topic (the late-joiner
   *  hello/snapshot) — scoped to that topic so a scoped pair only ever
   *  receives that topic's frames. */
  getHelloFrames: (topicHex: string) => Frame[] | Promise<Frame[]>;
  /** Diagnostic name used in thrown errors (defaults to createTopicGossip). */
  name?: string;
  /** managedSetInterval label for the refresh loop (defaults to
   *  `topic-gossip-refresh:<protocol>`). */
  refreshLabel?: string;
  /** FAST per-topic discovery-refresh cadence (ms). Default DEFAULT_REFRESH_MS; 0 disables refreshing entirely. */
  refreshMs?: number;
  /** How long the fast cadence runs after a join / last-peer loss (ms). Default DEFAULT_FAST_WINDOW_MS. */
  fastWindowMs?: number;
  /** Steady-state keepalive cadence once the fast window lapses (ms). Default DEFAULT_SLOW_REFRESH_MS. */
  slowRefreshMs?: number;
  /**
   * EI-13317 escalation ladder: once a topic HAD a paired channel and then
   * sits at ZERO paired channels for this long — despite the refresh()
   * self-heal loop actively ticking — force a topic-level leave+rejoin (a
   * fresh discovery session/DHT announce) and fire `onSeveredLink`. Mirrors
   * swarm.ts's `severedEscalationMs` (see its doc for the forensics). Default
   * `DEFAULT_SEVERED_ESCALATION_MS`. `0` disables the escalation entirely
   * (byte-identical pre-EI-13317 behavior).
   */
  severedEscalationMs?: number;
  /**
   * EI-13317 observability: fires when the severed-link escalation trips
   * (see `severedEscalationMs`) — the LOUD signal a persistently-severed
   * topic requires instead of silently freezing. Best-effort; a throw is
   * swallowed.
   */
  onSeveredLink?: (info: GossipSeveredLinkInfo) => void;
}

/**
 * Create a typed gossip family over the shared swarm. One instance per
 * (process, protocol) — topics are joined/left through the handle.
 */
export function createTopicGossip<Frame>(opts: CreateTopicGossipOpts<Frame>): TopicGossipHandle<Frame> {
  const name = opts.name ?? 'createTopicGossip';
  if (!opts.swarm) throw new Error(`${name}: swarm required`);
  if (!opts.protocol) throw new Error(`${name}: protocol required`);

  const topics = new Map<string, TopicState<Frame>>();
  const sockets = new Set<unknown>();
  let connectionCount = 0;
  let closed = false;

  /** Muxers that already carry our pair-notifier (one registration per muxer). */
  const pairedMuxers = new WeakSet<object>();

  /**
   * WI-5355 (EI-13317 downstream): which topics EACH currently-connected
   * socket has a live paired channel for, right now. Populated on a channel's
   * `onopen` (paired), pruned on `onclose` (unpaired) — see openTopicChannel
   * below. This is what lets the severed-link escalation tell "a socket that
   * is genuinely dead weight for THIS gossip instance" (zero entries here)
   * apart from "a socket that's fine, just not on the one severed topic" (a
   * socket paired on some OTHER topic must never be touched — it's a shared
   * A↔B connection per the module header).
   */
  const socketTopics = new WeakMap<object, Set<string>>();

  /**
   * WI-5355: true when `socket` currently holds ZERO live paired channels
   * across every topic this gossip instance manages — i.e. Hyperswarm still
   * thinks it's "connected" to this peer, but it isn't doing anything for us.
   * That is precisely the zombie-connection shape traced into
   * node_modules/hyperswarm's `_handlePeer` (client-side rediscovery no-ops
   * when `_allConnections.has(peer.publicKey)` is already true, with no
   * liveness re-check) — see the WI-5355 comment thread for the full trace.
   * A plain `leave()+join()` DHT rejoin can't fix that: Hyperswarm never even
   * attempts a fresh connection to a peer it still believes is live.
   *
   * EI-13317/WI-5481: this NO LONGER gates the severed-link escalation's
   * eviction (that now evicts unconditionally — see the call site) — a
   * `false` here just meant "another topic still claims this socket too",
   * which used to make every claimant refuse to evict and deadlock. It is
   * kept only to decide whether the diagnostic "force-evicting a shared
   * socket" log line is worth emitting.
   */
  const isSocketIdleAcrossAllTopics = (socket: unknown): boolean => {
    const set = socketTopics.get(socket as object);
    return !set || set.size === 0;
  };

  /**
   * WI-5355: best-effort evict a zombie socket — one Hyperswarm still counts
   * as "connected" but that carries zero live gossip pairing anywhere — so
   * the NEXT `leave()+join()` DHT rejoin can actually result in a fresh
   * connection attempt instead of silently no-op'ing against a stale
   * `_allConnections` entry. Duck-typed `.destroy()` (the standard
   * Duplex/NoiseSecretStream method Hyperswarm's own duplicate-connection
   * handling uses internally — see `_handleServerConnection`'s
   * `existing.destroy(...)` in the installed hyperswarm package).
   *
   * EI-13317/WI-5481: the severed-link escalation now calls this
   * UNCONDITIONALLY on every socket for the escalating topic, even one still
   * claimed by another topic — see the call site's shared-socket eviction
   * deadlock writeup. This helper itself stays a plain, unconditional
   * destroy+unregister; the "is this safe to evict" judgment lives entirely
   * at the call site now, not in here.
   */
  const evictIdleZombieSocket = (socket: unknown): void => {
    try {
      (socket as { destroy?: (err?: Error) => void }).destroy?.(
        new Error('papercusp: WI-5355 zombie-socket eviction on severed-link escalation'),
      );
    } catch {
      /* best-effort — a socket that can't be destroyed is left for Hyperswarm's own cleanup */
    }
    sockets.delete(socket);
  };

  /**
   * One shared muxer per socket + the LAZY-ACCEPT pair-notifier. Without the
   * notifier, protomux REJECTS a remote's channel-open for a topic we haven't
   * opened a channel for yet on that socket — and the remote never re-opens, so
   * a topic joined later could never pair on an existing connection. The
   * notifier accepts the open IFF we joined that topic (which is also the
   * scoping: an un-joined topic's open stays rejected).
   */
  const ensureMux = (socket: unknown): Protomux => {
    // Corestore/Hypercore attaches its shared Protomux to the NoiseSecretStream
    // (`socket.noiseStream`), while Hyperswarm hands consumers the outer wrapper.
    // Use the same stream as corestore so gossip and substrate announce channels
    // cannot split onto different muxers over one peer connection.
    const muxStream = ((socket as { noiseStream?: unknown } | null)?.noiseStream ?? socket) as {
      userData?: unknown;
    };
    const mux = Protomux.from(muxStream);
    // The ecosystem convention (hypercore createProtocolStream does the same):
    // pin the muxer on the stream so every other protocol on this connection
    // (corestore replication, cross-hive) reuses it instead of double-muxing.
    if (!muxStream.userData) muxStream.userData = mux;
    if (!pairedMuxers.has(mux)) {
      pairedMuxers.add(mux);
      try {
        mux.pair({ protocol: opts.protocol }, (id: Buffer | null) => {
          if (!id) return; // gossip channels are always topic-keyed
          const st = topics.get(id.toString('hex'));
          // MUST createChannel synchronously to consume the pending open.
          if (st) openTopicChannel(socket, st);
        });
      } catch {
        /* best-effort — connect-time channels still pair without it */
      }
    }
    return mux;
  };

  /** Open ONE topic's channel on ONE socket's shared muxer (best-effort). */
  const openTopicChannel = (socket: unknown, st: TopicState<Frame>): void => {
    try {
      const mux = ensureMux(socket);

      let message: FrameMessage<Frame> | null = null;
      const topicHex = st.topic.toString('hex');
      const sendOurs = (): void => {
        if (!message) return;
        st.channels.add(message);
        // Send our current hello frames for THIS topic to the freshly-paired peer.
        void Promise.resolve(opts.getHelloFrames(topicHex))
          .then((frames) => {
            for (const f of frames) {
              try {
                message!.send(f);
              } catch {
                /* best-effort per frame */
              }
            }
          })
          .catch(() => {});
      };
      // Keyed by topic: pairing completes only when the REMOTE also opened
      // `{ protocol, id: topic }` — i.e. it joined this topic too. That is the
      // scoping: no shared topic, no channel, no frame.
      const channel = mux.createChannel({
        protocol: opts.protocol,
        id: st.topic,
        onopen: () => {
          // WI-953 diagnosability: the directory-announce bug (peers show
          // 'connected' but no announce ever crosses) went unsolved across
          // multiple sessions partly because this layer had ZERO logging —
          // there was no way to tell "never paired on this topic" apart from
          // "paired fine, announce lost/rejected downstream". `onopen` fires
          // only once BOTH ends have created a channel for this topic (see
          // the comment above `mux.createChannel` call) — i.e. this line IS
          // the topic-level pairing signal. Same VITEST gating convention as
          // hive-directory-boot.ts's rejected-inbound trace (EI-8696-class).
          if (!process.env.VITEST) {
            console.warn(`[topic-gossip:${opts.protocol}] paired on topic ${topicHex}`);
          }
          // EI-13317: this topic has now genuinely paired at least once —
          // only a topic that HAD a peer is worth escalating when it later
          // sits at zero (a topic that's never paired yet may just have no
          // peer online, which the ladder should not act on).
          st.everPaired = true;
          // WI-5355: record that THIS socket is live-paired on THIS topic, so
          // the severed-link escalation can tell a genuinely-idle (zombie)
          // socket apart from one still serving another shared topic.
          {
            let set = socketTopics.get(socket as object);
            if (!set) {
              set = new Set<string>();
              socketTopics.set(socket as object, set);
            }
            set.add(topicHex);
          }
          sendOurs();
        },
        onclose: () => {
          if (message) st.channels.delete(message);
          // Lost the topic's last peer → re-arm the FAST refresh window so
          // rediscovery/reconnection is snappy again.
          if (st.channels.size === 0) st.fastWindowStartMs = Date.now();
          // WI-5355: this socket no longer carries a live channel for this topic.
          socketTopics.get(socket as object)?.delete(topicHex);
        },
      });
      if (!channel) return; // already open for this (socket, topic) — idempotent
      message = channel.addMessage<Frame>({
        encoding: c.json,
        onmessage: (frame: Frame) => {
          try {
            void Promise.resolve(opts.onFrame(frame, topicHex)).catch(() => {});
          } catch {
            /* synchronous throw — swallow */
          }
        },
      });
      channel.open();
    } catch {
      // Gossip channel is best-effort; a peer that can't speak it is ignored.
    }
  };

  const handler = (socket: unknown): void => {
    connectionCount++;
    // WI-953 diagnosability (see the onopen trace below for the fuller
    // rationale): a raw swarm connection is necessary but NOT sufficient for
    // a topic to pair — logging both separately is what lets a future run
    // distinguish "never connected at all" from "connected but never paired
    // on the directory topic" from "paired but the announce was rejected"
    // (hive-directory-boot.ts already covers the third).
    if (!process.env.VITEST) {
      console.warn(`[topic-gossip:${opts.protocol}] swarm connection #${connectionCount}`);
    }
    sockets.add(socket);
    // Unclean disconnect guard — same as joinHarnessSwarm's handler: an
    // unhandled socket 'error' (peer reset) is an uncaught exception that can
    // crash the host. Found by the P-004 swarm-chaos test.
    (socket as { on?: (ev: string, fn: (e: unknown) => void) => unknown }).on?.('error', () => {});
    (socket as { once?: (ev: string, fn: () => void) => unknown }).once?.('close', () => {
      sockets.delete(socket);
    });
    for (const st of topics.values()) openTopicChannel(socket, st);
  };
  opts.swarm.on('connection', handler);
  // Shared-swarm late join (the symmetric case of joinHarnessSwarm's seeding in
  // swarm.ts, WI-647): a gossip family is often wired LAZILY — typically AFTER
  // the substrate already opened the shared A↔B socket. That socket never
  // re-emits 'connection', so without seeding from the swarm's EXISTING
  // connections the `sockets` set stays empty → a later joinTopic opens its
  // channel on NOTHING → 0 reachable peers forever (no DHT re-pair on an
  // air-gapped / long-lived link). Treat each existing socket exactly like a
  // fresh connection. topics is empty at creation, so this only populates
  // `sockets`; the caller's joinTopic then opens channels.
  try {
    for (const socket of opts.swarm.connections ?? []) {
      try {
        handler(socket);
      } catch {
        /* per-socket best-effort — a bad existing socket can't block creation */
      }
    }
  } catch {
    /* connections iteration is best-effort (absent on minimal fakes) */
  }

  // Keep every topic's announce + lookup converging in the background (cleared
  // on close). discovery.refresh() re-runs the full DHT round for that topic —
  // the only driver that reliably connects (see the module header). Cadence is
  // TWO-SPEED: fast (refreshMs) inside a topic's post-join window — the first
  // rounds reliably miss on a fresh node — then a slow keepalive so a long-lived
  // topic doesn't hammer the public DHT forever. Losing a topic's last peer
  // re-arms its fast window (see the channel onclose).
  const refreshMs = opts.refreshMs ?? DEFAULT_REFRESH_MS;
  const fastWindowMs = opts.fastWindowMs ?? DEFAULT_FAST_WINDOW_MS;
  const slowRefreshMs = opts.slowRefreshMs ?? DEFAULT_SLOW_REFRESH_MS;
  let refreshTimer: ManagedHandle | null = null;
  if (refreshMs > 0) {
    refreshTimer = managedSetInterval(
      opts.refreshLabel ?? `topic-gossip-refresh:${opts.protocol}`,
      refreshMs,
      () => {
        const now = Date.now();
        const severedEscalationMs = opts.severedEscalationMs ?? DEFAULT_SEVERED_ESCALATION_MS;
        for (const st of topics.values()) {
          // ── EI-13317 escalation ladder ──
          // Evaluated on EVERY tick for EVERY topic, independent of that
          // topic's own inFastWindow/slowDue refresh-cadence gate below (a
          // topic can sit past the severed threshold DURING the dead zone
          // between its fast window lapsing and its next slow-keepalive
          // tick, and that gap must not delay detection). Mirrors swarm.ts's
          // severed-link escalation (see its doc for the forensics):
          // refresh() alone does not recover a link severed by a one-side
          // restart. Once this topic HAS paired before (`everPaired`) and
          // now sits at ZERO paired channels for `severedEscalationMs`
          // despite refresh() ticking, force a fresh topic leave+rejoin and
          // fire the loud health signal.
          if (severedEscalationMs > 0) {
            const severedMs = now - st.fastWindowStartMs;
            const genuinelySevered = st.everPaired && st.channels.size === 0;
            // WI-5211 (fresh-joiner limbo): a topic that has NEVER paired can sit
            // in the same stale-DHT state the severed case escapes — the win-rig's
            // hive-presence topic joined while the only counterpart was unwired,
            // then never paired and never re-joined, while the counterpart's own
            // escalation stayed silent (it HAD a channel to a third peer). Give the
            // never-paired case the same leave+rejoin at 2× the threshold (an
            // honest chance for the initial join; a genuinely-lonely topic pays
            // one cheap local rejoin per window).
            const neverPairedStuck = !st.everPaired && st.channels.size === 0;
            const threshold = st.everPaired ? severedEscalationMs : severedEscalationMs * 2;
            if (
              (genuinelySevered || neverPairedStuck) &&
              severedMs >= threshold &&
              now - st.lastEscalationMs >= threshold
            ) {
              st.lastEscalationMs = now;
              const topicHex = st.topic.toString('hex');
              const info: GossipSeveredLinkInfo = { topicHex, severedMs, neverPaired: !st.everPaired };
              // Diagnostic-only — never let a throwing/misbehaving console
              // transport block the actual recovery action below.
              try {
                if (!process.env.VITEST) {
                  const phrase = st.everPaired
                    ? `severed for ${Math.round(severedMs / 1000)}s`
                    : `NEVER paired ${Math.round(severedMs / 1000)}s after join`;
                  console.error(
                    `[topic-gossip:${opts.protocol}] ⚠ topic ${topicHex.slice(0, 16)}… ${phrase} ` +
                      'despite refresh() ticking — forcing a fresh topic leave+rejoin (the ' +
                      'discovery session likely holds stale DHT state).',
                  );
                }
              } catch {
                /* diagnostic-only; swallow */
              }
              try {
                opts.onSeveredLink?.(info);
              } catch {
                /* diagnostic-only callback; swallow */
              }
              // WI-5355 (EI-13317 downstream): a plain DHT leave()+join() alone
              // cannot heal this — traced into the installed hyperswarm's
              // `_handlePeer`, the client-side rediscovery callback: it no-ops
              // whenever `_allConnections.has(peer.publicKey)` is already true,
              // with NO liveness re-check, so a peer Hyperswarm still counts as
              // "connected" (even a dead/zombie socket post-restart) silently
              // blocks every future rediscovery from ever attempting a fresh
              // connection.
              //
              // EI-13317/WI-5481 (shared-socket eviction DEADLOCK — the exact
              // swarm.ts forceRejoinNow class, reproduced here): the original
              // guard only evicted a socket idle across EVERY topic THIS gossip
              // instance manages (`isSocketIdleAcrossAllTopics`) — "never touch
              // a socket another topic still claims". But one physical peer
              // socket is muxed across every harness/topic this gossip instance
              // gossips for (module header), so when it half-opens (live at the
              // transport layer, dead for gossip) every topic riding it goes
              // severed at once — and each one's escalation refused to evict
              // because the OTHERS still claimed the same dead socket. Nobody
              // evicted it; the connection sat connected-but-dead until the OS
              // TCP timeout (minutes later, same 341-378s class swarm.ts hit —
              // see shared-socket-eviction-deadlock-forced-rejoin.mdx). Reaching
              // this escalation means THIS topic's link is already proven dead
              // past the repair ladder, and a dead handshake is dead for every
              // topic muxed over the same socket — so evict unconditionally
              // (mirrors swarm.ts's forceRejoinNow fix) BEFORE rejoining, so
              // Hyperswarm's own `_allConnections`/`this.connections`
              // bookkeeping no longer blocks `_handlePeer` on the next
              // DHT-found event.
              for (const socket of sockets) {
                // Diagnostic-only: note when we are breaking the shared-socket
                // deadlock (destroying a socket another topic still claims).
                // Never let a throwing console block the eviction below (same
                // VITEST-gating convention as elsewhere in this module).
                if (!isSocketIdleAcrossAllTopics(socket) && !process.env.VITEST) {
                  try {
                    console.error(
                      `[topic-gossip:${opts.protocol}] force-evicting a peer socket still shared with ` +
                        `other topics (topic ${topicHex.slice(0, 16)}…) — a forced rejoin means the link ` +
                        `is proven dead for every muxed topic; breaking the shared-socket eviction ` +
                        `deadlock (EI-13317/WI-5481).`,
                    );
                  } catch {
                    /* diagnostic-only; swallow */
                  }
                }
                evictIdleZombieSocket(socket);
              }
              // WI-5355 iteration 3: the DHT-level leave()+join() below cannot,
              // by itself, heal a topic whose Protomux CHANNEL was already
              // closed/rejected on a socket that SURVIVES this escalation
              // (i.e. still serving some OTHER topic, so not evicted above —
              // sockets are shared A↔B connections, module header). Hyperswarm
              // dedupes connections per peer, so the same socket persists
              // across the DHT rejoin and no 'connection' event ever re-fires
              // to recreate the channel — the escalation was touching only the
              // discovery/DHT layer while the actual wedge is one layer down,
              // at the Protomux channel-pairing layer (see ensureMux's
              // lazy-accept-notifier doc: a rejected/closed channel is GONE —
              // the remote's original "open" is never re-delivered, so only a
              // freshly-created LOCAL channel + a freshly-sent "open" frame can
              // give the remote another chance to pair). Re-invoke
              // openTopicChannel on every surviving socket now — it is
              // idempotent (mux.createChannel no-ops if a channel for this
              // (protocol, topic) is already open) and mirrors exactly what
              // joinTopic() already does for a topic joined on existing
              // sockets after the fact.
              for (const socket of sockets) {
                openTopicChannel(socket, st);
              }
              void Promise.resolve(opts.swarm.leave(st.topic))
                .then(() => {
                  st.discovery = opts.swarm.join(st.topic, { server: true, client: true }) as DiscoveryLike;
                  // A fresh join re-arms the fast window too.
                  st.fastWindowStartMs = Date.now();
                })
                .catch(() => {
                  // best-effort — a failed rejoin is retried at the next
                  // escalation tick (lastEscalationMs already advanced).
                });
            }
          }

          const inFastWindow = now - st.fastWindowStartMs < fastWindowMs;
          const slowDue = now - st.lastRefreshMs >= slowRefreshMs;
          if (!inFastWindow && !slowDue) continue;
          st.lastRefreshMs = now;
          try {
            void Promise.resolve(st.discovery?.refresh?.()).catch(() => {});
          } catch {
            /* best-effort per topic */
          }
        }
      },
      { category: 'lifecycle', instanced: true },
    );
  }

  return {
    get topicsJoined() {
      return [...topics.keys()];
    },
    get connectionCount() {
      return connectionCount;
    },
    openChannelCount(topicHex?: string): number {
      if (topicHex) return topics.get(topicHex)?.channels.size ?? 0;
      let n = 0;
      for (const st of topics.values()) n += st.channels.size;
      return n;
    },

    joinTopic(topic: Buffer): void {
      if (closed) throw new Error(`${name}: gossip is closed`);
      if (!topic || topic.length !== 32) {
        throw new Error('joinTopic: topic must be a 32-byte Buffer');
      }
      const hex = topic.toString('hex');
      if (topics.has(hex)) return;
      // NO discovery.flushed() here — it never connects a standalone transport
      // (see the module header); the background refresh loop is the driver.
      const discovery = opts.swarm.join(topic, { server: true, client: true }) as DiscoveryLike;
      const st: TopicState<Frame> = {
        topic,
        discovery,
        channels: new Set(),
        fastWindowStartMs: Date.now(),
        lastRefreshMs: 0,
        everPaired: false,
        lastEscalationMs: 0,
      };
      topics.set(hex, st);
      // A topic joined after connections exist still gets its channel everywhere.
      for (const socket of sockets) openTopicChannel(socket, st);
    },

    async leaveTopic(topic: Buffer): Promise<void> {
      const hex = topic.toString('hex');
      const st = topics.get(hex);
      if (!st) return;
      topics.delete(hex);
      st.channels.clear();
      try {
        await opts.swarm.leave(topic);
      } catch {
        /* leaving a non-joined topic is a no-op */
      }
    },

    broadcast(topicHex: string, frame: Frame): void {
      const st = topics.get(topicHex);
      // WI-953 layer-4 diagnosability: broadcast() is fire-and-forget over
      // WHATEVER channels happen to be open at this exact instant (no queue,
      // no retry) — if a broadcast lands in the gap between "topic joined"
      // and "peer paired" (or during a connection-flap reconnect), the frame
      // is silently dropped and nothing else will ever re-send it until the
      // next explicit call (e.g. the 5-min reannounce timer). Trace the
      // channel count at call time so a live gate run can directly confirm
      // (not just infer from "pairing happened, announce still never
      // landed") whether an announce broadcast is going out over zero
      // channels.
      if (!process.env.VITEST) {
        console.warn(
          `[topic-gossip:${opts.protocol}] broadcast on topic ${topicHex} — ${st ? st.channels.size : 0} channel(s) open, topicKnown=${!!st}`,
        );
      }
      if (!st) return;
      for (const m of st.channels) {
        try {
          m.send(frame);
        } catch (e) {
          // WI-953 layer-4b diagnosability: this catch previously swallowed
          // the error with ZERO signal — a channel counted as "open" in
          // st.channels (added on `onopen`, removed on `onclose`) can still
          // throw on send() if the underlying Protomux/stream is mid-close
          // (a TOCTOU gap between "still in the Set" and "actually live").
          // Live run4 (2026-07-10) showed a broadcast with 1 channel open
          // (matching the create call's own reachablePeers:1) that the
          // joiner never received and never logged as rejected — i.e. the
          // frame was lost SOMEWHERE between a nominally-open channel and
          // the peer's onFrame handler. Logging the send failure here is
          // what would tell a future run whether THIS is that mechanism.
          if (!process.env.VITEST) {
            console.warn(
              `[topic-gossip:${opts.protocol}] broadcast SEND FAILED on topic ${topicHex}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      if (refreshTimer) {
        refreshTimer.stop();
        refreshTimer = null;
      }
      if (opts.swarm.off) opts.swarm.off('connection', handler);
      const leaving = [...topics.values()];
      topics.clear();
      sockets.clear();
      await Promise.all(
        leaving.map(async (st) => {
          try {
            await opts.swarm.leave(st.topic);
          } catch {
            /* ignore */
          }
        }),
      );
    },
  };
}
