/**
 * directory-swarm.ts — the Hyperswarm transport for the P2P HIVE DIRECTORY
 * (p2p-hive-directory-2026-06-06 P-003 boot-join).
 *
 * The directory is GOSSIP, not log-replication: peers join the well-known
 * directory topic (derive-hive-topic.ts) and exchange signed `SignedHiveAnnounce`
 * frames over a dedicated Protomux protocol (`papercusp/hive-directory`). Unlike
 * the per-harness substrate (joinHarnessSwarm — corestore.replicate + the
 * `papercusp/announce` log-binding channel), the directory does NO corestore
 * replication: there is nothing to replicate, just announces to gossip.
 *
 * It mirrors `openAnnounceChannel`'s discipline exactly: the channel opens on
 * EVERY connection of the shared swarm, but Protomux only PAIRS it with a peer
 * that also speaks `papercusp/hive-directory` (i.e. one that joined the directory
 * topic) — so opening it unconditionally is safe; a harness-only peer simply
 * never opens its side. On pair (`onopen`) we send our current owned announces;
 * inbound frames go to `onAnnounce`. Open channels are tracked so `broadcast`
 * (the re-announce timer / a metadata change) can push to every live peer.
 *
 * Pure over an injected `HyperswarmLike` (the same test seam swarm.ts uses), so
 * the join/pair/send/receive/broadcast all unit-test with a fake swarm.
 */

import Protomux from 'protomux';
import c from 'compact-encoding';
import type { HyperswarmLike } from './swarm';
import type { SignedHiveAnnounce } from './hive-announce';

/** Protomux protocol id for the hive-directory gossip exchange. */
export const HIVE_DIRECTORY_PROTOCOL = 'papercusp/hive-directory';

export interface DirectorySwarmHandle {
  /** Leave the topic + detach the connection handler. Idempotent. */
  close(): Promise<void>;
  /** Hex topic, for diagnostics. */
  topicHex: string;
  /** Send a frame to every currently-open directory channel (best-effort). */
  broadcast(frame: SignedHiveAnnounce): void;
  /** Connections seen since join (diagnostics). */
  connectionCount: number;
  /** Currently-open (paired) directory channels (diagnostics). */
  openChannelCount: number;
}

export interface JoinDirectorySwarmOpts {
  /** The shared process swarm (getSharedSwarm()); a fake in tests. */
  swarm: HyperswarmLike;
  /** The 32-byte directory topic (deriveDirectoryTopic() or an invite topic). */
  topic: Buffer;
  /** Handle an inbound announce (→ HiveDirectory.ingestAnnounce). */
  onAnnounce: (frame: SignedHiveAnnounce) => void | Promise<unknown>;
  /** The announces to send a freshly-paired peer (our owned public/invite hives). */
  getOwnAnnounces: () => SignedHiveAnnounce[] | Promise<SignedHiveAnnounce[]>;
}

type DirMessage = { send(value: SignedHiveAnnounce): void };

/** Open the directory channel on one connection's muxer (best-effort). */
function openDirectoryChannel(
  socket: unknown,
  opts: {
    onAnnounce: JoinDirectorySwarmOpts['onAnnounce'];
    getOwnAnnounces: JoinDirectorySwarmOpts['getOwnAnnounces'];
    channels: Set<DirMessage>;
  },
): void {
  try {
    const mux = Protomux.from(socket);
    let message: DirMessage | null = null;
    const sendOurs = (): void => {
      if (!message) return;
      opts.channels.add(message);
      // Send our current owned announces to the freshly-paired peer.
      void Promise.resolve(opts.getOwnAnnounces())
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
    const channel = mux.createChannel({
      protocol: HIVE_DIRECTORY_PROTOCOL,
      onopen: sendOurs,
      onclose: () => {
        if (message) opts.channels.delete(message);
      },
    });
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
}

/**
 * Join the directory topic + wire the gossip channel. Returns a handle whose
 * `broadcast` pushes a frame to every open peer channel (the re-announce path).
 */
export async function joinDirectorySwarm(opts: JoinDirectorySwarmOpts): Promise<DirectorySwarmHandle> {
  if (!opts.topic || opts.topic.length !== 32) {
    throw new Error('joinDirectorySwarm: topic must be a 32-byte Buffer');
  }
  if (!opts.swarm) throw new Error('joinDirectorySwarm: swarm required');

  const channels = new Set<DirMessage>();
  let connectionCount = 0;
  const handler = (socket: unknown): void => {
    connectionCount++;
    openDirectoryChannel(socket, {
      onAnnounce: opts.onAnnounce,
      getOwnAnnounces: opts.getOwnAnnounces,
      channels,
    });
  };

  opts.swarm.on('connection', handler);
  const discovery = opts.swarm.join(opts.topic, { server: true, client: true });
  if (discovery && typeof discovery.flushed === 'function') {
    void discovery.flushed().catch(() => {});
  }

  return {
    topicHex: opts.topic.toString('hex'),
    get connectionCount() {
      return connectionCount;
    },
    get openChannelCount() {
      return channels.size;
    },
    broadcast(frame: SignedHiveAnnounce): void {
      for (const m of channels) {
        try {
          m.send(frame);
        } catch {
          /* best-effort per channel */
        }
      }
    },
    async close() {
      if (opts.swarm.off) opts.swarm.off('connection', handler);
      channels.clear();
      try {
        await opts.swarm.leave(opts.topic);
      } catch {
        /* leaving a non-joined topic is a no-op */
      }
    },
  };
}
