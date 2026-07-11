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
}

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
          sendOurs();
        },
        onclose: () => {
          if (message) st.channels.delete(message);
          // Lost the topic's last peer → re-arm the FAST refresh window so
          // rediscovery/reconnection is snappy again.
          if (st.channels.size === 0) st.fastWindowStartMs = Date.now();
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
        for (const st of topics.values()) {
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
        } catch {
          /* best-effort per channel */
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
