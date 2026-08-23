#!/usr/bin/env node
/**
 * EI-18662389554660036 — a single agent's `npm install` on this shared tree
 * breaks EVERY other agent's test runs for minutes (node_modules/.bin/vitest
 * vanishes mid-rewrite), and two OVERLAPPING installs can corrupt a package
 * outright (half-written dist/ — not a version-resolution issue, does not
 * self-heal). There is no advisory lock on a shared-tree-wide mutation this
 * disruptive, even though the exact primitive (a named resource lock) already
 * guards `dev:restart` / `db:migrate` for the same reason.
 *
 * This wrapper serializes `npm install`/`npm ci`/etc invocations across
 * concurrent agent processes on the SAME host via `withFsMutex` (scripts/lib/
 * fs-mutex.mjs — the same mkdir-lock algorithm `withTestcontainerStartLock`
 * already uses for the analogous "many Vitest processes, one Docker handshake"
 * problem). The lock is keyed off the REPO ROOT's real (symlink-resolved) path,
 * so invoking it via the `papercup` symlink or the canonical `papercusp` path
 * both hit the SAME lock (they're one tree) — but a genuinely different
 * checkout (papercup-release, papercup-checkpoint, ...) gets its own lock and
 * is never blocked by this one.
 *
 * EI-18666853411437489 — the mutex stops CONCURRENT installs from corrupting npm's
 * reify bookkeeping, but it cannot detect corruption that ALREADY exists (from an
 * earlier bare `npm install`, or another checkout's run). That failure is silent:
 * npm prints "up to date", exits 0, and leaves a declared dependency un-extracted;
 * the first symptom is a confusing "cannot find module" / Rolldown "failed to
 * resolve" in some unrelated build or gate, often 10+ minutes later. So a successful
 * install is now VERIFIED before the lock is released — every directly-declared
 * dependency directory must resolve AND lockfile-selected critical runtime
 * entrypoints must really import (catching incomplete dist/native/transitive
 * contents) — with ONE bounded auto-repair before failing loudly. A nonzero repair
 * exit is itself fatal; a later spot probe may not erase an ENOTEMPTY failure.
 * Set PAPERCUSP_SKIP_DEP_VERIFY=1 to skip the verification.
 *
 * Managed hives reuse this same implementation with `--repo-root`; the lock
 * and npm cwd both follow that explicit target instead of this script's repo.
 * A `--prefix` install remains outside this wrapper because npm owns the target
 * selection in that shape and the global guard deliberately leaves it alone.
 *
 * Usage: npm run install:safe [-- <npm args>]   (defaults to plain `npm install`)
 *        node scripts/npm-install-safe.mjs ci
 *        node scripts/npm-install-safe.mjs install --legacy-peer-deps
 *        node scripts/npm-install-safe.mjs --repo-root /path/to/hive -- install --no-save pkg
 *        node scripts/npm-install-safe.mjs --repo-root /path/to/hive --exec-under-lock -- command arg...
 *
 * `--exec-under-lock` is the reader-side half of the same contract. Long-lived
 * host services build an entrypoint from node_modules immediately before boot;
 * if systemd restarts one while an install is reifying the shared tree, the
 * build/runtime can observe a half-extracted native package and crash-loop.
 * Running that build command under the install mutex makes it wait for the
 * verified install boundary instead of repeatedly reading the transition.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFsMutexRead, withFsMutex } from './lib/fs-mutex.mjs';
import {
  findUnextractedDepsWithRetry,
  findUnusableRuntimeDepsWithRetry,
  formatMissing,
  formatRuntimeFailures,
} from "./check-declared-deps-extracted.mjs";

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const REPAIR_ARGS = ['install', '--legacy-peer-deps'];
const EXEC_UNDER_LOCK_FLAG = "--exec-under-lock";

/**
 * Verify (post-install, still holding the lock) that dependency directories and
 * critical runtime contents actually landed on disk; repair once if not.
 *
 * @returns {Promise<0|1>} 0 = healthy (possibly after repair), 1 = still broken.
 */
export async function verifyDepsExtracted({
  repoRoot = DEFAULT_REPO_ROOT,
  runNpm,
  probeSpecifiers,
  deps = {},
} = {}) {
  const spawn =
    runNpm ??
    ((args) =>
      spawnSync("npm", args, { cwd: repoRoot, stdio: "inherit" }).status ?? 1);

  const inspect = async () => {
    const declared = await findUnextractedDepsWithRetry({ repoRoot, deps });
    if (declared.missing.length > 0)
      return { missing: declared.missing, runtimeFailures: [] };
    const runtime = await findUnusableRuntimeDepsWithRetry({
      repoRoot,
      probeSpecifiers,
      deps,
    });
    return { missing: [], runtimeFailures: runtime.failures };
  };

  const report = ({ missing, runtimeFailures }) => {
    if (missing.length > 0) console.error(formatMissing(missing));
    if (runtimeFailures.length > 0)
      console.error(formatRuntimeFailures(runtimeFailures));
  };

  const first = await inspect();
  if (first.missing.length === 0 && first.runtimeFailures.length === 0)
    return 0;

  report(first);
  console.error(
    `NPM_INSTALL_SAFE repairing: npm ${REPAIR_ARGS.join(" ")} (one bounded attempt, still holding the lock)`,
  );
  const repairStatus = spawn(REPAIR_ARGS) ?? 1;
  if (repairStatus !== 0) {
    console.error(
      `NPM_INSTALL_SAFE_FATAL: repair npm exited ${repairStatus}; dependency integrity is unverified.`,
    );
    return 1;
  }

  const second = await inspect();
  if (second.missing.length === 0 && second.runtimeFailures.length === 0) {
    console.log(
      "NPM_INSTALL_SAFE repaired: dependency directories and critical runtime imports are healthy",
    );
    return 0;
  }
  report(second);
  console.error(
    'NPM_INSTALL_SAFE_FATAL: dependencies are STILL incomplete after a repair install — this is not a race. Do not treat a downstream "cannot find module" as a code bug until this is clear.',
  );
  return 1;
}

