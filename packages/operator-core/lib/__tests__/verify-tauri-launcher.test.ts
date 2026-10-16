import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../../../..');
const source = readFileSync(resolve(repo, 'scripts/verify-tauri-headless.sh'), 'utf8');
const launcher = source.match(/write_and_launch_tauri\(\) \{[\s\S]*?\n\}/)?.[0];
if (!launcher) throw new Error('Maintained native launcher was not found');

function executeLauncher(isolated: boolean) {
  const dir = mkdtempSync(resolve(tmpdir(), 'tauri-launcher-'));
  const capture = resolve(dir, 'npm.json');
  writeFileSync(resolve(dir, 'npm'), `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.FIXTURE_CAPTURE, JSON.stringify({
  pid: process.pid,
  args: process.argv.slice(2),
  env: Object.fromEntries(['PAPERCUSP_CLUSTER', 'PAPERCUSP_SPAWNER_SIDECAR',
    'PAPERCUSP_OPERATOR_URL', 'PAPERCUSP_DEV_HOST_DIAGNOSTIC_DIR',
    'XDG_SESSION_TYPE', 'GH_TOKEN', 'DATABASE_URL'].map(key => [key, process.env[key] ?? null]))
}));
`, { mode: 0o755 });
  try {
    const launchedPid = execFileSync('bash', ['-c', `
set -euo pipefail
WORK="$FIXTURE_DIR"
DESKTOP_DIR="$FIXTURE_DIR"
LOG="$FIXTURE_DIR/tauri.log"
BOOT_ATTEMPTS=1
DEV_PORT=12345
PTY_PORT=12346
DISPLAY_NUM=91
ISOLATED_DB="$FIXTURE_ISOLATED"
WINDOW_GEOMETRY=''
ISOLATED_UNSET_LINE='-u GH_TOKEN'
NATIVE_TERMINAL=1
VERIFY_TAURI_TRACE_SESSION_CHAT_CSS=0
TAURI_OWNER_SID=fixture-owner
TAURI_LAUNCH_PROVENANCE=fixture-provenance
MEMORY_LIMIT_MB=2048
NATIVE_CARGO_DISK_RESERVATION_FILE="$FIXTURE_DIR/disk-reservation"
OPERATOR_SOURCE_ENV_LINE=''
SPA_ENV_LINE=''
ISOLATED_ENV_LINE='DATABASE_URL=postgresql://fixture/isolated'
VERIFY_SCOPE_BASE=fixture
LAUNCH_PREFIX=()
verify_tauri_dev_url() { printf 'http://127.0.0.1:%s' "$1"; }
start_verify_process() {
  bash "$3" > "$2" 2>&1 &
  VERIFY_STARTED_PROCESS_PID=$!
}
${launcher}
write_and_launch_tauri
wait "$TAURI_PID"
printf '%s' "$TAURI_PID"
`], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FIXTURE_DIR: dir,
      FIXTURE_CAPTURE: capture, FIXTURE_ISOLATED: isolated ? '1' : '0', GH_TOKEN: 'must-be-removed' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    return { ...JSON.parse(readFileSync(capture, 'utf8')), launchedPid: Number(launchedPid) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('maintained native generated launcher', () => {
  it.each([true, false])('executes npm with the complete environment (isolated=%s)', (isolated) => {
    const result = executeLauncher(isolated);
    expect(result.launchedPid).toBe(result.pid);
    expect(result.args.slice(0, 5)).toEqual(['run', 'tauri', '--', 'dev', '--no-watch']);
    const config = JSON.parse(result.args[6]);
    expect(config.build.devUrl).toBe(`http://127.0.0.1:12345${isolated ? '?verify-tauri-isolated=1' : ''}`);
    expect(result.env).toMatchObject({ PAPERCUSP_CLUSTER: '0', PAPERCUSP_SPAWNER_SIDECAR: '0',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:12345', XDG_SESSION_TYPE: 'x11',
      GH_TOKEN: null, DATABASE_URL: 'postgresql://fixture/isolated' });
    expect(result.env.PAPERCUSP_DEV_HOST_DIAGNOSTIC_DIR).toContain('/phases/boot/operator-startup/attempt-1');
  });
  it('accepts the maintained launcher before expensive preparation', () => {
    expect(checkPreflight(source)).toBe('accepted');
  });

  it.each(['PAPERCUSP_DEV_HOST_DIAGNOSTIC_DIR', 'PAPERCUSP_TRACE_FIRST_SESSION_CHAT_CSS',
    'PAPERCUSP_CLUSTER', 'PAPERCUSP_OPERATOR_BASE', 'PAPERCUSP_OPERATOR_URL'])
  ('rejects an over-escaped %s continuation before boot', (key) => {
    const corrupted = source.split('\n').map(line =>
      line.startsWith(`  ${key}=`) ? line.replace(/\\+$/, '\\'.repeat(4)) : line).join('\n');
    expect(corrupted).not.toBe(source);
    expect(checkPreflight(corrupted)).toMatchObject({ status: 2,
      stderr: expect.stringContaining('VERIFY_TAURI_LAUNCHER_INVALID') });
  });
});

function checkPreflight(candidate: string) {
  const start = source.indexOf('validate_tauri_launcher_preflight() {');
  const end = source.indexOf('\nvalidate_tauri_launcher_preflight ||', start);
  if (start < 0 || end < 0) throw new Error('Launcher preflight was not found');
  const dir = mkdtempSync(resolve(tmpdir(), 'tauri-launch-preflight-'));
  const file = resolve(dir, 'verifier.sh');
  writeFileSync(file, candidate);
  try {
    execFileSync('bash', ['-c', source.slice(start, end) + '\nvalidate_tauri_launcher_preflight', file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    return 'accepted';
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    return { status: failure.status, stderr: String(failure.stderr ?? '') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('frozen native SPA preparation', () => {
  function prepare(options: { pinned?: boolean; missingBuilder?: boolean; buildExit?: number;
    incomplete?: boolean; external?: boolean; sourceVolumeFull?: boolean } = {}) {
    const dir = mkdtempSync(resolve(tmpdir(), 'tauri-spa-preflight-'));
    const frozen = resolve(dir, 'frozen');
    const app = resolve(frozen, 'apps/operator-vite');
    const capture = resolve(dir, 'build.json');
    const preparation = source.match(/prepare_verifier_spa\(\) \{[\s\S]*?\n\}/)?.[0];
    if (!preparation) throw new Error('Frozen SPA preparation was not found');
    mkdirSync(resolve(app, 'bin'), { recursive: true });
    mkdirSync(resolve(frozen, 'scripts'), { recursive: true });
    if (!options.missingBuilder) writeFileSync(resolve(app, 'bin/vite-build-singleflight'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(resolve(frozen, 'scripts/pc-heavy.sh'), '#!/bin/bash\n[ "$1" != -- ] || shift\nexec "$@"\n');
    writeFileSync(resolve(dir, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.FIXTURE_CAPTURE, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2),
  out: process.env.VITE_BUILD_OUT_ROOT, command: process.env.VITE_BUILD_CMD ?? null,
  viteOut: process.env.PAPERCUSP_VITE_OUT_DIR, finalOut: process.env.PAPERCUSP_VITE_FINAL_OUT_DIR,
  lock: process.env.VITE_BUILD_LOCK ?? null, snapshot: process.env.VITE_BUILD_SNAPSHOT_DIR ?? null,
  retain: process.env.PAPERCUSP_RETAIN_DIST_CHUNKS }));
if (${Boolean(options.sourceVolumeFull)} && process.env.VITE_BUILD_OUT_ROOT === ${JSON.stringify(app)}) process.exit(28);
if (${options.buildExit ?? 0}) process.exit(${options.buildExit ?? 0});
fs.mkdirSync(process.env.VITE_BUILD_OUT_ROOT + '/dist/assets', { recursive: true });
fs.writeFileSync(process.env.VITE_BUILD_OUT_ROOT + '/dist/index.html', 'frozen HTML');
if (!${Boolean(options.incomplete)}) fs.writeFileSync(process.env.VITE_BUILD_OUT_ROOT + '/dist/assets/app.js', 'frozen UI');
`, { mode: 0o755 });
    try {
      const result = spawnSync('bash', ['-c', `set -euo pipefail
OPERATOR_SOURCE_ROOT="$FIXTURE_FROZEN"
WORK="$FIXTURE_DIR"
log() { :; }
${preparation}
prepare_verifier_spa
printf '%s' "$VERIFIER_SPA_DIST"
`], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
        FIXTURE_DIR: dir, FIXTURE_FROZEN: frozen, FIXTURE_CAPTURE: capture,
        VERIFY_TAURI_SOURCE_REF: options.pinned === false ? '' : 'committed-pin',
        PAPERCUSP_SHARED_SPA_DIST: options.external ? resolve(dir, 'unbound-donor-dist') : '',
        VITE_BUILD_CMD: 'unbound-command', VITE_BUILD_LOCK: 'donor-lock', VITE_BUILD_SNAPSHOT_DIR: 'donor-snapshot' } });
      return { status: result.status, stderr: result.stderr, selected: result.stdout,
        expected: resolve(dir, 'verifier-spa/dist'), outputRoot: resolve(dir, 'verifier-spa'), frozen, app,
        sourceOutputExists: existsSync(resolve(app, 'dist')),
        build: existsSync(capture) ? JSON.parse(readFileSync(capture, 'utf8')) : null };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it('builds from pinned source into the admitted work directory and selects only that artifact', () => {
    const result = prepare();
    expect(result.status, result.stderr).toBe(0);
    expect(result.selected).toBe(result.expected);
    expect(result.build).toEqual({ cwd: result.frozen, args: ['--workspace', '@papercusp/operator-vite', 'run', 'build'],
      out: result.outputRoot, viteOut: result.expected, finalOut: result.expected,
      command: null, lock: null, snapshot: null, retain: '0' });
    expect(result.sourceOutputExists).toBe(false);
    expect(source.indexOf('vh_run_step verifier-spa-build')).toBeLessThan(source.indexOf('vh_run_step verifier-host-bundle'));
    expect(source.indexOf('vh_run_step verifier-spa-build')).toBeLessThan(source.indexOf('vh_step isolated-database-prepare'));
  });

  it('builds on the admitted work volume when the source volume refuses output allocation', () => {
    const result = prepare({ sourceVolumeFull: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.selected).toBe(result.expected);
    expect(result.sourceOutputExists).toBe(false);
  });

  it.each([
    [{ missingBuilder: true }, 3, 'VERIFY_TAURI_SPA_BUILD_MISSING'],
    [{ incomplete: true }, 3, 'VERIFY_TAURI_SPA_BUILD_INCOMPLETE'],
    [{ external: true }, 3, 'VERIFY_TAURI_SPA_UNBOUND'],
    [{ buildExit: 17 }, 17, ''],
    [{ buildExit: 28 }, 28, ''],
  ] as const)('refuses boot when frozen SPA preparation fails (%j)', (options, status, marker) => {
    const result = prepare(options);
    expect(result.status).toBe(status);
    expect(result.selected).toBe('');
    expect(result.stderr).toContain(marker);
    if ('missingBuilder' in options || 'external' in options) expect(result.build).toBeNull();
  });

  it('preserves the existing unpinned artifact selection without building', () => {
    const result = prepare({ pinned: false });
    expect(result.status).toBe(0);
    expect(result.selected).toBe('');
    expect(result.build).toBeNull();
  });
});
