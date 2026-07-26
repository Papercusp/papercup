/**
 * pot-git/serve-wiring.ts — wires `serveUploadPack` (fetch-transport.ts, G-2)
 * onto the shared per-harness Hyperswarm connection, so a peer member can
 * fetch this device's namespace over the `papercusp/pot-git` Protomux channel
 * (P-201, p2p-git-live-activation-2026-07-09). Until this module, the channel
 * was documented (fetch-transport.ts's header) but had no live caller — every
 * fetch ran over a plain test socket pair.
 *
 * WHY A NEW MODULE (not just calling serveUploadPack from the connection
 * handler directly): Protomux channels are MESSAGE-based, not a raw byte
 * duplex — `addMessage({ encoding, onmessage })` sends/receives one discrete
 * frame at a time. `serveUploadPack`/`fetchOverDuplex` need a `node:stream`
 * `Duplex` to pipe a `git upload-pack`/`git fetch` child process's stdio
 * through. So this module MULTIPLEXES many concurrent logical fetch duplexes
 * over ONE Protomux channel per (muxer, hive topic) — mirroring the announce
 * channel's per-(muxer,topic) uniqueness (swarm.ts's `openAnnounceChannel`)
 * but framing REQUEST / DATA / END / REFUSE messages keyed by a per-fetch id
 * instead of one flat gossip frame.
 *
 * Wire shape — SIX message slots on ONE channel (compact-encoding, not JSON:
 * a git pack is binary and can run tens of MB; JSON/base64 would double the
 * bytes on the wire). Both peers construct the channel with these `addMessage`
 * calls in this EXACT order so the wire `type` indices line up (protomux
 * assigns `type` by call order, per-channel):
 *   0 req          { id, repoKey, peerGithubUserId } — open a logical fetch (requester → server)
 *   1 refuse        { id, reason }                    — server refused a req (server → requester)
 *   2 dataToServer  { id, chunk }                      — requester's outgoing bytes (client → server)
 *   3 dataToClient  { id, chunk }                      — server's response bytes (server → client)
 *   4 endToServer   { id, code }                       — requester's write side ended
 *   5 endToClient   { id, code }                       — server's write side ended
 *
 * Every message type is scoped to exactly one role's usage (e.g. `dataToServer`
 * always means "bytes flowing INTO whoever is serving id"), so ids only need to
 * be unique within each PEER's own outgoing-request set — no cross-peer id
 * coordination, and no ambiguity if both peers happen to pick the same id for
 * unrelated requests.
 *
 * SERVER side ({@link wireHiveGitServe}): on `req`, re-checks `hiveGit.mode`
 * (S-5: NEVER cached, so a mode flip needs no re-seed — mirrors
 * git-sync-action's per-tick re-consult of the same setting) and resolves the
 * repo path for `(potHomeSlug, repoKey)` — a `scope:`-prefixed repoKey
 * (`scope-repo.ts`'s `scopeRepoWireKey`/`parseScopeRepoWireKey`) resolves via
 * `scopeRepoPath` instead of the plain `hiveGitRepoPath` join, since a
 * `scopes/<owner>/<slug>.git` path has more path components than a single
 * wire repoKey token can address otherwise. A legacy-mode hive always REFUSEs —
 * no bytes are ever served, so legacy hives are byte-for-byte unchanged. Scope
 * (`scopes/`) repos call `authorizeScopeRepoServe` (scope-serve-gate.ts),
 * which needs a roster-VERIFIED peer identity — never the wire `req` frame's
 * self-reported `peerGithubUserId` (that field is NOT authenticated by
 * anything and a hostile peer could set it to any value). WI-3641: the
 * verified identity comes from `config.resolvePeerDevicePubkey(socket)` — a
 * caller-supplied resolver (swarm.ts wires `resolveVerifiedDevicePubkeyForSocket`
 * from peer-dial-registry.ts's SIGNED hello handshake) that answers "which
 * device, if any, has cryptographically PROVEN it owns this live connection".
 * No resolver, or no verified device on this socket yet ⇒ refuse — serving
 * unauthenticated would be worse than not serving at all.
 *
 * CLIENT side ({@link openHiveGitFetchDuplex}): sends `req`, returns a Duplex
 * the caller drives with `fetchOverDuplex` — the SAME `openDuplex: () =>
 * Promise<Duplex>` seam every downstream consumer already expects
 * (worktree-bridge.ts, github-bridge-tick via the integrator). A `refuse` or a
 * channel/connection loss destroys the duplex with an error; `fetchOverDuplex`
 * never throws on that (fail-soft: a broken fetch resolves nonzero).
 *
 * Fail-soft throughout: every handler is defensive (a throwing peer frame, a
 * missing session, a wiring failure) and NEVER crashes the shared swarm
 * connection handler — same contract as `openAnnounceChannel`.
 */
