/**
 * WI-10004327: operator-docs' docs swap leftovers (`docs.old.<pid>`, `docs.tmp.<pid>`).
 *
 * postbuild-copy.sh publishes `apps/operator/public/internal/docs` by swapping the
 * old tree out to `docs.old.<pid>` and reaping it after a grace period. Two defects
 * let ~350 MB trees pile up:
 *
 *  1. rename(2) keeps a directory's mtime, so the swapped-out tree carried its OLD
 *     BUILD time. The `-mmin +N` grace sweep then saw a tree swapped out this instant
 *     as long-stale, so the grace window protected nothing. The fix stamps the
 *     swap-out time. Measured: docs.old.3438785 had mtime 09-28 22:17Z, ctime 09-30 07:48Z.
 *  2. Vite copies publicDir into dist wholesale, and a retain-regime dist
 *     (emptyOutDir:false) never dropped the copies: dist/internal/docs.old.2520515
 *     outlived its public/ source by two days. distDocsSwapLeftoverPrunePlugin
 *     removes them after every build.
 *  3. The reaper was a setsid'd sleeper inside the build's cgroup, so a systemd unit
 *     launcher (KillMode=control-group) killed it when the build exited, and the tree
 *     survived until some later build. The reap is now a transient user timer.
 *
 * POSTBUILD_COPY_SCRIPT overrides the script under test, so a mutation probe can point
 * this suite at a mutated COPY rather than editing the shared tree.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneDocsSwapLeftovers, selectDocsSwapLeftovers } from './dev-dist-prune';

const SCRIPT =
  process.env.POSTBUILD_COPY_SCRIPT ??
  resolve(fileURLToPath(new URL('.', import.meta.url)), '../operator-docs/scripts/postbuild-copy.sh');

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wi10004327-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

describe('selectDocsSwapLeftovers', () => {
  it('selects only docs.old.<pid> and docs.tmp.<pid>, never the live tree or look-alikes', () => {
    expect(
      selectDocsSwapLeftovers([
        'docs',
        'docs.old.3438785',
        'docs.tmp.12',
        'docs.old.abc',
        'docs.old.',
        'docs.older.1',
        'mydocs.old.1',
        'docs.old.1.bak',
      ]),
    ).toEqual(['docs.old.3438785', 'docs.tmp.12']);
  });
});

describe('pruneDocsSwapLeftovers', () => {
  it('removes leftover trees from dist/internal and keeps the live docs tree intact', async () => {
    const internal = join(root, 'internal');
    for (const dir of ['docs/guide', 'docs.old.2520515/guide', 'docs.tmp.77']) {
      mkdirSync(join(internal, dir), { recursive: true });
    }
    writeFileSync(join(internal, 'docs/guide/index.html'), 'live');
    writeFileSync(join(internal, 'docs.old.2520515/guide/index.html'), 'stale');

    expect(await pruneDocsSwapLeftovers(internal)).toEqual(['docs.old.2520515', 'docs.tmp.77']);
    expect(readdirSync(internal)).toEqual(['docs']);
    expect(existsSync(join(internal, 'docs/guide/index.html'))).toBe(true);
  });

  it('is a no-op when the outDir has no internal/ directory', async () => {
    expect(await pruneDocsSwapLeftovers(join(root, 'missing'))).toEqual([]);
  });
});

describe('postbuild-copy.sh swap grace', () => {
  const docsApp = () => join(root, 'apps/operator-docs');
  const publicInternal = () => join(root, 'apps/operator/public/internal');
  const shimDir = () => join(root, 'shim-bin');
  const shimLog = () => join(root, 'shim.log');
  const oldTrees = () =>
    readdirSync(publicInternal())
      .filter((name) => name.startsWith('docs.old.'))
      .sort();
  const shimCalls = () =>
    existsSync(shimLog()) ? readFileSync(shimLog(), 'utf8').trim().split('\n') : [];

  // PATH shims: the script must never schedule a REAL timer or detach a real
  // sleeper from a test. Each shim only records its argv; SHIM_SYSTEMD_RUN_EXIT
  // simulates a host with no systemd user manager.
  beforeEach(() => {
    mkdirSync(shimDir(), { recursive: true });
    for (const name of ['systemd-run', 'setsid']) {
      const shim = join(shimDir(), name);
      const exit = name === 'systemd-run' ? '${SHIM_SYSTEMD_RUN_EXIT:-0}' : '0';
      writeFileSync(shim, `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> "$SHIM_LOG"\nexit ${exit}\n`);
      chmodSync(shim, 0o755);
    }
  });

  /** One docs "build": fresh dist/, then the real publish script, from the docs app dir. */
  function publish(page: string, env: Record<string, string> = {}): void {
    const dist = join(docsApp(), 'dist');
    rmSync(dist, { recursive: true, force: true });
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.html'), page);
    const run = spawnSync('bash', [SCRIPT], {
      cwd: docsApp(),
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PATH: `${shimDir()}:${process.env.PATH ?? ''}`, SHIM_LOG: shimLog(), ...env },
    });
    expect(run.status, `postbuild-copy.sh failed:\n${run.stderr}`).toBe(0);
  }

  it('schedules the reap as a transient user timer, outside the build cgroup', () => {
    publish('v1');
    publish('v2');
    const [swappedOut] = oldTrees();
    const target = join(publicInternal(), swappedOut);
    const timers = shimCalls().filter((line) => line.startsWith('systemd-run '));
    expect(timers).toHaveLength(1);
    expect(timers[0]).toContain('--user');
    expect(timers[0]).toContain('--on-active=120s');
    expect(timers[0].endsWith(` -rf -- ${target}`)).toBe(true);
    // the timer took the job, so no in-cgroup sleeper was detached
    expect(shimCalls().some((line) => line.startsWith('setsid '))).toBe(false);
  });

  it('falls back to the detached sleeper when there is no systemd user manager', () => {
    publish('v1');
    publish('v2', { SHIM_SYSTEMD_RUN_EXIT: '1' });
    const [swappedOut] = oldTrees();
    const sleepers = shimCalls().filter((line) => line.startsWith('setsid '));
    expect(sleepers).toHaveLength(1);
    expect(sleepers[0].endsWith(` 120 ${join(publicInternal(), swappedOut)}`)).toBe(true);
  });

  it('does not let an immediately following run reap a tree swapped out moments ago', () => {
    publish('v1');
    // The live tree was BUILT long ago: its mtime is its build time, not "now".
    const built = minutesAgo(10);
    utimesSync(join(publicInternal(), 'docs'), built, built);

    publish('v2'); // swaps the v1 tree out to docs.old.<pid>
    const [swappedOut] = oldTrees();
    expect(swappedOut).toMatch(/^docs\.old\.\d+$/);

    publish('v3'); // its start-of-run sweep must spare a tree swapped out inside the grace window
    expect(oldTrees()).toContain(swappedOut);
  });

  it('still reaps a swap leftover that is older than the grace period (calibration)', () => {
    publish('v1');
    const stale = join(publicInternal(), 'docs.old.999999');
    mkdirSync(stale);
    const swappedLongAgo = minutesAgo(10);
    utimesSync(stale, swappedLongAgo, swappedLongAgo);

    publish('v2');
    expect(existsSync(stale)).toBe(false);
  });
});
