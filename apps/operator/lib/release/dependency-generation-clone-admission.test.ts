import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const script = process.env.DEPENDENCY_GENERATION_SCRIPT
  ?? resolve(__dirname, '../../bin/release/dependency-generation.sh');
const roots: string[] = [];
function writableDirectories(root: string) {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return;
  chmodSync(root, 0o700);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) writableDirectories(join(root, entry.name));
  }
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    writableDirectories(root);
    rmSync(root, { recursive: true, force: true });
  }
});

async function fixture(run: (env: NodeJS.ProcessEnv, root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'immutable-clone-admission-'));
  roots.push(root);
  const source = join(root, 'generation/tree/node_modules');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'value'), 'immutable\n');
  chmodSync(join(source, 'value'), 0o444);
  writeFileSync(join(root, 'generation/.tree-bytes'), 'node_modules\t5000\n');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // Model a CoW-capable filesystem on portable test filesystems. Ordinary
  // copying still uses the real copier/lock; a strict clone makes independent
  // inodes. The production command must explicitly forbid a full-copy fallback.
  writeFileSync(join(bin, 'cp'), [
    '#!/usr/bin/env bash',
    'if [ "$1" = -a ] && [ "$2" = --reflink=always ]; then',
    '  printf "clone\\n" >> "$CLONE_CALLS"',
    '  [ "$CLONE_SUPPORTED" = 1 ] || exit 1',
    '  shift 2',
    '  exec /bin/cp -a "$@"',
    'fi',
    'exec /bin/cp "$@"',
  ].join('\n') + '\n', { mode: 0o755 });
  const lock = join(root, 'copy.lock');
  const holder = spawn('bash', ['-c', 'exec 9>>"$1"; flock 9; echo locked; exec sleep 60', 'holder', lock],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise<void>(done => holder.once('exit', () => done()));
  try {
    await new Promise<void>((ready, reject) => {
      const timer = setTimeout(() => reject(new Error('copy lock holder did not become ready')), 10_000);
      holder.once('error', error => { clearTimeout(timer); reject(error); });
      holder.stdout.once('data', chunk => {
        clearTimeout(timer);
        String(chunk).includes('locked') ? ready() : reject(new Error('unexpected lock control output'));
      });
    });
    run({ ...process.env, SCRIPT: script, SOURCE: source,
      DEST: join(root, 'out/node_modules'), PATH: bin + ':' + process.env.PATH,
      CLONE_SUPPORTED: '1', CLONE_CALLS: join(root, 'clone.calls'),
      DEPENDENCY_GENERATION_ALLOW_HARDLINK: '0', DEPENDENCY_GENERATION_FORCE_COPY: '1',
      DEPENDENCY_GENERATION_COPY_LOCK_FILE: lock,
      DEPENDENCY_GENERATION_COPY_LOCK_TIMEOUT_SEC: '1', DEPENDENCY_GENERATION_COPY_LOCK_MAX_SEC: '1',
      DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES: '10000',
      DEPENDENCY_GENERATION_HEADROOM_TOTAL_BYTES: '100000',
      DEPENDENCY_GENERATION_HEADROOM_RESERVE_PCT: '2',
      DEPENDENCY_GENERATION_HEADROOM_MARGIN_BYTES: '1000',
      DEPENDENCY_GENERATION_RESERVE_FS_PATH: '', DEPENDENCY_GENERATION_HEADROOM_SAME_FS: '1',
    }, root);
  } finally {
    if (holder.pid && holder.exitCode === null && holder.signalCode === null)
      process.kill(-holder.pid, 'SIGKILL');
    await exited;
  }
}

