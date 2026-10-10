/** Private PG + immutable git protocol integration; no inference or product writes. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, renameSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import http from 'node:http';
import { join } from 'node:path';
import { getTestPg } from '@papercusp/test-config/pg';
import { currentBenchObservationReader, currentBenchIdentityFromObservation, liveCurrentBenchObservationReaderPorts,
  currentSuBenchHarnessDriver, liveCurrentSuBenchPorts, readCurrentBenchCompletion, type CurrentSuBenchOptions,
  type CurrentBenchTask } from './current-su';
import { preregister } from './reproducibility/prereg';
import type { BenchHarnessOps } from './bench-harness-live';
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';
import { currentProtocolFixture } from './reproducibility/_protocol-test-fixture';
import { readProcessIdentity } from '../process-identity';
import { createInferenceGateway } from '../inference-gateway/gateway';
import { createFailoverPool } from '../inference-gateway/account-failover';
import { resetGovernorRegistry } from '@papercusp/papercusp-shared/agent';

const native = vi.hoisted(() => ({ launch: vi.fn(), kill: vi.fn() }));
const hostHome = vi.hoisted(() => ({ path: '' }));
vi.mock('../agent-tools/capability/launch-agent', () => ({ default: { handler: native.launch },
  INTERNAL_SCOPED_INFERENCE_GATEWAY: Symbol.for('benchmark-test-private-route') }));
vi.mock('../task-manager/control', () => ({ killTask: native.kill }));
// Only the private home allocator is substituted. SQL bindings, filesystem
// bytes, process pins, request observation and HTTP reads use production IO.
vi.mock('@papercusp/orchestrator/session-launch-dirs', () => ({ codexHomeForSessionKey: () => hostHome.path }));

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
  const ports = liveCurrentSuBenchPorts(ctx, { admit, observeIdentity: async () => null,
    nativeGateway: { baseURL: 'http://127.0.0.1:32101', token: 'a'.repeat(64) } }, opts, scope());
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
    CREATE TABLE harness_shared.work_items (workspace_id text, harness_slug text, feature_id text, status text);
    CREATE TABLE harness_shared.task_ledger (task_id text, workspace_id text, session_id text, detail jsonb);
    CREATE TABLE harness_shared.adv_sessions (id bigserial, workspace_id text, coord_owner_id text, session_id text,
      agent text, started_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE harness_shared.runtime_vintage (workspace_id text, unit text, host text, tree_sha text,
      build_time timestamptz, bundle_version text, pid int, extra jsonb, reported_at timestamptz);`);
}, 90_000);
beforeEach(async () => {
  vi.clearAllMocks();
  await sql`TRUNCATE harness_shared.benchmark_prereg, harness_shared.benchmark_run_result, harness_shared.work_items,
    harness_shared.task_ledger, harness_shared.adv_sessions, harness_shared.runtime_vintage`;
  repoRoot = mkdtempSync(join(tmpdir(), 'current-bench-protocol-')); roots.push(repoRoot);
});

let hostGateway: ReturnType<typeof createInferenceGateway> | undefined;
let hostProvider: http.Server | undefined;
afterEach(async () => {
  await hostGateway?.close(); hostGateway = undefined;
  if (hostProvider) await new Promise<void>(resolve => hostProvider!.close(() => resolve()));
  hostProvider = undefined; resetGovernorRegistry();
});

async function hostFixture() {
  resetGovernorRegistry();
  const ownerId = `su-private-${randomUUID()}`, nativeSessionId = randomUUID(), turnId = randomUUID();
  const taskId = `host-task-${randomUUID()}`, taskAt = new Date(Date.now() - 5000).toISOString();
  hostHome.path = join(repoRoot, 'native-home');
  const dir = join(hostHome.path, 'sessions', '2026', '10', '10'); mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-10-10T00-00-00-${nativeSessionId}.jsonl`);
  writeFileSync(file, [
    { type: 'session_meta', payload: { id: nativeSessionId, cli_version: '0.162.0' } },
    { type: 'turn_context', payload: { turn_id: turnId, model: 'gpt-6-sol', effort: 'high' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  await sql`INSERT INTO harness_shared.adv_sessions (workspace_id, coord_owner_id, session_id, agent)
    VALUES (${workspaceId}, ${ownerId}, ${nativeSessionId}, 'codex')`;
  await sql`INSERT INTO harness_shared.task_ledger VALUES (${taskId}, ${workspaceId}, ${nativeSessionId},
    ${sql.json({ coordOwnerId: ownerId })})`;
  const storedBinding = await sql`
    SELECT t.session_id, t.detail, jsonb_typeof(t.detail) AS detail_type, a.coord_owner_id
    FROM harness_shared.task_ledger t JOIN harness_shared.adv_sessions a
      ON a.workspace_id = t.workspace_id AND a.session_id = t.session_id
    WHERE t.task_id = ${taskId} AND t.workspace_id = ${workspaceId}`;
  expect(storedBinding, 'host stage: SQL stores object-valued task attribution').toMatchObject([
    { session_id: nativeSessionId, detail: { coordOwnerId: ownerId }, detail_type: 'object', coord_owner_id: ownerId },
  ]);
  hostProvider = http.createServer((req, res) => {
    req.resume(); req.once('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'resp-private-host', model: 'gpt-6-sol', status: 'completed', output: [],
        usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }));
    });
  });
  await new Promise<void>(resolve => hostProvider!.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (hostProvider.address() as { port: number }).port;
  hostGateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
    codexPool: createFailoverPool([{ accountId: 'private-account', token: async () => 'PRIVATE_LOOPBACK_TOKEN' }]),
    openaiUpstreamBase: `http://127.0.0.1:${upstreamPort}`, requestAbsorbMs: 0, selfHeal: { enabled: false } });
  const port = await hostGateway.listen(0), gatewayBaseUrl = `http://127.0.0.1:${port}`;
  const processPin = readProcessIdentity(process.pid);
  expect(processPin).toBeTruthy();
  for (const unit of ['host-worker', 'host-gateway']) {
    await sql`INSERT INTO harness_shared.runtime_vintage VALUES
      ('host-runtime-private', ${unit}, ${hostname()}, ${'a'.repeat(40)}, null, null, ${process.pid},
       ${sql.json({ kernelProcessIdentity: processPin, ...(unit === 'host-gateway' ? { port } : {}) })},
       ${new Date(Date.now() - 10_000).toISOString()}::timestamptz)`;
  }
  const response = await fetch(`${gatewayBaseUrl}/v1/responses`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-owner': ownerId },
    body: JSON.stringify({ model: 'gpt-6-sol', input: 'PRIVATE_FIXTURE_INPUT', instructions: 'PRIVATE_FIXTURE_SYSTEM',
      tools: [{ type: 'function', name: 'private_tool', parameters: { type: 'object' } }], reasoning: { effort: 'high' },
      client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: nativeSessionId, turn_id: turnId }) } }) });
  expect(response.status).toBe(200); await response.text();
  const task: CurrentBenchTask = { taskId, workspaceId, sessionId: nativeSessionId, startedAt: taskAt,
    state: 'exited', exitCode: 0, detail: { coordOwnerId: ownerId } };
  const options = { ...scope(), runtimeWorkspaceId: 'host-runtime-private',
    workerUnit: 'host-worker', gatewayUnit: 'host-gateway', gatewayBaseUrl };
  const io = liveCurrentBenchObservationReaderPorts(options);
  // Assert each real IO precondition before the composite reader can collapse
  // a failure to null. Every negative test starts from this verified fixture.
  const binding = await io.readBinding(task);
  expect(binding, 'host stage: exact SQL binding').toEqual({ ownerId, nativeSessionId, codexHome: hostHome.path });
  const runtimes = await io.readRuntimes();
  const units = ['host-worker', 'host-gateway'];
  const environment = io.measureRuntimes(runtimes, units);
  const runtimeRevision = io.measureRuntimes(runtimes, ['host-worker']);
  expect(environment, 'host stage: live runtime environment').toMatch(/^[a-f0-9]{64}$/);
  expect(runtimeRevision, 'host stage: live worker identity').toMatch(/^[a-f0-9]{64}$/);
  expect(await io.readTranscript(nativeSessionId, hostHome.path), 'host stage: stable native transcript')
    .toBe(readFileSync(file, 'utf8'));
  const report = await io.readGateway(ownerId);
  expect(report, 'host stage: local gateway report').toMatchObject({ owner: ownerId,
    process: { pid: process.pid, identity: processPin }, stageTelemetry: { ownerId } });
  const recent = report!.stageTelemetry.recent;
  expect(recent, 'host stage: finalized request census').toHaveLength(1);
  const timeline = recent[0];
  expect(timeline, 'host stage: exact native correlation and provider identity').toMatchObject({
    nativeCorrelation: { status: 'observed', threadId: nativeSessionId, turnId },
    providerIdentity: { model: 'gpt-6-sol', responseId: 'resp-private-host', accountId: 'private-account' },
    forwardedEffort: 'high', outcome: 'ok', finalStatus: 200,
  });
  expect(timeline.startedAt, 'host stage: request after pinned lifetimes').toBeGreaterThanOrEqual(
    Math.max(Date.parse(taskAt), Date.parse(runtimes.find(row => row.unit === 'host-worker')!.reportedAt), report!.process.startedAt));
  expect(io.measureRuntimes(await io.readRuntimes(), units), 'host stage: unchanged runtime environment').toBe(environment);
  expect(currentBenchIdentityFromObservation(task, {
    worker: { taskId, workspaceId, ownerId, nativeSessionId, runtimeRevision: runtimeRevision!,
      sourceRevision: 'a'.repeat(40), evidenceRef: 'runtime-vintage:private-physical-fixture' },
    nativeTranscript: readFileSync(file, 'utf8'), gateway: { processRef: `gateway:${processPin}`, timeline },
  }), 'host stage: native/provider identity agreement').not.toBeNull();
  const read = currentBenchObservationReader(options);
  return { task, read, file, ownerId, nativeSessionId };
}

describe('host-backed benchmark observation with private physical IO', () => {
  it('joins actual private SQL, transcript bytes, process pins and gateway provider evidence', async () => {
    const f = await hostFixture(), observation = await f.read(f.task);
    expect(observation).not.toBeNull();
    expect(currentBenchIdentityFromObservation(f.task, observation!)).toMatchObject({
      sourceRevision: 'a'.repeat(40), model: 'gpt-6-sol', clientVersion: 'codex/0.162.0',
      accountId: 'private-account', nativeSessionId: f.nativeSessionId, providerResponseId: 'resp-private-host' });
    const identity = currentBenchIdentityFromObservation(f.task, observation!);
    expect(JSON.stringify(identity)).not.toMatch(/PRIVATE_|private_tool/);
  });
  it('rejects an ambiguous native binding and a foreign task workspace', async () => {
    const f = await hostFixture();
    expect(await f.read({ ...f.task, workspaceId: 'other-private' })).toBeNull();
    await sql`INSERT INTO harness_shared.adv_sessions (workspace_id, coord_owner_id, session_id, agent)
      VALUES (${workspaceId}, ${f.ownerId}, ${f.nativeSessionId}, 'codex')`;
    expect(await f.read(f.task)).toBeNull();
  });
  it('rejects stale kernel pins instead of restamping from a live process', async () => {
    const f = await hostFixture();
    await sql`UPDATE harness_shared.runtime_vintage SET extra = '{"kernelProcessIdentity":"foreign-process"}'::jsonb
      WHERE unit = 'host-worker'`;
    expect(await f.read(f.task)).toBeNull();
  });
  it('rejects string-valued JSONB attribution and restores an object-valued binding', async () => {
    const f = await hostFixture();
    // postgres serializes a string again when its bind type is JSONB. This
    // reproduces the original fixture defect without accepting it as identity.
    await sql`UPDATE harness_shared.task_ledger SET detail = ${JSON.stringify({ coordOwnerId: f.ownerId })}::jsonb`;
    const [stored] = await sql`SELECT jsonb_typeof(detail) AS type FROM harness_shared.task_ledger`;
    expect(stored.type).toBe('string');
    expect(await f.read(f.task)).toBeNull();
    await sql`UPDATE harness_shared.task_ledger SET detail = ${sql.json({ coordOwnerId: f.ownerId })}`;
    expect(await f.read(f.task)).not.toBeNull();
  });
  it('rejects a symlinked native transcript even when its bytes and UUID match', async () => {
    const f = await hostFixture();
    expect(await f.read(f.task)).not.toBeNull();
    renameSync(f.file, f.file + '.target'); symlinkSync(f.file + '.target', f.file);
    expect(await f.read(f.task)).toBeNull();
  });
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
