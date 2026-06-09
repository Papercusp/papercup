/**
 * cross-hive-swarm-transport — the LIVE CrossHiveTransport adapter
 * (cross-hive-boundary-2026-06-08 P-006). Implements the injectable
 * `CrossHiveTransport` PORT (cross-hive-transport.ts) over the shared Hyperswarm,
 * so a directed Hive→Hive envelope is delivered cross-machine over the real
 * public DHT — `send` dials a peer Hive by PUBKEY, `subscribe` listens on OUR
 * Hive's topic.
 *
 * Mirrors directory-swarm.ts exactly (a dedicated Protomux protocol over the
 * shared swarm, NO corestore replication — there is nothing to replicate, just
 * signed envelopes to pass). The sovereignty boundary is preserved: we never
 * replicate a peer Hive's cores; we only open the `papercusp/cross-hive` channel
 * and exchange envelopes that the receiver still admits per its own grants
 * (receiveCrossHive → admitCrossHiveEnvelope).
 *
 * Addressing: on channel pair each side sends a HELLO carrying its own Hive
 * pubkey, so `send(toHivePubkey, env)` routes the envelope to ONLY the channel
 * whose remote is that Hive — never a broadcast that leaks an A→B envelope to a
 * third connected Hive C. A Hive is SERVER on its own topic (reachable) and
 * CLIENT on a peer's topic it dials.
 *
 * Pure over an injected `HyperswarmLike` + `deriveTopic` (the same seams swarm.ts
 * / directory-swarm.ts use), so the dial/pair/hello/send/receive lifecycle
 * unit-tests with a fake swarm + fake Protomux, and runs live over a real
 * Hyperswarm in the cross-machine E2E.
 */
import Protomux from 'protomux';
import c from 'compact-encoding';
import type { HyperswarmLike } from './sync/hyperbee/swarm';
import { deriveHiveFederationTopic } from './sync/hyperbee/derive-swarm-topic';
import type { CrossHiveTransport, CrossHiveWireEnvelope } from './cross-hive-transport';

/** Protomux protocol id for the cross-Hive envelope exchange. */
export const CROSS_HIVE_PROTOCOL = 'papercusp/cross-hive';

/**
 * A wire frame on the cross-hive channel: a HELLO (announce my Hive pubkey, so
 * the peer can route addressed envelopes to me) or an ENV (a signed envelope).
 */
type CrossHiveFrame =
  | { t: 'hello'; hivePubkey: string }
  | { t: 'env'; env: CrossHiveWireEnvelope };

interface OpenChannel {
  send(frame: CrossHiveFrame): void;
  /** The remote Hive's pubkey, learned from its HELLO (null until it arrives). */
  remotePubkey: string | null;
}

export interface SwarmCrossHiveTransportOpts {
  /** The shared process swarm (getSharedSwarm()); a fake in tests. */
  swarm: HyperswarmLike;
  /** THIS Hive's pubkey (base64). We join its topic as SERVER so peers can dial us. */
  selfHivePubkey: string;
  /** Topic derivation (default deriveHiveFederationTopic). Injected for tests. */
  deriveTopic?: (hivePubkeyBase64: string) => Buffer;
  /** How long send() waits for a paired channel to the target Hive (default 5000ms). */
  sendWaitMs?: number;
  /** Poll cadence while waiting for a channel (default 50ms). */
  pollMs?: number;
  /**
   * Background re-announce cadence (default 2500ms). The transport periodically
   * re-flushes the swarm so BOTH a receiver (re-announcing its topic) and a
   * sender (re-driving its lookup) stay continuously discoverable — repeated
   * mutual flushing is what makes the cross-topic rendezvous connect reliably
   * (a single announce can be missed). 0 disables it.
   */
  reannounceMs?: number;
}

