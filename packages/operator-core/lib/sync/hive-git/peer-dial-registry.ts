/**
 * hive-git/peer-dial-registry.ts — WI-3583 (p2p-git-live-activation-2026-07-09
 * Phase-3 prerequisite): the missing device-pubkey → live-swarm-socket
 * resolution that P-204's worktree-bridge-tick and P-202's ref-announce
 * receive-tick both documented as a KNOWN LIMITATION — `openHiveGitFetchDuplex`
 * (P-201, serve-wiring.ts) is the CLIENT dial primitive, but nothing maps "the
 * device that signed this staging-advance / ref-announce" to "the live socket
 * I'd dial to fetch from it". This module is that registry.
 *
 * WHY A SEPARATE tiny channel/protocol instead of extending serve-wiring.ts's
 * existing six-slot hive-git fetch channel: `serveUploadPack`'s wire format
 * (P-201, su-164d8's lane, mid-fix at the time this was written) is a stable
 * req/refuse/data/end contract with no notion of peer identity — bolting a
 * HELLO onto it would be a wire-format change to another lane's in-flight
 * file, and every future consumer of THIS registry (any hive-git driver that
 * needs "dial device X") stays decoupled from serve-wiring.ts's own evolution.
 * Instead this mirrors `authority-rpc-swarm-transport.ts`'s OWN precedent
 * exactly: a dedicated HELLO channel addressing peers by `device_pubkey`,
 * riding the SAME shared muxer, additive and independent of any other channel
 * on that muxer (same seam family as `openAnnounceChannel` / `wireHiveGitServe`
 * — never throws, never disturbs the shared connection handler).
 *
 * Protocol: ONE Protomux channel per (muxer, hive topic), protocol
 * `papercusp/hive-git-hello`, ONE message slot (`hello { device_pubkey }`)
 * sent by BOTH sides immediately once the channel opens (symmetric — either
 * peer may later dial the other). On receipt, the (topic, device_pubkey) →
 * socket mapping is recorded; on channel close it is removed, so a dropped
 * connection can never resolve to a stale/dead socket.
 *
 * Consumers (`resolveHiveGitPeerSocket` / `openHiveGitDuplexToDevice`) never
 * throw and fail soft to "no live connection to that device yet" — exactly
 * `openHiveGitFetchDuplex`'s own contract — so a caller with no registry hit
 * degrades to its existing documented fallback (local-mirror-only /
 * `fetch-failed`) rather than crashing.
 *
 * Registration entry point: `wireHiveGitDial(socket, topic,
 * selfDevicePubkeyBase64)` — called once per connection alongside
 * `wireHiveGitServe` (swarm.ts's connection handler).
 */
import { Duplex } from 'node:stream';
import Protomux, { type ProtomuxChannel } from 'protomux';
import c, { type CompactEncoding } from 'compact-encoding';
import { openHiveGitFetchDuplex } from './serve-wiring';

export const HIVE_GIT_HELLO_PROTOCOL = 'papercusp/hive-git-hello';

// ─── wire frame ────────────────────────────────────────────────────────────

interface HelloFrame {
  device_pubkey: string;
}

const helloEncoding: CompactEncoding<HelloFrame> = {
  preencode(state, v) {
    c.string.preencode(state, v.device_pubkey);
  },
  encode(state, v) {
    c.string.encode(state, v.device_pubkey);
  },
  decode(state) {
    return { device_pubkey: c.string.decode(state) };
  },
};

// ─── registry: topicHex -> devicePubkeyBase64 -> live socket ──────────────

const registryByTopic = new Map<string, Map<string, unknown>>();

function registryFor(topicHex: string): Map<string, unknown> {
  let m = registryByTopic.get(topicHex);
  if (!m) {
    m = new Map();
    registryByTopic.set(topicHex, m);
  }
  return m;
}

// ─── per-(muxer, topic) channel state ──────────────────────────────────────
// Mirrors serve-wiring.ts's `ensureChannel`/`resolveMuxStream` pattern
// EXACTLY (WI-3583 follow-up: su-164d8's P-201/WI-3490 raw-byte trace found
// the root cause of the hello-handshake hang shared by BOTH modules — see
// that file's `resolveMuxStream` comment for the full mechanism). Without
// this, a remote's channel-open control frame arriving before OUR OWN
// `createChannel()` call (e.g. during the `await opened` gap below) gets
// asynchronously REJECTED by protomux with no `pair()` registered, so our
// `onopen` never fires and the hello is never sent/received on that side.