export function repoLockName(repoRoot = DEFAULT_REPO_ROOT) {
  // realpath so the `papercup` -> `papercusp` symlink and the canonical path
  // both resolve to the identical lock; a genuinely different checkout
  // (different real path) gets its own lock instead of blocking on this one.
  const real = realpathSync(resolve(repoRoot));
  const digest = createHash('sha1').update(real).digest('hex').slice(0, 12);
  return `npm-install-${digest}`;
}

/**
 * npm treats config flags before a command as global flags. Preserve the
 * long-documented `npm run install:safe -- --legacy-peer-deps` form by making
 * the implicit install explicit before spawning npm.
 */
export function normalizeNpmArgs(argv) {
  if (argv.length === 0) return ['install'];
  return argv[0].startsWith('-') ? ['install', ...argv] : argv;
}

/**
 * Parse the wrapper-only target selector without stealing npm's own flags.
 * `--repo-root` is recognized only as the first wrapper argument and an
 * optional `--` cleanly separates it from the npm argv.
 */
export function parseCliArgs(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  let repoRoot = DEFAULT_REPO_ROOT;
  let npmArgv = [...argv];

  if (npmArgv[0] === '--repo-root' || npmArgv[0]?.startsWith('--repo-root=')) {
    const inline = npmArgv[0].startsWith('--repo-root=') ? npmArgv[0].slice('--repo-root='.length) : null;
    const rawRoot = inline ?? npmArgv[1];
    if (!rawRoot) throw new Error('--repo-root requires a path');
    repoRoot = resolve(cwd, rawRoot);
    npmArgv = npmArgv.slice(inline === null ? 2 : 1);
  }
  if (npmArgv[0] === EXEC_UNDER_LOCK_FLAG) {
    const commandArgs = npmArgv.slice(npmArgv[1] === "--" ? 2 : 1);
    if (commandArgs.length === 0)
      throw new Error(`${EXEC_UNDER_LOCK_FLAG} requires a command`);
    return { repoRoot, commandArgs };
  }

  if (npmArgv[0] === '--') npmArgv = npmArgv.slice(1);

  return { repoRoot, npmArgs: normalizeNpmArgs(npmArgv) };
}

/**
 * Run a dependency reader under the SAME repo-keyed mutex as install:safe.
 * The marker environment prevents a wrapped script from recursively wrapping
 * itself while keeping the contract explicit and testable at the child seam.
 */
export function runCommandUnderInstallMutex({
  repoRoot = DEFAULT_REPO_ROOT,
  commandArgs,
  runCommand = spawnSync,
} = {}) {
  if (!Array.isArray(commandArgs) || commandArgs.length === 0) {
    throw new Error(`${EXEC_UNDER_LOCK_FLAG} requires a command`);
  }
  const [command, ...args] = commandArgs;
  const lockName = repoLockName(repoRoot);

  return withFsMutexRead(
    lockName,
    async () => {
      // Reader diagnostics belong on stderr: callers such as ptool expose the
      // child command's stdout as a machine-readable JSON stream.
      console.error(`NPM_INSTALL_SAFE guarding reader: ${commandArgs.join(' ')} (root=${repoRoot}, lock=${lockName})`);
      const result = runCommand(command, args, {
        cwd: repoRoot,
        stdio: 'inherit',
        env: { ...process.env, PAPERCUSP_INSTALL_MUTEX_HELD: '1' },
      });
      if (result.error) throw result.error;
      return result.status ?? 1;
    },
    {
      onWaiting: ({ owner, elapsedMs }) => {
        console.error(
          `NPM_INSTALL_SAFE reader waiting on an install (${Math.round(elapsedMs / 1000)}s so far) — holder: ${owner.trim()}`,
        );
      },
    },
  );
}

export function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  if ("commandArgs" in parsed) return runCommandUnderInstallMutex(parsed);

  const { repoRoot, npmArgs } = parsed;
  const lockName = repoLockName(repoRoot);

  return withFsMutex(
    lockName,
    async () => {
      console.log(`NPM_INSTALL_SAFE running: npm ${npmArgs.join(' ')} (root=${repoRoot}, lock=${lockName})`);
      const result = spawnSync('npm', npmArgs, { cwd: repoRoot, stdio: 'inherit' });
      if (result.error) throw result.error;
      const status = result.status ?? 1;
      // A FAILED npm run reports its own error — never mask it with a dep verdict.
      if (status !== 0 || process.env.PAPERCUSP_SKIP_DEP_VERIFY === '1') return status;
      return verifyDepsExtracted({ repoRoot });
    },
    {
      onWaiting: ({ owner, elapsedMs }) => {
        console.log(
          `NPM_INSTALL_SAFE waiting on another agent's install (${Math.round(elapsedMs / 1000)}s so far) — holder: ${owner.trim()}`,
        );
      },
    },
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(`NPM_INSTALL_SAFE_ERROR ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