import { Duplex } from 'node:stream';
import { join } from 'node:path';
import Protomux, { type ProtomuxChannel } from 'protomux';
import c, { type CompactEncoding, type CompactEncodingState } from 'compact-encoding';
import { getPotGitMode, type PotGitMode } from '../../harness/git-sync/hive-git-mode';
import { hiveGitRepoPath, pathExists } from './storage';
import { isScopeRepoFamilyPath, parseScopeRepoWireKey, scopeRepoPath } from './scope-repo';
import { POT_GIT_PROTOCOL, serveUploadPack } from './fetch-transport';
import { authorizeScopeRepoServe, type ScopeRepoServeGrant } from './scope-serve-gate';
import { getScopeRoster } from '../../p2p/scope-roster';
import { resolveGithubUserIdForDevicePubkey } from '../hyperbee/hive-member-identity-set';

export { POT_GIT_PROTOCOL };

/** Config registered by {@link wireHiveGitServe} — what this connection may serve. */
export interface PotGitServeConfig {
  /** The hive this connection's swarm topic belongs to (repos are resolved
   *  under it — `hiveGitRepoPath(potHomeSlug, repoKey)`). */
  potHomeSlug: string;
  workspaceId: string;
  /** Per-fetch wall-clock ceiling forwarded to `serveUploadPack` (default
   *  DEFAULT_FETCH_TIMEOUT_MS — see fetch-transport.ts). */
  timeoutMs?: number;
  /**
   * WI-3641: resolve the SIGNATURE-VERIFIED device_pubkey bound to a live
   * connection socket, or `undefined` if none has been verified on it yet.
   * Required to authorize a `scopes/` repo fetch — swarm.ts wires
   * `resolveVerifiedDevicePubkeyForSocket` (peer-dial-registry.ts's signed
   * hello handshake) here. Omitted ⇒ every scope-repo fetch refuses
   * (`scope-repo-no-resolver`) — fail-closed, matching the pre-WI-3641
   * deferral's behavior when this config is absent.
   */
  resolvePeerDevicePubkey?: (socket: unknown) => string | undefined;
}

// ─── wire frames ─────────────────────────────────────────────────────────

interface ReqFrame {
  id: number;
  repoKey: string;
  peerGithubUserId: number;
}
interface RefuseFrame {
  id: number;
  reason: string;
}
interface DataFrame {
  id: number;
  chunk: Buffer;
}
interface EndFrame {
  id: number;
  code: number;
}

const reqEncoding: CompactEncoding<ReqFrame> = {
  preencode(state, v) {
    c.uint.preencode(state, v.id);
    c.string.preencode(state, v.repoKey);
    c.uint.preencode(state, v.peerGithubUserId);
  },
  encode(state, v) {
    c.uint.encode(state, v.id);
    c.string.encode(state, v.repoKey);
    c.uint.encode(state, v.peerGithubUserId);
  },
  decode(state) {
    const id = c.uint.decode(state);
    const repoKey = c.string.decode(state);
    const peerGithubUserId = c.uint.decode(state);
    return { id, repoKey, peerGithubUserId };
  },
};

const refuseEncoding: CompactEncoding<RefuseFrame> = {
  preencode(state, v) {
    c.uint.preencode(state, v.id);
    c.string.preencode(state, v.reason);
  },
  encode(state, v) {
    c.uint.encode(state, v.id);
    c.string.encode(state, v.reason);
  },
  decode(state) {
    const id = c.uint.decode(state);
    const reason = c.string.decode(state);
    return { id, reason };
  },
};

const dataEncoding: CompactEncoding<DataFrame> = {
  preencode(state, v) {
    c.uint.preencode(state, v.id);
    c.buffer.preencode(state, v.chunk);
  },
  encode(state, v) {
    c.uint.encode(state, v.id);
    c.buffer.encode(state, v.chunk);
  },
  decode(state) {
    const id = c.uint.decode(state);
    const chunk = c.buffer.decode(state);
    return { id, chunk };
  },
};

