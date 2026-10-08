/** Original lifetime proof for disposable with-test-pg workers. Reuses runHarness retention. */
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readlinkSync, writeFileSync, writeSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { defaultEvidenceRoot, runHarness } from '@papercusp/verification-harness';
import { linuxPpidFromProcStat, readProcessIdentity } from '../lib/process-identity';
import { it } from 'vitest';

/** Shared with the cheap context guard so the expensive fixture uses the tested API. */
export const isolatedIntegrationCases = it.for([false, true]);

/** Retain original output before termination can interrupt the fixture. A
 * descendant holding stdio must not turn a completed supervisor into a wait
 * without a deadline. Failure receipts never stand in for successful cleanup.
 */
export function captureIsolatedWorker(child: ChildProcess, evidenceDir: string, options: {
  timeoutMs: number; killGraceMs?: number;
}) {
  const fd = openSync(join(evidenceDir, 'worker.log'), 'wx');
  const grace = options.killGraceMs ?? 5_000;
  let output = '';
  let timedOut = false;
  let stdioDrainTimedOut = false;
  const capture = (chunk: Buffer) => { output += String(chunk); writeSync(fd, chunk); };
  const message = (value: unknown) => appendFileSync(join(evidenceDir, 'runtime-events.ndjson'), JSON.stringify(value) + '\n');
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  child.on('message', message);
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean;
    stdioDrainTimedOut: boolean; output: string }>((resolve, reject) => {
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      clearTimeout(drainTimer);
      child.stdout?.off('data', capture);
      child.stderr?.off('data', capture);
      child.off('message', message);
      child.off('exit', onExit);
      child.off('close', onClose);
      child.off('error', onError);
      closeSync(fd);
      const result = { code: child.exitCode, signal: child.signalCode, timedOut, stdioDrainTimedOut };
      writeFileSync(join(evidenceDir, 'worker-result.json'), JSON.stringify({ ...result, error: error?.message ?? null }), { flag: 'wx' });
      if (error) reject(error);
      else resolve({ ...result, output });
    };
    const stopDraining = () => {
      stdioDrainTimedOut = true;
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (child.connected) child.disconnect();
      finish();
    };
    const onExit = () => { drainTimer = setTimeout(stopDraining, grace); };
    const onClose = () => finish();
    const onError = (error: Error) => finish(error);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        // Also bound pipe drainage if a startup orphan retained the supervisor's
        // descriptors. Its missing cleanup remains a failed proof.
        drainTimer = setTimeout(stopDraining, grace);
      }, grace);
    }, options.timeoutMs);
    child.once('exit', onExit);
    child.once('close', onClose);
    child.once('error', onError);
  });
}

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function processPin(pid: number) {
  const identity = readProcessIdentity(pid);
  const parentPid = linuxPpidFromProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  assert.ok(identity && parentPid, 'kernel process identity must be measured while alive');
  return { pid, identity, parentPid };
}

