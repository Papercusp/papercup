/**
 * directory-swarm.ts — the Hyperswarm transport for the P2P HIVE DIRECTORY
 * (p2p-hive-directory-2026-06-06 P-003 boot-join).
 *
 * The directory is GOSSIP, not log-replication: peers join directory topics
 * (derive-hive-topic.ts — the global topic + invite-scoped topics) and exchange
 * signed `SignedHiveAnnounce` frames over a dedicated Protomux protocol
 * (`papercusp/hive-directory`). Unlike the per-harness substrate
 * (joinHarnessSwarm — corestore.replicate + the `papercusp/announce`
 * log-binding channel), the directory does NO corestore replication: there is
 * nothing to replicate, just announces to gossip.
 *
 * ONE gossip instance manages ALL directory topics (`createDirectoryGossip`),
 * because Hyperswarm dedupes connections per peer: a single A↔B socket serves
 * every topic both ends share, so per-topic connection handlers are wrong twice
 * over — a topic joined after the socket exists would never see it, and two
 * same-`(protocol, id)` channels on one muxer collide (Protomux `unique`
 * returns null for the second). Instead:
 *
   *   - One `connection` handler tracks live sockets; ONE muxer per Noise stream
   *     (`Protomux.from` + the `noiseStream.userData` convention, so corestore
   *     replication and the cross-hive channel share it in either attach order).
 *   - One channel PER TOPIC per socket, keyed `{ protocol, id: topic }` —
 *     Protomux pairing IS the scoping: a channel only opens once BOTH ends
 *     joined that topic (derived the same id), so an invite hive's announce is
 *     never written to a peer that doesn't hold the invite secret.
 *   - Joining a topic retroactively opens its channel on every existing socket
 *     (the `joinInviteTopic`-after-boot case).
 *
 * Discovery is driven by a per-topic `discovery.refresh()` LOOP — empirically
 * the ONLY driver that connects a standalone (non-corestore) transport on the
 * current hyperswarm/hyperdht: the first announce/lookup round after `join`
 * reliably misses (a fresh DHT node), nothing internal retries for minutes, and
 * neither `discovery.flushed()` nor swarm-level `swarm.flush()` (the older
 * cross-hive pattern — since rotted) ever forms a connection. Verified on a
 * loopback testnet: join + refresh-loop connects in ~1.1s; join + flushed /
 * flush(-loop) / dht.ready()+join all sit at 0 connections indefinitely.
 *
 * Pure over an injected `HyperswarmLike` (the same test seam swarm.ts uses), so
 * join/pair/send/receive/broadcast all unit-test with a fake swarm; the live
 * proof is hive-directory-live-two-peer.test.ts (real Hyperswarm on a testnet).
 */

import Protomux from 'protomux';
import c from 'compact-encoding';
import type { HyperswarmLike } from './swarm';
import type { SignedHiveAnnounce } from './hive-announce';

/** Protomux protocol id for the hive-directory gossip exchange. */
export const HIVE_DIRECTORY_PROTOCOL = 'papercusp/hive-directory';

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

type DirMessage = { send(value: SignedHiveAnnounce): void };

/** What swarm.join returns — flushed is legacy; refresh re-runs announce+lookup. */
type DiscoveryLike = { flushed?: () => Promise<void>; refresh?: (opts?: object) => unknown } | undefined;

interface TopicState {
  topic: Buffer;
  /** The swarm.join handle — its refresh() drives discovery for this topic. */
  discovery: DiscoveryLike;
  /** Paired channels for THIS topic (one per socket whose peer also joined it). */
  channels: Set<DirMessage>;
  /** Start of the topic's FAST-refresh window (join time; re-armed when the
   *  topic loses its last paired channel, so reconnection is snappy too). */
  fastWindowStartMs: number;
  /** Last refresh tick for this topic (drives the slow keepalive). */
  lastRefreshMs: number;
}

export interface DirectoryGossipHandle {
  /** Join a directory topic (global or invite-scoped). Opens the topic's channel
   *  on every existing connection too (the join-after-boot case). Idempotent. */
  joinTopic(topic: Buffer): void;
  /** Leave a topic + forget its channels. Idempotent. */
  leaveTopic(topic: Buffer): Promise<void>;
  /** Send a frame to every currently-paired channel of ONE topic (best-effort).
   *  Pairing guarantees only peers that joined that topic receive it. */
  broadcast(topicHex: string, frame: SignedHiveAnnounce): void;
  /** Leave every topic + detach the connection handler + stop re-flush. Idempotent. */
  close(): Promise<void>;
  /** Hex of every joined topic (diagnostics). */
  readonly topicsJoined: string[];
  /** Connections seen since creation (diagnostics). */
  readonly connectionCount: number;
  /** Currently-paired channels — for one topic, or all topics (diagnostics). */
  openChannelCount(topicHex?: string): number;
}

export interface CreateDirectoryGossipOpts {
  /** The shared process swarm (getSharedSwarm()); a fake in tests. */
  swarm: HyperswarmLike;
  /** Handle an inbound announce (→ HiveDirectory.ingestAnnounce). */
  onAnnounce: (frame: SignedHiveAnnounce) => void | Promise<unknown>;
  /** The announces to send a freshly-paired peer on ONE topic — scoped to that
   *  topic so a global-topic pair only ever receives PUBLIC hives and an
   *  invite-topic pair only that invite's hive(s). */
  getOwnAnnounces: (topicHex: string) => SignedHiveAnnounce[] | Promise<SignedHiveAnnounce[]>;
  /** FAST per-topic discovery-refresh cadence (ms). Default DEFAULT_REFRESH_MS; 0 disables refreshing entirely. */
  refreshMs?: number;
  /** How long the fast cadence runs after a join / last-peer loss (ms). Default DEFAULT_FAST_WINDOW_MS. */
  fastWindowMs?: number;
  /** Steady-state keepalive cadence once the fast window lapses (ms). Default DEFAULT_SLOW_REFRESH_MS. */
  slowRefreshMs?: number;
}

