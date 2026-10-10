/** Private PG + immutable git protocol integration; no inference or product writes. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, renameSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import http from 'node:http';
import { join } from 'node:path';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { currentBenchObservationReader, currentBenchIdentityFromObservation, liveCurrentBenchObservationReaderPorts,
  currentSuBenchHarnessDriver, liveCurrentSuBenchPorts, readCurrentBenchCompletion, type CurrentSuBenchOptions,
  liveCurrentBenchNativeCostReader, currentBenchLaunchRequest,
  currentBenchAssignmentId, currentBenchGatewayController,
  currentBenchProviderAuthenticator, currentBenchOpenAiInputContract, currentBenchOpenAiInputReader,
  type CurrentBenchTask } from './current-su';
import { preregister } from './reproducibility/prereg';
import { readBenchRunCost, type BenchHarnessOps } from './bench-harness-live';
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';
import { currentProtocolFixture } from './reproducibility/_protocol-test-fixture';
import { readProcessIdentity } from '../process-identity';
import { createInferenceGateway } from '../inference-gateway/gateway';
import { createFailoverPool } from '../inference-gateway/account-failover';
import { resetGovernorRegistry } from '@papercusp/papercusp-shared/agent';
import { closedCodexSessionPopulation } from '../interactive-usage/ingest-adapters';
import { registerLearningLoop, reserveLearningSpend, recordLearningSpendAttemptResult, getLearningSpendPositions } from '../learning-governor/store';
import type { GatewayCarryTrialAttemptResult } from '../inference-gateway/gateway';
import { startGatewayService } from '../inference-gateway/launch';
import { makeBearerCredentialResolver } from '../inference-gateway/credential-store';

const native = vi.hoisted(() => ({ launch: vi.fn(), kill: vi.fn() }));
const hostHome = vi.hoisted(() => ({ path: '', byId: new Map<number, string>() }));
vi.mock('../agent-tools/capability/launch-agent', () => ({ default: { handler: native.launch },
  INTERNAL_SCOPED_INFERENCE_GATEWAY: Symbol.for('benchmark-test-private-route') }));
vi.mock('../task-manager/control', () => ({ killTask: native.kill }));
// Only the private home allocator is substituted. SQL bindings, filesystem
// bytes, process pins, request observation and HTTP reads use production IO.
vi.mock('@papercusp/orchestrator/session-launch-dirs', () => ({ codexHomeForSessionKey: (id: number | string) => hostHome.byId.get(Number(id)) ?? hostHome.path }));

const workspaceId = 'bench-current-private';
const handle = { slug: 'xbench-current-private', featureId: 'xbench-private-task', worktreePath: '/private/task' };
const config = currentProtocolFixture('PRIVATE');
const ctx = { workspaceId, authenticatedPrincipal: { retained: true } } as unknown as PapercuspUnifiedToolContext;
let sql: postgres.Sql;
let repoRoot: string;
const roots: string[] = [];
const gateways: Array<{ stop(): Promise<void> }> = [];
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
  const controller = currentBenchGatewayController({ workspaceId, loopId: 'private-host-loop', token: 'a'.repeat(64),
    preregHash: frozen.preregHash, protocol: config, armId: opts.armId, taskId: 't1', seed: opts.seed,
    resources: { inputTokens: 1000, outputTokens: 100, requestsPerArm: 50, usdPerArm: 3, maxOpenUsd: 3,
      wallClockMs: 1000, wallClockMsPerArm: 100,
      armIds: config.arms.map(a => currentBenchAssignmentId(config.runId, a.id, 't1', 1)) },
    authenticateProvider: async () => null });
  const hosted = await controller.startNativeGateway(() => {}, async () => ({ port: 32101, stop: async () => {} } as never));
  gateways.push(hosted);
  const ports = liveCurrentSuBenchPorts(ctx, { admit, observeIdentity: async () => null, ...hosted }, opts, scope());
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
  try { await admin.unsafe(`CREATE DATABASE "${dbName}"`); await markManagedTestDatabase(admin, dbName); } finally { await admin.end({ timeout: 5 }); }
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
    CREATE TABLE harness_shared.task_ledger (task_id text, workspace_id text, session_id text, detail jsonb,
      class text DEFAULT 'agent-session', state text DEFAULT 'exited', parent_task_id text);
    CREATE TABLE harness_shared.adv_sessions (id bigserial, workspace_id text, coord_owner_id text, session_id text,
      agent text, started_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE harness_shared.runtime_vintage (workspace_id text, unit text, host text, tree_sha text,
      build_time timestamptz, bundle_version text, pid int, extra jsonb, reported_at timestamptz);
    CREATE TABLE harness_shared.interactive_usage_files (workspace_id text, file_path text, byte_offset bigint, parser_state jsonb);
    CREATE TABLE harness_shared.agent_usage_samples (id bigserial, workspace_id text, session_id text,
      usage_event_key text, usage_provenance jsonb, cost_source text, cost_usd numeric,
      identity_activation_event_id text, identity_owner_id text, identity_principal_id text,
      identity_specification_revision text, identity_state_revision text);
    CREATE VIEW harness_shared.agent_usage_samples_identity_attribution AS SELECT * FROM harness_shared.agent_usage_samples;`);
  await sql.unsafe('ALTER TABLE harness_shared.agent_usage_samples ADD COLUMN harness_slug text, ADD COLUMN run_id text, ADD COLUMN input_tokens bigint, ADD COLUMN output_tokens bigint');
  for (const name of ['244-learning-governor.sql', '1116-learning-spend-reservations.sql', '1224-learning-reservation-resources.sql']) {
    const body = readFileSync(new URL(`../../../../libs/papercusp/libs/db/sql/${name}`, import.meta.url), 'utf8')
      .split('\n').filter(line => !/\bGRANT\b|^\s*\\/.test(line)).join('\n');
    await sql.unsafe(body);
  }
  await sql.unsafe('ALTER TABLE harness_shared.learning_governor_loops ADD COLUMN pot_slug text');
  await sql.unsafe('ALTER TABLE harness_shared.learning_spend_events ADD COLUMN pot_slug text');
}, 90_000);
beforeEach(async () => {
  vi.clearAllMocks();
  hostHome.byId.clear();
  await sql`TRUNCATE harness_shared.benchmark_prereg, harness_shared.benchmark_run_result, harness_shared.work_items,
    harness_shared.task_ledger, harness_shared.adv_sessions, harness_shared.runtime_vintage,
    harness_shared.interactive_usage_files, harness_shared.agent_usage_samples,
    harness_shared.learning_governor_loops, harness_shared.learning_spend_events, harness_shared.learning_spend_reservations`;
  repoRoot = mkdtempSync(join(tmpdir(), 'current-bench-protocol-')); roots.push(repoRoot);
});

let hostGateway: ReturnType<typeof createInferenceGateway> | undefined;

describe('legacy SQL usage measurement', () => {
  it('distinguishes known empty usage from an incomplete charged population', async () => {
    expect(await readBenchRunCost(sql, 'private-legacy', workspaceId))
      .toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0 });
    await sql`INSERT INTO harness_shared.agent_usage_samples (workspace_id, harness_slug, run_id, input_tokens, output_tokens, cost_usd)
      VALUES (${workspaceId}, 'private-legacy', 'private-run', 100, NULL, 0.002)`;
    expect(await readBenchRunCost(sql, 'private-legacy', workspaceId))
      .toMatchObject({ tokensIn: 100, tokensOut: 0, costUsd: 0.002, turns: 1, costUsdMeasurementMissing: true });
  });
  it('reports a missing dollar measurement alongside the known token subtotal', async () => {
    await sql`INSERT INTO harness_shared.agent_usage_samples (workspace_id, harness_slug, run_id, input_tokens, output_tokens, cost_usd)
      VALUES (${workspaceId}, 'private-legacy', 'private-run', 100, 20, NULL)`;
    expect(await readBenchRunCost(sql, 'private-legacy', workspaceId))
      .toMatchObject({ tokensIn: 100, tokensOut: 20, costUsd: 0, turns: 1, costUsdMeasurementMissing: true });
  });
});

describe('production native accounting with private PG and full source bytes', () => {
  async function costFixture() {
    const opts: CurrentSuBenchOptions = { workspaceId, runId: 'PRIVATE', armId: 'papercusp', seed: 1,
      agent: 'codex', model: 'configured-alias', effort: 'high', account: 'auto',
      preregistration: { preregHash: createHash('sha256').update('private-cost-protocol').digest('hex'), config } };
    const label = currentBenchLaunchRequest(opts, handle, 'Private cost fixture.').label;
    async function addSource(home: string, ownerId: string) {
      const nativeSessionId = randomUUID(), nativeTurnId = randomUUID();
      const dir = join(home, 'sessions', '2026', '10', '10'); mkdirSync(dir, { recursive: true });
      const file = join(dir, `rollout-2026-10-10T00-00-00-${nativeSessionId}.jsonl`);
      const transcript = [
        { type: 'session_meta', payload: { id: nativeSessionId } },
        { type: 'turn_context', payload: { turn_id: nativeTurnId, model: 'configured-alias' } },
        { type: 'event_msg', payload: { type: 'token_count', info: {
          total_token_usage: { input_tokens: 100, output_tokens: 10 },
          last_token_usage: { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 10 },
        } } },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: nativeTurnId } },
      ].map(record => JSON.stringify(record) + '\n').join('');
      writeFileSync(file, transcript);
      const population = closedCodexSessionPopulation({ transcript, file, fileGeneration: 0, nativeSessionId });
      if (!population.ok) throw new Error(population.detail);
      await sql`INSERT INTO harness_shared.interactive_usage_files VALUES
        (${workspaceId}, ${file}, ${Buffer.byteLength(transcript)}, '{"initialized":true,"fileGeneration":0}'::jsonb)`;
      await sql`INSERT INTO harness_shared.agent_usage_samples
        (workspace_id, session_id, usage_event_key, usage_provenance, cost_source, cost_usd,
         identity_activation_event_id, identity_owner_id, identity_principal_id, identity_specification_revision, identity_state_revision)
        VALUES (${workspaceId}, ${nativeSessionId}, ${population.usageEventKeys[0]},
          ${sql.json({ turnId: nativeTurnId, costBound: null })}, 'provider', 0.002,
          'private-cost-activation', ${ownerId}, 'private-cost-principal', 'private-spec', 'private-state')`;
      return { file, nativeSessionId, nativeTurnId };
    }
    async function addParticipant(taskId: string, ownerId: string, parentTaskId: string | null = null) {
      const home = join(repoRoot, taskId), source = await addSource(home, ownerId);
      const [a] = await sql`INSERT INTO harness_shared.adv_sessions (workspace_id, coord_owner_id, session_id, agent)
        VALUES (${workspaceId}, ${ownerId}, ${source.nativeSessionId}, 'codex') RETURNING id`;
      hostHome.byId.set(Number(a.id), home);
      await sql`INSERT INTO harness_shared.task_ledger (task_id, workspace_id, session_id, detail, class, state, parent_task_id)
        VALUES (${taskId}, ${workspaceId}, ${source.nativeSessionId},
          ${sql.json({ coordOwnerId: ownerId, ...(parentTaskId === null ? { label } : {}) })}, 'agent-session', 'exited', ${parentTaskId})`;
      return { ...source, home, taskId, ownerId };
    }
    const solver = await addParticipant('private-cost-solver', 'su-private-cost-solver');
    async function accountingFixture() {
      const loopId = `private-benchmark:${randomUUID()}`, protocol = currentProtocolFixture('PRIVATE');
      const resources = { inputTokens: 1000, outputTokens: 100, requestsPerArm: 50,
        armIds: protocol.arms.map(a => currentBenchAssignmentId(protocol.runId, a.id, 't1', 1)),
        usdPerArm: 3, maxOpenUsd: 3, wallClockMs: 1000, wallClockMsPerArm: 100 };
      await registerLearningLoop(sql, { workspaceId, loopId, budgetKind: 'lifetime', budgetUsd: 60,
        enabled: true, meta: { reservationBinding: opts.preregistration.preregHash, reservationResourceBudget: resources } });
      const controller = currentBenchGatewayController({ workspaceId, loopId, token: randomUUID(),
        preregHash: opts.preregistration.preregHash, protocol, armId: 'papercusp', taskId: 't1', seed: 1, resources,
        authenticateProvider: async () => null });
      const binding = controller.accountingBinding; controller.revoke();
      async function addAttempt(source: { nativeSessionId: string; nativeTurnId: string },
        outcome: 'response-completed' | 'fetch-failed' = 'response-completed') {
        const id = randomUUID(), identity = { attemptId: id, manifestSha256: binding.preregHash, armId: binding.assignmentId,
          nativeSessionId: source.nativeSessionId, nativeTurnId: source.nativeTurnId, transport: 'bearer-http' as const,
          accountId: 'private-provider-account', credentialHeader: 'authorization' as const,
          credentialSha256: 'b'.repeat(64), bodySha256: 'c'.repeat(64), clockId: 'private-host-clock',
          target: 'https://api.openai.com/v1/responses' };
        const receipt = await reserveLearningSpend(sql, { workspaceId, loopId, requestedUsd: 0.003, floorUsd: 0,
          attemptKind: 'evaluation', note: JSON.stringify({ nativeGatewayAttempt: identity }),
          exact: { reservationId: id, binding: binding.preregHash, expectedBudgetUsd: 60,
            resources: { armId: binding.assignmentId, inputTokens: 100, outputTokens: 10 }, expectedResourceBudget: resources } });
        expect(receipt.ok).toBe(true);
        const headers: GatewayCarryTrialAttemptResult = { ...identity, reservationRef: id,
          outcome: outcome === 'fetch-failed' ? 'fetch-failed' : 'response-headers',
          responseStatus: outcome === 'fetch-failed' ? null : 200, costUsdMeasurementMissing: true };
        expect(await recordLearningSpendAttemptResult(sql, { workspaceId, reservationId: id, result: headers })).toEqual({ ok: true });
        if (outcome === 'response-completed') {
          const terminal: GatewayCarryTrialAttemptResult = { ...identity, reservationRef: id, outcome, responseStatus: 200,
            costUsdMeasurementMissing: true, responseSha256: 'd'.repeat(64), responseBytes: 300,
            providerCompletion: { responseId: `response-${id}`, model: 'configured-alias', providerEffort: 'high',
              usage: { inputTokenBasis: 'inclusive', inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheCreationTokens: 0 } } };
          expect(await recordLearningSpendAttemptResult(sql, { workspaceId, reservationId: id, result: terminal })).toEqual({ ok: true });
        }
        return id;
      }
      await addAttempt(solver);
      return { binding, addAttempt, read: liveCurrentBenchNativeCostReader(handle, opts, scope(), binding) };
    }
    return { solver, addParticipant, addSource, opts, accountingFixture, read: liveCurrentBenchNativeCostReader(handle, opts, scope()) };
  }

  it('reconciles production reservation evidence with exact host-native source requests using the frozen controller scope', async () => {
    const f = await costFixture(), accounting = await f.accountingFixture();
    expect(await accounting.read()).toMatchObject({ costUsdMeasurementMissing: false,
      armMeta: { nativeCostAccounting: { sourceCensusComplete: true, attemptAccountingComplete: true, billedCostUsd: 0.002 } } });
    const positions = await getLearningSpendPositions(sql, { workspaceId, loopId: accounting.binding.loopId, includeReservations: true });
    expect(positions.positions.unsettledUsd).toBe(0.003);
    expect(positions.census).toMatchObject({ status: 'complete', reservations: [{ status: 'open' }] });
  });
  it('composes the issued host HTTP route, authenticated provider, SQL admission and native source census', async () => {
    const f = await costFixture(), protocol = currentProtocolFixture('PRIVATE', 60_000);
    protocol.maxInFlightUsd = 0.00012;
    protocol.priceSchedule.rates[0].inputTokenCeiling = 100;
    protocol.priceSchedule.rates[0].inputTokenCeilingSourceSha256 = currentBenchOpenAiInputContract('configured-alias', 100);
    f.opts.preregistration.config = protocol;
    const loopId = `private-host-http:${randomUUID()}`, key = join(repoRoot, 'private-provider-key');
    writeFileSync(key, 'PRIVATE_HOST_PROVIDER_CREDENTIAL', { mode: 0o600 });
    const account = { id: 'private-host-account', provider: 'codex' as const, credentialRef: `token:${key}` };
    const resources = { inputTokens: 1000, outputTokens: 10, requestsPerArm: 50, usdPerArm: 3,
      maxOpenUsd: protocol.maxInFlightUsd, wallClockMs: 60_000, wallClockMsPerArm: 60_000,
      armIds: protocol.arms.map(a => currentBenchAssignmentId(protocol.runId, a.id, 't1', 1)) };
    await registerLearningLoop(sql, { workspaceId, loopId, budgetKind: 'lifetime', budgetUsd: 60,
      enabled: true, meta: { reservationBinding: f.opts.preregistration.preregHash, reservationResourceBudget: resources } });
    const count = vi.fn<typeof fetch>(async () => Response.json({ object: 'response.input_tokens', input_tokens: 100 }));
    const reader = currentBenchOpenAiInputReader({ model: 'configured-alias', inputTokens: 100 }, { fetch: count });
    const auth = currentBenchProviderAuthenticator({ workspaceId, preregHash: f.opts.preregistration.preregHash,
      protocol, armId: 'papercusp', taskId: 't1', seed: 1, readNativeInputCeiling: reader.read }, {
      readAccount: async (_workspace, id) => id === account.id ? account : null,
      credentialResolver: (_provider, ref) => makeBearerCredentialResolver(ref),
    });
    const authenticate = vi.fn(auth.authenticateProvider);
    const controller = currentBenchGatewayController({ workspaceId, loopId, token: 'h'.repeat(64),
      preregHash: f.opts.preregistration.preregHash, protocol, resources, armId: 'papercusp', taskId: 't1', seed: 1,
      authenticateProvider: authenticate }, { enabled: async () => true, getSql: async () => sql, log: () => {} });
    const providerEvidence: Array<{ target: string; credentialMatches: boolean; model: string; outputLimit: number;
      beforeSend: Awaited<ReturnType<typeof getLearningSpendPositions>> }> = [];
    const provider = vi.fn<typeof fetch>(async (target, init) => {
      // The maintained bearer adapter forwards Uint8Array, whose String()
      // representation is comma-separated byte values, not the JSON text.
      const body = JSON.parse(typeof init?.body === 'string' ? init.body :
        new TextDecoder().decode(init?.body as Uint8Array));
      providerEvidence.push({ target: String(target),
        credentialMatches: new Headers(init?.headers).get('authorization') === 'Bearer PRIVATE_HOST_PROVIDER_CREDENTIAL',
        model: body.model, outputLimit: body.max_output_tokens,
        beforeSend: await getLearningSpendPositions(sql, { workspaceId, loopId, includeReservations: true }) });
      return Response.json({ id: 'host-http-provider-response', model: 'configured-alias', status: 'completed',
        reasoning: { effort: 'high' }, output: [],
        usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 } } });
    });
    const hosted = await controller.startNativeGateway(() => {}, options => startGatewayService({ ...options,
      resolveAccounts: async () => [{ accountId: account.id, credentialRef: account.credentialRef, source: 'env' }],
      resolveLocalBackends: async () => [], observePool: () => () => {}, fetchImpl: provider,
      refreshIntervalMs: 0, poolReloadIntervalMs: 0, localBackendReloadIntervalMs: 0 }));
    const ports = liveCurrentSuBenchPorts(ctx, { ...hosted, admit: async () => ({ admitted: true, receiptRef: 'host-http:admit' }),
      observeIdentity: async () => null }, f.opts, scope());
    const send = () => fetch(`${hosted.nativeGateway.baseURL}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${hosted.nativeGateway.token}`,
        'x-papercusp-owner': f.solver.ownerId },
      body: JSON.stringify({ model: 'configured-alias', input: 'private benchmark task', reasoning: { effort: 'high' },
        client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: f.solver.nativeSessionId, turn_id: f.solver.nativeTurnId }) } }),
    });
    try {
      await ports.launch(currentBenchLaunchRequest(f.opts, handle, 'private task'));
      expect(native.launch.mock.calls.at(-1)![1][Symbol.for('benchmark-test-private-route')]).toEqual(hosted.nativeGateway);
      const accepted = await send(), acceptedBody = await accepted.text();
      const authority = await authenticate.mock.results.at(-1)?.value;
      const lastAttempt = authenticate.mock.calls.at(-1)?.[0];
      expect(accepted.status, JSON.stringify({ body: acceptedBody, counted: count.mock.calls.length,
        authenticated: authenticate.mock.calls.length, target: lastAttempt?.target,
        transport: lastAttempt?.transport, accountId: lastAttempt?.accountId,
        bodyFields: lastAttempt ? Object.keys(JSON.parse(lastAttempt.body)) : [],
        authority: authority ? { inputTokens: authority.inputTokens, outputTokens: authority.outputTokens, requestedUsd: authority.requestedUsd } : null,
        providerCalls: provider.mock.calls.length,
        providerBodyKind: provider.mock.calls[0]?.[1]?.body?.constructor.name,
        providerEvidence, positions: (await getLearningSpendPositions(sql, { workspaceId, loopId })).positions })).toBe(200);
      expect(provider).toHaveBeenCalledOnce();
      expect(providerEvidence).toHaveLength(1);
      expect(providerEvidence[0]).toMatchObject({ target: 'https://api.openai.com/v1/responses', credentialMatches: true,
        model: 'configured-alias', outputLimit: 10, beforeSend: { positions: { unsettledUsd: 0.00012 },
          census: { status: 'complete', reservations: [{ status: 'open' }] } } });
      expect(await ports.collectCost!({ handle, workspaceId })).toMatchObject({ costUsdMeasurementMissing: false,
        armMeta: { nativeCostAccounting: { attemptAccountingComplete: true, billedCostUsd: 0.002 } } });
      const denied = await send(); expect(denied.status).toBe(403); await denied.text();
      expect(provider).toHaveBeenCalledOnce();
      const final = await getLearningSpendPositions(sql, { workspaceId, loopId, includeReservations: true });
      expect(final.positions.unsettledUsd).toBe(0.00012);
      expect(final.census).toMatchObject({ status: 'complete', reservations: [{ status: 'open', usedUsd: 0 }] });
      if (final.census?.status !== 'complete') throw new Error('Incomplete private SQL census');
      const note = final.census.reservations[0].note!;
      expect(note).not.toContain('PRIVATE_HOST_PROVIDER_CREDENTIAL');
      expect(JSON.parse(note)).toMatchObject({ nativeGatewayAttemptResult: { outcome: 'response-completed',
        providerCompletion: { responseId: 'host-http-provider-response' } } });
      expect(count).toHaveBeenCalledTimes(2);
    } finally { await hosted.stop(); controller.revoke(); auth.revoke(); reader.revoke(); }
  });
  it('joins every recovered native file and unlabeled reviewer request to the same exact assignment', async () => {
    const f = await costFixture(), accounting = await f.accountingFixture();
    const recovered = await f.addSource(f.solver.home, f.solver.ownerId);
    const reviewer = await f.addParticipant('private-reviewer', 'private-reviewer-owner', f.solver.taskId);
    await accounting.addAttempt(recovered); await accounting.addAttempt(reviewer);
    const result = await accounting.read();
    expect(result.costUsd).toBeCloseTo(0.00033, 10);
    expect(result).toMatchObject({ costUsdMeasurementMissing: false,
      armMeta: { nativeCostAccounting: { attemptAccountingComplete: true, billedCostUsd: 0.006 } } });
  });
  it('keeps failed retry exposure and efficiency uncertainty even when the completed request has a native source and bill', async () => {
    const f = await costFixture(), accounting = await f.accountingFixture();
    await accounting.addAttempt(f.solver, 'fetch-failed');
    expect(await accounting.read()).toMatchObject({ costUsdMeasurementMissing: true,
      armMeta: { nativeCostAccounting: { attemptAccountingComplete: false, billedCostUsd: null, billedKnownSubtotalUsd: 0.002 } } });
    expect((await getLearningSpendPositions(sql, { workspaceId, loopId: accounting.binding.loopId })).positions.unsettledUsd).toBe(0.006);
  });
  it('does not replace actual provider billing with matched native token usage', async () => {
    const f = await costFixture(), accounting = await f.accountingFixture();
    await sql`UPDATE harness_shared.agent_usage_samples SET cost_source = 'estimate'`;
    expect(await accounting.read()).toMatchObject({ costUsdMeasurementMissing: true,
      armMeta: { nativeCostAccounting: { attemptAccountingComplete: true, billedCostUsd: null, missingBills: 1 } } });
  });
  it('refuses a mutated complete reservation population during native source validation', async () => {
    const f = await costFixture(), accounting = await f.accountingFixture();
    let frontiers = 0;
    const guarded = new Proxy(sql, { apply(target, self, args) {
      const result = Reflect.apply(target, self, args);
      if (!String(args[0]).includes('harness_shared.interactive_usage_files') || ++frontiers !== 2) return result;
      return Promise.resolve(result).then(async rows => {
        await sql`UPDATE harness_shared.learning_spend_reservations SET note = note || ' ' WHERE loop_id = ${accounting.binding.loopId}`;
        return rows;
      });
    } });
    expect(await liveCurrentBenchNativeCostReader(handle, f.opts, { ...scope(), sql: guarded as unknown as ReturnType<typeof scope>['sql'] }, accounting.binding)())
      .toMatchObject({ costUsdMeasurementMissing: true, armMeta: { nativeCostAccounting: { attemptAccountingComplete: false, billedCostUsd: null } } });
    expect(frontiers).toBeGreaterThanOrEqual(2);
  });
  it('rejects a fabricated controller scope before accounting IO', async () => {
    const f = await costFixture(), accounting = await f.accountingFixture();
    expect(() => liveCurrentBenchNativeCostReader(handle, f.opts, scope(), { ...accounting.binding, preregHash: 'f'.repeat(64) }))
      .toThrow('exact frozen controller binding');
  });

  it('uses exact full native bytes and provider attribution while leaving gateway-attempt reconciliation explicit', async () => {
    const f = await costFixture(), result = await f.read();
    expect(result.costUsd).toBeCloseTo(0.00011, 10);
    expect(result).toMatchObject({ tokensIn: 80, tokensOut: 10, tokensCacheRead: 20, costUsdMeasurementMissing: true,
      armMeta: { nativeCostAccounting: { normalizedCostUsd: result.costUsd, billedKnownSubtotalUsd: 0.002,
        billedCostUsd: null, sourceCensusComplete: true, attemptAccountingComplete: false, missingBills: 0 } } });
  });
  it('includes an unlabeled native reviewer subtree and excludes another workspace', async () => {
    const f = await costFixture();
    await f.addParticipant('private-cost-reviewer', 'su-private-cost-reviewer', f.solver.taskId);
    await sql`INSERT INTO harness_shared.task_ledger (task_id, workspace_id, detail, class, state, parent_task_id)
      VALUES ('foreign-workspace-task', 'other-workspace', '{"coordOwnerId":"foreign-owner"}'::jsonb, 'agent-session', 'running', ${f.solver.taskId})`;
    const result = await f.read();
    expect(result.costUsd).toBeCloseTo(0.00022, 10);
    expect(result.armMeta).toMatchObject({ nativeCostAccounting: { sourceCensusComplete: true, billedKnownSubtotalUsd: 0.004,
      participantTaskIds: ['private-cost-reviewer', 'private-cost-solver'] } });
  });
  it('accounts for the prior carry source even though adv_sessions names only the latest native session', async () => {
    const f = await costFixture(); await f.addSource(f.solver.home, f.solver.ownerId);
    const result = await f.read();
    expect(result.costUsd).toBeCloseTo(0.00022, 10); expect(result.turns).toBe(2);
    expect(result.armMeta).toMatchObject({ nativeCostAccounting: { sourceCensusComplete: true, billedKnownSubtotalUsd: 0.004 } });
  });
  it('preserves normalized tokens when ledger dollars are estimated rather than provider bills', async () => {
    const f = await costFixture(); await sql`UPDATE harness_shared.agent_usage_samples SET cost_source = 'estimated'`;
    const result = await f.read(); expect(result.costUsd).toBeCloseTo(0.00011, 10);
    expect(result.armMeta).toMatchObject({ nativeCostAccounting: { billedCostUsd: null, billedKnownSubtotalUsd: 0, missingBills: 1 } });
  });
  it.each(['open turn', 'partial record'] as const)('preserves a source-proven closed subtotal before an incomplete %s without certifying a total', async tail => {
    const f = await costFixture();
    const source = readFileSync(f.solver.file, 'utf8');
    const suffix = tail === 'open turn' ? JSON.stringify({ type: 'turn_context', payload: {
      turn_id: randomUUID(), model: 'configured-alias' } }) + '\n' : '{"type":"event_msg"';
    writeFileSync(f.solver.file, source + suffix);
    const result = await f.read();
    expect(result.costUsd).toBeCloseTo(0.00011, 10);
    expect(result).toMatchObject({ tokensIn: 80, tokensOut: 10, tokensCacheRead: 20, turns: 1,
      costUsdMeasurementMissing: true, armMeta: { nativeCostAccounting: { sourceCensusComplete: false,
        billedKnownSubtotalUsd: 0.002, billedCostUsd: null, missingSources: 1, missingBills: 0 } } });
  });
  it('marks an incomplete ingest frontier as missing usage without guessing free work', async () => {
    const f = await costFixture(); await sql`UPDATE harness_shared.interactive_usage_files SET byte_offset = 0`;
    expect(await f.read()).toMatchObject({ costUsdMeasurementMissing: true,
      armMeta: { nativeCostAccounting: { sourceCensusComplete: false, missingSources: 1, billedCostUsd: null } } });
  });
  it('preserves known cost while refusing an unbound or foreign billed identity', async () => {
    const f = await costFixture(); await sql`UPDATE harness_shared.agent_usage_samples SET identity_owner_id = 'foreign-owner'`;
    const result = await f.read(); expect(result.costUsd).toBeCloseTo(0.00011, 10);
    expect(result.armMeta).toMatchObject({ nativeCostAccounting: { billedCostUsd: null, billedKnownSubtotalUsd: 0, missingBills: 1 } });
  });
});
let hostProvider: http.Server | undefined;
afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.stop();
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
  await sql`INSERT INTO harness_shared.task_ledger (task_id, workspace_id, session_id, detail) VALUES (${taskId}, ${workspaceId}, ${nativeSessionId},
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
afterAll(async () => { for (const gateway of gateways) await gateway.stop();
  await sql?.end({ timeout: 5 }); for (const root of roots) rmSync(root, { recursive: true, force: true }); });

describe('production current benchmark protocol and private completion bindings', () => {
  it('uses the committed protocol, native receipt, private work-item completion and scoped cleanup together', async () => {
    const f = await execution();
    const result = await f.run();
    // Surface the originating driver failure before the derived stop reason.
    expect(result.telemetry.generationError ?? null).toBeNull();
    expect(result.telemetry.stopReason).toBe('done');
    expect(f.admit).toHaveBeenCalledOnce();
    expect(native.launch).toHaveBeenCalledWith(expect.objectContaining({ harness: handle.slug, workItem: handle.featureId }),
      expect.objectContaining({ ...ctx, [Symbol.for('benchmark-test-private-route')]: {
        baseURL: 'http://127.0.0.1:32101', token: 'a'.repeat(64),
      } }));
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
