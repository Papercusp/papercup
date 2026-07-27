/**
 * pot-git/fetch-transport.ts — native git protocol-v2 fetch over an injected
 * duplex (Phase 7 G-2, cross-machine-coord-parity-and-trust-2026-07-01 / P-026,
 * D-010/D-011).
 *
 * THE decision (research doc → D-010): replicate git OBJECTS with the real git
 * wire protocol (v2 pack negotiation), NOT bundles and NEVER loose objects. Each
 * fetch is one request/response byte stream between two peers; the peer serving
 * runs `git upload-pack`, the peer fetching runs `git fetch`. This module is the
 * transport CORE, pure over an injected `Duplex`:
 *
 *   - PROD: the duplex is a PER-FETCH Protomux sub-stream on the existing hive
 *     swarm connection (the `papercusp/pot-git` channel family — wired
 *     separately, the way presence-gossip wires its chassis). One stream per
 *     fetch so it opens/closes independently of the shared socket.
 *   - TESTS: the duplex is a plain socket pair — so the whole path (real
 *     upload-pack ↔ real fetch, real pack negotiation, real bare repos) runs
 *     offline with no swarm.
 *
 * The client half cannot hand git an arbitrary fd, so it uses git's native
 * `ext::` transport: git execs `node git-ext-bridge.mjs <sock>` as the
 * connection command, and we bridge that unix socket to the caller's duplex.
 * `protocol.ext.allow=always` is required (git blocks ext by default) — safe
 * here because WE construct the command, not a remote.
 *
 * Fail-soft by contract: every path is try/catch + never-throw; a broken fetch
 * resolves with a nonzero code, never rejects (the integrator/announcement layer
 * treats a failed fetch as "try again next announce").
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import { deviceNamespaceKey, noteFetchInFlight, potGitRoot } from './storage';
import { isScopeRepoFamilyPath } from './scope-repo';
import { type ScopeRepoServeGrant, isIssuedScopeServeGrant } from './scope-serve-gate';

/** The ext:: bridge helper git execs on the client (a real on-disk node script). */
const EXT_BRIDGE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'git-ext-bridge.mjs');

/** Protomux protocol id for the per-fetch git streams (the wiring opens one
 *  channel of this protocol per in-flight fetch, keyed by the hive topic). */
export const POT_GIT_PROTOCOL = 'papercusp/pot-git';

/**
 * Default per-fetch IDLE ceiling (ms) — a fetch that moves NO bytes in either
 * direction for this long is killed, so a hostile or wedged peer can't pin a
 * stream open forever.
 *
 * ⚠ THIS IS AN IDLE TIMEOUT, NOT A WALL-CLOCK ONE (EI-18776567787336109). It
 * used to be measured from spawn, which conflated two opposite conditions:
 *
 *   - a STALLED transfer (no bytes moving)        → must die fast
 *   - a LARGE but healthy transfer (bytes flowing) → must NOT be killed
 *
 * A wall-clock ceiling makes a large pot structurally un-joinable: the tower's
 * 6.3 GB papercusp store spends well over 120 s in upload-pack's counting/
 * compressing phase alone, so EVERY cold-join fetch died at exactly 120 s while
 * warm incremental fetches finished in 100-650 ms (live, 2026-07-27: 8/8 cold
 * fetches timed out, 101/101 warm fetches succeeded). Worse, the ladder's
 * last-resort `--unshallow` rung is unbounded in size BY DESIGN, so no rung
 * size could ever have rescued it.
 *
 * Resetting the deadline on progress preserves the original anti-wedge
 * guarantee EXACTLY — no progress for this long and the child is SIGKILLed —
 * while letting a genuinely large transfer run to completion.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 120_000;

/**
 * Absolute per-fetch ceiling (ms), regardless of progress. The idle timeout
 * above is the operative guard; this one exists so a hostile peer that
 * slow-drips a byte every 119 s still cannot pin a stream open indefinitely.
 * Generous on purpose — a multi-GB cold join over a p2p link legitimately takes
 * many minutes, and killing one that is actively streaming is the exact bug
 * this module just stopped having.
 */
export const DEFAULT_FETCH_MAX_MS = 30 * 60_000;

