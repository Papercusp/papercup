/**
 * pot-git/peer-dial-registry.ts — WI-3583 (p2p-git-live-activation-2026-07-09
 * Phase-3 prerequisite): the missing device-pubkey → live-swarm-socket
 * resolution that P-204's worktree-bridge-tick and P-202's ref-announce
 * receive-tick both documented as a KNOWN LIMITATION — `openHiveGitFetchDuplex`
 * (P-201, serve-wiring.ts) is the CLIENT dial primitive, but nothing maps "the
 * device that signed this staging-advance / ref-announce" to "the live socket
 * I'd dial to fetch from it". This module is that registry.
 *
 * WHY A SEPARATE tiny channel/protocol instead of extending serve-wiring.ts's
 * existing six-slot pot-git fetch channel: `serveUploadPack`'s wire format
 * (P-201, su-164d8's lane, mid-fix at the time this was written) is a stable
 * req/refuse/data/end contract with no notion of peer identity — bolting a
 * HELLO onto it would be a wire-format change to another lane's in-flight
 * file, and every future consumer of THIS registry (any pot-git driver that
 * needs "dial device X") stays decoupled from serve-wiring.ts's own evolution.
 * Instead this mirrors `authority-rpc-swarm-transport.ts`'s OWN precedent
 * exactly: a dedicated HELLO channel addressing peers by `device_pubkey`,
 * riding the SAME shared muxer, additive and independent of any other channel
 * on that muxer (same seam family as `openAnnounceChannel` / `wireHiveGitServe`
 * — never throws, never disturbs the shared connection handler).
 *
 * Protocol: ONE Protomux channel per (muxer, hive topic), protocol
 * `papercusp/pot-git-hello`, ONE message slot (`hello { device_pubkey }`)
 * sent by BOTH sides immediately once the channel opens (symmetric — either
 * peer may later dial the other). On receipt, the (topic, device_pubkey) →
 * socket mapping is recorded; on channel close it is removed, so a dropped
 * connection can never resolve to a stale/dead socket.
 *
 * Consumers (`resolvePotGitPeerSocket` / `openHiveGitDuplexToDevice`) never
 * throw and fail soft to "no live connection to that device yet" — exactly
 * `openHiveGitFetchDuplex`'s own contract — so a caller with no registry hit
 * degrades to its existing documented fallback (local-mirror-only /
 * `fetch-failed`) rather than crashing.
 *
 * Registration entry point: `wireHiveGitDial(socket, topic,
 * selfDevicePubkeyBase64, sign)` — called once per connection alongside
 * `wireHiveGitServe` (swarm.ts's connection handler).
 *
 * WI-3641 hardening: the hello used to carry a BARE, UNSIGNED
 * `{device_pubkey}` claim — any peer able to reach the hive's swarm topic
 * (DHT topics aren't secret) could open this channel and claim ANY
 * device_pubkey, including a genuine member's. Nothing downstream could then
 * trust "this socket is device X" for an authorization decision (exactly the
 * gap WI-3641 found in serve-wiring.ts's scope-repo refusal). The hello now
 * carries a `signature` over a fixed, topic-bound context string, produced
 * with the SAME device Ed25519 keypair bound to the peer's GitHub attestation
 * (`signWithDeviceKey` / the `announceIdentityOverride.sign` test seam boot.ts
 * already uses for the announce channel) — so only the actual private-key
 * holder can produce a hello that verifies, and a signature over `topic`
 * prevents a captured hello being replayed on a different hive's channel. An
 * unverified/forged hello is DROPPED (never registered) rather than trusted.
 */
import { Duplex } from 'node:stream';
import { appendFileSync } from 'node:fs';
import Protomux, { type ProtomuxChannel } from 'protomux';
import c, { type CompactEncoding } from 'compact-encoding';
import { verifyEd25519 } from '../../identity/ed25519';
import { openHiveGitFetchDuplex } from './serve-wiring';

/** The fixed, topic-bound context a hello's signature is over — binding the
 *  signature to THIS hive's topic so a captured hello can't be replayed to
 *  claim the same device on a different hive's channel. */
