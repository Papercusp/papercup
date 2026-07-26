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
 * Usage: npm run install:safe [-- <npm args>]   (defaults to plain `npm install`)
 *        node scripts/npm-install-safe.mjs ci
 *        node scripts/npm-install-safe.mjs install --legacy-peer-deps
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFsMutex } from './lib/fs-mutex.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function repoLockName() {
  // realpath so the `papercup` -> `papercusp` symlink and the canonical path
  // both resolve to the identical lock; a genuinely different checkout
  // (different real path) gets its own lock instead of blocking on this one.
  const real = realpathSync(REPO_ROOT);
  const digest = createHash('sha1').update(real).digest('hex').slice(0, 12);
  return `npm-install-${digest}`;
}

export function main(argv = process.argv.slice(2)) {
  const npmArgs = argv.length > 0 ? argv : ['install'];
  const lockName = repoLockName();

  return withFsMutex(
    lockName,
    async () => {
      console.log(`NPM_INSTALL_SAFE running: npm ${npmArgs.join(' ')} (lock=${lockName})`);
      const result = spawnSync('npm', npmArgs, { cwd: REPO_ROOT, stdio: 'inherit' });
      if (result.error) throw result.error;
      return result.status ?? 1;
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