const endEncoding: CompactEncoding<EndFrame> = {
  preencode(state, v) {
    c.uint.preencode(state, v.id);
    c.int.preencode(state, v.code);
  },
  encode(state, v) {
    c.uint.encode(state, v.id);
    c.int.encode(state, v.code);
  },
  decode(state) {
    const id = c.uint.decode(state);
    const code = c.int.decode(state);
    return { id, code };
  },
};

// ─── the per-fetch Duplex adapter ───────────────────────────────────────

/** One logical fetch stream, framed over the shared channel. Default
 *  `allowHalfOpen: true` (node's Duplex default) is load-bearing: ending our
 *  WRITE side must not also end our READ side — a git pack negotiation is
 *  asymmetric (the requester's write side legitimately ends well before the
 *  server's response finishes), exactly mirroring `fetchOverDuplex`'s own
 *  `allowHalfOpen` socket-pair contract. */
class FrameDuplex extends Duplex {
  constructor(
    private readonly sendChunk: (chunk: Buffer) => void,
    private readonly onLocalEnd: (code: number) => void,
  ) {
    super();
    // Fail-soft AT CONSTRUCTION (WI-5177 live crash, 2026-07-17): this module's
    // contract is that consumers read `.destroyed`, and a refusal/close can
    // destroy(err) this duplex at ANY moment — including the gap before a
    // consumer attaches its own 'error' listener (bootstrap.ts awaits between
    // openDuplex and fetchOverDuplex). With no listener, that destroy(err)
    // becomes an unhandled 'error' → process-fatal uncaughtException (took the
    // bg-host down: "pot-git serve refused: no-such-repo"). A no-op base
    // listener makes every FrameDuplex safe; consumers' own listeners still
    // fire alongside it.
    this.on('error', () => {
      /* fail-soft: consumers read `.destroyed` / attach their own listener */
    });
  }
  override _write(chunk: Buffer, _enc: string, cb: (e?: Error | null) => void): void {
    try {
      this.sendChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    } catch (e) {
      cb(e instanceof Error ? e : new Error(String(e)));
    }
  }
  override _read(): void {
    /* push-driven from inbound frames — nothing to pull here */
  }
  override _final(cb: (e?: Error | null) => void): void {
    try {
      this.onLocalEnd(0);
    } catch {
      /* best-effort — a dropped connection must not throw out of _final */
    }
    cb();
  }
  override _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
    cb(err);
  }
  /** Deliver an inbound DATA frame's bytes to the readable side. */
  pushChunk(chunk: Buffer): void {
    this.push(chunk);
  }
  /** Deliver an inbound END frame — EOF on the readable side (half-open: the
   *  writable side is untouched). */
  pushEnd(): void {
    this.push(null);
  }
}

// ─── per-(muxer, topic) channel state ───────────────────────────────────

interface ChannelMessages {
  req: { send(v: ReqFrame): void };
  refuse: { send(v: RefuseFrame): void };
  dataToServer: { send(v: DataFrame): void };
  dataToClient: { send(v: DataFrame): void };
  endToServer: { send(v: EndFrame): void };
  endToClient: { send(v: EndFrame): void };
}

