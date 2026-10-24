/** Real process/ledger acceptance, invoked only by the isolated integration suite. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { getBuildInfo } from '../lib/build-info';
import { readVerifierSourceReceiptSync } from '../lib/verifier-source';
import { absCgroupDir, walkCgroupTree } from '../lib/task-manager/cgroup-read';
import { killTask } from '../lib/task-manager/control';
import { getTask, listTasks } from '../lib/task-manager/store';
import { isTerminalState } from '../lib/task-manager/types';
import { ensureGradingAuditRuntime, retireUnusedGradingAuditRuntimes, type GradingAuditRuntimeDeps,
  type GradingAuditRuntimeLocator } from '../lib/release/grading-audit-runtime';
import { readGradingAuditSourcePin } from '../lib/release/grading-audit-source-pin';
import { assertPrivateManagedTaskRoute, preparePrivateHttpWorkspaces, preparePrivateOperatorApiBundle,
  privateBundleRuntimeEnv } from './private-http-workspace-preflight';

export interface GradingRuntimeReceipt {
  workspace: string;
  reused: boolean;
  recovered: boolean;
  confined: boolean;
  exactHealth: boolean;
  warmingRetained: boolean;
  transientProbeRetained: boolean;
  partialReferenceRetained: boolean;
  scopeEmpty: boolean;
  pinRemoved: boolean;
  bundleSha256: string;
  evaluatorBuild: ReturnType<typeof getBuildInfo>;
  taskIds: string[];
}

const taskIds = new Set<string>();
const evidenceDir = process.env.GRADING_RUNTIME_EVIDENCE_DIR!;
const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
const observations: object[] = [];

function retainRuntimeDiagnostics() {
  const logs = readdirSync(evidenceDir).filter(name => /^grading-audit-runtime-[a-f0-9]+\.log$/.test(name)).sort();
  writeFileSync(join(evidenceDir, 'grading-runtime-host.log'), logs.map(name =>
    `--- ${name} ---\n${readFileSync(join(evidenceDir, name), 'utf8')}`).join('\n'));
  writeFileSync(join(evidenceDir, 'grading-runtime-diagnostics.json'), JSON.stringify({ workspace, observations }));
}

async function emptyScope(taskId: string) {
  const task = await getTask(taskId);
  assert.ok(task?.confined && task.cgroupPath, 'real confined task ledger identity required');
  return walkCgroupTree(absCgroupDir(task.cgroupPath)).length === 0;
}

async function acquireReady(input: Parameters<typeof ensureGradingAuditRuntime>[0],
  deps: GradingAuditRuntimeDeps, expectedTaskId?: string) {
  // Exercise the canonical repair contract: unknown readiness preserves one
  // enrolled task. A retry may bind that task; it may never silently replace it.
  // Keep the maintained private HTTP fixture's 90s readiness allowance inside
  // the existing encompassing worker deadline.
  const deadline = Date.now() + 90_000;
  let enrolled = expectedTaskId;
  for (;;) {
    try {
      const binding = await ensureGradingAuditRuntime(input, deps);
      taskIds.add(binding.taskId);
      if (enrolled) assert.equal(binding.taskId, enrolled, 'readiness retry replaced the enrolled endpoint');
      return binding;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Audit runtime readiness is unknown') throw error;
      const tasks = await listTasks({ workspaceId: workspace, labelPrefix: 'grading-audit-runtime:', limit: 200 });
      assert.equal(tasks.length, 1, 'unknown readiness must retain exactly one live endpoint');
      const task = tasks[0];
      taskIds.add(task.taskId);
      if (enrolled) assert.equal(task.taskId, enrolled, 'readiness retry restarted the endpoint');
      enrolled = task.taskId;
      assert.equal(await emptyScope(task.taskId), false);
      const locator = task.detail.gradingAuditRuntime as GradingAuditRuntimeLocator;
      assert.ok(readGradingAuditSourcePin(locator.sourceRoot, locator.ownerRef));
      observations.push({ phase: 'unknown-readiness', taskId: task.taskId, baseUrl: locator.baseUrl,
        issueIds: locator.issueIds, observedAt: new Date().toISOString() });
      if (Date.now() >= deadline) throw new Error('Retained endpoint did not become ready within the fixture deadline', { cause: error });
      await new Promise(done => setTimeout(done, 250));
    }
  }
}

async function main() {
  assert.ok(evidenceDir, 'retained evidence directory required');
  assertPrivateManagedTaskRoute(process.env);
  assert.equal(preparePrivateHttpWorkspaces().workspace, workspace);
  assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(process.env.PAPERCUSP_DBOS_ENABLE, '0');
  assert.notEqual(process.env.PAPERCUSP_PG_PORT, '5432');
  // The worker already loaded its TS entry. Its native bundle descendants use
  // the same maintained preload policy as the other private HTTP fixtures.
  process.env.NODE_OPTIONS = privateBundleRuntimeEnv(process.env).NODE_OPTIONS;
  const root = resolve(import.meta.dirname, '../../..');
  // Keep the maintained builder's complete output in the same physical layout
  // production retains; the disposable supervisor owns this whole generation.
  const sourceRoot = join(evidenceDir, '.candidate-runtime-proof', 'checkout');
  const output = join(sourceRoot, 'apps/operator/dist-host');
  mkdirSync(output, { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(sourceRoot, 'node_modules'), 'dir');
  const prepared = preparePrivateOperatorApiBundle(root, output);
  const parentBuild = getBuildInfo();
  // The maintained archive builder stamps twelve source characters. The
  // unbundled worker's Git abbreviation is independently configurable.
  const selected = process.env.VERIFY_TAURI_SOURCE_RECEIPT
    ? readVerifierSourceReceiptSync(root) : null;
  if (selected) assert.ok(parentBuild.sha && selected.sourceCommit.startsWith(parentBuild.sha),
    'unbundled worker and prepared bundle must share the selected source');
  const evaluatorBuild = { ...parentBuild, sha: selected?.sourceCommit.slice(0, 12) ?? parentBuild.sha };
  assert.ok(evaluatorBuild.sha && evaluatorBuild.sha !== 'unknown');
  const deps: GradingAuditRuntimeDeps = {
    // The private supervisor removes its state directory during teardown.
    // Keep the real endpoint's startup evidence with the original worker.
    logDir: evidenceDir,
    currentSource: () => ({ schemaVersion: 1, sourceRoot, bundlePath: prepared.path,
      evaluatorBuild, bundleSha256: prepared.sha256, ownerRef: '' }),
  };
  const input = { workspaceId: workspace, issueId: 'private-audit-a', evaluatorBuild };
  // Deterministically exhaust readiness without waiting for a host-specific
  // startup speed. The real confined process, ledger and source pin must live.
  await assert.rejects(ensureGradingAuditRuntime(input, { ...deps,
    probe: async () => null, sleep: async () => {} }), /Audit runtime readiness is unknown/);
  const warming = await listTasks({ workspaceId: workspace, labelPrefix: 'grading-audit-runtime:', limit: 200 });
  assert.equal(warming.length, 1);
  taskIds.add(warming[0].taskId);
  assert.equal(await emptyScope(warming[0].taskId), false, 'readiness deadline retired the warming endpoint');
  const ready = await acquireReady({ ...input, allowSeed: false }, deps, warming[0].taskId);
  const [first, reused] = await Promise.all([acquireReady(input, deps, ready.taskId),
    acquireReady({ ...input, issueId: 'private-audit-b' }, deps, ready.taskId)]);
  taskIds.add(first.taskId); taskIds.add(reused.taskId);
  assert.equal(first.taskId, reused.taskId, 'concurrent audits must share one owned endpoint');
  const health = await fetch(first.baseUrl + '/api/health').then(response => response.json());
  assert.equal(health.sha, evaluatorBuild.sha);
  assert.equal(health.version, evaluatorBuild.version);
  const task = await getTask(first.taskId);
  assert.ok(task?.confined && task.cgroupPath);
  assert.equal(await emptyScope(first.taskId), false);
  const locator = task.detail.gradingAuditRuntime as { ownerRef: string; issueIds: string[] };
  assert.deepEqual(locator.issueIds.sort(), ['private-audit-a', 'private-audit-b']);
  assert.ok(readGradingAuditSourcePin(sourceRoot, locator.ownerRef));
  await assert.rejects(ensureGradingAuditRuntime({ ...input, issueId: 'private-audit-c' },
    { ...deps, probe: async () => null }), /Audit runtime readiness is unknown/);
  assert.equal(await emptyScope(first.taskId), false, 'a missed probe retired the live endpoint');
  assert.equal((await acquireReady({ ...input, issueId: 'private-audit-c', allowSeed: false }, deps,
    first.taskId)).taskId, first.taskId);
  const retained = (await getTask(first.taskId))?.detail.gradingAuditRuntime as GradingAuditRuntimeLocator;
  assert.deepEqual(retained.issueIds.sort(), ['private-audit-a', 'private-audit-b', 'private-audit-c']);
  const stopped = await killTask(first.taskId, { includeSubtree: true, escalateAfterMs: 5000 });
  assert.ok(stopped.ok, JSON.stringify(stopped));
  assert.equal(await emptyScope(first.taskId), true);
  const recovered = await acquireReady({ ...input, allowSeed: false }, {
    logDir: evidenceDir,
    currentSource: () => { throw new Error('mutable staging alias has advanced'); },
  });
  taskIds.add(recovered.taskId);
  assert.notEqual(recovered.taskId, first.taskId);
  assert.equal(recovered.bundleSha256, first.bundleSha256);
  assert.equal(recovered.baseUrl, first.baseUrl);
  const recoveredHealth = await fetch(recovered.baseUrl + '/api/health').then(response => response.json());
  assert.equal(recoveredHealth.sha, evaluatorBuild.sha);
  assert.equal(recoveredHealth.version, evaluatorBuild.version);
  await retireUnusedGradingAuditRuntimes(workspace, async ids => ids.filter(id => id === 'private-audit-b'));
  assert.equal(await emptyScope(recovered.taskId), false, 'last pending reference must retain the endpoint');
  const partial = (await getTask(recovered.taskId))?.detail.gradingAuditRuntime as { issueIds: string[] };
  assert.deepEqual(partial.issueIds, ['private-audit-b']);
  await retireUnusedGradingAuditRuntimes(workspace, async () => []);
  assert.equal(await emptyScope(recovered.taskId), true);
  assert.equal(readGradingAuditSourcePin(sourceRoot, locator.ownerRef), null);
  assert.equal(await fetch(recovered.baseUrl + '/api/health', { signal: AbortSignal.timeout(1000) })
    .then(() => true, () => false), false);
  assert.equal(createHash('sha256').update(readFileSync(prepared.path)).digest('hex'), prepared.sha256);
  const receipt: GradingRuntimeReceipt = { workspace, reused: true, recovered: true, confined: true, exactHealth: true,
    warmingRetained: true, transientProbeRetained: true,
    partialReferenceRetained: true, scopeEmpty: true, pinRemoved: true, bundleSha256: prepared.sha256,
    evaluatorBuild, taskIds: [...taskIds] };
  writeFileSync(join(evidenceDir, 'grading-runtime-receipt.json'), JSON.stringify(receipt));
  console.log('GRADING_RUNTIME_RECEIPT ' + JSON.stringify(receipt));
}

try { await main(); }
catch (error) {
  const failure = error as { message?: string; stack?: string; actual?: unknown; expected?: unknown };
  console.error('GRADING_RUNTIME_FAILURE ' + JSON.stringify({ message: failure.message ?? String(error),
    stack: failure.stack, actual: failure.actual, expected: failure.expected }));
  process.exitCode = 1;
} finally {
  // Preserve the original startup log even if census or cleanup itself fails.
  retainRuntimeDiagnostics();
  // Include processes that were registered just before readiness threw.
  for (const task of await listTasks({ workspaceId: workspace, labelPrefix: 'grading-audit-runtime:', limit: 200 })) {
    taskIds.add(task.taskId);
  }
  for (const taskId of taskIds) {
    const task = await getTask(taskId);
    const locator = task?.detail.gradingAuditRuntime as GradingAuditRuntimeLocator | undefined;
    if (task && locator) {
      const health = await fetch(locator.baseUrl + '/api/health', { signal: AbortSignal.timeout(2000) })
        .then(async response => {
          const body = response.ok ? await response.json() : null;
          return { status: response.status, sha: body?.sha, version: body?.version, service: body?.service };
        }).catch(error => ({ error: String(error) }));
      observations.push({ phase: 'before-teardown', taskId, state: task.state, baseUrl: locator.baseUrl,
        issueIds: locator.issueIds, health, sourcePinPresent: Boolean(readGradingAuditSourcePin(locator.sourceRoot, locator.ownerRef)),
        observedAt: new Date().toISOString() });
      retainRuntimeDiagnostics();
    }
    if (task?.confined && !(await emptyScope(taskId))) {
      const result = await killTask(taskId, { includeSubtree: true, reapTerminalResidue: isTerminalState(task.state) });
      assert.ok(result.ok || result.error === 'already_gone', JSON.stringify(result));
      assert.equal(await emptyScope(taskId), true, 'owned runtime survived teardown');
    }
  }
  retainRuntimeDiagnostics();
  await getOrgPg().sql.end({ timeout: 1 });
}
