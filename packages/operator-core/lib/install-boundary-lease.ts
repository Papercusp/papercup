/**
 * Install-boundary lease for agent launches (WI-10005137).
 *
 * A headless psu launch resolves its launcher and every module it imports from
 * a shared checkout's node_modules. While `npm run install:safe` is reifying
 * that checkout, those directories are torn down and rewritten for minutes, and
 * a launch in that window dies at boot with ERR_MODULE_NOT_FOUND. Observed
 * 2026-10-01 22:58-22:59Z: four grading-integrity audit dispatches died this way
 * and each then sat in a blind 15-minute dispatch backoff.
 *
 * install:safe already publishes the boundary: it holds a repo-keyed WRITER
 * lock (scripts/lib/fs-mutex.mjs) until the install is VERIFIED complete, and
 * readers (`--exec-under-lock`) wait on it. This module is that reader half for
 * an in-process launch: take a read lease before spawning, hold it across the
 * boot window where module resolution happens, then release it. The lock is
 * writer-preferring, so an install queued behind the lease waits only for the
 * boot window, never for the agent's lifetime.
 *
 * Fail-open by design: a lease that cannot be acquired within the timeout (or a
 * lock-root fault) returns `timed-out` / `error` and the caller launches anyway,
 * exactly as it did before this guard existed.
 */
import { existsSync } from 'node:fs';
import { withFsMutexRead } from '../../../scripts/lib/fs-mutex.mjs';
// @ts-expect-error -- same buildless plain-JS module family, no declaration file.
import { installLockNameForRoot } from '../../../scripts/lib/install-lock-name.mjs';

/** How long a launch waits for an in-flight install before launching anyway. */
export const INSTALL_BOUNDARY_WAIT_MS = 5 * 60_000;

/**
 * The env keys the psu shim (~/.papercusp/bin/psu, resolve_launcher) consults,
 * in its own precedence order, to pick the checkout it runs the launcher from.
 */
export const LAUNCHER_ROOT_ENV_KEYS = [
  'PAPERCUSP_CANONICAL_TREE',
  'PAPERCUSP_INTEGRATION_ROOT',
  'PAPERCUSP_RELEASE_ROOT',
] as const;

/**
 * The checkout whose node_modules a launched psu boots from: the first launcher
 * root the shim would consult that exists on disk. `null` when none is set
 * (the shim then falls back to fixed paths; no lease is taken).
 */
export function installBoundaryRoot(
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean = existsSync,
): string | null {
  for (const key of LAUNCHER_ROOT_ENV_KEYS) {
    const root = env[key]?.trim();
    if (root && exists(root)) return root;
  }
  return null;
}

export type InstallBoundaryOutcome = 'acquired' | 'no-root' | 'nested' | 'timed-out' | 'error';

export interface InstallBoundaryLease {
  outcome: InstallBoundaryOutcome;
  /** Milliseconds spent waiting for the lease (0 when none was attempted). */
  waitedMs: number;
  /** The lock name waited on, when one was derived. */
  lockName?: string;
  /** Why the lease was not held, for `timed-out` / `error`. */
  detail?: string;
  /** Idempotent. Releases the read lease; a no-op when none is held. */
  release: () => void;
}

type ReadLease = <T>(
  name: string,
  fn: () => Promise<T>,
  opts?: { timeoutMs?: number },
) => Promise<T>;

export interface AcquireInstallBoundaryLeaseOpts {
  timeoutMs?: number;
  /** The env of the launching process; `PAPERCUSP_INSTALL_MUTEX_HELD=1` means
   *  we already run inside an install-safe reader (or the writer), so taking
   *  another reader would self-deadlock under a writer we are nested in. */
  env?: Record<string, string | undefined>;
  readLease?: ReadLease;
  lockName?: (root: string) => string;
  now?: () => number;
}

const noop = () => {};

export async function acquireInstallBoundaryLease(
  root: string | null,
  opts: AcquireInstallBoundaryLeaseOpts = {},
): Promise<InstallBoundaryLease> {
  if (!root) return { outcome: 'no-root', waitedMs: 0, release: noop };
  const env = opts.env ?? process.env;
  if (env.PAPERCUSP_INSTALL_MUTEX_HELD === '1') {
    return { outcome: 'nested', waitedMs: 0, release: noop };
  }
  const now = opts.now ?? Date.now;
  let lockName: string;
  try {
    lockName = (opts.lockName ?? installLockNameForRoot)(root);
  } catch (error) {
    return { outcome: 'error', waitedMs: 0, detail: errorMessage(error), release: noop };
  }

  const readLease: ReadLease = opts.readLease ?? (withFsMutexRead as ReadLease);
  const startedAt = now();
  let release: () => void = noop;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signalAcquired: () => void = noop;
  const acquired = new Promise<{ ok: true }>((resolve) => {
    signalAcquired = () => resolve({ ok: true });
  });
  const lease = readLease(
    lockName,
    async () => {
      signalAcquired();
      await released;
    },
    { timeoutMs: opts.timeoutMs ?? INSTALL_BOUNDARY_WAIT_MS },
  );
  const settled = await Promise.race([
    acquired,
    lease.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  ]);
  // A rejection after acquisition (a release-side fs fault) must not surface as
  // an unhandled rejection in the operator process.
  lease.catch(noop);
  const waitedMs = Math.max(0, now() - startedAt);
  if (settled.ok) return { outcome: 'acquired', waitedMs, lockName, release };
  const detail = errorMessage(settled.error);
  return {
    outcome: /timed? ?out|timeout/i.test(detail) ? 'timed-out' : 'error',
    waitedMs,
    lockName,
    detail,
    release: noop,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
