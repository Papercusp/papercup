import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { buildPrivateOperatorApiBundle, privateBundleRuntimeEnv, waitForPrivateOperator } from './private-http-workspace-preflight';

const dirs: string[] = [];
const common = resolve(import.meta.dirname, '../../../apps/operator/bin/bundle-host-common.sh');
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('stops builder descendants on timeout and retains the original diagnostics', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-builder-')); dirs.push(evidenceDir);
  const childFile = join(evidenceDir, 'descendant.pid');
  let descendant: number | undefined;
  try {
    expect(() => buildPrivateOperatorApiBundle(evidenceDir, evidenceDir, { command: 'bash',
      args: ['-c', 'source "$2"; BUNDLE_HOST_STEP_LOG="$3"; bundle_host_run_step blocked-builder bash -c \'sleep 60 & echo $! > "$1"; echo CHILD_READY; wait\' _ "$1"',
        '_', childFile, common, join(evidenceDir, 'hono-host.mjs.build-steps.jsonl')],
      timeoutMs: 1000 })).toThrow(/ETIMEDOUT/);
    descendant = Number(readFileSync(childFile, 'utf8'));
    expect(readFileSync(join(evidenceDir, 'operator-api-build.log'), 'utf8')).toContain('CHILD_READY');
    const receipt = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
    expect(receipt).toMatchObject({ signal: 'SIGKILL', status: null, error: { code: 'ETIMEDOUT' }, groupStop: 'signaled' });
    expect(receipt.steps).toMatchObject({ active: 'blocked-builder', count: 1, unreadableRows: [],
      last: { step: 'blocked-builder', event: 'start', pid: expect.any(Number), at: expect.any(Number) } });
    await expect.poll(() => {
      try { return readFileSync(`/proc/${descendant}/stat`, 'utf8').split(') ')[1].split(' ')[0]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone'; throw error; }
    }).toMatch(/^(?:gone|Z|X)$/);
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* already stopped */ } }
  }
});

it('retains completed step timing and the failing command status', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-builder-')); dirs.push(evidenceDir);
  const journal = join(evidenceDir, 'hono-host.mjs.build-steps.jsonl');
  expect(() => buildPrivateOperatorApiBundle(evidenceDir, evidenceDir, { command: 'bash',
    args: ['-c', 'source "$1"; BUNDLE_HOST_STEP_LOG="$2"; bundle_host_run_step cli-guard bash -c "exit 17"',
      '_', common, journal], timeoutMs: 1000 })).toThrow(/exited 17/);
  const receipt = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
  expect(receipt).toMatchObject({ status: 17, steps: { active: null, count: 2, unreadableRows: [],
    durationsMs: [{ step: 'cli-guard', status: 17, elapsedMs: expect.any(Number) }] } });
  expect(receipt.steps.durationsMs[0].elapsedMs).toBeGreaterThanOrEqual(0);
});

it('preserves the timeout when the final journal append is partial', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-builder-')); dirs.push(evidenceDir);
  writeFileSync(join(evidenceDir, 'hono-host.mjs.build-steps.jsonl'),
    JSON.stringify({ at: 1, pid: 1, step: 'syntax-check', event: 'start' }) + '\n{"at":');
  expect(() => buildPrivateOperatorApiBundle(evidenceDir, evidenceDir, { command: 'bash',
    args: ['-c', 'sleep 60'], timeoutMs: 100 })).toThrow(/ETIMEDOUT/);
  const receipt = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
  expect(receipt).toMatchObject({ error: { code: 'ETIMEDOUT' }, steps: { active: 'syntax-check', unreadableRows: [2] } });
});

it.each(['--import=tsx', '--import "tsx"', '--loader=tsx/esm', '--require tsx/cjs',
  '--import="file:///repo/node_modules/tsx/dist/loader.mjs"'])('removes %s and preserves guarded plain Node options', preload => {
  const guard = '--import="/repo with spaces/scripts/lib/committed-source-loader.mjs"';
  const env = { NODE_OPTIONS: `${guard} ${preload} --max-old-space-size=4096 --trace-warnings`, OTHER: 'keep' };
  expect(privateBundleRuntimeEnv(env)).toEqual({ ...env,
    NODE_OPTIONS: `${guard} --max-old-space-size=4096 --trace-warnings` });
  expect(env.NODE_OPTIONS).toContain(preload);
});

it.each(['--import=/repo/scripts/lib/vitest-startup-trace.mjs',
  '--import "file:///repo%20with%20spaces/scripts/lib/vitest-startup-trace.mjs"',
  '--require=/repo/scripts/lib/vitest-startup-trace.mjs'])('removes test-owned startup trace %s while retaining source guards', preload => {
  const guard = '--import="/repo with spaces/scripts/lib/committed-source-loader.mjs"';
  const env = { NODE_OPTIONS: `${preload} ${guard} --trace-warnings`, OTHER: 'keep' };
  expect(privateBundleRuntimeEnv(env)).toEqual({ ...env, NODE_OPTIONS: `${guard} --trace-warnings` });
  expect(env.NODE_OPTIONS).toContain(preload);
});