export interface TransportResult {
  /** git process exit code (0 = success; -1 = spawn/timeout failure). */
  code: number;
  /** Captured stderr (diagnostics; never surfaced to a peer). */
  stderr: string;
  /** True when the timeout fired (the process was killed). */
  timedOut: boolean;
}

/** Guard: only ever serve upload-pack for a repo INSIDE our pot-git root — a
 *  defense-in-depth backstop so a wiring bug can't turn this into an arbitrary
 *  repo-read oracle for a peer. The (hive, repo) → path mapping already sanitizes
 *  components (storage.hiveGitRepoPath), this re-checks the resolved path. */
function assertServeableRepo(repoPath: string): void {
  const root = potGitRoot();
  if (repoPath !== root && !repoPath.startsWith(root.endsWith('/') ? root : `${root}/`)) {
    throw new Error(`pot-git: refusing to serve a repo outside the pot-git root: ${repoPath}`);
  }
}

/** §5.3 fail-closed serve gate for the per-scope repo family (P-108 / D-018
 *  option b): any path inside `<root>/<hive>/scopes/` is UNSERVABLE without a
 *  roster-verified grant from `authorizeScopeRepoServe`, bound to this exact
 *  path — so future serve wiring structurally cannot skip the membership
 *  check. Checked regardless of `allowOutsideRoot` (an out-of-root test path
 *  is not in the family, so tests are unaffected). */
function assertScopeServeAuthorized(repoPath: string, grant?: ScopeRepoServeGrant): void {
  if (!isScopeRepoFamilyPath(repoPath)) return;
  if (!grant || !isIssuedScopeServeGrant(grant) || grant.repoPath !== repoPath) {
    throw new Error(
      `pot-git: refusing to serve scope repo without a roster-verified serve grant: ${repoPath}`,
    );
  }
}

/**
 * SERVER half — serve `git upload-pack` (protocol v2) for `repoPath` over
 * `duplex`, piping duplex↔child both ways. Ends `duplex` when upload-pack exits
 * (the per-fetch stream is disposable). Resolves with the exit result; never
 * throws. `allowOutsideRoot` (tests only) skips the root guard.
 */
export function serveUploadPack(
  repoPath: string,
  duplex: Duplex,
  opts: {
    /** IDLE ceiling — reset on every byte of progress. See
     *  {@link DEFAULT_FETCH_TIMEOUT_MS}. */
    timeoutMs?: number;
    /** Absolute ceiling regardless of progress. See {@link DEFAULT_FETCH_MAX_MS}. */
    maxMs?: number;
    allowOutsideRoot?: boolean;
    /** REQUIRED for any repo in the scopes/ family (§5.3 roster serve gate). */
    scopeServeGrant?: ScopeRepoServeGrant;
  } = {},
): Promise<TransportResult> {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const idleMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const maxMs = opts.maxMs ?? DEFAULT_FETCH_MAX_MS;
    let bytesServed = 0;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      resolve({ code, stderr, timedOut });
    };
    try {
      if (!opts.allowOutsideRoot) assertServeableRepo(repoPath);
      assertScopeServeAuthorized(repoPath, opts.scopeServeGrant);
    } catch (e) {
      stderr += e instanceof Error ? e.message : String(e);
      try {
        duplex.end();
      } catch {
        /* ignore */
      }
      finish(-1);
      return;
    }
    const child = spawn('git', ['upload-pack', '--strict', repoPath], {
      env: { ...process.env, GIT_PROTOCOL: 'version=2', LC_ALL: 'C', LANG: 'C' },
    });
    const killChild = (why: string): void => {
      timedOut = true;
      stderr += `\nupload-pack ${why} (served ${bytesServed}B)`;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    };
    // IDLE ceiling: armed now, rearmed on every byte of progress in EITHER
    // direction. A transfer that is still streaming never trips it; one that
    // has genuinely stalled dies exactly as fast as it used to.
    const armIdle = (): void => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => killChild(`timed out after ${idleMs}ms idle`), idleMs);
      timer.unref?.();
    };
    armIdle();
    // ABSOLUTE ceiling: never rearmed, so a slow-drip peer still cannot pin the
    // stream open forever.
    hardTimer = setTimeout(() => killChild(`timed out after ${maxMs}ms (absolute ceiling)`), maxMs);
    hardTimer.unref?.();
    child.stderr.on('data', (d) => {
      stderr += String(d);
      // upload-pack's counting/compressing phase on a multi-GB repo emits
      // progress here while stdout is still silent — that IS liveness, and
      // treating it as idle is what killed every large cold join.
      armIdle();
    });
    // Never let a stream error crash the host (peer resets, EPIPE mid-pack).
    duplex.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    // Safe to attach 'data' alongside the pipes below: `.pipe()` already puts
    // both in flowing mode and Node delivers each chunk to EVERY listener, so
    // these counters never consume or steal bytes (same reasoning as the
    // client half's byte counters).
    duplex.on('data', armIdle);
    child.stdout.on('data', (d: Buffer | string) => {
      bytesServed += typeof d === 'string' ? Buffer.byteLength(d) : d.length;
      armIdle();
    });
    duplex.pipe(child.stdin);
    child.stdout.pipe(duplex);
    child.on('error', (e) => {
      stderr += String(e);
      // WI-6184: END the duplex here too, not only in the 'close' handler. A
      // spawn failure (`spawn git ENOENT` — live-observed once on the tower
      // bg-host) is not guaranteed to also emit 'close', and without an end
      // frame the REQUESTER is told nothing: it waits out its full 120s fetch
      // ceiling and reports a bare timeout, hiding a purely local, instantly
      // knowable failure. Ending is idempotent, so the common 'error'-then-
      // 'close' ordering is unaffected.
      try {
        duplex.end();
      } catch {
        /* ignore */
      }
      finish(-1);
    });
    child.on('close', (code) => {
      try {
        duplex.end();
      } catch {
        /* ignore */
      }
      finish(code ?? -1);
    });
  });
}

