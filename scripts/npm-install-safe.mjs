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
 * dependency must actually resolve on disk — with ONE bounded auto-repair (a full
 * root `npm install --legacy-peer-deps`, which is exactly what cleared it by hand
 * during the incident) before failing loudly. Set PAPERCUSP_SKIP_DEP_VERIFY=1 to
 * skip the verification.
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
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFsMutex } from './lib/fs-mutex.mjs';
import { findUnextractedDepsWithRetry, formatMissing } from './check-declared-deps-extracted.mjs';

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const REPAIR_ARGS = ['install', '--legacy-peer-deps'];

/**
 * Verify (post-install, still holding the lock) that every directly-declared
 * dependency actually landed on disk; repair once if not.
 *
 * @returns {Promise<0|1>} 0 = healthy (possibly after repair), 1 = still broken.
 */
export async function verifyDepsExtracted({ repoRoot = DEFAULT_REPO_ROOT, runNpm, deps = {} } = {}) {
  const spawn = runNpm ?? ((args) => spawnSync('npm', args, { cwd: repoRoot, stdio: 'inherit' }).status ?? 1);

  const first = await findUnextractedDepsWithRetry({ repoRoot, deps });
  if (first.missing.length === 0) return 0;

  console.error(formatMissing(first.missing));
  console.error(`NPM_INSTALL_SAFE repairing: npm ${REPAIR_ARGS.join(' ')} (one bounded attempt, still holding the lock)`);
  spawn(REPAIR_ARGS);

  const second = await findUnextractedDepsWithRetry({ repoRoot, deps });
  if (second.missing.length === 0) {
    console.log('NPM_INSTALL_SAFE repaired: every directly-declared dependency now resolves on disk');
    return 0;
  }
  console.error(formatMissing(second.missing));
  console.error('NPM_INSTALL_SAFE_FATAL: dependencies are STILL un-extracted after a repair install — this is not a race. Do not treat a downstream "cannot find module" as a code bug until this is clear.');
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
  if (npmArgv[0] === '--') npmArgv = npmArgv.slice(1);

  return { repoRoot, npmArgs: normalizeNpmArgs(npmArgv) };
}

export function main(argv = process.argv.slice(2)) {
  const { repoRoot, npmArgs } = parseCliArgs(argv);
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
