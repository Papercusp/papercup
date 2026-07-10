/**
 * hive-git/fetch-transport.ts — native git protocol-v2 fetch over an injected
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
 *     swarm connection (the `papercusp/hive-git` channel family — wired
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
import { deviceNamespaceKey, hiveGitRoot } from './storage';
import { isScopeRepoFamilyPath } from './scope-repo';
import { type ScopeRepoServeGrant, isIssuedScopeServeGrant } from './scope-serve-gate';

/** The ext:: bridge helper git execs on the client (a real on-disk node script). */
const EXT_BRIDGE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'git-ext-bridge.mjs');

/** Protomux protocol id for the per-fetch git streams (the wiring opens one
 *  channel of this protocol per in-flight fetch, keyed by the hive topic). */
export const HIVE_GIT_PROTOCOL = 'papercusp/hive-git';

/** Default per-fetch wall-clock ceiling (ms) — a stuck upload-pack/fetch is
 *  killed so a hostile or wedged peer can't pin a stream open forever. */
export const DEFAULT_FETCH_TIMEOUT_MS = 120_000;

export interface TransportResult {
  /** git process exit code (0 = success; -1 = spawn/timeout failure). */
  code: number;
  /** Captured stderr (diagnostics; never surfaced to a peer). */
  stderr: string;
  /** True when the timeout fired (the process was killed). */
  timedOut: boolean;
}

/** Guard: only ever serve upload-pack for a repo INSIDE our hive-git root — a
 *  defense-in-depth backstop so a wiring bug can't turn this into an arbitrary
 *  repo-read oracle for a peer. The (hive, repo) → path mapping already sanitizes
 *  components (storage.hiveGitRepoPath), this re-checks the resolved path. */
function assertServeableRepo(repoPath: string): void {
  const root = hiveGitRoot();
  if (repoPath !== root && !repoPath.startsWith(root.endsWith('/') ? root : `${root}/`)) {
    throw new Error(`hive-git: refusing to serve a repo outside the hive-git root: ${repoPath}`);
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
      `hive-git: refusing to serve scope repo without a roster-verified serve grant: ${repoPath}`,
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
    timeoutMs?: number;
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
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
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
    timer = setTimeout(() => {
      timedOut = true;
      stderr += `\nupload-pack timed out after ${opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS}ms`;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
    timer.unref?.();
    child.stderr.on('data', (d) => (stderr += String(d)));
    // Never let a stream error crash the host (peer resets, EPIPE mid-pack).
    duplex.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    duplex.pipe(child.stdin);
    child.stdout.pipe(duplex);
    child.on('error', (e) => {
      stderr += String(e);
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
export function fetchOverDuplex(
  localRepoPath: string,
  duplex: Duplex,
  refspecs: string[],
  opts: { timeoutMs?: number } = {},
): Promise<TransportResult> {
  return new Promise((resolve) => {
    // Never let a stream error crash the host — attached SYNCHRONOUSLY, before
    // any await, so an already-destroyed/decoy duplex (the documented
    // DIAL-REGISTRY GAP idiom several callers use — a pre-destroyed stub
    // returned when there's no live dial path yet: hive-git-gc-action /
    // git-sync-action's bootstrap+ref-announce legs, peer-dial-registry.ts's
    // openHiveGitDuplexToDevice) can never emit an unhandled 'error' event.
    // Below (in the real `server.on('connection', ...)` path) a SECOND
    // `duplex.on('error', () => {})` is attached once a real connection
    // exists — harmless double-attach, EventEmitter supports multiple
    // listeners on the same event.
    duplex.on('error', () => {});
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let tmpDir: string | null = null;
    // Tracked so the OUTER ceiling timer (below) can actually kill whatever's
    // in flight — a child process, or nothing yet if we're still stuck in
    // mkdtemp/server.listen setup.
    let child: ChildProcessWithoutNullStreams | null = null;
    // allowHalfOpen:true so a FIN on either leg does NOT destroy the socket
    // before its buffered bytes flush — the git pack is delimited in-band, so a
    // premature destroy truncates it ("bad pack header"). Default end:true pipes
    // then propagate each half-close cleanly.
    const server = createServer({ allowHalfOpen: true });
    const cleanup = async (): Promise<void> => {
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
    const timer = setTimeout(() => {
      timedOut = true;
      stderr += `\nfetch timed out after ${opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS}ms`;
      try {
        child?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(-1);
    }, opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
    timer.unref?.();

    server.on('error', () => {});
    // The bridge (git's ext helper) connects here; wire it to the caller's duplex.
    server.on('connection', (conn) => {
      conn.on('error', () => {});
      duplex.on('error', () => {});
      conn.pipe(duplex);
      duplex.pipe(conn);
    });

    void (async () => {
      try {
        tmpDir = await mkdtemp(join(tmpdir(), 'hgfetch-'));
        const sockPath = join(tmpDir, 's.sock');
        await new Promise<void>((r, rej) => {
          server.once('error', rej);
          server.listen(sockPath, () => r());
        });
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
        child = spawn(
          'git',
          [
            '-c',
            'protocol.ext.allow=always',
            '-c',
            'protocol.version=2',
            'fetch',
            '--no-write-fetch-head',
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
        child.stderr.on('data', (d) => (stderr += String(d)));
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