function materialize(env: NodeJS.ProcessEnv) {
  mkdirSync(dirname(env.DEST!), { recursive: true });
  return spawnSync('bash', ['-c', 'set -euo pipefail; source "$SCRIPT"; dependency_generation_materialize_tree "$SOURCE" "$DEST"'],
    { env, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
}

it('materializes an independent immutable clone while a peer holds physical copy capacity', async () => {
  await fixture((env, root) => {
    const result = materialize(env);
    expect(result.status, result.stderr).toBe(0);
    const copied = join(env.DEST!, 'value'), original = join(env.SOURCE!, 'value');
    expect(readFileSync(join(root, 'clone.calls'), 'utf8')).toBe('clone\n');
    expect(statSync(copied).ino).not.toBe(statSync(original).ino);
    chmodSync(copied, 0o644);
    writeFileSync(copied, 'private mutation\n');
    expect(readFileSync(original, 'utf8')).toBe('immutable\n');
  });
}, 30_000);

it('keeps ordinary copy admission when strict immutable cloning is unsupported', async () => {
  await fixture((env, root) => {
    const result = materialize({ ...env, CLONE_SUPPORTED: '0' });
    expect(result.status, result.stderr).toBe(76);
    expect(result.stderr).toContain('DEPENDENCY_GENERATION_LOCK_TIMEOUT');
    expect(existsSync(env.DEST!)).toBe(false);
    expect(readFileSync(join(root, 'clone.calls'), 'utf8')).toBe('clone\n');
  });
}, 30_000);

it.each(['clone', 'physical', 'portable'] as const)(
  'verifier %s copies preserve executable and internal link semantics without borrowing source inodes', method => {
    const root = mkdtempSync(join(tmpdir(), 'verifier-copy-profile-'));
    roots.push(root);
    const source = join(root, 'source');
    const destination = join(root, 'output/node_modules');
    mkdirSync(source);
    const executable = join(source, 'tool');
    writeFileSync(executable, '#!/bin/sh\nprintf verifier-copy-ok\\n\n', { mode: 0o555 });
    linkSync(executable, join(source, 'alias'));
    symlinkSync('tool', join(source, 'bin'));
    const external = join(root, 'external');
    writeFileSync(external, 'outside snapshot');
    symlinkSync('../external', join(source, 'external-link'));
    utimesSync(executable, 1, 1);
    chmodSync(source, 0o555);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'cp'), [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$*" >> "$COPY_CALLS"',
      'args=()',
      'for arg in "$@"; do',
      '  if [ "$arg" = --reflink=always ]; then',
      '    [ "$COPY_METHOD" = clone ] || exit 1',
      '  elif [ "$arg" = --reflink=auto ]; then',
      '    [ "$COPY_METHOD" != portable ] || exit 1',
      '  else args+=("$arg"); fi',
      'done',
      'exec /bin/cp "${args[@]}"',
    ].join('\n') + '\n', { mode: 0o755 });
    const result = spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'source "$SCRIPT"',
      // Model a platform without GNU device/headroom probes, independently of
      // the copier being exercised. Copy admission itself remains real.
      'dependency_generation_check_headroom() { return 0; }',
      'umask 077',
      'dependency_generation_materialize_tree "$SOURCE" "$DEST" verifier',
    ].join('\n')], { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL', env: {
      ...process.env, SCRIPT: script, SOURCE: source, DEST: destination,
      PATH: bin + ':' + process.env.PATH, COPY_METHOD: method, COPY_CALLS: join(root, 'calls'),
      DEPENDENCY_GENERATION_ALLOW_HARDLINK: '1',
      DEPENDENCY_GENERATION_COPY_LOCK_FILE: join(root, 'copy.lock'),
    } });
    // Restore source directory write access even if the copy/assertions fail.
    chmodSync(source, 0o755);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const copied = join(destination, 'tool');
    expect(statSync(copied).ino).not.toBe(statSync(executable).ino);
    expect(statSync(join(destination, 'alias')).ino).toBe(statSync(copied).ino);
    expect(statSync(copied).mode & 0o777).toBe(0o555);
    expect(lstatSync(join(destination, 'bin')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(destination, 'bin'))).toBe('tool');
    expect(readlinkSync(join(destination, 'external-link'))).toBe('../external');
    if (method !== 'portable') expect(statSync(copied).mtimeMs).not.toBe(1000);
    expect(readFileSync(join(root, 'calls'), 'utf8')).not.toContain('-al');
    chmodSync(copied, 0o755);
    writeFileSync(copied, 'private mutation');
    expect(readFileSync(executable, 'utf8')).toContain('verifier-copy-ok');
    expect(statSync(executable).mode & 0o777).toBe(0o555);
    expect(readFileSync(join(destination, 'alias'), 'utf8')).toBe('private mutation');
    expect(readFileSync(external, 'utf8')).toBe('outside snapshot');
  }, 30_000,
);

it('preserves headroom refusal before cloning even when physical copy capacity is busy', async () => {
  await fixture((env, root) => {
    const result = materialize({ ...env, DEPENDENCY_GENERATION_HEADROOM_AVAIL_BYTES: '7999' });
    expect(result.status, result.stderr).toBe(77);
    expect(result.stderr).toContain('DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT');
    expect(existsSync(env.DEST!)).toBe(false);
    expect(existsSync(join(root, 'clone.calls'))).toBe(false);
  });
}, 30_000);