export interface SwarmCrossHiveTransport extends CrossHiveTransport {
  /** Leave every joined topic + detach the connection handler. Idempotent. */
  close(): Promise<void>;
  /** Connections seen since construction (diagnostics). */
  readonly connectionCount: number;
  /** Currently-open (paired) cross-hive channels (diagnostics). */
  readonly openChannelCount: number;
  /** Hex of our own Hive topic (diagnostics). */
  readonly selfTopicHex: string;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Build a live CrossHiveTransport over the shared swarm. Construction joins our
 * own Hive topic (server+client) and registers the connection handler, so we are
 * immediately reachable; `subscribe` sets the inbound handler (buffered until
 * then); `send` dials the target Hive's topic (client) and pushes the envelope to
 * the matching channel.
 */
export function makeSwarmCrossHiveTransport(opts: SwarmCrossHiveTransportOpts): SwarmCrossHiveTransport {
  if (!opts.swarm) throw new Error('makeSwarmCrossHiveTransport: swarm required');
  if (!opts.selfHivePubkey) throw new Error('makeSwarmCrossHiveTransport: selfHivePubkey required');
  const deriveTopic = opts.deriveTopic ?? deriveHiveFederationTopic;
  const sendWaitMs = opts.sendWaitMs ?? 5000;
  const pollMs = opts.pollMs ?? 50;
  const reannounceMs = opts.reannounceMs ?? 2500;

  const channels = new Set<OpenChannel>();
  const joined = new Map<string, unknown>(); // topicHex → discovery handle
  let inbound: ((env: CrossHiveWireEnvelope) => void | Promise<unknown>) | null = null;
  const inboundBuffer: CrossHiveWireEnvelope[] = [];
  let connectionCount = 0;

  const deliver = (env: CrossHiveWireEnvelope): void => {
    if (inbound) void Promise.resolve(inbound(env)).catch(() => {});
    else inboundBuffer.push(env); // received before subscribe() → flush on subscribe
  };

  /** Open the cross-hive channel on one connection's muxer (best-effort). */
  const openChannel = (socket: unknown): void => {
    try {
      const mux = Protomux.from(socket);
      const oc: OpenChannel = { send: () => {}, remotePubkey: null };
      let message: { send(v: CrossHiveFrame): void } | null = null;
      const channel = mux.createChannel({
        protocol: CROSS_HIVE_PROTOCOL,
        onopen: () => {
          channels.add(oc);
          // Announce our identity so the peer can route addressed envelopes to us.
          try {
            message?.send({ t: 'hello', hivePubkey: opts.selfHivePubkey });
          } catch {
            /* best-effort */
          }
        },
        onclose: () => {
          channels.delete(oc);
        },
      });
      message = channel.addMessage<CrossHiveFrame>({
        encoding: c.json,
        onmessage: (frame: CrossHiveFrame) => {
          if (!frame || typeof frame !== 'object') return;
          if (frame.t === 'hello' && typeof frame.hivePubkey === 'string') {
            oc.remotePubkey = frame.hivePubkey;
            return;
          }
          if (frame.t === 'env' && frame.env && typeof frame.env === 'object') {
            deliver(frame.env);
          }
        },
      });
      oc.send = (frame: CrossHiveFrame) => {
        try {
          message!.send(frame);
        } catch {
          /* best-effort */
        }
      };
      channel.open();
    } catch {
      // The channel is best-effort; a peer that can't speak it is ignored.
    }
  };

  const handler = (socket: unknown): void => {
    connectionCount++;
    openChannel(socket);
  };

  // Join a Hive topic as BOTH server + client. Cross-Hive rendezvous is the
  // recipient's topic: the recipient is always server there, and a sender joins
  // it too — both announce + look up so mutual discovery is reliable (a
  // client-only sender connects unreliably over the DHT). Announcing on a peer's
  // topic is not an impersonation: every connection still Noise-handshakes our
  // own key and our HELLO carries our real pubkey; addressing is still validated
  // by the receiver, so a stray connection mis-delivers nothing.
  //
  // CRITICAL: do NOT call the per-topic `discovery.flushed()` here. Calling it
  // alongside `swarm.flush()` POISONS discovery on this swarm — the connection
  // never forms (verified: a bare two-swarm pair connects in ~1.5s, but adding
  // `void discovery.flushed()` to the same joins keeps connectionCount at 0).
  // We drive discovery exclusively through `swarmFlush()` (the swarm-level flush),
  // which is the pattern that reliably connects.
  const ensureJoined = (topic: Buffer): void => {
    const hex = topic.toString('hex');
    if (joined.has(hex)) return;
    joined.set(hex, opts.swarm.join(topic, { server: true, client: true }));
  };

  /** Drive a full DHT announce+lookup+connect round (awaited). Best-effort. */
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

  // Reachable immediately: register the handler + join our own topic (server) so
  // peers can dial us, then flush in the background to announce it on the DHT.
  opts.swarm.on('connection', handler);
  const selfTopic = deriveTopic(opts.selfHivePubkey);
  ensureJoined(selfTopic);
  void swarmFlush();

  // Keep BOTH sides continuously discoverable: a periodic re-flush re-announces
  // our joined topics + re-drives lookups, so a sender and a receiver converge
  // even if an announce/lookup is missed on the first round. Cleared on close.
  let reannounceTimer: ReturnType<typeof setInterval> | null = null;
  if (reannounceMs > 0) {
    reannounceTimer = setInterval(() => void swarmFlush(), reannounceMs);
    reannounceTimer.unref?.();
  }

  return {
    selfTopicHex: selfTopic.toString('hex'),
    get connectionCount() {
      return connectionCount;
    },
    get openChannelCount() {
      return channels.size;
    },

    subscribe(handlerFn: (env: CrossHiveWireEnvelope) => Promise<void>): void {
      inbound = handlerFn;
      // Flush anything that arrived before we had a handler.
      const buffered = inboundBuffer.splice(0);
      for (const env of buffered) void Promise.resolve(handlerFn(env)).catch(() => {});
      // Now that we're listening, (re)announce our self-topic so senders find us.
      void swarmFlush();
    },

    async send(toHivePubkey: string, env: CrossHiveWireEnvelope): Promise<void> {
      // Rendezvous on the target Hive's topic (it is server there; we join too).
      ensureJoined(deriveTopic(toHivePubkey));
      const targets = (): OpenChannel[] => [...channels].filter((ch) => ch.remotePubkey === toHivePubkey);
      // Wait for the channel to the target to pair + exchange HELLOs, AWAITING a
      // re-triggered DHT announce+lookup+connect round (swarm.flush) each
      // iteration — awaiting the flush is what drives the connection to
      // completion (it resolves only after the swarm has looked up + connected to
      // discovered peers). Never use discovery.flushed() (it poisons discovery).
      const start = Date.now();
      while (targets().length === 0 && Date.now() - start < sendWaitMs) {
        await swarmFlush();
        if (targets().length > 0) break;
        await delay(pollMs);
      }
      const t = targets();
      if (t.length === 0) {
        throw new Error(
          `cross-hive: no paired channel to Hive ${toHivePubkey.slice(0, 8)}… within ${sendWaitMs}ms`,
        );
      }
      for (const ch of t) ch.send({ t: 'env', env });
    },

    async close(): Promise<void> {
      if (reannounceTimer) {
        clearInterval(reannounceTimer);
        reannounceTimer = null;
      }
      if (opts.swarm.off) opts.swarm.off('connection', handler);
      channels.clear();
      for (const hex of joined.keys()) {
        try {
          await opts.swarm.leave(Buffer.from(hex, 'hex'));
        } catch {
          /* leaving a non-joined topic is a no-op */
        }
      }
      joined.clear();
    },
  };
}
