import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { assertNativeIsolatedWorkspace, NATIVE_CUSTODY_LIFECYCLE_PICK, readNativeCustodyLifecycle } from './testing-native-runtime';
import { applyPick } from './result-projection/apply';

const root = resolve(import.meta.dirname, '../../..');
const modulePath = join(root, 'packages/operator-core/lib/testing-native-runtime.ts');
const bwrap = spawnSync('bwrap', ['--unshare-user', '--dev-bind', '/', '/', '--die-with-parent', '--', 'true']);

it('preserves empty and populated native custody timelines through the real response projection', () => {
  const id = 'WI-native-custody-projection';
  const coverage = { auditRows: 0, reopenEntries: 0, notRecorded: ['continuity unknown'],
    truncated: false, invalidEntries: 0, degraded: false };
  const event = { at: '2026-11-18T00:00:00.000Z', atMs: 1794960000000, kind: 'other',
    by: null, source: 'audit_log', action: 'work_items:custody:capture',
    custodyCapture: { receipt: 'valid', operation: 'UPDATE', actorAuthentication: 'unverified',
      continuity: 'unknown', problems: [] } };
  for (const events of [[], [event]]) {
    const source = { results: [{ id, lifecycle: { events, coverage }, workItem: { title: 'unselected' } }] };
    const { picked, unmatched } = applyPick(source, NATIVE_CUSTODY_LIFECYCLE_PICK);
    expect(unmatched).toEqual([]);
    expect(picked).toEqual({ results: [{ id, lifecycle: { events, coverage } }] });
    expect(readNativeCustodyLifecycle(JSON.parse(JSON.stringify(picked)), id)).toEqual({ events, coverage });
  }
  const empty = { results: [{ id, lifecycle: { events: [], coverage } }] };
  const oldSelection = applyPick(empty, ['results[].id',
    'results[].lifecycle.events[].action', 'results[].lifecycle.events[].custodyCapture',
    'results[].lifecycle.coverage']).picked;
  expect(() => readNativeCustodyLifecycle(oldSelection, id)).toThrow('event array and coverage');
  for (const lifecycle of [{ coverage }, { events: null, coverage }, { events: {}, coverage },
    { events: [] }, { events: [], coverage: { notRecorded: null } }])
    expect(() => readNativeCustodyLifecycle({ results: [{ id, lifecycle }] }, id))
      .toThrow('event array and coverage');
  for (const response of [null, {}, { results: [] },
    { results: [{ id: 'WI-foreign', lifecycle: { events: [], coverage } }] }])
    expect(() => readNativeCustodyLifecycle(response, id)).toThrow('requested work-item');
});

