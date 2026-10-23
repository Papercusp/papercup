import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { CloneIndex } from './clone-index';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../..');
const deadlines = isolatedWorkerOptions(360_000);
const cloneCorpusSource = 'export function sum(xs: number[]) { let total = 0; for (const x of xs) { if (x > 0) { total += x; } else { total -= x; } if (x % 2 === 0) { total += x * 2; } else { total += x * 3; } if (x > 100) { total -= 10; } else if (x < -100) { total += 10; } } return total + xs.length; }';

// The background worker loads production source and starts the actual managed
// CLI. Its private workspace and database cannot file findings in the live pot.
const journey = String.raw`
  import assert from 'node:assert/strict';
  import { execFileSync } from 'node:child_process';
  import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
  import { readFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { setTimeout as delay } from 'node:timers/promises';
  import { getOrgPg } from '@papercusp/db-org';
  import { saveHarnessRegistry } from './packages/operator-core/lib/harness-registry.ts';
  import { runCloneFamilySweepAction } from './packages/operator-core/lib/harness/routines/clone-family-sweep-action.ts';
  import { getTask } from './packages/operator-core/lib/task-manager/store.ts';
  import { killTask } from './packages/operator-core/lib/task-manager/control.ts';
  import { readProcessIdentity } from './packages/operator-core/lib/process-identity.ts';

  const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID;
  assert.match(workspaceId, /^test-runtime-/);
  assert.notEqual(new URL(process.env.HARNESS_ADMIN_DATABASE_URL).port, '5432');
  const sourceRoot = process.cwd();
  const corpus = await mkdtemp(join(process.env.TMPDIR, 'clone-sweep-corpus-'));
  await mkdir(join(corpus, 'packages/a'), { recursive: true });
  await mkdir(join(corpus, 'apps/b'), { recursive: true });
  await mkdir(join(corpus, 'scripts'));
  await symlink(join(sourceRoot, 'node_modules'), join(corpus, 'node_modules'), 'dir');
  await symlink(join(sourceRoot, 'scripts/clone-family-sweep.mts'), join(corpus, 'scripts/clone-family-sweep.mts'));
  const source = ${JSON.stringify(cloneCorpusSource)};
  await writeFile(join(corpus, 'packages/a/a.ts'), source);
  await writeFile(join(corpus, 'apps/b/b.ts'), source.replace('sum(', 'sumAgain('));
  // This disposable corpus has no commits, remotes or shared working tree.
  execFileSync('git', ['init', '--quiet', corpus]);
  await saveHarnessRegistry({ projects: [{ slug: workspaceId, path: corpus, harness_kind: 'hive' }] }, workspaceId);

  const tasks = [];
  const taskIds = [];
  const run = async fireId => {
    const result = await runCloneFamilySweepAction({ workspaceId, installSlug: workspaceId,
      workflowId: fireId, triggerConfig: {}, payloadTemplate: {
        harnessSlug: workspaceId, input: { root: corpus, acceptances: [], genericEvidence: [] },
      } });
    assert.equal(result.diagnostics.status, 'launched');
    const taskId = result.diagnostics.taskId;
    taskIds.push(taskId);
    const cutoff = Date.now() + 120_000;
    let task;
    while (Date.now() < cutoff) {
      task = await getTask(taskId);
      if (task?.endedAt) break;
      await delay(100);
    }
    assert.ok(task?.endedAt, 'managed sweep must reach a terminal ledger state');
    assert.equal(task.workspaceId, workspaceId);
    assert.equal(task.class, 'build');
    assert.equal(task.launchedBy, 'system:clone-family-sweep');
    assert.equal(task.memoryMaxBytes, 4 * 1024 ** 3);
    assert.ok(task.deadlineAt, 'managed sweep must retain its execution deadline');
    assert.equal(task.state, 'exited');
    assert.equal(task.exitCode, 0, readFileSync(result.diagnostics.logPath, 'utf8'));
    assert.ok(task.processIdentity, 'native process identity must be recorded');
    assert.notEqual(readProcessIdentity(task.pid), task.processIdentity, 'original managed child must have exited');
    tasks.push({ taskId, pid: task.pid, processIdentity: task.processIdentity,
      state: task.state, exitCode: task.exitCode, confined: task.confined });
    const outcomes = readFileSync(result.diagnostics.logPath, 'utf8').split('\n').flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const outcome = outcomes.find(row => row.schemaVersion === 1 && row.fireId === fireId);
    assert.ok(outcome, 'actual CLI must retain its sweep outcome');
    assert.equal(outcome.indexed, 2);
    assert.deepEqual(outcome.incomplete, []);
    assert.equal(outcome.rows.length, 1);
    return outcome;
  };

  const { sql } = getOrgPg();
  try {
    const first = await run('native-first');
    assert.equal(first.created, 1);
    const second = await run('native-second');
    assert.equal(second.created, 0);
    assert.equal(second.rows[0].disposition, 'reused');
    assert.equal(second.rows[0].itemId, first.rows[0].itemId);
    assert.notEqual(tasks[0].taskId, tasks[1].taskId);
    console.log('P008_NATIVE ' + JSON.stringify({ workspaceId, tasks,
      familyId: first.rows[0].familyId, itemId: first.rows[0].itemId }));
  } finally {
    try {
      for (const taskId of taskIds) {
        const task = await getTask(taskId);
        assert.equal(task.workspaceId, workspaceId);
        if (task.pid && task.processIdentity && readProcessIdentity(task.pid) === task.processIdentity) {
          const stopped = await killTask(taskId, { includeSubtree: true, reapTerminalResidue: true, escalateAfterMs: 5000 });
          assert.equal(stopped.ok, true, 'owned private task cleanup must succeed');
          assert.notEqual(readProcessIdentity(task.pid), task.processIdentity);
        }
      }
    } finally { await sql.end({ timeout: 5 }); }
  }
`;