interface ChannelState {
  channel: ProtomuxChannel | null;
  hello: { send(v: HelloFrame): void } | null;
  opened: boolean;
  openedWaiters: Array<() => void>;
  /** Set by `wireHiveGitDial` once known — read by `onopen` (which may fire
   *  before this is set, if the channel was materialized early by the lazy
   *  `pair()` notifier below) to send our own hello as soon as both are true. */
  selfDevicePubkeyBase64: string | null;
  helloSent: boolean;
  remoteDevicePubkey: string | null;
  /** The connection socket THIS side registered with (set by
   *  `wireHiveGitDial` — may still be null if the channel was materialized
   *  early by the lazy `pair()` notifier and the direct call hasn't run yet;
   *  a hello received before then is a genuine race and is simply dropped,
   *  the peer's next reconnect/retry re-sends it). Read by the hello
   *  `onmessage` handler to record the REMOTE device against OUR socket. */
  localSocket: unknown;
}

const stateByMuxer = new WeakMap<object, Map<string, ChannelState>>();

function statesFor(mux: object): Map<string, ChannelState> {
  let m = stateByMuxer.get(mux);
  if (!m) {
    m = new Map();
    stateByMuxer.set(mux, m);
  }
  return m;
}

/** Muxers on which the lazy-accept `pair()` notifier is already registered —
 *  `pair()` is idempotent to call twice, but this avoids redundant
 *  re-registration on every `resolveMuxStream` call. */
const hiveGitDialPairedMuxers = new WeakSet<object>();

function newState(): ChannelState {
  return {
    channel: null,
    hello: null,
    opened: false,
    openedWaiters: [],
    selfDevicePubkeyBase64: null,
    helloSent: false,
    remoteDevicePubkey: null,
    localSocket: null,
  };
}

function maybeSendHello(state: ChannelState): void {
  if (!state.opened || state.helloSent || !state.selfDevicePubkeyBase64 || !state.hello) return;
  try {
    state.hello.send({ device_pubkey: state.selfDevicePubkeyBase64 });
    state.helloSent = true;
  } catch {
    /* best-effort */
  }
}

/** Get-or-create the hello channel + its message slot for (mux, topic).
 *  Idempotent per muxer — a late `pair()`-triggered materialization and a
 *  direct `wireHiveGitDial` call both resolve to the SAME state object. */
function ensureChannel(mux: Protomux, topic: Buffer): ChannelState {
  const states = statesFor(mux as unknown as object);
  const topicHex = topic.toString('hex');
  let state = states.get(topicHex);
  if (state) return state;
  state = newState();
  states.set(topicHex, state);
  const channel: ProtomuxChannel | null = mux.createChannel({
    protocol: HIVE_GIT_HELLO_PROTOCOL,
    id: topic,
    onopen: () => {
      state!.opened = true;
      const waiters = state!.openedWaiters.splice(0);
      for (const w of waiters) w();
      maybeSendHello(state!);
    },
    onclose: () => {
      if (state!.remoteDevicePubkey) registryFor(topicHex).delete(state!.remoteDevicePubkey);
    },
  });
  if (!channel) {
    // Defensive: a (protocol,id) collision on this muxer (shouldn't happen —
    // HIVE_GIT_HELLO_PROTOCOL is private to this module). Fail soft rather
    // than throw, same contract as serve-wiring.ts's ensureChannel.
    return state;
  }
  state.channel = channel;
  state.hello = channel.addMessage<HelloFrame>({
    encoding: helloEncoding,
    onmessage: (v) => {
      state!.remoteDevicePubkey = v.device_pubkey;
      // `localSocket` is set by `wireHiveGitDial`'s register() — normally
      // already populated by the time a peer's hello arrives (both run at
      // connection-open time), but if a hello genuinely races ahead of it,
      // fail soft (drop this hello) rather than register a `null` socket;
      // the registry then simply stays "not yet resolvable" for this device,
      // matching every other not-connected-yet case.
      if (state!.localSocket) registryFor(topicHex).set(v.device_pubkey, state!.localSocket);
    },
  });
  channel.open();
  return state;
}

/** Resolve the shared Protomux for a connection socket — corestore attaches it
 *  at `socket.noiseStream`, not always the outer Hyperswarm socket (mirrors
 *  the identical resolution in swarm.ts / serve-wiring.ts) — AND register the
 *  lazy-accept `pair()` notifier once per muxer, closing the client-open race
 *  described above.
 *
 *  ALSO caches the resolved mux onto `muxStream.userData` (mirrors
 *  `openAnnounceChannel`'s identical fixup in swarm.ts). This is NOT
 *  optional: `Protomux.from()`'s own caching only activates when
 *  `stream.userData` was already strictly `null` before the FIRST call on
 *  that stream (its constructor does `if (stream.userData === null)
 *  stream.userData = this`) — a bare socket's `userData` starts as
 *  `undefined`, not `null`, so that guard silently never fires, and every
 *  independent `Protomux.from(sameSocket)` call (this module's, and
 *  `wireHiveGitServe`'s/`openHiveGitFetchDuplex`'s own, in serve-wiring.ts)
 *  would otherwise construct a SEPARATE Protomux instance competing to
 *  parse/write the SAME underlying byte stream — corrupting BOTH channels'
 *  framing. Whichever wiring function runs first on a socket "wins" the
 *  cache; every later caller (any module) then retrieves the SAME instance
 *  via `Protomux.from`'s own `stream.userData.isProtomux` fast path. */