it('preserves unrelated loaders and similarly named imports', () => {
  const env = { NODE_OPTIONS: '--import=/repo/tsx-observer.mjs --loader=other-loader --require ./guard.cjs'
    + ' --import=/repo/other/vitest-startup-trace.mjs --import=/repo/scripts/lib/vitest-startup-trace.mjs-extra' };
  expect(privateBundleRuntimeEnv(env)).toEqual(env);
});

it('boots a real confined Node descendant after removing the inaccessible test tracer and keeps its source guard', () => {
  const traceRoot = mkdtempSync(join(tmpdir(), 'private-hidden-trace-')); dirs.push(traceRoot);
  const guardRoot = mkdtempSync(join(tmpdir(), 'private-visible-guard-')); dirs.push(guardRoot);
  mkdirSync(join(traceRoot, 'scripts/lib'), { recursive: true });
  const trace = join(traceRoot, 'scripts/lib/vitest-startup-trace.mjs');
  const guard = join(guardRoot, 'committed-source-loader.mjs');
  writeFileSync(trace, 'globalThis.privateTraceLoaded = true;');
  writeFileSync(guard, 'globalThis.privateGuardLoaded = true;');
  const env = { ...process.env,
    NODE_OPTIONS: `--import=${JSON.stringify(pathToFileURL(trace).href)} --import=${JSON.stringify(pathToFileURL(guard).href)} --trace-warnings` };
  const args = ['--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
    '--ro-bind', guardRoot, guardRoot, '--tmpfs', traceRoot, '--', process.execPath, '-e',
    'console.log(JSON.stringify({guard:globalThis.privateGuardLoaded,trace:globalThis.privateTraceLoaded??false}))'];
  const failed = spawnSync('bwrap', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 });
  expect(failed.error).toBeUndefined();
  expect(failed.status, failed.stderr).toBe(1);
  expect(failed.stderr).toContain('ERR_MODULE_NOT_FOUND');
  expect(failed.stderr).toContain('vitest-startup-trace.mjs');
  const launched = spawnSync('bwrap', args, { env: privateBundleRuntimeEnv(env),
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 });
  expect(launched.error).toBeUndefined();
  expect(launched.status, launched.stderr).toBe(0);
  expect(JSON.parse(launched.stdout)).toEqual({ guard: true, trace: false });
});

it.each(['signal', 'exit'] as const)('persists readiness evidence when the real child terminates by %s', async kind => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-readiness-')); dirs.push(evidenceDir);
  const child = spawn(process.execPath, ['-e', kind === 'signal'
    ? 'process.kill(process.pid,"SIGTERM")' : 'process.exit(17)'], { env: privateBundleRuntimeEnv(process.env) });
  await once(child, 'close');
  await expect(waitForPrivateOperator({ host: child, base: 'http://127.0.0.1:1', evidenceDir,
    environment: { MALLOC_ARENA_MAX: '2' }, timeoutMs: 1000 })).rejects.toThrow(/before readiness/);
  const receipt = JSON.parse(readFileSync(join(evidenceDir, 'readiness.json'), 'utf8'));
  expect(receipt).toMatchObject({ attempts: 0, mallocArenaMax: '2', failure: expect.stringContaining('before readiness'),
    exitCode: kind === 'exit' ? 17 : null, signalCode: kind === 'signal' ? 'SIGTERM' : null });
});

it('retains the successful health probe and actual launch options', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-readiness-')); dirs.push(evidenceDir);
  const server = createServer((_, response) => response.end(JSON.stringify({ service: 'papercusp-operator' })));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: privateBundleRuntimeEnv(process.env) });
  const environment = privateBundleRuntimeEnv({ NODE_OPTIONS: '--import=tsx --trace-warnings' });
  try {
    const address = server.address() as { port: number };
    await expect(waitForPrivateOperator({ host: child, base: `http://127.0.0.1:${address.port}`, evidenceDir,
      environment, timeoutMs: 1000 })).resolves.toEqual({ service: 'papercusp-operator' });
    expect(JSON.parse(readFileSync(join(evidenceDir, 'readiness.json'), 'utf8'))).toMatchObject({
      attempts: 1, nodeOptions: '--trace-warnings', probes: [{ status: 200, service: 'papercusp-operator', elapsedMs: expect.any(Number) }] });
  } finally {
    const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
    server.close(); await once(server, 'close');
  }
});