function helloSignContext(topic: Buffer): Buffer {
  return Buffer.concat([Buffer.from('papercusp/pot-git-hello:v1:'), topic]);
}

// TEMP debug trace (WI-3583 diagnosis) — writes to a file, NOT console.error,
// because this repo's vitest setup (vitest-fail-on-console) fails any test
// that calls console.error, which a raw debug log would trip. Gated on its
// OWN env var (HGDIALDEBUG), deliberately DECOUPLED from serve-wiring.ts's
// HGDEBUG (which still drives raw console.error there) — turning this on
// alone must not also trip serve-wiring.ts's console.error tracing and
// self-sabotage the very test being debugged. To be removed once the root
// cause is confirmed & the fix lands.
function dbg(...args: unknown[]): void {
  if (!process.env.HGDIALDEBUG) return;
  try {
    appendFileSync('/tmp/hgdial-trace.log', `${new Date().toISOString()} ${JSON.stringify(args)}\n`);
  } catch {
    /* best-effort */
  }
}

export const POT_GIT_HELLO_PROTOCOL = 'papercusp/pot-git-hello';

// ─── wire frame ────────────────────────────────────────────────────────────

interface HelloFrame {
  device_pubkey: string;
  /** Raw 64-byte Ed25519 signature over `helloSignContext(topic)`, proving
   *  possession of `device_pubkey`'s private key (WI-3641). */
  signature: Buffer;
}

const helloEncoding: CompactEncoding<HelloFrame> = {
  preencode(state, v) {
    c.string.preencode(state, v.device_pubkey);
    c.buffer.preencode(state, v.signature);
  },
  encode(state, v) {
    c.string.encode(state, v.device_pubkey);
    c.buffer.encode(state, v.signature);
  },
  decode(state) {
    const device_pubkey = c.string.decode(state);
    const signature = c.buffer.decode(state);
    return { device_pubkey, signature };
  },
};

// ─── registry: topicHex -> devicePubkeyBase64 -> live socket ──────────────
// Only ever populated from a SIGNATURE-VERIFIED hello (see handleHello) —
// never a bare claim.

const registryByTopic = new Map<string, Map<string, unknown>>();

function registryFor(topicHex: string): Map<string, unknown> {
  let m = registryByTopic.get(topicHex);
  if (!m) {
    m = new Map();
    registryByTopic.set(topicHex, m);
  }
  return m;
}

/** Reverse index: socket -> the VERIFIED remote device_pubkey bound to it (one
 *  per socket — a connection is one peer). Populated/cleared alongside
 *  `registryByTopic`. This is what `resolveVerifiedDevicePubkeyForSocket`
 *  (serve-wiring.ts's WI-3641 consumer) reads: "which device, if any, has
 *  PROVEN it owns this specific live connection". */
const verifiedDeviceBySocket = new WeakMap<object, string>();

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
  /** Signer for `selfDevicePubkeyBase64`'s private key — set alongside it by
   *  `wireHiveGitDial`. Null until then (channel materialized early by the
   *  lazy `pair()` notifier), matching `selfDevicePubkeyBase64`'s own gate in
   *  `maybeSendHello`. */
  sign: ((bytes: Buffer) => Promise<Buffer> | Buffer) | null;
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
const potGitDialPairedMuxers = new WeakSet<object>();

function newState(): ChannelState {
  return {
    channel: null,
    hello: null,
    opened: false,
    openedWaiters: [],
    selfDevicePubkeyBase64: null,
    sign: null,
    helloSent: false,
    remoteDevicePubkey: null,
    localSocket: null,
  };
}