/**
 * Create the directory gossip over the shared swarm. One instance per process —
 * topics are joined/left through the handle.
 */
export function createDirectoryGossip(opts: CreateDirectoryGossipOpts): DirectoryGossipHandle {
  if (!opts.swarm) throw new Error('createDirectoryGossip: swarm required');

  const topics = new Map<string, TopicState>();
  const sockets = new Set<unknown>();
  let connectionCount = 0;
  let closed = false;

  /** Muxers that already carry our pair-notifier (one registration per muxer). */
  const pairedMuxers = new WeakSet<object>();

  /**
   * One shared muxer per socket + the LAZY-ACCEPT pair-notifier. Without the
   * notifier, protomux REJECTS a remote's channel-open for a topic we haven't
   * opened a channel for yet on that socket — and the remote never re-opens, so
   * a topic joined later (joinInviteTopic) could never pair on an existing
   * connection. The notifier accepts the open IFF we joined that topic (which
   * is also the scoping: an un-joined topic's open stays rejected).
   */
  const ensureMux = (socket: unknown): Protomux => {
    // Corestore/Hypercore attaches its shared Protomux to the NoiseSecretStream
    // (`socket.noiseStream`), while Hyperswarm hands consumers the outer wrapper.
    // Use the same stream as corestore so directory gossip and substrate announce
    // channels cannot split onto different muxers over one peer connection.
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
        mux.pair({ protocol: HIVE_DIRECTORY_PROTOCOL }, (id: Buffer | null) => {
          if (!id) return; // directory channels are always topic-keyed
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
  const openTopicChannel = (socket: unknown, st: TopicState): void => {
    try {
      const mux = ensureMux(socket);

      let message: DirMessage | null = null;
      const topicHex = st.topic.toString('hex');
      const sendOurs = (): void => {
        if (!message) return;
        st.channels.add(message);
        // Send our current owned announces for THIS topic to the freshly-paired peer.
        void Promise.resolve(opts.getOwnAnnounces(topicHex))
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
      // invite-scoping: no shared topic, no channel, no frame.
      const channel = mux.createChannel({
        protocol: HIVE_DIRECTORY_PROTOCOL,
        id: st.topic,
        onopen: sendOurs,
        onclose: () => {
          if (message) st.channels.delete(message);
          // Lost the topic's last peer → re-arm the FAST refresh window so
          // rediscovery/reconnection is snappy again.
          if (st.channels.size === 0) st.fastWindowStartMs = Date.now();
        },
      });
      if (!channel) return; // already open for this (socket, topic) — idempotent
      message = channel.addMessage<SignedHiveAnnounce>({
        encoding: c.json,
        onmessage: (frame: SignedHiveAnnounce) => {
          try {
            void Promise.resolve(opts.onAnnounce(frame)).catch(() => {});
          } catch {
            /* synchronous throw — swallow */
          }
        },
      });
      channel.open();
    } catch {
      // Directory channel is best-effort; a peer that can't speak it is ignored.
    }
  };

  const handler = (socket: unknown): void => {
    connectionCount++;
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
  // swarm.ts, WI-647): the directory gossip is wired LAZILY
  // (ensureHiveDirectoryWired) — typically AFTER the substrate already opened
  // the shared A↔B socket. That socket never re-emits 'connection', so without
  // seeding from the swarm's EXISTING connections the `sockets` set stays empty
  // → a later joinTopic opens its channel on NOTHING → reachablePeers:0 forever
  // (no DHT re-pair on an air-gapped / long-lived link). Treat each existing
  // socket exactly like a fresh connection so the directory channel pairs over
  // the already-established substrate socket. topics is empty at creation, so
  // this only populates `sockets`; the caller's joinTopic then opens channels.
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
  // topic (the global directory) doesn't hammer the public DHT forever. Losing a
  // topic's last peer re-arms its fast window (see the channel onclose).
  const refreshMs = opts.refreshMs ?? DEFAULT_REFRESH_MS;
  const fastWindowMs = opts.fastWindowMs ?? DEFAULT_FAST_WINDOW_MS;
  const slowRefreshMs = opts.slowRefreshMs ?? DEFAULT_SLOW_REFRESH_MS;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  if (refreshMs > 0) {
    refreshTimer = setInterval(() => {
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
    }, refreshMs);
    refreshTimer.unref?.();
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
      if (closed) throw new Error('createDirectoryGossip: gossip is closed');
      if (!topic || topic.length !== 32) {
        throw new Error('joinTopic: topic must be a 32-byte Buffer');
      }
      const hex = topic.toString('hex');
      if (topics.has(hex)) return;
      // NO discovery.flushed() here — it never connects a standalone transport
      // (see the module header); the background refresh loop is the driver.
      const discovery = opts.swarm.join(topic, { server: true, client: true }) as DiscoveryLike;
      const st: TopicState = {
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

    broadcast(topicHex: string, frame: SignedHiveAnnounce): void {
      const st = topics.get(topicHex);
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
        clearInterval(refreshTimer);
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
