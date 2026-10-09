/** Private PG + immutable git protocol integration; no inference or product writes. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestPg } from '@papercusp/test-config/pg';
import { currentSuBenchHarnessDriver, liveCurrentSuBenchPorts, readCurrentBenchCompletion, type CurrentSuBenchOptions } from './current-su';
import { preregister } from './reproducibility/prereg';
import type { BenchHarnessOps } from './bench-harness-live';
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';
import { currentProtocolFixture } from './reproducibility/_protocol-test-fixture';

const native = vi.hoisted(() => ({ launch: vi.fn(), kill: vi.fn() }));
vi.mock('../agent-tools/capability/launch-agent', () => ({ default: { handler: native.launch } }));
vi.mock('../task-manager/control', () => ({ killTask: native.kill }));

const workspaceId = 'bench-current-private';
const handle = { slug: 'xbench-current-private', featureId: 'xbench-private-task', worktreePath: '/private/task' };
const config = currentProtocolFixture('PRIVATE');
const ctx = { workspaceId, authenticatedPrincipal: { retained: true } } as unknown as PapercuspUnifiedToolContext;
let sql: postgres.Sql;
let repoRoot: string;
const roots: string[] = [];
const scope = () => ({ workspaceId, sql: sql as never });
const request = {
  blueprintId: 'su', task: { benchmark: 'swe-bench-pro', instanceId: 't1', problemStatement: 'Fix the public issue.', graderMeta: {} },
  checkout: { dir: '/private/task', repo: 'fixture/repo', baseCommit: 'base', cleanup: async () => {} },
  budget: { maxUsd: 3, maxWallClockMs: 100 },
};
function commitProtocol(filePath: string, body: string): void {
  // Force a conflicting configured default: this exercises the explicit branch
  // under every CI host, including machines whose global default is main.
  execFileSync('git', ['-c', 'init.defaultBranch=fixture-other', 'init', '-q', '--initial-branch=main'], { cwd: repoRoot });
  const stream = `blob\nmark :1\ndata ${Buffer.byteLength(body)}\n${body}\ncommit refs/heads/main\ncommitter Fixture <fixture@example.invalid> 1577836800 +0000\ndata 6\nfrozen\nM 100644 :1 ${filePath}\n\ndone\n`;
  execFileSync('git', ['fast-import', '--quiet'], { cwd: repoRoot, input: stream });
  expect(execFileSync('git', ['symbolic-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('refs/heads/main');
  execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoRoot });
}
async function execution(committed = true) {
  const frozen = await preregister({ ...scope(), runId: 'PRIVATE', suites: [], config, repoRoot });
  if (committed) commitProtocol(frozen.filePath, readFileSync(frozen.absFilePath, 'utf8'));
  const opts: CurrentSuBenchOptions = {
    workspaceId, runId: 'PRIVATE', armId: 'papercusp', seed: 1, agent: 'codex', model: 'configured-alias', effort: 'high', account: 'auto',
    preregistration: { preregHash: frozen.preregHash, config, repoRoot }, pollIntervalMs: 1, driveTimeoutMs: 100,
  };
  const admit = vi.fn(async () => ({ admitted: true, receiptRef: 'budget:private-fixture' }));
  // Unknown native identity stays unknown; these tests prove protocol/SQL binding,
  // while actual native client/serving observation has its own acceptance clause.
  const ports = liveCurrentSuBenchPorts(ctx, { admit, observeIdentity: async () => null }, opts, scope());
  const lifecycle: BenchHarnessOps = {
    now: () => 0, createHarness: async () => handle,
    addFeature: async () => { await sql`INSERT INTO harness_shared.work_items VALUES (${workspaceId}, ${handle.slug}, ${handle.featureId}, 'done')`; },
    driveToDone: async () => ({ disposition: 'error' }),
    collectCost: async () => ({ costUsd: 0, tokensIn: 0, tokensOut: 0, turns: 0 }), teardown: async () => {},
  };
  native.launch.mockImplementation(async args => ({ data: { launch: { agentStarted: true, tasks: [{ taskId: 'private-native' }] } } }));
  native.kill.mockResolvedValue({ ok: true, taskId: 'private-native', action: 'kill' });
  const task = () => ({ taskId: 'private-native', workspaceId, state: 'running' as const, exitCode: null,
    detail: { label: native.launch.mock.calls[0][0].label } });
  const live = { ...ports, getTask: async () => task(), listTasks: async () => [task()] };
  return { opts, frozen, ports, admit, run: () => currentSuBenchHarnessDriver(lifecycle, live, opts).spinRunAndCost(request) };
}

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `currentbench_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE "${dbName}"`); } finally { await admin.end({ timeout: 5 }); }
  const uri = new URL(adminUri); uri.pathname = `/${dbName}`;
  sql = postgres(uri.toString(), { max: 2, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.benchmark_prereg (
      prereg_hash text PRIMARY KEY, run_id text NOT NULL, workspace_id text NOT NULL,
      label text, suites jsonb NOT NULL DEFAULT '[]', config jsonb NOT NULL, file_path text NOT NULL,
      git_committed boolean NOT NULL DEFAULT false, git_commit_sha text, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, run_id));
    CREATE TABLE harness_shared.benchmark_run_result (run_id text, workspace_id text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE harness_shared.work_items (workspace_id text, harness_slug text, feature_id text, status text);`);
}, 90_000);
beforeEach(async () => {
  vi.clearAllMocks();
  await sql`TRUNCATE harness_shared.benchmark_prereg, harness_shared.benchmark_run_result, harness_shared.work_items`;
  repoRoot = mkdtempSync(join(tmpdir(), 'current-bench-protocol-')); roots.push(repoRoot);
});
afterAll(async () => { await sql?.end({ timeout: 5 }); for (const root of roots) rmSync(root, { recursive: true, force: true }); });

describe('production current benchmark protocol and private completion bindings', () => {
  it('uses the committed protocol, native receipt, private work-item completion and scoped cleanup together', async () => {
    const f = await execution();
    const result = await f.run();
    // Surface the originating driver failure before the derived stop reason.
    expect(result.telemetry.generationError ?? null).toBeNull();
    expect(result.telemetry.stopReason).toBe('done');
    expect(f.admit).toHaveBeenCalledOnce();
    expect(native.launch).toHaveBeenCalledWith(expect.objectContaining({ harness: handle.slug, workItem: handle.featureId }), ctx);
    expect(native.kill).toHaveBeenCalledWith('private-native', { includeSubtree: true, reapTerminalResidue: true, escalateAfterMs: 5000 });
    expect(result.telemetry.armMeta?.currentExecution).toMatchObject({
      preregistration: { preregHash: f.frozen.preregHash, gitCommitSha: expect.stringMatching(/^[a-f0-9]{40}$/) },
      identityStatus: 'unknown', measured: null, terminalReceipt: { taskId: 'private-native' }, retiredTaskIds: ['private-native'],
    });
  });
  it('rejects an uncommitted protocol before budget reservation or native launch', async () => {
    const f = await execution(false);
    expect((await f.run()).telemetry.generationError).toMatch(/committed/);
    expect(f.admit).not.toHaveBeenCalled(); expect(native.launch).not.toHaveBeenCalled();
  });
  it.each([{ ...config, taskIds: ['other'] }, { ...config, seeds: [2] }, { ...config, grader: { ...config.grader, version: 'changed' } }])(
    'rejects drift from frozen task, seed or grader configuration: %j', async changed => {
      const f = await execution();
      f.opts.preregistration.config = changed;
      expect((await f.run()).telemetry.generationError).toMatch(/exact frozen|frozen protocol/);
      expect(f.admit).not.toHaveBeenCalled(); expect(native.launch).not.toHaveBeenCalled();
    },
  );
  it('refuses a caller context for a different workspace before any SQL/launch binding', async () => {
    const f = await execution();
    expect(() => liveCurrentSuBenchPorts(ctx, { admit: f.admit, observeIdentity: async () => null }, { ...f.opts, workspaceId: 'other-private' }, scope())).toThrow(/isolated/);
  });
  it.each(['done', 'passed', 'resolved'])('recognizes maintained successful work-item state %s', async status => {
    await sql`INSERT INTO harness_shared.work_items VALUES (${workspaceId}, ${handle.slug}, ${handle.featureId}, ${status})`;
    expect(await readCurrentBenchCompletion(handle, scope())).toBe('done');
  });
  it.each(['dropped', 'deprecated', 'closed'])('reports abandoned work-item state %s as failure', async status => {
    await sql`INSERT INTO harness_shared.work_items VALUES (${workspaceId}, ${handle.slug}, ${handle.featureId}, ${status})`;
    expect(await readCurrentBenchCompletion(handle, scope())).toBe('failed');
  });
  it('ignores another workspace, harness or feature and refuses production scope', async () => {
    await sql`INSERT INTO harness_shared.work_items VALUES
      ('papercusp-workspace', ${handle.slug}, ${handle.featureId}, 'done'),
      (${workspaceId}, 'peer-harness', ${handle.featureId}, 'done'),
      (${workspaceId}, ${handle.slug}, 'peer-feature', 'done')`;
    expect(await readCurrentBenchCompletion(handle, scope())).toBeNull();
    await expect(readCurrentBenchCompletion(handle, { ...scope(), workspaceId: 'papercusp-workspace' })).rejects.toThrow(/PRODUCTION/);
    await sql`INSERT INTO harness_shared.work_items VALUES (${workspaceId}, ${handle.slug}, ${handle.featureId}, 'wip')`;
    expect(await readCurrentBenchCompletion(handle, scope())).toBeNull();
  });
});