it('preserves native fixture isolation through actual hermetic worker setup', async () => {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, {
      PAPERCUSP_WORKSPACE: 'verify-tauri-isolated-90',
      PAPERCUSP_WORKSPACE_ID: 'verify-tauri-isolated-90',
      PAPERCUSP_VERIFY_TAURI_ISOLATED: '1', PAPERCUSP_SKIP_PG_DISCOVERY: '1',
    });
    expect(assertNativeIsolatedWorkspace()).toBe('verify-tauri-isolated-90');
    vi.resetModules();
    await import('../../../libs/test-config/src/setup-hermetic-env');
    expect(process.env.PAPERCUSP_WORKSPACE_ID).toBeUndefined();
    expect(assertNativeIsolatedWorkspace()).toBe('verify-tauri-isolated-90');
    for (const override of [
      { PAPERCUSP_WORKSPACE: 'papercusp-workspace' },
      { PAPERCUSP_WORKSPACE: undefined },
      { PAPERCUSP_WORKSPACE_ID: 'verify-tauri-isolated-91' },
      { PAPERCUSP_VERIFY_TAURI_ISOLATED: undefined },
      { PAPERCUSP_SKIP_PG_DISCOVERY: '0' },
    ]) expect(() => assertNativeIsolatedWorkspace({ ...process.env, ...override }))
      .toThrow('Native fixture requires the owned isolated workspace');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

it.skipIf(bwrap.status !== 0)('keeps native custody outside a mutation overlay and rejects source mismatch and process exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-runtime-wrapper-test-'));
  const receipt = join(dir, 'receipt.json');
  const socketReceipt = join(dir, 'socket');
  const livenessCheck = join(dir, 'check-live.sh');
  const owner = 'native-runtime-test-owner';
  const provenance = 'native-runtime-test-launch';
  const guard = `#!/usr/bin/env bash
set -eu
env_p="$(tr '\\0' '\\n' < "/proc/$VERIFY_TAURI_PID/environ")"
if ! grep -qxF 'PAPERCUSP_SID=${owner}' <<<"$env_p" \\
  || ! grep -qxF 'PAPERCUSP_TAURI_LAUNCH_PROVENANCE=${provenance}' <<<"$env_p"; then
  echo 'native launch provenance mismatch' >&2
  exit 1
fi
`;
  writeFileSync(livenessCheck, guard);
  const commit = 'a'.repeat(40);
  writeFileSync(receipt, JSON.stringify({ schemaVersion: 'verifier-source-v1', sourceCommit: commit }));
  const native = spawn(process.execPath, ['-e', 'console.log("READY"); setInterval(() => {}, 1000)'], {
    env: { ...process.env, PAPERCUSP_SID: owner, PAPERCUSP_TAURI_LAUNCH_PROVENANCE: provenance },
  });
  try {
    await new Promise<void>((done, reject) => {
      native.stdout.once('data', () => done());
      native.once('error', reject);
    });
    const env: Record<string, string | undefined> = { ...process.env, VERIFY_TAURI_PID: String(native.pid), OPERATOR_SOURCE_ROOT: root,
      VERIFY_TAURI_SOURCE_REF: commit, VERIFY_TAURI_SOURCE_RECEIPT: receipt,
      VERIFY_TAURI_LIVENESS_CHECK: livenessCheck,
      PAPERCUSP_NATIVE_RUNTIME_OBSERVER_SOCKET: undefined };
    // Actual-goal journeys can use the shared database read-only. Native
    // custody is proven by the source receipt and original process identity.
    delete env.PAPERCUSP_VERIFY_TAURI_ISOLATED;
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', modulePath, '--with-native-observer', '--',
        'bwrap', '--unshare-user', '--dev-bind', '/', '/', '--die-with-parent', '--', process.execPath,
        '--import', 'tsx', '--input-type=module', '-e', `
          import assert from 'node:assert/strict';
          import { readFileSync, statSync, writeFileSync } from 'node:fs';
          import { assertNativeRuntimeLiveness, prepareNativeRuntimeReader } from ${JSON.stringify(pathToFileURL(modulePath).href)};
          assert.throws(() => statSync('/proc/' + process.env.VERIFY_TAURI_PID + '/exe'), { code: 'EACCES' });
          assert.throws(() => readFileSync('/proc/' + process.env.VERIFY_TAURI_PID + '/environ'), { code: 'EACCES' });
          writeFileSync(${JSON.stringify(socketReceipt)}, process.env.PAPERCUSP_NATIVE_RUNTIME_OBSERVER_SOCKET);
          const read = prepareNativeRuntimeReader(${JSON.stringify(root)}, ${JSON.stringify(commit)});
          assert.match(read().fingerprint, /^[a-f0-9]{64}$/);
          assert.match(assertNativeRuntimeLiveness(${JSON.stringify(root)}, ${JSON.stringify(commit)}).fingerprint, /^[a-f0-9]{64}$/);
          for (const badGuard of [
            ${JSON.stringify(guard.replace(owner, 'another-owner'))},
            ${JSON.stringify(guard.replace(provenance, 'another-launch'))},
          ]) {
            writeFileSync(${JSON.stringify(livenessCheck)}, badGuard);
            assert.throws(() => assertNativeRuntimeLiveness(${JSON.stringify(root)}, ${JSON.stringify(commit)}), /launch provenance mismatch/);
          }
          writeFileSync(${JSON.stringify(livenessCheck)}, ${JSON.stringify(guard)});
          assert.match(assertNativeRuntimeLiveness(${JSON.stringify(root)}, ${JSON.stringify(commit)}).fingerprint, /^[a-f0-9]{64}$/);
          assert.throws(() => assertNativeRuntimeLiveness(${JSON.stringify(root)}, 'b'.repeat(40)), /source receipt mismatch/);
          console.log('PROVENANCE_VERIFIED');
          assert.throws(() => prepareNativeRuntimeReader(${JSON.stringify(root)}, 'b'.repeat(40)), /source receipt mismatch/);
          console.log('WITNESS_READY');
          const end = Date.now() + 10000;
          const timer = setInterval(() => {
            if (read() === null) { clearInterval(timer); console.log('EXIT_REFUSED'); process.exitCode = 7; }
            else if (Date.now() > end) { clearInterval(timer); process.exitCode = 9; }
          }, 50);
        `], { cwd: root, env });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`observer timed out: ${stderr}`)); }, 30000);
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.includes('WITNESS_READY')) native.kill('SIGTERM');
      });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); done({ code, stdout, stderr }); });
    });
    expect(result.code, result.stderr).toBe(7);
    expect(result.stdout).toContain('PROVENANCE_VERIFIED');
    expect(result.stdout).toContain('EXIT_REFUSED');
    expect(existsSync(readFileSync(socketReceipt, 'utf8'))).toBe(false);
    const refused = spawnSync('bash', [join(root, 'scripts/mutation-probe.sh'), '--help'], {
      cwd: root, env: { ...env, TMPDIR: dir, VERIFY_TAURI_SOURCE_REF: 'b'.repeat(40) }, encoding: 'utf8', timeout: 10000,
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('native runtime source receipt mismatch');
    expect(readdirSync(dir).filter(name => name.startsWith('mutation-probe-source.'))).toEqual([]);
  } finally {
    native.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
}, 45000);

