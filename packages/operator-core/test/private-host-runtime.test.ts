import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { buildPrivateOperatorApiBundle, privateBundleRuntimeEnv, waitForPrivateOperator } from './private-http-workspace-preflight';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('stops builder descendants on timeout and retains the original diagnostics', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-builder-')); dirs.push(evidenceDir);
  const childFile = join(evidenceDir, 'descendant.pid');
  let descendant: number | undefined;
  try {
    expect(() => buildPrivateOperatorApiBundle(evidenceDir, evidenceDir, { command: 'bash',
      args: ['-c', 'sleep 60 & echo $! > "$1"; echo CHILD_READY; wait', '_', childFile],
      timeoutMs: 1000 })).toThrow(/ETIMEDOUT/);
    descendant = Number(readFileSync(childFile, 'utf8'));
    expect(readFileSync(join(evidenceDir, 'operator-api-build.log'), 'utf8')).toContain('CHILD_READY');
    const receipt = JSON.parse(readFileSync(join(evidenceDir, 'operator-api-build-result.json'), 'utf8'));
    expect(receipt).toMatchObject({ signal: 'SIGKILL', status: null, error: { code: 'ETIMEDOUT' }, groupStop: 'signaled' });
    await expect.poll(() => {
      try { return readFileSync(`/proc/${descendant}/stat`, 'utf8').split(') ')[1].split(' ')[0]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone'; throw error; }
    }).toMatch(/^(?:gone|Z|X)$/);
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* already stopped */ } }
  }
});

it.each(['--import=tsx', '--import "tsx"', '--loader=tsx/esm', '--require tsx/cjs',
  '--import="file:///repo/node_modules/tsx/dist/loader.mjs"'])('removes %s and preserves guarded plain Node options', preload => {
  const guard = '--import="/repo with spaces/scripts/lib/committed-source-loader.mjs"';
  const env = { NODE_OPTIONS: `${guard} ${preload} --max-old-space-size=4096 --trace-warnings`, OTHER: 'keep' };
  expect(privateBundleRuntimeEnv(env)).toEqual({ ...env,
    NODE_OPTIONS: `${guard} --max-old-space-size=4096 --trace-warnings` });
  expect(env.NODE_OPTIONS).toContain(preload);
});

it('preserves unrelated loaders and similarly named imports', () => {
  const env = { NODE_OPTIONS: '--import=/repo/tsx-observer.mjs --loader=other-loader --require ./guard.cjs' };
  expect(privateBundleRuntimeEnv(env)).toEqual(env);
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