function resolveMuxStream(socket: unknown): { mux: Protomux; opened?: Promise<unknown> } {
  const muxStream = ((socket as { noiseStream?: unknown } | null)?.noiseStream ?? socket) as {
    opened?: Promise<unknown>;
    userData?: unknown;
  };
  const mux = Protomux.from(muxStream as never);
  if (!muxStream.userData) muxStream.userData = mux;
  if (!hiveGitDialPairedMuxers.has(mux as unknown as object)) {
    hiveGitDialPairedMuxers.add(mux as unknown as object);
    try {
      mux.pair({ protocol: HIVE_GIT_HELLO_PROTOCOL }, (id: Buffer | null) => {
        if (!id) return;
        ensureChannel(mux, id);
      });
    } catch {
      // pair() unsupported on this muxer build — connect-time channels still
      // pair the normal (non-lazy) way when both sides create first.
    }
  }
  return { mux, opened: muxStream.opened };
}

// ─── public API ─────────────────────────────────────────────────────────────

/**
 * Register this connection on the hive-git dial-hello channel for `topic`:
 * announce OUR device_pubkey to the peer and learn THEIRS. Fire-and-forget,
 * NEVER throws (mirrors `wireHiveGitServe`'s contract) — a wiring bug here
 * must never crash the shared swarm connection handler. Call once per
 * connection, alongside `wireHiveGitServe` / `openAnnounceChannel`.
 */
export function wireHiveGitDial(socket: unknown, topic: Buffer, selfDevicePubkeyBase64: string): void {
  try {
    const { mux, opened } = resolveMuxStream(socket);
    const register = (): void => {
      try {
        const state = ensureChannel(mux, topic);
        state.selfDevicePubkeyBase64 = selfDevicePubkeyBase64;
        state.localSocket = socket;
        // `onopen` may already have fired (the channel was materialized
        // early by the lazy `pair()` notifier in `resolveMuxStream`, before
        // this register() ran) — send now if so; otherwise `onopen` itself
        // calls `maybeSendHello` once it fires.
        maybeSendHello(state);
      } catch {
        /* best-effort */
      }
    };
    if (opened && typeof opened.then === 'function') void opened.then(register, register);
    else register();
  } catch {
    /* best-effort — dial registration is additive, never breaks the swarm connection */
  }
}

/** Resolve the live socket for `devicePubkeyBase64` on `topic`'s hive, or
 *  `undefined` when no connection has completed the hello handshake with that
 *  device yet (not connected / connection dropped / hello still in flight —
 *  all indistinguishable from "no live dial path right now"). */
export function resolveHiveGitPeerSocket(topic: Buffer, devicePubkeyBase64: string): unknown | undefined {
  return registryByTopic.get(topic.toString('hex'))?.get(devicePubkeyBase64);
}

/**
 * Build (or fail soft) a live fetch Duplex to `devicePubkeyBase64` on
 * `topic`'s hive-git channel — the real cross-machine `openDuplex` seam
 * `worktree-bridge-tick.ts` / `ref-announce-tick.ts` document as a KNOWN
 * LIMITATION when omitted. No live connection to that device yet ⇒ an
 * immediately-destroyed Duplex (fail-soft, matches `openHiveGitFetchDuplex`'s
 * own "never throws" contract) so a caller degrades to a `fetch-failed`
 * outcome (retried next tick) rather than crashing.
 */
export async function openHiveGitDuplexToDevice(
  topic: Buffer,
  devicePubkeyBase64: string,
  req: { repoKey: string; peerGithubUserId?: number },
): Promise<Duplex> {
  const socket = resolveHiveGitPeerSocket(topic, devicePubkeyBase64);
  if (!socket) {
    const d = new Duplex({
      read() {
        /* no data — destroyed below */
      },
      write(_chunk, _enc, cb) {
        cb();
      },
    });
    d.destroy(new Error(`hive-git: no live connection to device ${devicePubkeyBase64.slice(0, 12)}…`));
    return d;
  }
  return openHiveGitFetchDuplex(socket, topic, req);
}

export const _testing = {
  registryByTopic,
  reset(): void {
    registryByTopic.clear();
  },
};
