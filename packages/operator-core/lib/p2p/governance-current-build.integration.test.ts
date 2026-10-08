import { describe, expect, it } from 'vitest';
import { fork, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const journeys = [
  'packages/operator-core/lib/agent-tools/plans/plan-admission-governance-store.integration.test.ts',
  'packages/operator-core/lib/sync/hyperbee/__tests__/federation-adversarial.integration.test.ts',
];
const sources = [
  ...journeys,
  'scripts/with-test-pg.mjs',
  'packages/operator-core/lib/agent-tools/plans/governance-authentication.ts',
  'packages/operator-core/lib/agent-tools/plans/governance-round.ts',
  'packages/operator-core/lib/agent-tools/plans/governance-voting.ts',
  'packages/operator-core/lib/agent-tools/plans/governance-federation.ts',
  'packages/operator-core/lib/agent-tools/plans/plan-admission-governance-store.ts',
  'packages/operator-core/lib/agent-tools/plans/plan-admission-certificate-source.ts',
  'packages/operator-core/lib/sync/hyperbee/boot.ts',
  'packages/operator-core/lib/sync/hyperbee/read-merge.ts',
  'packages/operator-core/lib/sync/hyperbee/projection.ts',
];

function sourceFingerprint() {
  return createHash('sha256').update(JSON.stringify(sources.map(path => [
    path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex'),
  ]))).digest('hex');
}

/** This is current-build background evidence, not a deployed/API assertion.
 * Reuse the maintained isolated-runtime route and canonical journey suites.
 * The nested ledger is disposable; the parent suite keeps the measured receipt.
 */
describe('isolated current-build governance and P2P journeys', () => {
  it('runs real signed PG and DHT journeys in a private runtime and verifies teardown', async () => {
    const before = sourceFingerprint();
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const messages: Array<Record<string, unknown>> = [];
    let output = '';
    // The outer canonical runner already owns these barriers. A nested
    // runner must not republish or remove its live parent's marker.
    const environment = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0' };
    delete environment.PC_HEAVY_PREEMPT_READY_FILE;
    delete environment.PC_HEAVY_PSI_FINALIZATION_FILE;
    expect(environment.PC_HEAVY_PREEMPT_READY_FILE).toBeUndefined();
    expect(environment.PC_HEAVY_PSI_FINALIZATION_FILE).toBeUndefined();
    const child = fork(resolve(root, 'scripts/with-test-pg.mjs'), [
      '--isolated-runtime', '--', process.execPath,
      '--import', resolve(root, 'scripts/lib/committed-source-loader.mjs'),
      resolve(root, 'scripts/test-files.mjs'), ...journeys,
    ], {
      cwd: root,
      execArgv: [],
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout!.on('data', chunk => { output += String(chunk); });
    child.stderr!.on('data', chunk => { output += String(chunk); });
    child.on('message', message => {
      if (message && typeof message === 'object') messages.push(message as Record<string, unknown>);
    });
    const result = await new Promise<{ code: number | null; signal: string | null }>((done, reject) => {
      const timeout = setTimeout(() => child.kill('SIGTERM'), 140_000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timeout); done({ code, signal }); });
    });
    const cleanOutput = output.replace(/\u001b\[[0-9;]*m/g, '');
    expect(result, cleanOutput.slice(-12_000)).toEqual({ code: 0, signal: null });
    expect(cleanOutput).toMatch(/Test Files\s+2 passed\s+\(2\)/);
    expect(cleanOutput).toMatch(/Tests\s+13 passed\s+\(13\)/);
    const start = messages.find(message => message.kind === 'isolated-runtime-start');
    const end = messages.find(message => message.kind === 'isolated-runtime-end');
    expect(start).toBeDefined();
    expect(end).toMatchObject({ exitCode: 0, signal: null, runtimeRemoved: true, pgDataRemoved: true });
    expect(start!.root).toBe(root);
    expect(start!.workspace).toMatch(/^test-runtime-/);
    expect(start!.workspace).not.toBe(process.env.PAPERCUSP_WORKSPACE_ID);
    expect(start!.pgPort).toBeGreaterThan(0);
    expect(start!.pgPort).not.toBe(5432);
    expect(typeof start!.runtimeRoot).toBe('string');
    expect(typeof start!.dataDir).toBe('string');
    expect(existsSync(String(start!.runtimeRoot))).toBe(false);
    expect(existsSync(String(start!.dataDir))).toBe(false);
    expect(end!.childPid).toBe(start!.childPid);
    expect(() => process.kill(Number(start!.childPid), 0)).toThrow();
    expect(sourceFingerprint()).toBe(before);
    console.log('GOVERNANCE_P2P_CURRENT_BUILD_RECEIPT ' + JSON.stringify({
      commit, sourceFingerprint: before, sourcePaths: sources, journeys,
      runtime: start, cleanup: end, scope: 'isolated current-build background; no deployed or HTTP API claim',
    }));
  }, 150_000);
});