/**
 * CLIENT half — fetch `refspecs` into the local bare repo `localRepoPath` from a
 * peer, driving native `git fetch` (protocol v2) over `duplex` via the ext::
 * bridge. Bridges a temp unix socket → `duplex`; git's ext helper connects to
 * that socket. Resolves with the exit result; never throws. Cleans up the socket
 * + temp dir on completion.
 */
export interface FetchOverDuplexOptions {
  /** IDLE ceiling — rearmed on every byte of progress in either direction, and
   *  on git's own progress output. See {@link DEFAULT_FETCH_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Absolute ceiling regardless of progress. See {@link DEFAULT_FETCH_MAX_MS}. */
  maxMs?: number;
  /** WI-6189 resumable cold-join: `--depth=<n>` — request a SHALLOW fetch
   *  truncated to `n` commits per tip. The ladder's first rung: for the
   *  papercusp pot-home store this is a 78 MB transfer against 2.5 GB for the
   *  full history. Mutually exclusive with {@link deepen}. */
  depth?: number;
  /** WI-6189: `--deepen=<n>` — extend an ALREADY-shallow repo by `n` more
   *  commits per tip. Each successful deepen is durably committed to the local
   *  ODB + refs, so an interrupted ladder resumes from where it stopped
   *  instead of restarting. Mutually exclusive with {@link depth}. */
  deepen?: number;
  /** WI-6189: `--unshallow` — convert a shallow store to a complete one in a
   *  single transfer. The ladder's LAST-RESORT rung, used only when a `--deepen`
   *  rung lands without moving the shallow boundary (git will hand over no more
   *  at that granularity). Unbounded in size, so never the default path.
   *  Requires an already-shallow repo. */
  unshallow?: boolean;
  /** Suppress git's automatic tag-following. The bootstrap ladder sets this:
   *  auto-followed tags land OUTSIDE the requested refspec (in `refs/tags/*`),
   *  dragging in history nobody asked for and making a shallow rung's transfer
   *  size unpredictable. */
  noTags?: boolean;
}