interface ChannelState {
  channel: ProtomuxChannel | null;
  messages: ChannelMessages | null;
  opened: boolean;
  openedWaiters: Array<() => void>;
  /** Set by `wireHiveGitServe` — null means "not registered to serve on this
   *  connection" (an inbound req refuses `not-serving`, never crashes). */
  serverConfig: PotGitServeConfig | null;
  /** WI-3641: the raw connection socket `wireHiveGitServe` was called with —
   *  threaded through so `handleReq` can resolve the caller's verified device
   *  identity via `serverConfig.resolvePeerDevicePubkey(socket)` for the
   *  `scopes/` repo gate. Null until `wireHiveGitServe` registers. */
  socket: unknown;
  /** Sessions where WE are the server (id allocated by the peer's req). */
  serverSessions: Map<number, FrameDuplex>;
  /** Sessions where WE are the requester (id allocated by us). */
  clientSessions: Map<number, FrameDuplex>;
  nextClientId: number;
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

/** Per-(muxer, topic) serve registration that SURVIVES the onclose eviction in
 *  `ensureChannel` (WI-3496/WI-5177 drill): `wireHiveGitServe` runs once per
 *  connection, so a channel re-created after a close (or materialized by the
 *  lazy `pair()` notifier) would otherwise have `serverConfig` null forever and
 *  refuse every inbound req `not-serving`. */
const serveConfigByMuxer = new WeakMap<object, Map<string, { serverConfig: PotGitServeConfig; socket: unknown }>>();

function serveConfigsFor(mux: object): Map<string, { serverConfig: PotGitServeConfig; socket: unknown }> {
  let m = serveConfigByMuxer.get(mux);
  if (!m) {
    m = new Map();
    serveConfigByMuxer.set(mux, m);
  }
  return m;
}

/** Muxers on which the lazy-accept `pair()` notifier (below) is already
 *  registered — pair() is idempotent to call twice, but this avoids
 *  redundant re-registration on every `resolveMuxStream` call. */
const potGitPairedMuxers = new WeakSet<object>();

function newState(): ChannelState {
  return {
    channel: null,
    messages: null,
    opened: false,
    openedWaiters: [],
    serverConfig: null,
    socket: null,
    serverSessions: new Map(),
    clientSessions: new Map(),
    nextClientId: 1,
  };
}

function markOpened(state: ChannelState): void {
  state.opened = true;
  const waiters = state.openedWaiters.splice(0);
  for (const w of waiters) w();
}

function waitOpened(state: ChannelState): Promise<void> {
  return state.opened ? Promise.resolve() : new Promise((resolve) => state.openedWaiters.push(resolve));
}

/** A dropped/closed connection fails every in-flight session loudly (destroy,
 *  never a silent hang) — `fetchOverDuplex`/`serveUploadPack` both treat a
 *  destroyed duplex as a failed (nonzero) result, never a thrown exception. */
function failAllSessions(state: ChannelState): void {
  for (const d of state.serverSessions.values()) d.destroy(new Error('pot-git: serve channel closed'));
  for (const d of state.clientSessions.values()) d.destroy(new Error('pot-git: serve channel closed'));
  state.serverSessions.clear();
  state.clientSessions.clear();
}

// ─── WI-6184: serve-side observability ──────────────────────────────────
// Before this, the ENTIRE serving half of the p2p-git plane was silent: an
// inbound fetch that was refused, that threw, or that served a pack left no
// trace on this machine. A peer whose clone hung for the full 120s ceiling
// therefore had nothing to report and we had nothing to read — the documented
// cause of five stalled diagnosis wakes (git-sync-action.ts:1746-1757).
//
// Deliberately NOT env-gated: this is release-grade observability, not a debug
// trace. Volume is controlled instead — a served pack is rare and always logged,
// while REFUSALS (which a misconfigured or looping peer can generate steadily)
// are aggregated per reason, never emitted per event.
const REFUSE_LOG_WINDOW_MS = 30_000;
const refuseLogLast = new Map<string, { at: number; suppressed: number }>();

/** Emit a plane diagnostic. Suppressed under vitest — the repo runs
 *  `vitest-fail-on-console`, so an unconditional diagnostic would fail every
 *  suite that exercises a refusal path (live-caught: serve-wiring's 3 refusal
 *  tests). Same guard swarm.ts's data-path sampler uses for the same reason. */
function potGitLog(level: 'info' | 'warn', msg: string): void {
  if (process.env.VITEST) return;
  if (level === 'warn') console.warn(msg);
  else console.info(msg);
}

/** True when this refusal should be logged now; folds any suppressed repeats
 *  from the current window into the returned count so a storm reports as one
 *  line with a tally instead of N lines. */
function shouldLogRefusal(key: string, now: number): { log: boolean; suppressed: number } {
  const prev = refuseLogLast.get(key);
  if (prev && now - prev.at < REFUSE_LOG_WINDOW_MS) {
    prev.suppressed++;
    return { log: false, suppressed: prev.suppressed };
  }
  const suppressed = prev?.suppressed ?? 0;
  refuseLogLast.set(key, { at: now, suppressed: 0 });
  // Bound the map: these keys are (reason, repoKey, peer) tuples, so a hostile
  // peer varying repoKey could otherwise grow it without limit.
  if (refuseLogLast.size > 512) {
    for (const [k, e] of refuseLogLast) {
      if (now - e.at >= REFUSE_LOG_WINDOW_MS) refuseLogLast.delete(k);
      if (refuseLogLast.size <= 256) break;
    }
  }
  return { log: true, suppressed };
}

/** Short, log-safe tag for the peer that opened this serve session. Uses the
 *  SIGNATURE-VERIFIED device identity where one exists (never the wire frame's
 *  self-reported fields) so the tag can be trusted in a forensic read. */
function peerTag(state: ChannelState): string {
  try {
    const pk = state.serverConfig?.resolvePeerDevicePubkey?.(state.socket);
    return pk ? pk.slice(0, 8) : 'unverified';
  } catch {
    return 'unverified';
  }
}

function handleReq(state: ChannelState, v: ReqFrame): void {
  const startedAt = Date.now();
  const refuse = (reason: string): void => {
    try {
      state.messages?.refuse.send({ id: v.id, reason });
    } catch {
      /* best-effort */
    }
    const { log, suppressed } = shouldLogRefusal(`${reason} ${v.repoKey} ${peerTag(state)}`, Date.now());
    if (log) {
      potGitLog(
        'warn',
        `[pot-git] serve REFUSED reason=${reason} repo=${v.repoKey} peer=${peerTag(state)} id=${v.id}` +
          (suppressed > 0 ? ` (+${suppressed} identical suppressed in the last ${REFUSE_LOG_WINDOW_MS / 1000}s)` : ''),
      );
    }
  };
  void (async () => {
    const cfg = state.serverConfig;
    if (!cfg) return refuse('not-serving');
    let mode: PotGitMode;
    try {
      mode = await getPotGitMode(cfg.workspaceId, cfg.potHomeSlug);
    } catch {
      mode = 'legacy';
    }
    if (mode === 'legacy') return refuse('mode-legacy');
    // WI-3641: a `scope:`-prefixed wire repoKey (scopeRepoWireKey) addresses a
    // `scopes/` family repo — hiveGitRepoPath's single-path-component join can
    // never itself PRODUCE a `scopes/<owner>/<slug>.git` path (that's 2
    // components below potHomeSlug), so scope-family requests are resolved via
    // scopeRepoPath directly instead. A malformed scope segment refuses
    // (fail-closed) rather than falling through to the plain-repo path.
    let repoPath: string;
    const wireScopeId = parseScopeRepoWireKey(v.repoKey);
    if (wireScopeId) {
      repoPath = scopeRepoPath(cfg.potHomeSlug, wireScopeId);
    } else {
      try {
        repoPath = hiveGitRepoPath(cfg.potHomeSlug, v.repoKey);
      } catch {
        return refuse('bad-repo-key');
      }
    }
    // WI-3641: the grant `fetch-transport.ts`'s `assertScopeServeAuthorized`
    // backstop DEMANDS for any scopes/-family repoPath — computed here (never
    // skippable: every branch below fails closed) and threaded into
    // `serveUploadPack`'s `scopeServeGrant` option below. Without passing it
    // through, the backstop throws for EVERY scope-repo serve regardless of
    // this gate's decision (a real gap: the gate ran but its answer never
    // reached the enforcement point) — undefined here only for a non-scope
    // repoPath, where the backstop is a no-op anyway.
    let scopeServeGrant: ScopeRepoServeGrant | undefined;
    if (isScopeRepoFamilyPath(repoPath)) {
      // WI-3641: authorize via the roster serve-gate, keyed by the caller's
      // SIGNATURE-VERIFIED device identity (never the wire `req` frame's
      // self-reported `peerGithubUserId` — see module header). Every branch
      // below fails closed: no resolver, no verified device, an unresolvable
      // member, or a roster refusal all refuse rather than serve.
      const devicePubkey = cfg.resolvePeerDevicePubkey?.(state.socket);
      if (!devicePubkey) return refuse('scope-repo-no-verified-peer');
      let githubUserId: number | null;
      try {
        githubUserId = await resolveGithubUserIdForDevicePubkey(
          cfg.workspaceId,
          cfg.potHomeSlug,
          devicePubkey,
        );
      } catch {
        return refuse('scope-repo-member-lookup-error');
      }
      if (githubUserId == null) return refuse('scope-repo-unknown-device');
      const roster = getScopeRoster({ workspaceId: cfg.workspaceId, potSlug: cfg.potHomeSlug });
      const decision = await authorizeScopeRepoServe({
        repoPath,
        peerGithubUserId: githubUserId,
        isScopeMember: roster.predicate,
      });
      if (!decision.ok) return refuse(`scope-repo:${decision.refusal.reason}`);
      scopeServeGrant = decision.grant;
    }
    // EI-8863/WI-3643 finding (su-95401d6d's handoff): an unknown-but-validly
    // NAMED repoKey (no traversal, no unsafe chars — so hiveGitRepoPath above
    // never throws) resolves to a path that simply doesn't exist on disk.
    // Without this check, `serveUploadPack` below spawns a REAL `git
    // upload-pack --strict <nonexistent path>` — which does not fail fast:
    // it stalls in the protocol handshake instead of erroring immediately,
    // so the requester never gets a refuse (or any bytes at all) and just
    // sits until ITS OWN ceiling timer fires (serve-wiring.integration.test.ts's
    // "refuses an unknown repoKey" case: ~15s wall time, vs <100ms for every
    // other refusal path). Check existence up front and refuse loudly —
    // matches the fail-fast contract every other refusal reason already gets.
    if (!(await pathExists(join(repoPath, 'HEAD')))) {
      return refuse('no-such-repo');
    }
    const duplex = new FrameDuplex(
      (chunk) => state.messages?.dataToClient.send({ id: v.id, chunk }),
      (code) => {
        try {
          state.messages?.endToClient.send({ id: v.id, code });
        } catch {
          /* best-effort */
        }
      },
    );
    state.serverSessions.set(v.id, duplex);
    try {
      const res = await serveUploadPack(repoPath, duplex, { timeoutMs: cfg.timeoutMs, scopeServeGrant });
      // WI-6184: the one line that says a real fetch was served, and how it
      // ended. `code === 0` is the success signal; timedOut distinguishes "the
      // requester went away / upload-pack wedged" from a clean nonzero exit.
      const ms = Date.now() - startedAt;
      const detail =
        `repo=${v.repoKey} peer=${peerTag(state)} id=${v.id} code=${res.code}` +
        `${res.timedOut ? ' timedOut=true' : ''} ${ms}ms`;
      if (res.code === 0) potGitLog('info', `[pot-git] serve OK ${detail}`);
      else potGitLog('warn', `[pot-git] serve FAILED ${detail} stderr=${res.stderr.trim().slice(0, 300)}`);
    } finally {
      state.serverSessions.delete(v.id);
    }
  })().catch((e) => {
    // A bad/hostile request must never crash the shared channel — but it must
    // never SILENTLY STARVE the requester either. This catch used to swallow
    // the error with no frame sent, so any throw above (a wedged `pathExists`,
    // an unexpected `serveUploadPack` failure) left the peer with no refuse and
    // no end: it then hung its FULL 120s fetch ceiling and reported a bare
    // ":failed" with no reason — indistinguishable from a dead transport, and
    // exactly the signature seen on the 2-machine rig. Tell the requester so it
    // fails fast (its `duplex.on('error')` resolves immediately), and say so
    // here so the failing side is diagnosable on THIS machine.
    try {
      state.messages?.refuse.send({ id: v.id, reason: 'serve-error' });
    } catch {
      /* best-effort — the channel may already be gone */
    }
    potGitLog(
      'warn',
      `[pot-git] serve ERROR repo=${v.repoKey} peer=${peerTag(state)} id=${v.id}` +
        ` after ${Date.now() - startedAt}ms: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    );
  });
}

function handleRefuse(state: ChannelState, v: RefuseFrame): void {
  const d = state.clientSessions.get(v.id);
  if (!d) return;
  state.clientSessions.delete(v.id);
  d.destroy(new Error(`pot-git serve refused: ${v.reason}`));
}
function handleDataToServer(state: ChannelState, v: DataFrame): void {
  state.serverSessions.get(v.id)?.pushChunk(v.chunk);
}
function handleDataToClient(state: ChannelState, v: DataFrame): void {
  state.clientSessions.get(v.id)?.pushChunk(v.chunk);
}
function handleEndToServer(state: ChannelState, v: EndFrame): void {
  state.serverSessions.get(v.id)?.pushEnd();
}
function handleEndToClient(state: ChannelState, v: EndFrame): void {
  const d = state.clientSessions.get(v.id);
  if (!d) return;
  d.pushEnd();
  state.clientSessions.delete(v.id);
}

/** Get-or-create the channel + its six message slots for (mux, topic).
 *  Idempotent per muxer (both `wireHiveGitServe` and `openHiveGitFetchDuplex`
 *  share the SAME channel via this). */
function ensureChannel(mux: Protomux, topic: Buffer): ChannelState {
  const states = statesFor(mux as unknown as object);
  const topicHex = topic.toString('hex');
  let state = states.get(topicHex);
  if (state) return state;
  state = newState();
  states.set(topicHex, state);
  // Seed from the muxer-level serve config (see serveConfigByMuxer): a channel
  // re-created after the onclose eviction below — or materialized by the lazy
  // `pair()` notifier before `wireHiveGitServe`'s register() ran — must still
  // serve; `wireHiveGitServe` runs once per connection and never back-fills.
  const kept = serveConfigByMuxer.get(mux as unknown as object)?.get(topicHex);
  if (kept) {
    state.serverConfig = kept.serverConfig;
    state.socket = kept.socket;
  }
  const channel = mux.createChannel({
    protocol: POT_GIT_PROTOCOL,
    id: topic,
    onopen: () => {
      markOpened(state!);
    },
    onclose: () => {
      failAllSessions(state!);
      // WI-3496/WI-5177 drill: same dead-channel-cache class as
      // peer-dial-registry.ts — a closed channel cached forever poisons this
      // (muxer, topic): our next openHiveGitFetchDuplex resolves to a dead
      // channel whose `waitOpened` NEVER resolves (the 120s-ceiling hang), and
      // the remote's re-open is protomux-REJECTED via the pair() notifier
      // resolving to the dead state. Flush waiters (callers re-check
      // `state.opened`) and evict so the next use re-creates a live channel.
      const waiters = state!.openedWaiters.splice(0);
      for (const w of waiters) w();
      if (states.get(topicHex) === state) states.delete(topicHex);
    },
  });
  if (!channel) {
    // Defensive: a (protocol,id) collision on this muxer from outside this
    // module (shouldn't happen — POT_GIT_PROTOCOL is private to it). Leave
    // `channel`/`messages` null so callers fail soft instead of throwing.
    return state;
  }
  state.channel = channel;
  state.messages = {
    req: channel.addMessage<ReqFrame>({ encoding: reqEncoding, onmessage: (v) => handleReq(state!, v) }),
    refuse: channel.addMessage<RefuseFrame>({ encoding: refuseEncoding, onmessage: (v) => handleRefuse(state!, v) }),
    dataToServer: channel.addMessage<DataFrame>({ encoding: dataEncoding, onmessage: (v) => handleDataToServer(state!, v) }),
    dataToClient: channel.addMessage<DataFrame>({ encoding: dataEncoding, onmessage: (v) => handleDataToClient(state!, v) }),
    endToServer: channel.addMessage<EndFrame>({ encoding: endEncoding, onmessage: (v) => handleEndToServer(state!, v) }),
    endToClient: channel.addMessage<EndFrame>({ encoding: endEncoding, onmessage: (v) => handleEndToClient(state!, v) }),
  };
  channel.open();
  return state;
}

/** Resolve the shared Protomux for a connection socket — corestore attaches it
 *  at `socket.noiseStream`, not always the outer Hyperswarm socket (mirrors
 *  `openAnnounceChannel`'s identical resolution in swarm.ts). */
function resolveMuxStream(socket: unknown, topic: Buffer): { mux: Protomux; opened?: Promise<unknown> } {
  const muxStream = ((socket as { noiseStream?: unknown } | null)?.noiseStream ?? socket) as {
    opened?: Promise<unknown>;
    userData?: unknown;
  };
  const mux = Protomux.from(muxStream as never);
  // WI-3583 finding (peer-dial-registry.ts, su-7b21d): `Protomux.from()`'s own
  // instance-caching only activates when `stream.userData` was already
  // strictly `null` before the FIRST call on that stream (its constructor:
  // `if (stream.userData === null) stream.userData = this`) — a bare
  // socket's `userData` starts `undefined`, so that guard silently never
  // fires. A SECOND independent wiring function calling
  // `Protomux.from(sameSocket)` (e.g. peer-dial-registry.ts's
  // `wireHiveGitDial`, wired onto the SAME connection as `wireHiveGitServe`)
  // would otherwise construct a SEPARATE Protomux instance competing to
  // parse/write the same byte stream — corrupting both channels' framing.
  // Mirrors `openAnnounceChannel`'s identical fixup in swarm.ts — whichever
  // wiring fn runs first on a socket "wins" the cache; everyone else then
  // retrieves the SAME instance via the `stream.userData.isProtomux` fast
  // path inside `Protomux.from`.
  if (!muxStream.userData) muxStream.userData = mux;
  // Close a channel-open race: if the REMOTE's "open" control message arrives
  // before OUR OWN `ensureChannel()`/`createChannel()` call runs (e.g. while a
  // caller is still `await`ing `opened` below), Protomux queues it into that
  // channel-info's `incoming` list and — with no `pair()` registered —
  // asynchronously REJECTS it (see protomux's `_requestSession`) before we
  // ever get a chance to pair. When that happens our own `onopen` never fires
  // and `waitOpened` hangs forever (the client never reaches its `req` send,
  // so the server's `handleReq` never fires either).
  //
  // Register the lazy-accept notifier at PROTOCOL scope (no `id`) — NOT
  // `{ protocol, id: topic }`. Swarm.ts's announce channel already learned
  // this the hard way (see its own `mux.pair` comment): an id-scoped pair()
  // leaves a late remote open for that id unaccepted in practice, so dispatch
  // by the `id` protomux hands the notify callback instead. `ensureChannel` is
  // keyed per-topic and idempotent, so this safely materializes (and thus
  // pairs with) whichever topic the remote just opened.
  if (!potGitPairedMuxers.has(mux)) {
    potGitPairedMuxers.add(mux);
    try {
      mux.pair({ protocol: POT_GIT_PROTOCOL }, (id: Buffer | null) => {
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

// ─── public API ──────────────────────────────────────────────────────────

/**
 * SERVER side (P-201): register this connection to serve `hiveGitServe`
 * requests for `topic`. Call once per connection alongside
 * `openAnnounceChannel` (same connection handler, same muxer) — a no-op-safe,
 * fire-and-forget, NEVER-throwing registration (mirrors `openAnnounceChannel`'s
 * contract so a wiring bug can't crash the shared swarm handler).
 */
export function wireHiveGitServe(socket: unknown, topic: Buffer, config: PotGitServeConfig): void {
  try {
    const { mux, opened } = resolveMuxStream(socket, topic);
    const register = (): void => {
      try {
        // Persist per-muxer FIRST (survives channel eviction — see
        // serveConfigByMuxer), then mirror onto the live state.
        serveConfigsFor(mux as unknown as object).set(topic.toString('hex'), { serverConfig: config, socket });
        const state = ensureChannel(mux, topic);
        state.serverConfig = config;
        state.socket = socket;
      } catch {
        /* best-effort */
      }
    };
    if (opened && typeof opened.then === 'function') {
      void opened.then(register, register);
    } else {
      register();
    }
  } catch {
    /* best-effort — pot-git serve is additive, never breaks the swarm connection */
  }
}

/**
 * CLIENT side (consumed by P-202's announce→fetch driver + worktree-bridge's
 * `openDuplex` seam): request a fetch duplex for `repoKey` from the peer on
 * the other end of `socket`'s connection, on `topic`'s pot-git channel.
 * Resolves a Duplex immediately after the request is sent (never rejects —
 * a refusal/drop destroys the returned duplex instead, matching
 * `fetchOverDuplex`'s fail-soft "never throws" contract).
 */
export async function openHiveGitFetchDuplex(
  socket: unknown,
  topic: Buffer,
  req: { repoKey: string; peerGithubUserId?: number },
): Promise<Duplex> {
  const { mux, opened } = resolveMuxStream(socket, topic);
  if (opened && typeof opened.then === 'function') await opened.catch(() => {});
  const state = ensureChannel(mux, topic);
  if (!state.channel || !state.messages) {
    const d = new FrameDuplex(
      () => {},
      () => {},
    );
    // Fail-soft: callers check `.destroyed`, they never attach 'error' — an
    // unswallowed destroy(err) becomes an uncaught exception on next tick
    // (same footgun peer-dial-registry.ts's openHiveGitDuplexToDevice fixed).
    d.on('error', () => {});
    d.destroy(new Error('pot-git: could not open the serve channel'));
    return d;
  }
  await waitOpened(state);
  if (!state.opened) {
    // The channel closed WITHOUT ever opening (remote side not wired yet —
    // protomux rejected our open; WI-3496 drill boot-order race). The onclose
    // handler evicted it, so the NEXT attempt re-creates a live channel; this
    // attempt fails soft instead of hanging to the caller's outer timeout.
    const d = new FrameDuplex(
      () => {},
      () => {},
    );
    d.on('error', () => {});
    d.destroy(new Error('pot-git: serve channel closed before opening (peer not wired yet — will retry)'));
    return d;
  }
  const messages = state.messages;
  const id = state.nextClientId++;
  const duplex = new FrameDuplex(
    (chunk) => messages.dataToServer.send({ id, chunk }),
    (code) => {
      try {
        messages.endToServer.send({ id, code });
      } catch {
        /* best-effort */
      }
    },
  );
  state.clientSessions.set(id, duplex);
  try {
    messages.req.send({ id, repoKey: req.repoKey, peerGithubUserId: req.peerGithubUserId ?? 0 });
  } catch (e) {
    state.clientSessions.delete(id);
    duplex.destroy(e instanceof Error ? e : new Error(String(e)));
  }
  return duplex;
}
