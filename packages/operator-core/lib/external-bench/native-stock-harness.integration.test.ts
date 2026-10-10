/** Actual stock factory/native CLI/SRT/task and transcript IO against private
 * Postgres. The local listener refuses every request and has no forwarding code
 * or provider credential. This is lifecycle proof, not benchmark performance. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { currentProtocolFixture } from './reproducibility/_protocol-test-fixture';
import { preregister } from './reproducibility/prereg';
import { createCurrentStockBenchHarness } from './native-harness-runner';
import { currentBenchAssignmentId, currentBenchGatewayController, type CurrentSuBenchOptions } from './current-su';
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';
import { GatewayRequestTelemetry } from '../inference-gateway/request-stage-telemetry';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, homes: '' }));
vi.mock('@papercusp/db-org', async original => ({ ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('@papercusp/orchestrator/session-launch-dirs', () => ({ codexHomeForSessionKey: (id: number) => join(h.homes, String(id)) }));
vi.mock('../workspace-registry', async original => ({ ...await original<typeof import('../workspace-registry')>(), activeWorkspaceId: () => 'private-stock-native' }));
// Keep delayed lifecycle routines from acting after the fixture DB is dropped.
vi.mock('../session-end-lease-release-hook', () => ({ scheduleSessionEndLeaseRelease: () => {} }));
vi.mock('../session-archive-hook', () => ({ scheduleArchiveForAdvSession: () => {} }));

const workspaceId = 'private-stock-native';
let db: OrgTestDb, root: string;
beforeAll(async () => {
  expect(execFileSync('codex', ['--version'], { encoding: 'utf8' })).toMatch(/codex/i);
  db = await createOrgTestDb(); h.sql = db.adminSql;
  // SRT has private shared-memory mounts; native files must live on physical /tmp.
  root = mkdtempSync('/tmp/stock-native-factory-'); h.homes = join(root, 'homes'); mkdirSync(h.homes);
});
afterAll(async () => { await db?.cleanup(); if (root) rmSync(root, { recursive: true, force: true }); });

async function refusedAssignment(name: string, problemStatement: string) {
  const repoRoot = join(root, `protocol-${name}`), checkout = join(root, `checkout-${name}`); mkdirSync(repoRoot); mkdirSync(checkout);
  const config = currentProtocolFixture(`PRIVATE-STOCK-NATIVE-${name}`, 8000);
  const corpus = JSON.stringify({ entries: [{ key: 'permitted:test', text: 'Permitted frozen context.' }] });
  for (const name of ['corpus', 'memory']) writeFileSync(join(repoRoot, `${name}.json`), corpus);
  config.context = { ...config.context, corpusRef: 'corpus.json', memoryRef: 'memory.json',
    corpusHash: createHash('sha256').update(corpus).digest('hex'), memoryHash: createHash('sha256').update(corpus).digest('hex') };
  const frozen = await preregister({ workspaceId, sql: h.sql as never, runId: config.runId, suites: [], config, repoRoot });
  // Immutable protocol fixture only; no commits in the shared staging checkout.
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: repoRoot });
  const body = readFileSync(frozen.absFilePath, 'utf8');
  execFileSync('git', ['fast-import', '--quiet'], { cwd: repoRoot,
    input: `blob\nmark :1\ndata ${Buffer.byteLength(body)}\n${body}\ncommit refs/heads/main\ncommitter Fixture <fixture@example.invalid> 1577836800 +0000\ndata 6\nfrozen\nM 100644 :1 ${frozen.filePath}\n\ndone\n` });
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.url?.endsWith('/responses')) bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Private no-forwarding lifecycle fixture.' } }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  const controller = currentBenchGatewayController({ workspaceId, loopId: 'private-stock-loop', token: 'a'.repeat(64),
    preregHash: frozen.preregHash, protocol: config, armId: 'baseline', taskId: 't1', seed: 1,
    resources: { inputTokens: 100000, outputTokens: 1000, requestsPerArm: 50, usdPerArm: 3, maxOpenUsd: 3,
      wallClockMs: 16000, wallClockMsPerArm: 8000,
      armIds: config.arms.map(arm => currentBenchAssignmentId(config.runId, arm.id, 't1', 1)) }, authenticateProvider: async () => null });
  const hosted = await controller.startNativeGateway(() => {}, async () => ({ port, stop: async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } } as never));
  const opts: CurrentSuBenchOptions = { workspaceId, runId: config.runId, armId: 'baseline', seed: 1,
    agent: 'codex', model: 'configured-alias', effort: 'high', account: 'auto', pollIntervalMs: 25, driveTimeoutMs: 15000,
    preregistration: { config, preregHash: frozen.preregHash, repoRoot } };
  const ctx = { workspaceId, principal: { slug: 'authenticated-private-fixture' } } as PapercuspUnifiedToolContext;
  try {
    const factory = createCurrentStockBenchHarness(opts, ctx, { ...hosted,
      admit: async () => ({ admitted: true, receiptRef: 'private-no-spend-admission' }), observeIdentity: async () => null }, { sql: h.sql as never });
    const result = await factory.spinRunAndCost({ blueprintId: 'native-codex',
      task: { benchmark: 'swe-bench-pro', instanceId: 't1', problemStatement, graderMeta: {} },
      checkout: { dir: checkout, repo: 'fixture/private', baseCommit: 'fixture', cleanup: async () => {} },
      budget: config.arms[1].generationBudget });
    // The listener supplies no model answer or billed identity. Refusal must
    // never become a verified successful generation or a complete free run.
    expect(result.telemetry.stopReason, JSON.stringify(result)).not.toBe('done');
    expect(result.telemetry.armMeta?.costUsdMeasurementMissing, JSON.stringify(result)).toBe(true);
    const tasks = await h.sql`SELECT task_id, session_id, state, exit_code FROM harness_shared.task_ledger WHERE workspace_id=${workspaceId}`;
    const sessions = await h.sql`SELECT id, session_id, ended_at FROM harness_shared.adv_sessions WHERE workspace_id=${workspaceId}`;
    const diagnostic = JSON.stringify({ telemetry: result.telemetry, tasks, sessions });
    expect(bodies.length, diagnostic).toBeGreaterThan(0); expect(bodies[0].model, diagnostic).toBe('configured-alias');
    const rows = await h.sql`SELECT t.task_id, t.session_id, t.state, t.ended_at, a.id, a.ended_at AS session_ended_at
      FROM harness_shared.task_ledger t JOIN harness_shared.adv_sessions a
        ON a.workspace_id=t.workspace_id AND a.coord_owner_id=t.detail->>'coordOwnerId' AND a.session_id=t.session_id
      WHERE t.workspace_id=${workspaceId} AND t.detail->>'assignmentId'=${currentBenchAssignmentId(config.runId, 'baseline', 't1', 1)}`;
    expect(rows).toHaveLength(1); expect(rows[0].session_id).toMatch(/^[0-9a-f-]{36}$/i);
    // managedSpawn persists exit asynchronously after its cgroup handoff
    // barrier. Observe its authoritative terminal row, not the stream's exit.
    await expect.poll(async () => {
      const [terminal] = await h.sql`SELECT ended_at FROM harness_shared.task_ledger WHERE task_id=${rows[0].task_id}`;
      return terminal?.ended_at;
    }, { timeout: 10000, interval: 50 }).not.toBeNull();
    expect(rows[0].session_ended_at).not.toBeNull();
    const files = await h.sql`SELECT file_path, byte_offset FROM harness_shared.interactive_usage_files WHERE workspace_id=${workspaceId}`;
    expect(files.length).toBeGreaterThan(0);
    expect(files.some(file => file.file_path.includes(join(h.homes, String(rows[0].id), 'sessions')))).toBe(true);
    const collector = new GatewayRequestTelemetry();
    const span = collector.begin({ provider: 'codex', protocol: 'openai-responses' });
    span.setCacheShape(Buffer.from(JSON.stringify(bodies[0])));
    const cache = span.finish('gateway-error', 400)!.cache;
    const text = JSON.stringify(bodies[0].input);
    return { cache, checkout, body: bodies[0], checkoutInInput: text.includes(checkout) };
  } finally { await hosted.stop(); }
}

it('retains a real native UUID and terminal ingestion after local refusal without provider forwarding', async () => {
  await refusedAssignment('lifecycle', 'Describe the empty repository.');
}, 45000);

it('keeps source-bound native instruction templates across distinct isolated assignments', async () => {
  const first = await refusedAssignment('fingerprint-first', 'Describe the first empty repository.');
  const second = await refusedAssignment('fingerprint-second', 'Describe the second empty repository.');
  expect(first.cache.shape).toBe('observed'); expect(second.cache.shape).toBe('observed');
  expect(first.cache.instructions?.bytes).toBe(first.cache.instructions?.hashedBytes);
  expect(first.cache.tools?.bytes).toBe(first.cache.tools?.hashedBytes);
  console.info('NATIVE_ASSIGNMENT_FINGERPRINTS', JSON.stringify({ first: first.cache, second: second.cache,
    checkoutInInput: [first.checkoutInInput, second.checkoutInInput] }));
  // This is native request-shape proof only: refusal supplies no provider answer,
  // metered success, preregistration pin or benchmark-performance evidence.
  expect(second.cache.tools).toEqual(first.cache.tools);
  expect(first.cache.instructions).not.toEqual(second.cache.instructions);
  expect(first.cache.nativeInstructionTemplate?.fingerprint?.bytes).toBeGreaterThan(0);
  expect(second.cache.nativeInstructionTemplate?.fingerprint).toEqual(first.cache.nativeInstructionTemplate?.fingerprint);
  for (const assignment of [first, second]) {
    const declaredRoot = `${String((assignment.body.input as Array<Record<string, unknown>>)
      .flatMap(item => Array.isArray(item.content) ? item.content : [])
      .find(part => String(part.text).includes('<skills_instructions>'))?.text)
      .match(/^- [\x60]r0[\x60] = [\x60]([^\x60]+)[\x60]$/m)?.[1]}`;
    expect(assignment.cache.nativeInstructionTemplate?.skillsRootHash)
      .toBe(createHash('sha256').update(declaredRoot).digest('hex'));
  }
}, 90000);
