/** Offline acceptance of the unchanged official loop, real Linux boundary,
 * process-pipe task broker and maintained clone/grade/teardown seam. The tiny
 * task and deterministic Responses server are fixtures, never benchmark data
 * or provider billing evidence. No provider credential or external send. */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { measureProximusRuntime, proximusHostProcess, runProximusHost, requireProximusHostConfinement,
  readProximusAttemptPopulation, readProximusBilling, type ProximusRuntimeReceipt } from './proximus-runtime';
import { currentBenchAssignmentId, currentBenchGatewayController, currentBenchProviderAuthenticator,
  currentBenchOpenAiInputContract, currentBenchOpenAiInputReader } from './current-su';
import { currentProtocolFixture, allCapabilities } from './reproducibility/_protocol-test-fixture';
import { currentBenchmarkProtocolSchema } from './reproducibility/schema';
import { registerLearningLoop, getLearningSpendPositions } from '../learning-governor/store';
import { startGatewayService } from '../inference-gateway/launch';
import { makeBearerCredentialResolver } from '../inference-gateway/credential-store';
import { recordUsageSample } from '../agent-usage-telemetry';
import { makeFrontierSweCloneGradeSeam, type FrontierSweEnvHandle } from './frontier-swe-seam';
import type { BenchTask } from './types';

const exec = promisify(execFile);
// Maintained Debian SCM image supplies the real bash, timeout and git used by
// upstream submissions. Require the immutable local image; never pull at run time.
const image = 'buildpack-deps@sha256:1314fd2a9c83b257b37132883b3c8e326d3909211bdcb419c9757399ebc34bf3';
const token = 'offline_assignment_' + 'x'.repeat(48);
const workspaceId = 'proximus-controller-private';
const privateDb = vi.hoisted(() => ({ sql: undefined as postgres.Sql | undefined }));
// Only host DB/workspace selection is replaced. The controller, governor,
// SQL mutations, HTTP transport and canonical usage writer remain real.
vi.mock('@papercusp/db-org', async original => ({ ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => { if (!privateDb.sql) throw new Error('Private Proximus DB is not allocated'); return { sql: privateDb.sql }; } }));
vi.mock('../workspace-registry', async original => ({ ...await original<typeof import('../workspace-registry')>(),
  activeWorkspaceId: () => 'proximus-controller-private' }));
vi.mock('../sync-sse', async original => ({ ...await original<typeof import('../sync-sse')>(),
  notifySyncInvalidate: vi.fn(async () => {}) }));