function maybeSendHello(state: ChannelState, topic: Buffer): void {
  dbg('maybeSendHello', {
    opened: state.opened,
    helloSent: state.helloSent,
    hasSelf: !!state.selfDevicePubkeyBase64,
    hasSign: !!state.sign,
    hasHello: !!state.hello,
    self: state.selfDevicePubkeyBase64?.slice(0, 8),
  });
  if (!state.opened || state.helloSent || !state.selfDevicePubkeyBase64 || !state.sign || !state.hello) return;
  // Mark sent BEFORE the async sign resolves — a second `maybeSendHello` call
  // racing in (onopen firing while register() is still mid-flight, or vice
  // versa) must not send two hellos on the same channel.
  state.helloSent = true;
  const self = state.selfDevicePubkeyBase64;
  const sign = state.sign;
  void (async () => {
    try {
      const signature = await sign(helloSignContext(topic));
      state.hello?.send({ device_pubkey: self, signature });
      dbg('hello sent OK', { self: self.slice(0, 8) });
    } catch (e) {
      dbg('hello send THREW', { err: String(e) });
    }
  })();
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
  dbg('[HGDEBUG-dial] ensureChannel: calling createChannel', { topicHex });
  const channel: ProtomuxChannel | null = mux.createChannel({
    protocol: POT_GIT_HELLO_PROTOCOL,
    id: topic,
    onopen: () => {
      dbg('[HGDEBUG-dial] onopen fired', { topicHex });
      state!.opened = true;
      const waiters = state!.openedWaiters.splice(0);
      for (const w of waiters) w();
      maybeSendHello(state!, topic);
    },
    onclose: () => {
      dbg('[HGDEBUG-dial] onclose fired', { topicHex });
      if (state!.remoteDevicePubkey) registryFor(topicHex).delete(state!.remoteDevicePubkey);
      if (state!.localSocket && typeof state!.localSocket === 'object') {
        verifiedDeviceBySocket.delete(state!.localSocket as object);
      }
    },
  });
  dbg('[HGDEBUG-dial] createChannel returned', { topicHex, channel: !!channel });
  if (!channel) {
    // Defensive: a (protocol,id) collision on this muxer (shouldn't happen —
    // POT_GIT_HELLO_PROTOCOL is private to this module). Fail soft rather
    // than throw, same contract as serve-wiring.ts's ensureChannel.
    return state;
  }
  state.channel = channel;
  state.hello = channel.addMessage<HelloFrame>({
    encoding: helloEncoding,
    onmessage: (v) => {
      dbg('[HGDEBUG-dial] hello received', { topicHex, from: v.device_pubkey.slice(0, 8), hasLocalSocket: !!state!.localSocket });
      // WI-3641: verify possession of `v.device_pubkey`'s private key BEFORE
      // trusting/registering anything — an unsigned or badly-signed hello is
      // dropped exactly like a not-yet-arrived one (fail soft, never throws;
      // the registry simply stays "not resolvable" for the claimed device).
      if (!verifyEd25519(helloSignContext(topic), v.device_pubkey, v.signature)) {
        dbg('[HGDEBUG-dial] hello signature INVALID — dropping', { topicHex, from: v.device_pubkey.slice(0, 8) });
        return;
      }
      state!.remoteDevicePubkey = v.device_pubkey;
      // `localSocket` is set by `wireHiveGitDial`'s register() — normally
      // already populated by the time a peer's hello arrives (both run at
      // connection-open time), but if a hello genuinely races ahead of it,
      // fail soft (drop this hello) rather than register a `null` socket;
      // the registry then simply stays "not yet resolvable" for this device,
      // matching every other not-connected-yet case.
      if (state!.localSocket) {
        registryFor(topicHex).set(v.device_pubkey, state!.localSocket);
        if (typeof state!.localSocket === 'object') {
          verifiedDeviceBySocket.set(state!.localSocket as object, v.device_pubkey);
        }
      }
    },
  });
  channel.open();
  dbg('[HGDEBUG-dial] channel.open() called', { topicHex });
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
  if (!potGitDialPairedMuxers.has(mux as unknown as object)) {
    potGitDialPairedMuxers.add(mux as unknown as object);
    try {
      mux.pair({ protocol: POT_GIT_HELLO_PROTOCOL }, (id: Buffer | null) => {
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
 * Register this connection on the pot-git dial-hello channel for `topic`:
 * announce OUR device_pubkey to the peer and learn THEIRS. Fire-and-forget,
 * NEVER throws (mirrors `wireHiveGitServe`'s contract) — a wiring bug here
 * must never crash the shared swarm connection handler. Call once per
 * connection, alongside `wireHiveGitServe` / `openAnnounceChannel`.
 */
export function wireHiveGitDial(
  socket: unknown,
  topic: Buffer,
  selfDevicePubkeyBase64: string,
  sign: (bytes: Buffer) => Promise<Buffer> | Buffer,
): void {
  try {
    dbg('[HGDEBUG-dial] wireHiveGitDial called', { self: selfDevicePubkeyBase64.slice(0, 8) });
    const { mux, opened } = resolveMuxStream(socket);
    dbg('[HGDEBUG-dial] resolved mux', { hasOpened: !!opened });
    const register = (): void => {
      try {
        dbg('[HGDEBUG-dial] register() running');
        const state = ensureChannel(mux, topic);
        state.selfDevicePubkeyBase64 = selfDevicePubkeyBase64;
        state.sign = sign;
        state.localSocket = socket;
        // `onopen` may already have fired (the channel was materialized
        // early by the lazy `pair()` notifier in `resolveMuxStream`, before
        // this register() ran) — send now if so; otherwise `onopen` itself
        // calls `maybeSendHello` once it fires.
        maybeSendHello(state, topic);
        dbg('[HGDEBUG-dial] register() done', { opened: state.opened, helloSent: state.helloSent });
      } catch (e) {
        dbg('[HGDEBUG-dial] register() threw', e);
        /* best-effort */
      }
    };
    if (opened && typeof opened.then === 'function') void opened.then(register, register);
    else register();
  } catch (e) {
    dbg('[HGDEBUG-dial] wireHiveGitDial threw', e);
    /* best-effort — dial registration is additive, never breaks the swarm connection */
  }
}

/** Resolve the live socket for `devicePubkeyBase64` on `topic`'s hive, or
 *  `undefined` when no connection has completed the hello handshake with that
 *  device yet (not connected / connection dropped / hello still in flight —
 *  all indistinguishable from "no live dial path right now"). */
export function resolvePotGitPeerSocket(topic: Buffer, devicePubkeyBase64: string): unknown | undefined {
  return registryByTopic.get(topic.toString('hex'))?.get(devicePubkeyBase64);
}

/**
 * WI-3641: the VERIFIED device_pubkey bound to `socket` (this specific live
 * connection), or `undefined` if no signature-verified hello has been
 * received on it yet (not connected via pot-git-hello at all, hello still
 * in flight, or a forged hello was dropped — all indistinguishable from "not
 * verified", matching this module's fail-soft contract throughout). This is
 * the one thing safe to feed an authorization decision (e.g.
 * serve-wiring.ts's scope-repo gate) — never the wire-level `req` frame's
 * self-reported `peerGithubUserId`, which nothing here verifies.
 */
export function resolveVerifiedDevicePubkeyForSocket(socket: unknown): string | undefined {
  if (typeof socket !== 'object' || socket === null) return undefined;
  return verifiedDeviceBySocket.get(socket);
}

/**
 * Build (or fail soft) a live fetch Duplex to `devicePubkeyBase64` on
 * `topic`'s pot-git channel — the real cross-machine `openDuplex` seam
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
  const socket = resolvePotGitPeerSocket(topic, devicePubkeyBase64);
  if (!socket) {
    const d = new Duplex({
      read() {
        /* no data — destroyed below */
      },
      write(_chunk, _enc, cb) {
        cb();
      },
    });
    // Fail-soft contract (see file header): callers check `.destroyed`, they
    // never `.on('error', ...)` — so swallow the destroy-time error here.
    // Without this, `.destroy(err)` with no attached 'error' listener
    // schedules an UNHANDLED 'error' emission on the next tick (a genuine
    // Node stream footgun, not test-only — it would just as surely surface
    // in production as an uncaught exception on the process).
    d.on('error', () => {
      /* fail-soft: caller reads `.destroyed`, never the error event */
    });
    d.destroy(new Error(`pot-git: no live connection to device ${devicePubkeyBase64.slice(0, 12)}…`));
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