export async function recordIsolatedIntegrationProof(options: {
  root: string; filePath: string; sourcePaths: string[];
  execute: (observe: (child: ChildProcess) => void, evidenceDir: string) => Promise<void>;
}): Promise<string> {
  const { root, filePath } = options;
  const paths = [...new Set([filePath, ...options.sourcePaths])].sort();
  let source: any;
  let lifecycle: any;
  let ended: any;
  let observationError: unknown;
  let observedChild: ChildProcess | undefined;
  const result = await runHarness({
    contract: { name: 'isolated-integration', phases: [
      { id: 'prepare' }, { id: 'execute', dependsOn: ['prepare'] }, { id: 'teardown' },
    ] }, evidenceRoot: defaultEvidenceRoot('isolated-integration'),
    runPhase: async ctx => {
      if (ctx.phase === 'prepare') {
        const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        const files = paths.map(path => {
          assert.ok(path && !path.startsWith('/') && !path.split('/').some(p => p === '..' || p === '.'));
          const bytes = readFileSync(join(root, path));
          let gitSha256: string | null = null;
          try { gitSha256 = hash(execFileSync('git', ['-C', root, 'show', `${commit}:${path}`],
            { maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { /* uncommitted local test remains usable, not live proof */ }
          return { path, sha256: hash(bytes), gitSha256 };
        });
        source = { schemaVersion: 1, runId: ctx.runId, sourceCommit: commit, repoRoot: root, filePath,
          runGroupId: process.env.PAPERCUSP_TEST_RUN_GROUP ?? null,
          workspaceId: process.env.PAPERCUSP_WORKSPACE_ID ?? process.env.PAPERCUSP_WORKSPACE ?? null,
          harnessSlug: process.env.PAPERCUSP_TEST_RUN_HARNESS ?? null, files };
        await writeFile(join(ctx.evidenceDir, 'source.json'), JSON.stringify(source), { flag: 'wx' });
      } else if (ctx.phase === 'execute') {
        await options.execute(child => {
          assert.ok(!observedChild, 'one lifecycle per run');
          observedChild = child;
          child.on('message', (message: any) => {
            try {
              if (message.kind === 'isolated-runtime-start') {
                assert.ok(!lifecycle, 'one start per run');
                assert.equal(message.supervisorPid, child.pid);
                assert.equal(message.root, root);
                const observer = processPin(process.pid);
                const supervisor = processPin(child.pid!);
                const worker = processPin(message.childPid);
                assert.equal(supervisor.parentPid, observer.pid);
                assert.equal(worker.parentPid, supervisor.pid);
                assert.equal(readlinkSync(`/proc/${worker.pid}/cwd`), root);
                const env = Object.fromEntries(readFileSync(`/proc/${worker.pid}/environ`, 'utf8')
                  .split('\0').filter(Boolean).map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
                assert.equal(env.PAPERCUSP_WORKSPACE_ID, message.workspace);
                assert.equal(env.HOME, join(message.runtimeRoot, 'home'));
                assert.equal(env.PAPERCUSP_PG_PORT, String(message.pgPort));
                assert.equal(env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
                assert.ok(/^test-runtime-/.test(message.workspace));
                const pgFile = readFileSync(join(message.dataDir, 'postmaster.pid'), 'utf8').split('\n');
                assert.equal(Number(pgFile[3]), message.pgPort);
                const database = processPin(Number(pgFile[0]));
                assert.equal(database.parentPid, supervisor.pid);
                const argv = readFileSync(`/proc/${worker.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
                lifecycle = { schemaVersion: 1, runId: ctx.runId, host: hostname(), observedAt: new Date().toISOString(),
                  observer, supervisor, worker, database, argv, cwd: root, workspace: message.workspace,
                  runtimeRoot: message.runtimeRoot, dataDir: message.dataDir, pgPort: message.pgPort };
              } else if (message.kind === 'isolated-runtime-end') {
                assert.ok(lifecycle && !ended);
                assert.equal(message.childPid, lifecycle.worker.pid);
                ended = { ...message, observedAt: new Date().toISOString() };
              }
            } catch (error) { observationError = error; }
            writeFileSync(join(ctx.evidenceDir, 'lifecycle-observation.json'), JSON.stringify({
              lifecycle: lifecycle ?? null, ended: ended ?? null,
              observationError: observationError instanceof Error ? observationError.message : observationError ? String(observationError) : null,
            }));
          });
        }, ctx.evidenceDir);
        if (observationError) throw observationError;
        assert.ok(lifecycle && ended, 'original start and cleanup observations are required');
        assert.ok(!ended.signal && ended.runtimeRemoved && ended.pgDataRemoved);
        assert.ok(!existsSync(lifecycle.runtimeRoot) && !existsSync(lifecycle.dataDir));
        assert.notEqual(readProcessIdentity(lifecycle.worker.pid), lifecycle.worker.identity);
        assert.notEqual(readProcessIdentity(lifecycle.database.pid), lifecycle.database.identity);
        for (const file of source.files) assert.equal(hash(readFileSync(join(root, file.path))), file.sha256);
        lifecycle.ended = ended;
        await writeFile(join(ctx.evidenceDir, 'lifecycle.json'), JSON.stringify(lifecycle), { flag: 'wx' });
      } else {
        assert.ok(lifecycle && ended && observedChild?.exitCode !== null);
        assert.ok(!existsSync(lifecycle.runtimeRoot) && !existsSync(lifecycle.dataDir));
      }
      return { ok: true };
    },
  });
  assert.equal(result.verdict, 'pass', JSON.stringify({
    runId: result.runId,
    firstFailure: result.firstFailure,
    phaseFailures: result.phases
      .filter((phase) => phase.status === 'failed' || phase.status === 'blocked')
      .map(({ phase, step, reasonCode, detail }) => ({ phase, step, reasonCode, detail })),
  }));
  return result.runId;
}
