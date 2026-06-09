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
 *   - One `connection` handler tracks live sockets; ONE muxer per socket
 *     (`Protomux.from` + the `socket.userData` convention, so corestore
 *     replication and the cross-hive channel share it in either attach order).
 *   - One channel PER TOPIC per socket, keyed `{ protocol, id: topic }` —
 *     Protomux pairing IS the scoping: a channel only opens once BOTH ends
 *     joined that topic (derived the same id), so an invite hive's announce is
 *     never written to a peer that doesn't hold the invite secret.
 *   - Joining a topic retroactively opens its channel on every existing socket
 *     (the `joinInviteTopic`-after-boot case).
 *
 * Discovery is driven by swarm-level `swarm.flush()` (an immediate flush per
 * join + a background re-flush), NEVER the per-topic `discovery.flushed()` —
 * calling that on a standalone (non-corestore) transport poisons discovery and
 * the connection never forms (the verified cross-hive-swarm-transport gotcha;
 * see the agent insight + cross-hive-swarm-transport.ts).
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

/** Background swarm re-flush cadence — keeps announce+lookup converging even
 *  when a first DHT round is missed (the cross-hive transport's proven value). */
export const DEFAULT_REFLUSH_MS = 2500;

type DirMessage = { send(value: SignedHiveAnnounce): void };

interface TopicState {
  topic: Buffer;
  /** Paired channels for THIS topic (one per socket whose peer also joined it). */
  channels: Set<DirMessage>;
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
  /** Background re-flush cadence (ms). Default DEFAULT_REFLUSH_MS; 0 disables. */
  reflushMs?: number;
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

  /** Open ONE topic's channel on ONE socket's shared muxer (best-effort). */
  const openTopicChannel = (socket: unknown, st: TopicState): void => {
    try {
      const mux = Protomux.from(socket);
      // The ecosystem convention (hypercore createProtocolStream does the same):
      // pin the muxer on the stream so every other protocol on this connection
      // (corestore replication, cross-hive) reuses it instead of double-muxing.
      const s = socket as { userData?: unknown };
      if (!s.userData) s.userData = mux;

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
    (socket as { once?: (ev: string, fn: () => void) => unknown }).once?.('close', () => {
      sockets.delete(socket);
    });
    for (const st of topics.values()) openTopicChannel(socket, st);
  };
  opts.swarm.on('connection', handler);

  /** Drive a full DHT announce+lookup+connect round (best-effort, awaited). */
  const swarmFlush = async (): Promise<void> => {
    const f = (opts.swarm as { flush?: () => Promise<unknown> }).flush;
    if (typeof f === 'function') {
      try {
        await f.call(opts.swarm);
      } catch {
        /* best-effort */
      }
    }
  };

  // Keep announce + lookup converging in the background (cleared on close).
  const reflushMs = opts.reflushMs ?? DEFAULT_REFLUSH_MS;
  let reflushTimer: ReturnType<typeof setInterval> | null = null;
  if (reflushMs > 0) {
    reflushTimer = setInterval(() => void swarmFlush(), reflushMs);
    reflushTimer.unref?.();
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
      const st: TopicState = { topic, channels: new Set() };
      topics.set(hex, st);
      // NO discovery.flushed() — on a standalone (non-corestore) transport it
      // poisons discovery (connection never forms). swarm.flush() is the driver.
      opts.swarm.join(topic, { server: true, client: true });
      // A topic joined after connections exist still gets its channel everywhere.
      for (const socket of sockets) openTopicChannel(socket, st);
      void swarmFlush();
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
      if (reflushTimer) {
        clearInterval(reflushTimer);
        reflushTimer = null;
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
