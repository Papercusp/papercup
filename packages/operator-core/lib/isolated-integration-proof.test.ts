import { expect, it, vi } from 'vitest';
import { fork } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pruneRuns, runHarness } from '@papercusp/verification-harness';
import { captureIsolatedWorker, recordIsolatedIntegrationProof } from '../test/isolated-integration-proof';

// Only the parent's telemetry database is substituted. The proof writer,
// worker IPC, kernel process identities, receipt retention and pruning are real.
vi.mock('../test/_org-test-db', () => ({ createOrgTestDb: async () => ({
  dbName: 'isolated-proof-telemetry', adminDsn: 'unused', adminSql: {}, cleanup: async () => {},
}) }));
vi.mock('./_baseline-coord-fixture', () => ({ setupBaselineCoordFixture: async () => ({ dispose: async () => {} }) }));
vi.mock('./degradation/fallback-observations', () => ({ flushFallbackObservations: async () => ({ failed: 0 }) }));

it.each([
  { fails: false, ended: true, valid: true },
  { fails: true, ended: true, valid: true },
  { fails: false, ended: false, valid: true },
  { fails: false, ended: true, valid: false },
])('retains original proof diagnostics through pruning (fails=$fails ended=$ended valid=$valid)', async ({ fails, ended, valid }) => {
  const fixture = mkdtempSync(join(tmpdir(), 'isolated-proof-failure-'));
  const root = resolve(import.meta.dirname, '../../..');
  const evidenceRoot = join(fixture, 'isolated-integration');
  const runtimeRoot = join(fixture, 'runtime');
  const dataDir = join(fixture, 'pg');
  const supervisorPath = join(fixture, 'supervisor.cjs');
  const workspace = 'test-runtime-proof-failure';
  let child: ReturnType<typeof fork> | undefined;
  vi.stubEnv('VH_EVIDENCE_ROOT_BASE', fixture);
  try {
    mkdirSync(runtimeRoot); mkdirSync(dataDir);
    writeFileSync(supervisorPath, `
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const root = process.cwd(), runtimeRoot = process.env.PROOF_RUNTIME, dataDir = process.env.PROOF_DATA;
const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  cwd: root, stdio: 'ignore', env: { ...process.env, HOME: join(runtimeRoot, 'home'),
    PAPERCUSP_WORKSPACE_ID: '${workspace}', PAPERCUSP_PG_PORT: '34567', PAPERCUSP_SKIP_PG_DISCOVERY: '1' }
});
const database = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
Promise.all([once(worker, 'spawn'), once(database, 'spawn')]).then(() => {
  writeFileSync(join(dataDir, 'postmaster.pid'), database.pid + '\\nunused\\nunused\\n34567\\n');
  process.send({ kind: 'isolated-runtime-start', supervisorPid: process.pid, childPid: worker.pid,
    root: ${valid ? 'root' : "root + '/foreign'"}, runtimeRoot, dataDir, workspace: '${workspace}', pgPort: 34567, token: 'original' });
});
process.once('message', async message => {
  const stopped = Promise.all([once(worker, 'exit'), once(database, 'exit')]);
  worker.kill(); database.kill(); await stopped;
  rmSync(runtimeRoot, { recursive: true }); rmSync(dataDir, { recursive: true });
  if (${ended}) process.send({ kind: 'isolated-runtime-end', childPid: worker.pid, code: 0, signal: null,
    runtimeRemoved: true, pgDataRemoved: true }, () => process.disconnect());
  else process.disconnect();
  if (!message.accepted) process.exitCode = 1;
});
`);
    let runId: string | undefined;
    const run = recordIsolatedIntegrationProof({
      root, filePath: 'packages/operator-core/lib/isolated-integration-proof.test.ts', sourcePaths: [],
      execute: async (observe, evidenceDir) => {
        runId = JSON.parse(readFileSync(join(evidenceDir, '../prepare/source.json'), 'utf8')).runId;
        child = fork(supervisorPath, [], { cwd: root, execArgv: [],
          env: { ...process.env, PROOF_RUNTIME: runtimeRoot, PROOF_DATA: dataDir },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        const result = await captureIsolatedWorker(child, evidenceDir, { timeoutMs: 5_000 });
        expect(result.code).toBe(valid ? 0 : 1);
        if (fails) throw new Error('original journey assertion');
      },
    });
    const rejected = fails || !ended || !valid;
    if (rejected) await expect(run).rejects.toThrow();
    else expect(await run).toBe(runId);
    const result = JSON.parse(readFileSync(join(evidenceRoot, runId!, 'result.json'), 'utf8'));
    expect(result.verdict).toBe(rejected ? 'fail' : 'pass');
    if (fails) expect(result.phases.find((p: { phase: string }) => p.phase === 'execute').detail)
      .toContain('original journey assertion');
    const artifacts = new Map<string, string>();
    for (const path of ['phases/execute/worker-result.json', 'phases/execute/lifecycle-observation.json'])
      artifacts.set(path, readFileSync(join(evidenceRoot, runId!, path), 'utf8'));
    const lifecyclePath = 'phases/execute/lifecycle.json';
    if (valid) {
      const bytes = readFileSync(join(evidenceRoot, runId!, lifecyclePath), 'utf8');
      artifacts.set(lifecyclePath, bytes);
      expect(JSON.parse(bytes)).toMatchObject({ runId, workspace, runtimeRoot, dataDir,
        ended: ended ? { code: 0, signal: null, runtimeRemoved: true, pgDataRemoved: true } : null });
    } else {
      expect(existsSync(join(evidenceRoot, runId!, lifecyclePath))).toBe(false);
      expect(JSON.parse(artifacts.get('phases/execute/lifecycle-observation.json')!).observationError).toBeTruthy();
    }
    expect(existsSync(runtimeRoot) || existsSync(dataDir)).toBe(false);
    await runHarness({ contract: { name: 'isolated-integration', phases: [{ id: 'execute' }] },
      evidenceRoot, runId: '20991014T000000Z-1', guardRails: [], runPhase: async () => ({ ok: true }) });
    expect(await pruneRuns(evidenceRoot, 1, Date.now(), {
      measureDisk: async () => ({ totalBytes: 1_000, availableBytes: 500 }), reserveBytes: () => 400,
    })).toContain(runId);
    for (const [path, bytes] of artifacts)
      expect(readFileSync(join(evidenceRoot, 'retained', runId!, path), 'utf8')).toBe(bytes);
    expect(JSON.parse(readFileSync(join(evidenceRoot, 'retained', runId!, 'result.json'), 'utf8')).verdict)
      .toBe(rejected ? 'fail' : 'pass');
  } finally {
    child?.kill('SIGKILL');
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(fixture, { recursive: true, force: true });
  }
}, 15_000);