export function fetchOverDuplex(
  localRepoPath: string,
  duplex: Duplex,
  refspecs: string[],
  opts: FetchOverDuplexOptions = {},
): Promise<TransportResult> {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let tmpDir: string | null = null;
    // Tracked so the OUTER ceiling timer (below) can actually kill whatever's
    // in flight — a child process, or nothing yet if we're still stuck in
    // mkdtemp/server.listen setup.
    let child: ChildProcessWithoutNullStreams | null = null;
    // ── WI-6184 timeout forensics ──
    // A bare "fetch timed out after 120000ms" is undiagnosable: it cannot
    // distinguish "the peer never answered at all" from "the peer answered and
    // then stalled mid-pack" — and those have completely different causes (a
    // silently-swallowed serve error vs. a dying transport). Counting bytes in
    // each direction makes the timeout message name which one happened, on the
    // DIALING box, without a cross-machine log read (the exact gap that stalled
    // five diagnosis wakes — see git-sync-action.ts:1746-1757).
    //
    // Safe to attach alongside the pipes below: `duplex`/`conn` are ALREADY put
    // in flowing mode by `.pipe()`, and Node delivers each chunk to EVERY
    // 'data' listener, so an extra counter never consumes or steals bytes.
    // (Contrast swarm.ts's warning about adding a 'data' listener to a socket
    // that is NOT piped — that would switch it to flowing and eat bytes.)
    let bytesFromPeer = 0;
    let bytesToPeer = 0;
    let bridgeConnected = false;
    // Idle + absolute ceilings (EI-18776567787336109). `timer` is REARMED on
    // every byte of progress, so a large-but-healthy fetch is never killed;
    // `hardTimer` is never rearmed and bounds the whole fetch absolutely.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const idleMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const maxMs = opts.maxMs ?? DEFAULT_FETCH_MAX_MS;
    // Never let a stream error crash the host — attached SYNCHRONOUSLY, before
    // any await, so an already-destroyed/decoy duplex (the documented
    // DIAL-REGISTRY GAP idiom several callers use — a pre-destroyed stub
    // returned when there's no live dial path yet: pot-git-gc-action /
    // git-sync-action's bootstrap+ref-announce legs, peer-dial-registry.ts's
    // openHiveGitDuplexToDevice) can never emit an unhandled 'error' event.
    // Below (in the real `server.on('connection', ...)` path) a SECOND
    // `duplex.on('error', () => {})` is attached once a real connection
    // exists — harmless double-attach, EventEmitter supports multiple
    // listeners on the same event.
    //
    // FAIL FAST on a destroyed duplex (EI-8863/WI-3643, su-95401d6d's
    // handoff finding): a `.destroy(err)` on the injected duplex means the
    // PEER already refused or the channel/connection dropped (serve-wiring.ts's
    // handleRefuse / failAllSessions) — there is nothing left to wait for.
    // Previously this listener was a pure no-op, so a refused fetch sat until
    // the OUTER ceiling timer (`opts.timeoutMs`) fired regardless —
    // serve-wiring.integration.test.ts's 3 refusal-path tests each burned
    // their FULL 15s timeout on an instant refusal, fragile under host load
    // (the "hangs, times out near 90s" symptom the handoff reproduced).
    // Finish immediately instead — mirrors the fail-soft contract (never
    // throws, never crashes) while resolving as fast as the real signal
    // allows.
    duplex.on('error', (err) => {
      if (settled) return;
      stderr += `\nduplex error: ${err instanceof Error ? err.message : String(err)}`;
      try {
        child?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(-1);
    });
    // allowHalfOpen:true so a FIN on either leg does NOT destroy the socket
    // before its buffered bytes flush — the git pack is delimited in-band, so a
    // premature destroy truncates it ("bad pack header"). Default end:true pipes
    // then propagate each half-close cleanly.
    const server = createServer({ allowHalfOpen: true });
    /**
     * EI-18765930091826096: THIS FETCH OWNS THE DUPLEX'S LIFETIME — release it
     * when the fetch settles, on EVERY path (success, refusal, ceiling).
     *
     * Nothing here used to end or destroy the caller's duplex at all: `finish`
     * closed our LOCAL unix bridge and removed the tmpdir, and the peer-facing
     * duplex was simply dropped on the floor still open. For a pot-git
     * `FrameDuplex` that is a two-sided leak, and it is the mechanism behind a
     * peer channel that degrades until it can serve nothing:
     *
     *   - the PEER is never told we left. `FrameDuplex._final` (which sends the
     *     `end` frame) only runs on a graceful `.end()`, so an abandoned rung
     *     left the serving side's `git upload-pack` running against an open
     *     stdin until ITS own ceiling — one zombie upload-pack per failed rung,
     *     still generating and pushing pack bytes at us.
     *   - OUR side kept absorbing those bytes. The session stayed registered in
     *     `clientSessions`, so every inbound data frame was buffered into a
     *     duplex whose only reader (git) had already been SIGKILLed.
     *
     * A cold-join ladder fails rungs BY DESIGN, so this accumulated per tick and
     * was freed only by the connection dying — i.e. only by a process restart,
     * exactly the observed signature.
     *
     * Ordering matters: `end()` first so `_final` fires and the end frame
     * actually reaches the peer, and only THEN destroy (which would abort a
     * pending `_final` and swallow the frame). The unref'd fallback timer covers
     * a writable side that can never finish because the transport is already
     * gone — without it, a dead-transport abandon would leak the very session
     * this is here to release.
     */
    const releasePeerDuplex = (): void => {
      try {
        if (duplex.destroyed) return;
        const hardRelease = (): void => {
          try {
            if (!duplex.destroyed) duplex.destroy();
          } catch {
            /* ignore */
          }
        };
        if (duplex.writableEnded) {
          hardRelease();
          return;
        }
        duplex.once('finish', hardRelease);
        const fallback = setTimeout(hardRelease, 1_000);
        fallback.unref?.();
        duplex.end();
      } catch {
        /* ignore — releasing a duplex must never fail a settled fetch */
      }
    };
    // Hold the in-flight mark for this repo until the fetch settles, so a
    // concurrent tick's stale-lock sweep can never unlink the `shallow.lock`
    // this fetch is actively holding (EI-18776567787336109).
    const releaseInFlight = noteFetchInFlight(localRepoPath);
    const cleanup = async (): Promise<void> => {
      releaseInFlight();
      releasePeerDuplex();
      try {
        server.close();
      } catch {
        /* ignore */
      }
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    };
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      void cleanup();
      resolve({ code, stderr, timedOut });
    };
    // BUG FIXED (WI-3490/P-201): this ceiling used to only SET `timedOut` —
    // it never actually killed anything or resolved the promise. So a stall
    // BEFORE `child` exists (mkdtemp / server.listen never resolving — e.g. a
    // wedged fs call) had NO ceiling at all: the inner `killTimer` below only
    // starts once `spawn()` has already run, so it can't cover that window.
    // A hostile/wedged peer or a slow host could then pin this open forever
    // (bounded only by an external caller's own timeout, if any — vitest's
    // global 90s test timeout is what surfaced this in serve-wiring's
    // integration tests, not a real fix). Now this outer timer is the actual
    // enforced ceiling: kill the child if one was spawned, and always finish.
    const expire = (why: string): void => {
      timedOut = true;
      // WI-6184: name what we were WAITING ON, not just that we waited.
      //   peer→us 0 B  ⇒ the serving side never answered (its handleReq refused
      //                  silently, threw and got swallowed, or never received
      //                  the req frame) — look at the PEER, not the transport.
      //   peer→us > 0  ⇒ the peer did answer and the stream then stalled — a
      //                  transport/connection-death problem on this path.
      //   bridge=no    ⇒ we never even got git's ext helper connected locally,
      //                  so the stall is LOCAL setup (mkdtemp/listen/spawn).
      stderr +=
        `\nfetch ${why}` +
        ` (peer→us ${bytesFromPeer}B, us→peer ${bytesToPeer}B,` +
        ` bridge=${bridgeConnected ? 'yes' : 'no'}, gitChild=${child ? 'spawned' : 'none'})`;
      try {
        child?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(-1);
    };
    // IDLE ceiling — rearmed by `noteProgress()` on every byte in either
    // direction, so only a genuinely STALLED fetch trips it.
    const armIdle = (): void => {
      if (settled) return;
      clearTimeout(timer);
      // Wording note: the `fetch timed out after <n>ms` prefix is an ASSERTED
      // contract (fetch-transport.test.ts, WI-6184 forensics). The ceiling that
      // fired is appended rather than replacing it, so the diagnostic gains
      // which-ceiling information without breaking that contract.
      timer = setTimeout(() => expire(`timed out after ${idleMs}ms idle`), idleMs);
      timer.unref?.();
    };
    armIdle();
    // ABSOLUTE ceiling — never rearmed.
    hardTimer = setTimeout(() => expire(`timed out after ${maxMs}ms (absolute ceiling)`), maxMs);
    hardTimer.unref?.();

    // FAIL FAST on an ALREADY-destroyed duplex (WI-3496 rig finding): the
    // 'error' listener above only covers a destroy that happens AFTER this
    // call — a pre-destroyed decoy stub (openHiveGitDuplexToDevice's "no live
    // dial path" contract) emitted its 'error' ticks ago into its own no-op
    // listener, before callers like bootstrapFromPeer (which awaits
    // dropQuarantine/listNamespaces first) ever reach here. Without this
    // check such a fetch hangs the FULL outer ceiling (live-observed: every
    // G-8 cold-join burned 120s per tick instead of failing fast).
    if (duplex.destroyed) {
      stderr += '\nduplex already destroyed before fetch began (no live dial path)';
      finish(-1);
      return;
    }

    server.on('error', () => {});

    // ── WI-6189: propagate a peer half-close to git, ALWAYS ──
    // `duplex.pipe(conn)` forwards EOF only if the duplex's 'end' is still
    // ahead of us. Two very common cases leave nothing to forward:
    //   (a) the channel closed BEFORE git's ext helper connected (we're
    //       awaiting mkdtemp/listen/spawn for a few ms — a pot-git channel
    //       closing 23–36x/min lands in that window constantly), so 'end'
    //       fired into the void and a later `.pipe()` never re-emits it;
    //   (b) the channel was DESTROYED without an error, which emits 'close'
    //       and no 'end' at all, so `pipe` has nothing to act on either.
    // In both, the bridge sits waiting for bytes that can never arrive, git
    // waits on the bridge, and the fetch burns its FULL ceiling (120 s in
    // prod) before anyone learns the peer left. Latch the half-close and hand
    // the EOF to the bridge by hand so git fails in milliseconds instead.
    //
    // Deliberately NOT `finish(-1)`: on a HEALTHY fetch the serving side also
    // ends the duplex as soon as upload-pack exits, while our git is still
    // indexing/resolving deltas. Aborting there would kill successful fetches.
    // Handing git the EOF is correct in both cases — it then exits on its own,
    // successfully if it already has the whole pack.
    let bridgeConn: import('node:net').Socket | null = null;
    let peerHalfClosed = false;
    const propagateHalfClose = (): void => {
      peerHalfClosed = true;
      try {
        bridgeConn?.end();
      } catch {
        /* ignore */
      }
    };
    duplex.on('end', propagateHalfClose);
    duplex.on('close', propagateHalfClose);

    // The bridge (git's ext helper) connects here; wire it to the caller's duplex.
    server.on('connection', (conn) => {
      conn.on('error', () => {});
      duplex.on('error', () => {});
      bridgeConn = conn;
      conn.pipe(duplex);
      duplex.pipe(conn);
      // Case (a)/(b) above: the peer was already gone when git got here.
      if (peerHalfClosed || duplex.readableEnded || duplex.destroyed) propagateHalfClose();
      // WI-6184: counters — see the declarations above for why an extra
      // 'data' listener on an already-piped stream is byte-safe. These are also
      // the IDLE-ceiling's progress signal (EI-18776567787336109): every byte in
      // either direction rearms it, so a multi-GB transfer that is still moving
      // is never killed for taking a long time.
      bridgeConnected = true;
      duplex.on('data', (c: Buffer | string) => {
        bytesFromPeer += typeof c === 'string' ? Buffer.byteLength(c) : c.length;
        armIdle();
      });
      conn.on('data', (c: Buffer | string) => {
        bytesToPeer += typeof c === 'string' ? Buffer.byteLength(c) : c.length;
        armIdle();
      });
    });

    void (async () => {
      try {
        tmpDir = await mkdtemp(join(tmpdir(), 'hgfetch-'));
        // The duplex may already have errored (fast refusal, or a
        // pre-destroyed decoy stub — see the `duplex.on('error', ...)`
        // handler above) while we were still awaiting mkdtemp — `finish`
        // already ran, so don't waste a real `git fetch` spawn on a fetch
        // that's already resolved failed.
        if (settled) return;
        const sockPath = join(tmpDir, 's.sock');
        await new Promise<void>((r, rej) => {
          server.once('error', rej);
          server.listen(sockPath, () => r());
        });
        if (settled) return;
        // ext:: command tokens are space-split by git — EXT_BRIDGE_PATH/sockPath
        // live under tmp/dist dirs with no spaces, so a plain command is safe.
        const url = `ext::node ${EXT_BRIDGE_PATH} ${sockPath}`;
        // The ext helper is a plain `node` grandchild whose STDOUT *is* the git
        // pkt-line channel — so it must boot vanilla. Strip any injected loader
        // (NODE_OPTIONS / tsx --import|--require) that would print startup noise
        // to fd 1 and corrupt the pack stream ("bad pack header"). git passes its
        // env through to the ext command.
        const cleanEnv = { ...process.env } as Record<string, string | undefined>;
        delete cleanEnv.NODE_OPTIONS;
        delete cleanEnv.TSX_TSCONFIG_PATH;
        // WI-6189: the shallow-ladder knobs. `--depth` and `--deepen` are
        // mutually exclusive in git; depth wins if a caller passes both
        // (bootstrap.ts never does — its phase machine picks exactly one).
        const ladderArgs: string[] = [];
        if (opts.noTags) ladderArgs.push('--no-tags');
        if (opts.depth !== undefined) ladderArgs.push(`--depth=${opts.depth}`);
        else if (opts.deepen !== undefined) ladderArgs.push(`--deepen=${opts.deepen}`);
        else if (opts.unshallow) ladderArgs.push('--unshallow');
        child = spawn(
          'git',
          [
            '-c',
            'protocol.ext.allow=always',
            '-c',
            'protocol.version=2',
            'fetch',
            '--no-write-fetch-head',
            ...ladderArgs,
            url,
            ...refspecs,
          ],
          { cwd: localRepoPath, env: { ...cleanEnv, GIT_PROTOCOL: 'version=2', LC_ALL: 'C', LANG: 'C' } },
        );
        // Fires faster than the outer ceiling timer would in the common case
        // (same deadline, but this one only has to wait on the child, not
        // re-derive that nothing else settled it) — the outer `timer` above
        // is the actual backstop now, so this being redundant on the happy
        // path is fine; `finish` is idempotent either way.
        const killTimer = setTimeout(() => {
          try {
            child?.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }, opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
        killTimer.unref?.();
        child.stderr.on('data', (d) => {
          stderr += String(d);
          // git's own progress ("Receiving objects", "Resolving deltas") is
          // liveness too: during index-pack the client burns minutes writing to
          // disk with NO network bytes moving, which the byte counters above
          // cannot see. Without this, a large cold join would idle out at the
          // very last step (EI-18776567787336109).
          armIdle();
        });
        child.on('error', (e) => {
          clearTimeout(killTimer);
          stderr += String(e);
          finish(-1);
        });
        child.on('close', (code) => {
          clearTimeout(killTimer);
          finish(code ?? -1);
        });
      } catch (e) {
        stderr += e instanceof Error ? e.message : String(e);
        finish(-1);
      }
    })();
  });
}

/** The refspec that mirrors ONE peer device's entire namespace into our local
 *  bare repo, verbatim (`refs/namespaces/<devHex>/*` ↔ same). Forced (`+`) — the
 *  peer is the sole writer of its own namespace, so its head is authoritative for
 *  its subtree; there is no local writer to clobber. */
export function peerNamespaceRefspec(peerDevicePubkeyBase64: string): string {
  const hex = deviceNamespaceKey(peerDevicePubkeyBase64);
  return `+refs/namespaces/${hex}/*:refs/namespaces/${hex}/*`;
}

/**
 * Convenience: fetch a single peer device's whole namespace into `localRepoPath`
 * over `duplex`. The announcement layer (G-3) calls this when a peer advertises
 * its sigrefs advanced; the integrator (G-5) then merges the mirrored heads.
 */
export function fetchPeerNamespace(
  localRepoPath: string,
  duplex: Duplex,
  peerDevicePubkeyBase64: string,
  opts?: { timeoutMs?: number },
): Promise<TransportResult> {
  return fetchOverDuplex(localRepoPath, duplex, [peerNamespaceRefspec(peerDevicePubkeyBase64)], opts);
}