async function controllerFixture(input: { measured: ProximusRuntimeReceipt;
  scratch: string; provider: typeof fetch }) {
  // Validate frozen inputs before allocating SQL or a gateway. Measurement
  // receipts intentionally contain fields outside the strict protocol schema.
  if (input.measured.harborVersion !== '0.23.0') throw new Error('Unsupported fixture Harbor runtime');
  const protocol = currentProtocolFixture('offline-proximus-controller', 180_000);
  for (const arm of protocol.arms) {
    arm.model = 'gpt-4.1'; arm.account = 'offline-proximus-account';
    arm.control = { topology: arm.id === 'baseline' ? 'stock-native-reference' : 'solo', solverGroup: arm.id,
      solverToolsHash: 'a'.repeat(64), capabilities: allCapabilities(arm.id === 'baseline' ? 'off' : 'on') };
  }
  const arm = protocol.arms[1]; arm.agent = 'proximus';
  arm.runtime = { sourceRevision: input.measured.sourceRevision, runtimeRevision: input.measured.runtimeRevision,
    clientVersion: input.measured.clientVersion, promptHash: 'a'.repeat(64), toolsHash: 'b'.repeat(64),
    proximus: { provider: 'openai', harborVersion: input.measured.harborVersion, maxInputTokens: 20_000, supportsVision: false } };
  Object.assign(protocol.priceSchedule.rates[0], { model: arm.model, inputTokenCeiling: 10_000,
    inputTokenCeilingSourceSha256: currentBenchOpenAiInputContract(arm.model, 10_000), outputTokenCeiling: 1000 });
  protocol.grader.images = { t1: image };
  currentBenchmarkProtocolSchema.parse(protocol);
  const preregHash = createHash('sha256').update(JSON.stringify(protocol)).digest('hex'), loopId = 'offline-proximus-loop';
  const resources = { inputTokens: 100_000, outputTokens: 1000, requestsPerArm: 3, usdPerArm: 3,
    maxOpenUsd: protocol.maxInFlightUsd, wallClockMs: 180_000, wallClockMsPerArm: 180_000,
    armIds: protocol.arms.map(a => currentBenchAssignmentId(protocol.runId, a.id, 't1', 1)) };
  const admin = postgres(await getTestPg(), { max: 1, onnotice: () => {} });
  const dbName = 'proximus_' + randomUUID().replaceAll('-', '');
  let sql: postgres.Sql | undefined, hosted: Awaited<ReturnType<ReturnType<typeof currentBenchGatewayController>['startHostGateway']>> | undefined;
  let auth: ReturnType<typeof currentBenchProviderAuthenticator> | undefined;
  const stop = async () => {
    try { await hosted?.stop(); } finally {
      auth?.revoke(); privateDb.sql = undefined;
      try { await sql?.end({ timeout: 5 }); }
      finally { try { await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); }
        finally { await admin.end({ timeout: 5 }); } }
    }
  };
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`); await markManagedTestDatabase(admin, dbName);
    const uri = new URL(await getTestPg()); uri.pathname = '/' + dbName;
    sql = postgres(uri.toString(), { max: 3, onnotice: () => {} }); privateDb.sql = sql;
    await sql.unsafe('CREATE SCHEMA harness_shared');
    for (const name of ['244-learning-governor.sql', '1116-learning-spend-reservations.sql', '1224-learning-reservation-resources.sql'])
      await sql.unsafe(readFileSync(new URL(`../../../../libs/papercusp/libs/db/sql/${name}`, import.meta.url), 'utf8')
        .split('\n').filter(line => !/\bGRANT\b|^\s*\\/.test(line)).join('\n'));
    await sql.unsafe(`ALTER TABLE harness_shared.learning_governor_loops ADD COLUMN pot_slug text;
      ALTER TABLE harness_shared.learning_spend_events ADD COLUMN pot_slug text;
      CREATE FUNCTION harness_shared.goal_id_for_usage_session(text,text) RETURNS text LANGUAGE sql AS 'SELECT NULL::text';
      CREATE TABLE harness_shared.agent_usage_samples (id bigserial PRIMARY KEY, workspace_id text, ts bigint,
        bucket_key text, provider text, model_class text, source text, input_tokens bigint, output_tokens bigint,
        cache_read_tokens bigint, cache_creation_tokens bigint, cost_usd numeric, model text, cost_source text,
        harness_slug text, run_id text, role text, rl_requests_limit bigint, rl_requests_remaining bigint,
        rl_tokens_limit bigint, rl_tokens_remaining bigint, rl_reset_at bigint, session_id text, goal_id text,
        tool_name text, turn_trigger text, account_id text, price_table_version text, usage_provenance jsonb)`);
    await registerLearningLoop(sql, { workspaceId, loopId, budgetKind: 'lifetime', budgetUsd: protocol.aggregateBudgetUsd,
      enabled: true, meta: { reservationBinding: preregHash, reservationResourceBudget: resources } });
    const key = join(input.scratch, 'fake-provider-key'); writeFileSync(key, 'OFFLINE_PROVIDER_TOKEN', { mode: 0o600 });
    const account = { id: arm.account, provider: 'codex' as const, credentialRef: `token:${key}` };
    const count = currentBenchOpenAiInputReader({ model: arm.model, inputTokens: 10_000 }, {
      fetch: async () => Response.json({ object: 'response.input_tokens', input_tokens: 100 }) });
    auth = currentBenchProviderAuthenticator({ workspaceId, preregHash, protocol, armId: 'baseline', taskId: 't1', seed: 1,
      readNativeInputCeiling: count.read }, { readAccount: async (_ws, id) => id === account.id ? account : null,
      credentialResolver: (_provider, ref) => makeBearerCredentialResolver(ref) });
    const controller = currentBenchGatewayController({ workspaceId, loopId, token, preregHash, protocol, resources,
      armId: 'baseline', taskId: 't1', seed: 1, outputTokenLimit: 1000, authenticateProvider: auth.authenticateProvider },
      { enabled: async () => true, getSql: async () => sql!, log: () => {} });
    hosted = await controller.startHostGateway(() => {}, options => startGatewayService({ ...options,
      checkGoalInferenceAdmission: async () => ({ allowed: true, goalId: null, reason: 'no-goal' }),
      readAcceptedOperationModelPolicy: async () => ({ status: 'none' }),
      recordAcceptedOperationModelAttestation: async () => {},
      resolveAccounts: async () => [{ accountId: account.id, credentialRef: account.credentialRef, source: 'env' }],
      resolveLocalBackends: async () => [], observePool: () => () => {}, fetchImpl: input.provider,
      refreshIntervalMs: 0, poolReloadIntervalMs: 0, localBackendReloadIntervalMs: 0 }));
    const readCensus = async () => (await getLearningSpendPositions(sql!, { workspaceId, loopId, includeReservations: true })).census;
    return { protocol, arm, hosted, sql, readCensus, stop };
  } catch (error) { await stop(); throw error; }
}

it.each(['direct process', 'controller accounting'] as const)
('runs the official Proximus tool/submit loop against its bound task and grades the resulting workspace (%s)', async mode => {
  await exec('docker', ['image', 'inspect', image], { timeout: 30_000 });
  const project = fileURLToPath(new URL('../../vendor/proximus', import.meta.url));
  const lock = createHash('sha256').update(readFileSync(join(project, 'uv.lock'))).digest('hex').slice(0, 16);
  const runtime = await exec('uv', ['run', '--frozen', '--no-dev', '--python', '3.12', '--project', project,
    'python', '-c', 'import sys;print(sys.executable)'], { timeout: 120_000,
    env: { ...process.env, UV_PROJECT_ENVIRONMENT: join(tmpdir(), `papercusp-proximus-${lock}`) } });
  const pythonBin = runtime.stdout.trim();
  const measured = await measureProximusRuntime({ pythonBin });
  const scratch = mkdtempSync(join(tmpdir(), 'px-official-loop-'));
  const trialDir = join(scratch, 'trial'); mkdirSync(trialDir);
  const tests = join(scratch, 'tasks/t1/tests'); mkdirSync(tests, { recursive: true });
  writeFileSync(join(tests, 'test.sh'), 'mkdir -p /logs/verifier\nif [ "$(cat /app/answer.txt)" = solved ]; then echo 1; else echo 0; fi > /logs/verifier/reward.txt\n');
  const task: BenchTask = { benchmark: 'frontier-swe', instanceId: 't1', problemStatement: 'Write solved to /app/answer.txt, then submit.',
    graderMeta: { dockerImage: image, networkMode: 'no-network', gpus: 0 } };
  const seam = makeFrontierSweCloneGradeSeam({ version: 'offline-fixture-v1', repoDir: scratch,
    extraRunArgs: ['--label', `papercusp.proximus-offline-proof=${scratch}`] });
  let succeeded = false;
  let handle: FrontierSweEnvHandle | undefined;
  const requests: { path: string; authorization: string | undefined; body: any }[] = [];
  const failures: string[] = [];
  const response = (path: string, authorization: string | undefined, body: any) => {
      requests.push({ path, authorization, body });
      if (requests.length > 3) throw new Error('Unexpected extra official-loop request');
      const first = requests.length === 1;
      const output = [{ type: 'function_call', id: `fc_${requests.length}`, call_id: `call_${requests.length}`,
        name: first ? 'bash' : 'submit', arguments: JSON.stringify(first ? {
          command: "printf 'solved\\n' > /app/answer.txt; test -z \"$OPENAI_API_KEY\"; printf 'task-tool-result'", timeout_sec: 10,
        } : {}), status: 'completed' }];
      return { id: `resp_${requests.length}`, object: 'response', created_at: 1,
        status: 'completed', model: 'gpt-4.1', output,
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  };
  const gateway = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const result = response(req.url!, req.headers.authorization, JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
    } catch (error) { failures.push(String(error)); res.writeHead(500); res.end('{}'); }
  });
  let controlled: Awaited<ReturnType<typeof controllerFixture>> | undefined;
  try {
    await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
    const baseURL = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
    const maxWallClockMs = 180_000;
    if (mode === 'controller accounting') controlled = await controllerFixture({ measured, scratch,
      provider: async (target, init) => {
        if (String(target) !== 'https://api.openai.com/v1/responses') throw new Error('Unexpected fixture provider route');
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : new TextDecoder().decode(init?.body as Uint8Array));
        return Response.json(response('/v1/responses', new Headers(init?.headers).get('authorization') ?? undefined, body));
      } });
    handle = await seam.clone(task);
    await exec('docker', ['exec', handle.containerId, 'mkdir', '-p', '/app'], { timeout: 30_000 });
    // Fail preflight with a concrete missing-tool error rather than waiting
    // through upstream retries on an unsuitable image.
    await exec('docker', ['exec', handle.containerId, 'bash', '-lc', 'command -v git && command -v timeout'], { timeout: 30_000 });
    const result = controlled ? await runProximusHost(controlled.protocol, {
      runId: controlled.protocol.runId, armId: 'baseline', taskId: 't1', seed: 1, agent: 'proximus',
      model: controlled.arm.model, effort: controlled.arm.effort, account: controlled.arm.account,
      budget: controlled.arm.generationBudget, topology: 'stock-native-reference', handle, pythonBin, trialDir,
      instruction: task.problemStatement, network: 'none', networkMode: 'no-network',
      maxWallClockMs, outputTokenLimit: 1000, gateway: controlled.hosted,
    }) : await proximusHostProcess({ pythonBin, operation: 'run', maxWallClockMs,
      confinement: { trialDir, gatewayBaseURL: baseURL, task: { ...handle, network: 'none', networkMode: 'no-network' } },
      stdin: JSON.stringify({ trialDir, instruction: task.problemStatement, network: 'none', networkMode: 'no-network',
        gateway: { baseURL, token }, spec: { ...measured, agent: 'harbor_proximus:Proximus',
          provider: 'openai', model: 'gpt-4.1', modelName: 'openai/gpt-4.1', taskId: task.instanceId,
          containerId: handle.containerId, image, maxWallClockMs, options: { time_budget_sec: maxWallClockMs / 1000,
            reasoning_effort: 'high', model_info: { max_input_tokens: 20_000, supports_vision: false, mode: 'responses' },
            llm_call_kwargs: { max_tokens: 1000 } } } }) });
    expect(result).toMatchObject({ status: 'completed', runtime: measured, billingStatus: 'unreconciled' });
    expect(failures).toEqual([]);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.path).toBe('/v1/responses');
      expect(request.authorization).toBe(`Bearer ${controlled ? 'OFFLINE_PROVIDER_TOKEN' : token}`);
      expect(request.body.model).toBe('gpt-4.1');
    }
    expect(JSON.stringify(requests[1].body)).toContain('task-tool-result');
    if (controlled) {
      expect(requireProximusHostConfinement(result)).toMatchObject({ trialDir, task: { containerId: handle.containerId, image } });
      await controlled.hosted.stop();
      const population = await readProximusAttemptPopulation(controlled.hosted.accountingBinding, controlled.readCensus);
      expect(population).toMatchObject({ status: 'terminal', usageComplete: true,
        knownUsage: { modelCalls: 3, tokensIn: 300, tokensOut: 30, tokensCacheRead: 0, tokensCacheWrite: 0 } });
      if (population.status !== 'terminal') throw new Error('No complete controller request population');
      expect(new Set(population.attempts.map(attempt => attempt.gatewayRequestId)).size).toBe(3);
      const readBill = () => readProximusBilling(controlled!.sql, controlled!.hosted.accountingBinding, controlled!.readCensus);
      expect(await readBill()).toMatchObject({ status: 'incomplete', knownSubtotalMicros: '0', billedInferenceMicros: null });
      // Explicit synthetic provider bills exercise the canonical writer and
      // exact SQL join. They prove fixture reconciliation, never a real charge.
      for (const attempt of population.attempts) await recordUsageSample({ bucketKey: 'offline-proximus',
        provider: 'openai', modelClass: 'fixture', source: 'headers', model: controlled.arm.model,
        runId: controlled.protocol.runId, accountId: controlled.arm.account, costUsd: 0.001, costSource: 'provider',
        inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0,
        providerRequest: { gatewayRequestId: attempt.gatewayRequestId, gatewayAttemptId: attempt.attemptId,
          providerResponseId: attempt.providerCompletion!.responseId, manifestSha256: controlled.hosted.accountingBinding.preregHash,
          assignmentId: controlled.hosted.accountingBinding.assignmentId } });
      expect(await readBill()).toMatchObject({ status: 'complete', billedInferenceMicros: '3000', missingAttemptIds: [] });
    }
    const answer = await exec('docker', ['exec', handle.containerId, 'cat', '/app/answer.txt'], { timeout: 30_000 });
    expect(answer.stdout).toBe('solved\n');
    // Upstream actually committed/restored its submission inside the disposable
    // task, independently of the host's shared Git tree.
    const submissions = readFileSync(join(trialDir, 'submissions.jsonl'), 'utf8');
    expect(submissions).toContain('harness_commit');
    expect(readFileSync(join(trialDir, 'trajectory.json'), 'utf8')).toContain('task-tool-result');
    const grade = await seam.grade(task, handle);
    expect(grade).toMatchObject({ resolved: true, score: 1,
      graderStatus: 'passed' satisfies typeof grade.graderStatus });
    succeeded = true;
  } finally {
    try { if (handle) await seam.teardown(handle); }
    finally {
      try { await controlled?.stop(); }
      finally { await new Promise<void>(resolve => gateway.close(() => resolve())); }
      if (succeeded) rmSync(scratch, { recursive: true, force: true });
      else {
        // Keep exact inputs and official diagnostics on failure; a successor
        // can diagnose this attempt without replaying it or losing its task ID.
        writeFileSync(join(scratch, 'failure.json'), JSON.stringify({ handle, failures,
          requests: requests.map(({ path, body }) => ({ path, body })) }));
        process.stderr.write(`Proximus offline failure evidence: ${scratch}\n`);
      }
    }
  }
  await expect(exec('docker', ['inspect', handle!.containerId], { timeout: 30_000 })).rejects.toThrow();
}, 330_000);
