// EI-18662389554660036 — a filesystem-local mutex for shared-tree-wide mutations
// that plain repo tooling (no MCP/Papercusp credentials, just `node`) needs to
// serialize across concurrent agent processes on the same host.
//
// This is the SAME proven algorithm as `withTestcontainerStartLock`
// (libs/test-config/src/testcontainer-start-lock.ts): an atomic `mkdir` as the
// lock primitive (POSIX mkdir either creates the dir or fails EEXIST — no
// separate compare-and-swap needed), an owner.json recording {pid, host,
// startedAt} for diagnostics, and a two-layer reclaim so a crashed holder can
// never wedge every future caller forever:
//   1. age-based staleness (`staleMs`) — a purely time-based fallback;
//   2. positive dead-owner confirmation (same host + ESRCH on `kill(pid, 0)`) —
//      reclaims immediately instead of waiting out the FULL stale window,
//      closing the gap EI-7818 found in the pure age-based check alone.
// Deliberately duplicated here rather than importing from `@papercusp/test-config`:
// that package is TS or vitest-testcontainer-shaped, but the caller (a bare
// `node scripts/npm-install-safe.mjs`, run from `preinstall`/CI/any agent's raw
// shell, no build step) must stay plain-JS-executable with zero devDependency on
// the test toolchain. If a THIRD consumer shows up, promote both to one shared
// `libs/generic/fs-mutex` package instead of a third copy.
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_STALE_MS = 10 * 60_000;
const DEFAULT_RETRY_MS = 250;

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * Resolve one host-stable mutex root.
 *
 * `os.tmpdir()` is intentionally NOT used here. It follows each process's
 * TMPDIR, and Papercusp agents legitimately run with both TMPDIR unset and
 * TMPDIR=/tmp/pcv. That split one logical npm-install mutex across
 * /tmp/pcv/fs-mutex-locks and /tmp/pcv/pcv/fs-mutex-locks, allowing two root
 * reifiers to hollow shared packages concurrently (WI-40965 / D-031).
 *
 * Keep the existing Linux/macOS default path so already-running default-env
 * callers retain lock continuity. Windows has no guaranteed /tmp, so use the
 * account home there. PAPERCUSP_FS_MUTEX_LOCK_DIR remains the explicit test /
 * operator override on every platform.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ platform?: NodeJS.Platform, homeDir?: string }} [options]
 */
export function resolveFsMutexLockRoot(env = process.env, options = {}) {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const stableDefault =
    platform === 'win32' ? join(homeDir, '.papercusp', 'fs-mutex-locks') : '/tmp/pcv/fs-mutex-locks';
  return resolve(env.PAPERCUSP_FS_MUTEX_LOCK_DIR ?? stableDefault);
}

function lockRoot() {
  return resolveFsMutexLockRoot();
}

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function readOwner(lockDir) {
  try {
    return await readFile(join(lockDir, 'owner.json'), 'utf8');
  } catch {
    return '(owner unknown)';
  }
}

/**
 * True only when we can POSITIVELY confirm the lock's recorded owner process is
 * dead: same host (a cross-host pid means nothing) AND `process.kill(pid, 0)`
 * reports ESRCH (no such process). Any other outcome (different host,
 * unparseable owner.json, EPERM/alive, or any other error) returns false — this
 * must never produce a false "dead" that reclaims a live holder's lock.
 */
async function isOwnerProcessConfirmedDead(lockDir) {
  let raw;
  try {
    raw = await readFile(join(lockDir, 'owner.json'), 'utf8');
  } catch {
    return false;
  }
  let owner;
  try {
    owner = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof owner.pid !== 'number' || typeof owner.host !== 'string') return false;
  if (owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false; // no throw ⇒ signal delivered ⇒ process exists (or we lack permission ⇒ assume alive)
  } catch (error) {
    return error && error.code === 'ESRCH';
  }
}

/**
 * Run `fn` while holding an exclusive, cross-process, filesystem-local mutex
 * named `name`. Blocks (retrying every `retryMs`) until acquired, a stale/dead
 * holder is reclaimed, or `timeoutMs` elapses (throws). Always releases in a
 * `finally`, even if `fn` throws.
 *
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} fn
 * @param {{ timeoutMs?: number, staleMs?: number, retryMs?: number, onWaiting?: (info: { owner: string, elapsedMs: number }) => void }} [opts]
 * @returns {Promise<T>}
 */
export async function withFsMutex(name, fn, opts = {}) {
  if (process.env.PAPERCUSP_DISABLE_FS_MUTEX === '1') {
    return fn();
  }

  const root = lockRoot();
  const lockDir = join(root, `${safeName(name)}.lock`);
  const timeoutMs = opts.timeoutMs ?? intEnv('PAPERCUSP_FS_MUTEX_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const staleMs = opts.staleMs ?? intEnv('PAPERCUSP_FS_MUTEX_STALE_MS', DEFAULT_STALE_MS);
  const retryMs = opts.retryMs ?? intEnv('PAPERCUSP_FS_MUTEX_RETRY_MS', DEFAULT_RETRY_MS);
  const startedAt = Date.now();
  const owner = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date(startedAt).toISOString(),
    name,
  };

  await mkdir(root, { recursive: true });

  let announcedWaiting = false;
  for (;;) {
    try {
      await mkdir(lockDir);
      await writeFile(join(lockDir, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      const elapsed = Date.now() - startedAt;
      if (!announcedWaiting && opts.onWaiting) {
        announcedWaiting = true;
        opts.onWaiting({ owner: await readOwner(lockDir), elapsedMs: elapsed });
      }
      const lockAgeMs = await stat(lockDir)
        .then((s) => Date.now() - s.mtimeMs)
        .catch(() => 0);
      if (lockAgeMs > staleMs) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (await isOwnerProcessConfirmedDead(lockDir)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (elapsed > timeoutMs) {
        const currentOwner = await readOwner(lockDir);
        throw new Error(`Timed out after ${timeoutMs}ms waiting for fs-mutex "${name}" (${lockDir}); holder: ${currentOwner}`);
      }
      await sleep(retryMs);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

/**
 * EI-19304880034803985 — a NON-blocking, synchronous peek at whether `name`'s
 * mutex is currently held, for a caller that wants to WARN a caller ("an
 * install may be about to make you hang") rather than wait/acquire it.
 *
 * Deliberately does not reclaim a stale/dead-owner lock (that mutates shared
 * state — a caller merely peeking must never race the real holder's own
 * cleanup) and deliberately does not throw on any read/parse failure — an
 * inconclusive peek reports `held:false` (never block a caller on a
 * diagnostic that fails open by design, mirroring `withFsMutex`'s own
 * fail-open error handling).
 *
 * @param {string} name
 * @returns {{ held: boolean, owner?: { pid?: number, host?: string, startedAt?: string, name?: string }, lockDir: string }}
 */
export function peekFsMutexSync(name) {
  const lockDir = join(lockRoot(), `${safeName(name)}.lock`);
  try {
    const raw = readFileSync(join(lockDir, 'owner.json'), 'utf8');
    return { held: true, owner: JSON.parse(raw), lockDir };
  } catch {
    return { held: false, lockDir };
  }
}