it('runs two real managed sweep children against one private corpus without refiling, then tears down', async () => {
  const calibration = new CloneIndex();
  calibration.update({ path: 'packages/a/a.ts', source: cloneCorpusSource });
  calibration.update({ path: 'apps/b/b.ts', source: cloneCorpusSource.replace('sum(', 'sumAgain(') });
  expect(calibration.families('renamed'), 'native corpus must admit one family at the production mass floor').toHaveLength(1);
  await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/code-intelligence/clone-sweep.native.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'scripts/clone-family-sweep.mts',
      'scripts/lib/tracked-files.mjs', 'packages/operator-core/lib/code-intelligence/clone-sweep.ts',
      'packages/operator-core/lib/code-intelligence/clone-index.ts',
      'packages/operator-core/lib/harness/routines/clone-family-sweep-action.ts',
      'packages/operator-core/lib/task-manager/managed-spawn.ts',
      'packages/operator-core/lib/task-manager/store.ts',
      'packages/operator-core/lib/task-manager/control.ts',
      'packages/operator-core/lib/harness-registry.ts'],
    retainedArtifacts: ['phases/execute/native-sweep.json'],
    execute: async (observe, evidenceDir) => {
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1' };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime', '--',
        process.execPath, '--import', 'tsx', '--input-type=module', '-e', journey],
      { cwd: root, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      const result = await captureIsolatedWorker(child, evidenceDir, deadlines);
      expect(result, result.output.slice(-6000)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const output = result.output.split('\n').find(line => line.startsWith('P008_NATIVE '));
      expect(output).toBeDefined();
      await writeFile(join(evidenceDir, 'phases/execute/native-sweep.json'), output!.slice('P008_NATIVE '.length));
      const stages = result.output.split('\n').filter(line => line.startsWith('[with-test-pg] cleanup '))
        .map(line => JSON.parse(line.slice('[with-test-pg] cleanup '.length)));
      const complete = stages.find(stage => stage.stage === 'complete');
      expect(complete).toMatchObject({ runtimeRemoved: true, pgDataRemoved: true });
      expect(existsSync(complete.runtimeRoot)).toBe(false);
      expect(existsSync(complete.dataDir)).toBe(false);
    },
  });
}, deadlines.testTimeoutMs);
