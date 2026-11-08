/** Whole factory/read path preparation. The native process and provider are
 * deliberately not started; product readers and lease/source checks use PG. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLatencyPgFixture } from '../../../test/_latency-pg-fixture';
import { currentProtocolFixture, allCapabilities } from '../../external-bench/reproducibility/_protocol-test-fixture';
import { canonicalJson } from '../../external-bench/reproducibility/canonical-json';
import { benchFixtureAllocationSha256, freezeBenchFixtureReadBoundary, readBenchFixtureSourceSnapshot,
  BENCH_PRIVATE_FIXTURE_TOOL, type BenchFixtureAllocation } from '../../external-bench/private-fixture-reads';
import type { BenchFixtureReadArgs } from '../../external-bench/private-fixture-reads';
import { startCurrentBenchTaskAssignment, currentBenchTaskProviderCapture, type CurrentTaskInput } from '../../external-bench/run-launcher';
import { currentBenchAssignmentId, currentBenchLaunchRequest, liveCurrentSuBenchPorts } from '../../external-bench/current-su';
import { upsertBenchRun } from '../../external-bench/run-store';
import { runWithWorkspace } from '../../workspace-als';
import { evaluateSessionConfinement, type SessionToolConfinement } from '../../capability-envelope/session-confinement';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

const h = vi.hoisted(() => ({ sql: undefined as postgres.Sql | undefined,
  ceiling: undefined as SessionToolConfinement | undefined, launch: vi.fn(), item: vi.fn() }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => { if (!h.sql) throw Error('Private fixture DB is not ready'); return { sql: h.sql }; },
  withWorkspace: async <T>(ws: string, cb: (tx: postgres.Sql) => Promise<T>) => h.sql!.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    return cb(tx as unknown as postgres.Sql);
  }),
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
// Keep the native launcher as the explicit no-inference boundary. Capture the
// actual server ceiling built by liveCurrentSuBenchPorts; do not construct one.
vi.mock('../capability/launch-agent', () => ({ default: { handler: h.launch },
  INTERNAL_SCOPED_INFERENCE_GATEWAY: Symbol.for('latency-integration-gateway'),
  INTERNAL_SCOPED_SESSION_CONFINEMENT: Symbol.for('latency-integration-ceiling'),
  INTERNAL_BACKEND_BIN_OVERRIDE: Symbol.for('latency-integration-backend') }));
vi.mock('../../capability-envelope/session-confinement-store', () => ({
  readSessionConfinement: async () => h.ceiling,
}));
vi.mock('../../work-items', async original => ({
  ...await original<typeof import('../../work-items')>(), getWorkItem: h.item,
}));
import tool from './read-private-fixture';
import { proposeRubric } from '../../rubrics';
import { seedPlan } from '../plans/__tests__/_pg-tool-fixture';
import { recordPlanRevisionInTransaction } from '../plans/revisions';
import { setSpecClause, type SpecClauseSql } from '../plans/spec-clauses-store';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const clock = '2026-11-06T00:00:00.000Z';
const ownerId = 'su-latency-private-reader';
let fx: Awaited<ReturnType<typeof createLatencyPgFixture>>;
const roots: string[] = [];
let fixtureSerial = 0;
beforeAll(async () => { fx = await createLatencyPgFixture(); h.sql = fx.db.adminSql; }, 180_000);
afterAll(async () => { h.sql = undefined; if (fx) expect(await fx.cleanup()).toBe('dropped'); }, 60_000);
afterEach(() => { h.ceiling = undefined; vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture(armId: 'cold' | 'warm', taskId: 'LATENCY-M1:T01' | 'LATENCY-M1:T02' | 'LATENCY-M1:T03') {
  const workspaceId = fx.fixture.workspace, sql = fx.db.adminSql, scope = { sql, workspaceId };
  const root = mkdtempSync(join(tmpdir(), 'latency-whole-read-')); roots.push(root);
  const checkout = join(root, 'assignment'); mkdirSync(checkout);
  const rubricRef = `private-${armId}-${taskId.slice(-3).toLowerCase()}-${++fixtureSerial}`, subjectRef = `subject-${rubricRef}`;
  await runWithWorkspace(workspaceId, () => proposeRubric({ rubricId: rubricRef, title: 'Private input rubric',
    characteristic: 'fixture-read', criteria: [{ key: 'evidence', title: 'Exact evidence', model: 'read source',
      method: 'compare exact input', driftMarkers: 'lost text' }], status: 'active', by: ownerId }));
  const issueIds = Array.from({ length: taskId.endsWith('T02') ? 23 : 2 }, (_, i) => `EI-${rubricRef}-${i}`);
  for (const [i, issueId] of issueIds.entries()) {
    const observation = { rubricRef, subject: { kind: 'fixture', ref: subjectRef },
      ratings: { evidence: { rating: 'healthy', evidence: `Exact input ${i}: ` + 'é🧪 source '.repeat(i < 2 ? 800 : 1) } },
      rerunRecipe: { schemaVersion: 1, evaluator: 'fixture-reader', args: { retained: 'recipe-data '.repeat(i < 2 ? 600 : 1) } } };
    await sql`INSERT INTO harness_shared.engineer_issues
      (workspace_id, issue_id, title, kind, state, created_by, created_at, updated_at, payload)
      VALUES (${workspaceId}, ${issueId}, 'Private source card', 'change', 'open', ${ownerId},
        ${new Date(Date.parse(clock) - (i + 1) * 1000)}, ${new Date(clock)}, ${JSON.stringify({ observation })}::text::jsonb)`;
  }
  const allocation: BenchFixtureAllocation = {
    'LATENCY-M1:T01': { A: { issueId: issueIds[0], comparisonTime: clock }, B: { issueId: issueIds[1], comparisonTime: clock } },
    'LATENCY-M1:T02': { A: { issueId: issueIds[0], rubricRef, subjectRef, comparisonTime: clock },
      B: { issueId: issueIds[1], rubricRef, subjectRef, comparisonTime: clock } },
    'LATENCY-M1:T03': { A: { harness: 'unused', slug: 'a', revision: 1, specAsOf: clock },
      B: { harness: 'unused', slug: 'b', revision: 1, specAsOf: clock } },
  };
  if (taskId === 'LATENCY-M1:T03') {
    const harness = `private-history-${fixtureSerial}`;
    for (const which of ['A', 'B'] as const) {
      const slug = `history-${which.toLowerCase()}`;
      const body = `---\nslug: ${slug}\ntitle: Frozen history ${which}\nstatus: draft\n---\n\n## Work\n\n- **P-001** \`todo\` — Original task.\n\n## Original\n\n` + `Original ${which} é🧪. `.repeat(900);
      await seedPlan(sql, workspaceId, harness, slug, body);
      await sql`INSERT INTO harness_shared.plan_items (workspace_id, harness_slug, plan_slug, item_id)
        VALUES (${workspaceId}, ${harness}, ${slug}, 'P-001')`;
      const identity = { ownerId, ownerLabel: 'Private fixture', source: 'static-client' as const, workspaceId, userId: null };
      await sql.begin(tx => recordPlanRevisionInTransaction(tx, { workspaceId, harnessSlug: harness, planSlug: slug, content: body, identity }));
      const clause = { harnessSlug: harness, planSlug: slug, specId: 'SPEC-1', expectedRevision: 0,
        planItemId: 'P-001', behavior: `Original accepted ${which}. `.repeat(800), behaviorClass: 'concurrency' as const,
        requiredEvidence: ['exact historical readback'], requiredTestLayers: ['integration'], mutationRequired: false,
        lifecycleStatus: 'active' as const, acceptanceRef: 'D-001', actorId: ownerId };
      const written = await sql.begin(tx => setSpecClause(clause, { workspaceId, harnessSlug: harness, executor: tx as unknown as SpecClauseSql }));
      expect(written.status).toBe('created');
      await sql`UPDATE harness_shared.plan_revisions SET created_at = '2026-11-01' WHERE workspace_id = ${workspaceId}
        AND harness_slug = ${harness} AND plan_slug = ${slug}`;
      await sql`UPDATE harness_shared.plan_spec_clause_revisions SET created_at = '2026-11-01', accepted_at = '2026-11-01'
        WHERE workspace_id = ${workspaceId} AND harness_slug = ${harness} AND plan_slug = ${slug}`;
      await seedPlan(sql, workspaceId, harness, slug, body.replaceAll('Original', 'Later'));
      await sql.begin(tx => recordPlanRevisionInTransaction(tx, { workspaceId, harnessSlug: harness, planSlug: slug,
        content: body.replaceAll('Original', 'Later'), identity }));
      await sql.begin(tx => setSpecClause({ ...clause, expectedRevision: 1, behavior: 'Later accepted behavior' },
        { workspaceId, harnessSlug: harness, executor: tx as unknown as SpecClauseSql }));
      allocation['LATENCY-M1:T03'][which] = { harness, slug, revision: 1, specAsOf: clock };
    }
  }
  const task = { benchmark: 'harness-bench' as const, instanceId: taskId, problemStatement: 'Read both exact frozen inputs.',
    repo: checkout, baseCommit: 'a'.repeat(40), graderMeta: { latencyM1: { qualityOracle: { hidden: 'private-answer-reference' } } } };
  const protocol = currentProtocolFixture(`private-${armId}-${taskId.slice(-3).toLowerCase()}-${fixtureSerial}`, 60_000);
  protocol.taskIds = [taskId]; protocol.sampling!.taskRepositories = { [taskId]: 'fixture-repo', 'withheld-1': 'withheld-repo' };
  const snapshot = JSON.stringify({ entries: [{ key: 'input', text: 'Use only the assigned source reader.' }] });
  for (const name of ['corpus', 'memory']) writeFileSync(join(root, `${name}.json`), snapshot);
  protocol.context = { ...protocol.context, corpusRef: 'corpus.json', memoryRef: 'memory.json', corpusHash: digest(snapshot), memoryHash: digest(snapshot) };
  const initial = freezeBenchFixtureReadBoundary({ binding: { workspaceId, runId: protocol.runId, preregHash: 'a'.repeat(64),
    assignmentId: 'bench-assignment:prepare', armId, seed: 1 }, taskId,
    expectedSha256: benchFixtureAllocationSha256(allocation), allocation })!;
  const pin = async (which: 'A' | 'B') => { const text = canonicalJson(await readBenchFixtureSourceSnapshot(initial, which, scope));
    return { sha256: digest(text), bytes: Buffer.byteLength(text) }; };
  allocation.verification = { [taskId]: { inputs: { A: await pin('A'), B: await pin('B') },
    promptSha256: digest(task.problemStatement), oracleSha256: digest(canonicalJson(task.graderMeta.latencyM1.qualityOracle)) } };
  for (const [i, arm] of protocol.arms.entries()) { arm.id = i ? 'warm' : 'cold';
    arm.account = 'private-provider-account';
    arm.control = { topology: 'solo', solverGroup: 'private-paired', solverToolsHash: 'f'.repeat(64),
      capabilities: allCapabilities('off'), fixtureReads: { kind: 'latency-m1-v1', sha256: benchFixtureAllocationSha256(allocation) } }; }
  const preregHash = digest(canonicalJson(protocol)), hostRunId = `host-${protocol.runId}`, loopId = `benchmark:${preregHash}`;
  const ctx = { workspaceId, uiClientId: ownerId, principal: { slug: ownerId }, isSuperuser: true, role: 'worker',
    log: vi.fn(), progress: vi.fn(), emit: vi.fn(), signal: new AbortController().signal } as PapercuspUnifiedToolContext;
  const input: CurrentTaskInput = { options: { workspaceId, runId: protocol.runId, armId, seed: 1,
    agent: 'codex', model: 'configured-alias', effort: 'high', account: 'private-provider-account',
    preregistration: { preregHash, config: protocol, repoRoot: root } }, protocol, task, scope, context: ctx,
    resources: { requestsPerArm: 2, inputTokens: 2000, outputTokens: 8192,
      armIds: protocol.arms.map(arm => currentBenchAssignmentId(protocol.runId, arm.id, taskId, 1)).sort(),
      usdPerArm: 3, maxOpenUsd: 3, wallClockMsPerArm: 60_000, wallClockMs: 120_000 }, loopId, hostRunId,
    checkout: { dir: checkout, repo: 'fixture-repo', baseCommit: 'a'.repeat(40), cleanup: async () => {} },
    fixtureReads: allocation, observation: { runtimeWorkspaceId: workspaceId, workerUnit: 'private-worker', gatewayUnit: 'private-gateway' } };
  await upsertBenchRun({ id: hostRunId, arm: armId, taskSetId: 'custom', model: input.options.model,
    status: 'running', config: { current: { preregHash }, protocol, loopId } }, scope);
  h.item.mockResolvedValue({ harness: 'private-assignment', state: 'wip', assignee: ownerId });
  h.launch.mockImplementation(async (_args, nativeCtx) => { h.ceiling = nativeCtx[Symbol.for('latency-integration-ceiling')]; return { data: {} }; });
  const assignment = await startCurrentBenchTaskAssignment(input, {
    startGateway: async () => ({ port: 32123, stop: async () => {} } as never) });
  roots.push((await currentBenchTaskProviderCapture(input)).captureRoot);
  const handle = { slug: 'private-assignment', featureId: 'WI-private-assignment', worktreePath: checkout };
  const ports = liveCurrentSuBenchPorts(ctx, assignment.observations, assignment.options, { sql });
  const context = await ports.restoreContext(handle, taskId);
  await ports.launch(currentBenchLaunchRequest(assignment.options, handle, task.problemStatement, context));
  return { input, ctx, assignment, issueIds, allocation, rubricRef };
}

async function readProduct<T>(args: BenchFixtureReadArgs, ctx: PapercuspUnifiedToolContext): Promise<T> {
  let reply = await tool.handler(args, ctx), text = '', pages = 0, expectedHash: string | undefined;
  for (;;) {
    if (!('data' in reply)) throw Error('Private fixture reader returned no data');
    const data = reply.data as Record<string, unknown>;
    const page = data.privateFixtureResult as { sha256: string; bytes: number; totalChars: number;
      offset: number; text: string; complete: boolean; next: { tool: string; args: BenchFixtureReadArgs } | null } | undefined;
    if (!page) { expect(pages).toBe(0); return data as T; }
    expect(++pages).toBeLessThan(2000);
    expect(Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(data) }] }))).toBeLessThanOrEqual(6000);
    expectedHash ??= page.sha256;
    expect(page.sha256).toBe(expectedHash); expect(page.offset).toBe(text.length); text += page.text;
    if (page.complete) {
      expect(page.next).toBeNull(); expect(text.length).toBe(page.totalChars);
      expect(Buffer.byteLength(text)).toBe(page.bytes); expect(digest(text)).toBe(expectedHash);
      return JSON.parse(text) as T;
    }
    expect(page.next!.tool).toBe(BENCH_PRIVATE_FIXTURE_TOOL);
    reply = await tool.handler(page.next!.args, ctx);
  }
}

describe('real factory through native ceiling and private PG product readers', () => {
  it.each(['cold', 'warm'] as const)('carries the %s factory lease into bounded reads and refuses reads after stop', async armId => {
    const f = await fixture(armId, 'LATENCY-M1:T01');
    try {
      expect(h.ceiling!.denyBenchmarkReadsOutside).toMatchObject({ armId, taskId: f.input.task.instanceId,
        lease: f.assignment.observations.fixtureReadLease,
        assignmentId: currentBenchAssignmentId(f.input.options.runId, armId, f.input.task.instanceId, 1) });
      expect(evaluateSessionConfinement({ toolName: 'scorecards:get', args: { issueId: f.issueIds[0] }, confinement: h.ceiling! }).allowed).toBe(false);
      expect(evaluateSessionConfinement({ toolName: BENCH_PRIVATE_FIXTURE_TOOL, args: { operation: 'card', case: 'A' }, confinement: h.ceiling! }).allowed).toBe(true);
      const result = await readProduct({ operation: 'card', case: 'A' }, f.ctx);
      expect(result).toMatchObject({ ok: true, scorecard: { issueId: f.issueIds[0] } });
      expect(JSON.stringify(result)).not.toContain('private-answer-reference');
      await f.assignment.stop();
      await expect(tool.handler({ operation: 'card', case: 'A' }, f.ctx)).rejects.toThrow(/host lease/);
    } finally { await f.assignment.stop(); }
  }, 90_000);

  it('reads the complete T02 sibling roster and saved recipe through actual product handlers', async () => {
    const f = await fixture('cold', 'LATENCY-M1:T02');
    try {
      let cursor: { createdAt: string; issueId: string } | undefined;
      const ids: string[] = [];
      do {
        const data = await readProduct<{ ok: boolean; scorecards: Array<{ issueId: string }>; nextCursor: typeof cursor }>(
          { operation: 'siblings', case: 'A', ...(cursor ? { cursor } : {}) }, f.ctx);
        expect(data.ok).toBe(true);
        ids.push(...data.scorecards.map(row => row.issueId)); cursor = data.nextCursor ?? undefined;
      } while (cursor);
      expect(ids).toEqual(f.issueIds);
      let recipe = '', request: BenchFixtureReadArgs | undefined = { operation: 'card', case: 'A', rerunRecipeOffset: 0 };
      while (request) {
        const reply: { ok: boolean; rerunRecipeRead: { text: string; chunk?: string; complete: boolean;
          next?: { tool: string; args: BenchFixtureReadArgs } } } = await readProduct<{ ok: boolean; rerunRecipeRead: { text: string; chunk?: string;
          complete: boolean; next?: { tool: string; args: BenchFixtureReadArgs } } }>(request, f.ctx);
        expect(reply.ok).toBe(true);
        recipe += reply.rerunRecipeRead.text ?? reply.rerunRecipeRead.chunk ?? '';
        if (reply.rerunRecipeRead.complete) break;
        expect(reply.rerunRecipeRead.next!.tool).toBe(BENCH_PRIVATE_FIXTURE_TOOL);
        request = reply.rerunRecipeRead.next!.args;
      }
      expect(JSON.parse(recipe)).toMatchObject({ args: { retained: 'recipe-data '.repeat(600) } });
      expect(recipe).not.toContain('private-answer-reference');
    } finally { await f.assignment.stop(); }
  }, 90_000);

  it('rejects a forged result cursor and a continuation after its real host stops', async () => {
    const f = await fixture('cold', 'LATENCY-M1:T02');
    try {
      const result = await tool.handler({ operation: 'siblings', case: 'A' }, f.ctx);
      if (!('data' in result)) throw Error('Private fixture reader returned no data');
      const page = (result.data as { privateFixtureResult: { next: { args: BenchFixtureReadArgs } } }).privateFixtureResult;
      expect(page.next).toBeTruthy();
      const request = page.next.args;
      await expect(tool.handler({ ...request, resultCursor: { ...request.resultCursor!, sha256: '0'.repeat(64) } }, f.ctx))
        .rejects.toThrow(/cursor differs/);
      await f.assignment.stop();
      await expect(tool.handler(request, f.ctx)).rejects.toThrow(/host lease/);
    } finally { await f.assignment.stop(); }
  }, 90_000);

  it.each(['cold', 'warm'] as const)('reads complete historical plan/spec payloads under the %s native ceiling', async armId => {
    const f = await fixture(armId, 'LATENCY-M1:T03');
    try {
      for (const which of ['A', 'B'] as const) {
        const plan = await readProduct<{ results: Array<{ ok: boolean; revision: number; prose: string }> }>(
          { operation: 'plan', case: which }, f.ctx);
        expect(plan.results[0]).toMatchObject({ ok: true, revision: 1 });
        expect(plan.results[0].prose).toContain(`Original ${which} é🧪. `.repeat(900));
        expect(plan.results[0].prose).not.toContain('Later');
        const specs = await readProduct<{ ok: boolean; specs: Array<{ revision: number; behavior: string }> }>(
          { operation: 'specs', case: which }, f.ctx);
        expect(specs.ok).toBe(true);
        expect(specs.specs).toEqual([expect.objectContaining({ revision: 1, behavior: `Original accepted ${which}. `.repeat(800) })]);
      }
    } finally { await f.assignment.stop(); }
  }, 90_000);

  it.each(['rubric', 'sibling-recipe', 'creator'] as const)('refuses drift in the pinned %s dependency before returning reader output', async change => {
    const f = await fixture('warm', 'LATENCY-M1:T02'), sql = fx.db.adminSql;
    try {
      if (change === 'rubric') await sql`UPDATE harness_shared.harness_plans SET template_data =
        jsonb_set(template_data, '{criteria,0,method}', '"changed method"') WHERE plan_slug = ${f.rubricRef}`;
      if (change === 'sibling-recipe') await sql`UPDATE harness_shared.engineer_issues SET payload =
        jsonb_set(payload, '{observation,rerunRecipe,args,retained}', '"changed recipe"') WHERE issue_id = ${f.issueIds[22]}`;
      if (change === 'creator') await sql`UPDATE harness_shared.engineer_issues SET created_by = 'foreign-author' WHERE issue_id = ${f.issueIds[0]}`;
      await expect(tool.handler({ operation: 'card', case: 'A' }, f.ctx)).rejects.toThrow(/source content or size/);
    } finally { await f.assignment.stop(); }
  }, 90_000);
});