it('cancels an actual native mutation guard and removes its observer and frozen script', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-mutation-cancel-test-'));
  const receipt = join(dir, 'receipt.json');
  const marker = join(dir, 'guard-ready');
  const subject = join(dir, 'subject.txt');
  const commit = 'a'.repeat(40);
  writeFileSync(receipt, JSON.stringify({ schemaVersion: 'verifier-source-v1', sourceCommit: commit }));
  writeFileSync(subject, 'alpha\n');
  const native = spawn(process.execPath, ['-e', 'console.log("READY"); setInterval(() => {}, 1000)']);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await new Promise<void>((done, reject) => {
      native.stdout.once('data', () => done());
      native.once('error', reject);
    });
    child = spawn('bash', [join(root, 'scripts/mutation-probe.sh'), '--file', subject,
      '--mutate', 's/alpha/beta/', '--test',
      `printf '%s' "$PAPERCUSP_NATIVE_RUNTIME_OBSERVER_SOCKET" > ${JSON.stringify(marker)}; sleep 30; grep -q alpha {}`], {
      cwd: root,
      // This guard writes only to the temp marker and subject; checkout containment is out of scope here.
      env: { ...process.env, TMPDIR: dir, MUTATION_PROBE_CONTAIN_WRITES: '0', VERIFY_TAURI_PID: String(native.pid), OPERATOR_SOURCE_ROOT: root,
        VERIFY_TAURI_SOURCE_REF: commit, VERIFY_TAURI_SOURCE_RECEIPT: receipt,
        PAPERCUSP_NATIVE_RUNTIME_OBSERVER_SOCKET: undefined },
    });
    let stderr = '';
    child.stdout!.resume();
    child.stderr!.on('data', chunk => { stderr += chunk; });
    const closed = new Promise<number | null>((done, reject) => {
      child!.once('close', done);
      child!.once('error', reject);
    });
    // The probe prepares source/write containment before it invokes the guard
    // command. Leave most of the 45s test budget for that readiness signal,
    // keeping 15s for cancellation and cleanup.
    const deadline = Date.now() + 30000;
    while (!existsSync(marker) && Date.now() < deadline && child.exitCode === null)
      await new Promise(done => setTimeout(done, 25));
    expect(existsSync(marker), stderr).toBe(true);
    const socket = readFileSync(marker, 'utf8');
    expect(existsSync(socket)).toBe(true);
    child.kill('SIGTERM');
    expect(await closed, stderr).toBe(143);
    expect(existsSync(socket)).toBe(false);
    expect(readdirSync(dir).filter(name => name.startsWith('mutation-probe-source.'))).toEqual([]);
    expect(readFileSync(subject, 'utf8')).toBe('alpha\n');
  } finally {
    child?.kill('SIGTERM');
    native.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
}, 45000);
