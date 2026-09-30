/**
 * WI-10003918 — the live deploy copies node_modules from the INTEGRATION tree, so a
 * dependency removed/re-versioned on staging after the pin is absent from the release
 * tree of every older target (2026-09-29: @mdxeditor/editor broke the deploy of green
 * pin 9a9473af AND its rollback). pinned-lock-deps.mjs backfills drifted paths from
 * immutable dependency generations; reconcile_pinned_lock_deps() wires it into
 * setup-release-checkout.sh without ever aborting a deploy on its own.
 *
 * The helper is exercised through its CLI (the surface the shell script calls), and
 * the shell function is sed-extracted from the shipped script, the same isolation
 * pattern as setup-release-checkout-deps.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HELPER = join(__dirname, '../../bin/release/pinned-lock-deps.mjs');
const SCRIPT_PATH =
  process.env.PROBE_SCRIPT ?? join(__dirname, '../../bin/release/setup-release-checkout.sh');

type LockPackages = Record<string, { version?: string; link?: boolean; optional?: boolean }>;

const lockOf = (packages: LockPackages) =>
  JSON.stringify({ name: 'root', lockfileVersion: 3, packages: { '': { name: 'root' }, ...packages } });

function installPkg(root: string, path: string, version: string): void {
  mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, path, 'package.json'), JSON.stringify({ name: path.split('node_modules/').pop(), version }));
}

describe('pinned-lock-deps.mjs — pinned-lockfile reconcile (WI-10003918)', () => {
  let dir: string;
  let release: string;
  let generations: string;
  let pinnedLock: string;
  let integrationLock: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'pinned-lock-deps-')));
    release = join(dir, 'release');
    generations = join(dir, 'generations');
    pinnedLock = join(dir, 'pinned.json');
    integrationLock = join(dir, 'integration.json');
    mkdirSync(join(release, 'node_modules'), { recursive: true });
    mkdirSync(generations, { recursive: true });
  });

  afterEach(() => {
    // Generations are frozen read-only in production; restore write so cleanup works.
    spawnSync('chmod', ['-R', 'u+w', dir]);
    rmSync(dir, { recursive: true, force: true });
  });

  function run(extra: string[] = ['--backfill']) {
    const r = spawnSync(
      process.execPath,
      [HELPER, '--pinned-lock', pinnedLock, '--integration-lock', integrationLock, '--release', release, '--generations', generations, ...extra],
      { encoding: 'utf8' },
    );
    return { code: r.status, out: r.stdout + r.stderr };
  }

  function generation(name: string, pkgs: Record<string, string>): string {
    const tree = join(generations, name, 'tree');
    mkdirSync(tree, { recursive: true });
    for (const [path, version] of Object.entries(pkgs)) installPkg(tree, path, version);
    return tree;
  }

  it('short-circuits when the pinned and integration locks are byte-identical', () => {
    const lock = lockOf({ 'node_modules/gone': { version: '1.0.0' } });
    writeFileSync(pinnedLock, lock);
    writeFileSync(integrationLock, lock);
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toContain('PINNED_LOCK_DEPS status=clean drifted=0 reason=locks-identical');
  });

  it('backfills a package removed on staging after the pin, as an independent writable copy', () => {
    writeFileSync(pinnedLock, lockOf({ 'node_modules/kept': { version: '1.0.0' }, 'node_modules/gone': { version: '3.55.0' } }));
    writeFileSync(integrationLock, lockOf({ 'node_modules/kept': { version: '1.0.0' } }));
    installPkg(release, 'node_modules/kept', '1.0.0');
    const tree = generation('v1-aaa', { 'node_modules/gone': '3.55.0' });
    chmodSync(join(tree, 'node_modules/gone/package.json'), 0o444);

    const { code, out } = run();

    expect(code).toBe(0);
    expect(out).toContain('PINNED_LOCK_DEPS_BACKFILL node_modules/gone version=3.55.0 from=v1-aaa');
    expect(out).toContain('status=backfilled drifted=1 backfilled=1 unresolved=0');
    const copied = join(release, 'node_modules/gone/package.json');
    expect(JSON.parse(readFileSync(copied, 'utf8')).version).toBe('3.55.0');
    // Never a hardlink into the frozen generation: a later patch-package write
    // must not be able to reach the immutable snapshot through a shared inode.
    expect(statSync(copied).ino).not.toBe(statSync(join(tree, 'node_modules/gone/package.json')).ino);
    expect(statSync(copied).mode & 0o200).toBe(0o200);
  });

  it('replaces a re-versioned package with the pinned version from the generation that holds it', () => {
    writeFileSync(pinnedLock, lockOf({ 'node_modules/undici': { version: '7.29.1' } }));
    writeFileSync(integrationLock, lockOf({ 'node_modules/undici': { version: '7.30.0' } }));
    installPkg(release, 'node_modules/undici', '7.30.0');
    generation('v1-bbb', { 'node_modules/undici': '7.30.0' });
    generation('v1-ccc', { 'node_modules/undici': '7.29.1' });

    const { code, out } = run();

    expect(code).toBe(0);
    expect(out).toContain('PINNED_LOCK_DEPS_BACKFILL node_modules/undici version=7.29.1 from=v1-ccc');
    expect(JSON.parse(readFileSync(join(release, 'node_modules/undici/package.json'), 'utf8')).version).toBe('7.29.1');
    expect(readdirNames(join(release, 'node_modules'))).toEqual(['undici']);
  });

  it('names drift no generation can supply and exits 3 without touching the tree', () => {
    writeFileSync(pinnedLock, lockOf({ 'node_modules/gone': { version: '1.0.0' } }));
    writeFileSync(integrationLock, lockOf({}));
    generation('v1-ddd', { 'node_modules/gone': '2.0.0' });

    const { code, out } = run();

    expect(code).toBe(3);
    expect(out).toContain('PINNED_LOCK_DEPS_UNRESOLVED node_modules/gone expected=1.0.0 found=missing');
    expect(out).toContain('status=unresolved drifted=1 backfilled=0 unresolved=1');
    expect(existsSync(join(release, 'node_modules/gone'))).toBe(false);
  });

  it('ignores workspace links and optional (platform) packages', () => {
    writeFileSync(
      pinnedLock,
      lockOf({
        'node_modules/@papercusp/ws': { link: true },
        'node_modules/@esbuild/darwin-arm64': { version: '0.25.0', optional: true },
      }),
    );
    writeFileSync(integrationLock, lockOf({}));
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toContain('status=clean drifted=0');
  });

  it('refuses misuse with exit 2', () => {
    const r = spawnSync(process.execPath, [HELPER, '--release', release], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});

function readdirNames(path: string): string[] {
  return spawnSync('ls', ['-1', path], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
}

describe('setup-release-checkout.sh reconcile_pinned_lock_deps() — wiring (WI-10003918)', () => {
  let integrationRoot: string;
  let releaseRoot: string;
  let helperLog: string;
  let helper: string;
  let targetSha: string;

  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', integrationRoot, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };

  beforeEach(() => {
    integrationRoot = realpathSync(mkdtempSync(join(tmpdir(), 'reconcile-int-')));
    releaseRoot = realpathSync(mkdtempSync(join(tmpdir(), 'reconcile-rel-')));
    helperLog = join(releaseRoot, 'helper-args.log');
    helper = join(releaseRoot, 'stub-helper.mjs');
    git('init', '-q');
    writeFileSync(join(integrationRoot, 'package-lock.json'), lockOf({ 'node_modules/gone': { version: '1.0.0' } }));
    git('add', '-A');
    git('commit', '-q', '-m', 'pin');
    targetSha = git('rev-parse', 'HEAD');
    writeFileSync(join(integrationRoot, 'package-lock.json'), lockOf({}));
  });

  afterEach(() => {
    rmSync(integrationRoot, { recursive: true, force: true });
    rmSync(releaseRoot, { recursive: true, force: true });
  });

  function stubHelper(exitCode: number): void {
    writeFileSync(
      helper,
      [
        "import { appendFileSync, readFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(helperLog)}, process.argv.slice(2).join(' ') + '\\n');`,
        "const i = process.argv.indexOf('--pinned-lock');",
        "console.log('PINNED_LOCK_DEPS stub pinned=' + JSON.stringify(Object.keys(JSON.parse(readFileSync(process.argv[i + 1], 'utf8')).packages)));",
        `process.exit(${exitCode});`,
      ].join('\n'),
    );
  }

  function runReconcile(env: Record<string, string> = {}) {
    const wrapper = [
      'set -euo pipefail',
      'log() { echo "[log] $*"; }',
      'source <(sed -n "/^reconcile_pinned_lock_deps()/,/^}/p" "$SETUP_SCRIPT")',
      'reconcile_pinned_lock_deps',
      'echo AFTER-RECONCILE',
    ].join('\n');
    return spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SETUP_SCRIPT: SCRIPT_PATH,
        INTEGRATION_ROOT: integrationRoot,
        RELEASE_ROOT: releaseRoot,
        TARGET_SHA: targetSha,
        PINNED_LOCK_DEPS_HELPER: helper,
        ...env,
      },
      encoding: 'utf8',
    });
  }

  it('hands the helper the TARGET sha lockfile (not the live one) and logs its lines', () => {
    stubHelper(0);
    const r = runReconcile();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[log] PINNED_LOCK_DEPS stub pinned=["","node_modules/gone"]');
    const args = readFileSync(helperLog, 'utf8');
    expect(args).toContain(`--integration-lock ${integrationRoot}/package-lock.json`);
    expect(args).toContain(`--release ${releaseRoot}`);
    expect(args).toContain('--backfill');
  });

  it('WARNS and continues under set -euo pipefail when drift stays unresolved (exit 3)', () => {
    stubHelper(3);
    const r = runReconcile();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('WARN pinned-lock drift unresolved');
    expect(r.stdout).toContain('AFTER-RECONCILE');
  });

  it('continues when the helper itself crashes', () => {
    stubHelper(1);
    const r = runReconcile();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('WARN pinned-lock reconcile did not run cleanly (exit 1)');
    expect(r.stdout).toContain('AFTER-RECONCILE');
  });

  it('is skipped for a pinned dependency generation and for --node-modules skip', () => {
    stubHelper(0);
    expect(runReconcile({ PINNED_DEPENDENCY_GENERATION_ID: 'v1-abc' }).status).toBe(0);
    expect(runReconcile({ NODE_MODULES_MODE: 'skip' }).status).toBe(0);
    expect(existsSync(helperLog)).toBe(false);
  });

  it('removes its temporary pinned-lock extraction', () => {
    stubHelper(0);
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'reconcile-tmp-')));
    try {
      runReconcile({ TMPDIR: tmp });
      expect(readdirNames(tmp)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
