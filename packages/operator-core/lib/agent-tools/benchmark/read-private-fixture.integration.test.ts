/** Whole factory/read path preparation. The native process and provider are
 * deliberately not started; product readers and lease/source checks use PG. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLatencyPgFixture } from '../../../test/_latency-pg-fixture';
import { currentProtocolFixture, allCapabilities } from '../../external-bench/reproducibility/_protocol-test-fixture';
import { canonicalJson } from '../../external-bench/reproducibility/canonical-json';
import { benchFixtureAllocationSha256, benchFixtureBoundarySchema, freezeBenchFixtureReadBoundary, readBenchFixtureSourceSnapshot,
  BENCH_PRIVATE_FIXTURE_TOOL, benchFixtureContextSnapshot, benchFixtureProductCall, benchFixtureResultPage,
  type BenchFixtureAllocation } from '../../external-bench/private-fixture-reads';
import type { BenchFixtureReadArgs } from '../../external-bench/private-fixture-reads';
import { startCurrentBenchTaskAssignment, currentBenchTaskProviderCapture, type CurrentTaskInput } from '../../external-bench/run-launcher';
import { currentBenchAssignmentId, currentBenchLaunchRequest, liveCurrentSuBenchPorts,
  type CurrentBenchTaskEndpointObservation } from '../../external-bench/current-su';
import { processMonotonicClock } from '../../process-monotonic-clock';
import { upsertBenchRun } from '../../external-bench/run-store';
import { runWithWorkspace } from '../../workspace-als';
import { evaluateSessionConfinement, type SessionToolConfinement } from '../../capability-envelope/session-confinement';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

const h = vi.hoisted(() => ({ sql: undefined as postgres.Sql | undefined,
  appSql: undefined as postgres.Sql | undefined,
  workspace: '',
  ceiling: undefined as SessionToolConfinement | undefined, launch: vi.fn(), item: vi.fn(),
  realItem: undefined as typeof import('../../work-items').getWorkItem | undefined }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => { if (!h.sql) throw Error('Private fixture DB is not ready'); return { sql: h.sql }; },
  withWorkspace: async <T>(ws: string, cb: (tx: postgres.Sql) => Promise<T>, options?: { bypassRlsForAdmin?: boolean }) =>
    (options?.bypassRlsForAdmin ? h.sql! : h.appSql!).begin(async tx => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    return cb(tx as unknown as postgres.Sql);
  }),
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('../coordination/log', async original => ({
  ...await original<typeof import('../coordination/log')>(),
  coordHasPgFastPath: () => true,
  coordSql: () => { if (!h.sql) throw Error('Private condition DB is not ready'); return h.sql; },
  coordWorkspaceId: () => h.workspace,
}));
// Keep the native launcher as the explicit no-inference boundary. Capture the
// actual server ceiling built by liveCurrentSuBenchPorts; do not construct one.
vi.mock('../capability/launch-agent', () => ({ default: { handler: h.launch },
  INTERNAL_SCOPED_INFERENCE_GATEWAY: Symbol.for('latency-integration-gateway'),
  INTERNAL_SCOPED_SESSION_CONFINEMENT: Symbol.for('latency-integration-ceiling'),
  INTERNAL_BACKEND_BIN_OVERRIDE: Symbol.for('latency-integration-backend') }));
vi.mock('../../capability-envelope/session-confinement-store', () => ({
  readSessionConfinement: async () => h.ceiling,
}));
vi.mock('../../work-items', async original => {
  const actual = await original<typeof import('../../work-items')>();
  h.realItem = actual.getWorkItem;
  return { ...actual, getWorkItem: h.item };
});
import tool from './read-private-fixture';
import { proposeRubric } from '../../rubrics';
import { seedPlan } from '../plans/__tests__/_pg-tool-fixture';
import { recordPlanRevisionInTransaction } from '../plans/revisions';
import { setSpecClause, type SpecClauseSql } from '../plans/spec-clauses-store';
import { asStructuredObservation } from '../../harness/improvements/observation-types';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const clock = '2026-11-06T00:00:00.000Z';
const ownerId = 'su-latency-private-reader';
let fx: Awaited<ReturnType<typeof createLatencyPgFixture>>;
const roots: string[] = [];
let fixtureSerial = 0;
beforeAll(async () => {
  fx = await createLatencyPgFixture(); h.sql = fx.db.adminSql; h.appSql = fx.db.appSql;
  h.workspace = fx.fixture.workspace;
  // Only this synthetic preparation DB follows wall time. Keep its recent
  // controls recent and its thirty-day holds old in every future CI run,
  // without changing the real host lease clock or any frozen baseline input.
  const shiftMs = Date.now() - fx.fixture.anchorMs;
  const anchored = fx.fixture.conditionEnvelopes.map(row => ({ ...row,
    ts: new Date(Date.parse(row.ts) + shiftMs).toISOString() }));
  const updated = await h.sql`UPDATE harness_shared.coord_event_log AS c
    SET body = r.body, ts = (r.body->>'ts')::timestamptz
    FROM jsonb_array_elements(${JSON.stringify(anchored)}::text::jsonb) AS r(body)
    WHERE c.workspace_id = ${h.workspace} AND c.msg_id = r.body->>'msg_id'
    RETURNING c.body`;
  expect(updated.map(row => row.body).sort((a, b) => a.msg_id.localeCompare(b.msg_id))).toEqual(anchored);
  const clocks = await h.sql`SELECT table_name, column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'harness_shared' AND
      ((table_name = 'plan_revisions' AND column_name = 'created_at') OR
       (table_name = 'plan_spec_clause_revisions' AND column_name IN ('created_at', 'accepted_at')))
    ORDER BY table_name, column_name`;
  expect(clocks.map(row => [row.table_name, row.column_name, row.data_type])).toEqual([
    ['plan_revisions', 'created_at', 'bigint'],
    ['plan_spec_clause_revisions', 'accepted_at', 'timestamp with time zone'],
    ['plan_spec_clause_revisions', 'created_at', 'timestamp with time zone'],
  ]);
}, 180_000);
afterAll(async () => { h.sql = undefined; h.appSql = undefined; if (fx) expect(await fx.cleanup()).toBe('dropped'); }, 60_000);
afterEach(() => { h.ceiling = undefined; vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture(armId: 'cold' | 'warm', taskId: 'LATENCY-M1:T01' | 'LATENCY-M1:T02' | 'LATENCY-M1:T03' | 'LATENCY-M1:T04' | 'LATENCY-M1:T05' | 'LATENCY-M1:T07' | 'LATENCY-M1:T08' | 'LATENCY-M1:T09' | 'LATENCY-M1:T10',
  entries = [{ key: 'input', text: 'Use only the assigned source reader.' }],
  hostPorts: NonNullable<Parameters<typeof startCurrentBenchTaskAssignment>[1]> = {}) {
  const workspaceId = fx.fixture.workspace, sql = fx.db.adminSql, scope = { sql, workspaceId };
  const root = mkdtempSync(join(tmpdir(), 'latency-whole-read-')); roots.push(root);
  const checkout = join(root, 'assignment'); mkdirSync(checkout);
  const rubricRef = `private-${armId}-${taskId.slice(-3).toLowerCase()}-${++fixtureSerial}`, subjectRef = `subject-${rubricRef}`;
  await runWithWorkspace(workspaceId, () => proposeRubric({ rubricId: rubricRef, title: 'Private input rubric',
    characteristic: 'fixture-read', criteria: [{ key: 'evidence', title: 'Exact evidence', model: 'read source',
      method: 'compare exact input', driftMarkers: 'lost text' }], status: 'active', by: ownerId }));
  const issueIds = Array.from({ length: taskId.endsWith('T02') ? 23 : 2 }, (_, i) => `EI-${rubricRef}-${i}`);
  const recipes = issueIds.map((_, i) => {
    const recipe = asStructuredObservation({ rerunRecipe: { schemaVersion: 1,
      evaluator: 'plans:evaluate-spec-test-adequacy', classRef: 'plan-class-feature-ship',
      selection: { planSlug: 'private-input-plan', specId: 'SPEC-1', specRevision: 1,
        specFingerprint: 'a'.repeat(64), evidence: Array.from({ length: i < 2 ? 600 : 1 }, (_, n) =>
          ({ evidenceKind: 'manual', evidenceRef: `private-recipe-data-${n}` })) },
      current: { supplied: false, fingerprints: [] },
      derivation: { kind: 'listSpecEvidence.currentness', classifier: 'classifySpecEvidenceCurrentness', unknownWhenMissing: true },
    } })?.rerunRecipe;
    expect(recipe, 'fixture must use a recipe accepted by the maintained reader').toBeDefined();
    return recipe!;
  });
  for (const [i, issueId] of issueIds.entries()) {
    const observation = { rubricRef, subject: { kind: 'fixture', ref: subjectRef },
      ratings: { evidence: { rating: 'healthy', evidence: `Exact input ${i}: ` + 'é🧪 source '.repeat(i < 2 ? 800 : 1) } },
      rerunRecipe: recipes[i] };
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
  if (taskId === 'LATENCY-M1:T10') allocation[taskId] = {
    A: { budgetMs: 4000, scenarioIds: ['on-time'] },
    B: { budgetMs: 4000, scenarioIds: ['synchronous-entry-block', 'queue-delay', 'late-timer',
      'late-success', 'abort-network', 'abort-queued', 'lexical-fallback'] } };
  if (taskId === 'LATENCY-M1:T09') allocation[taskId] = {
    A: { prefix: 'latency-acceptance:busy:' }, B: { prefix: 'latency-acceptance:quiet:' } };
  if (taskId === 'LATENCY-M1:T07' || taskId === 'LATENCY-M1:T08') {
    const source = { harness: fx.fixture.harness, slug: fx.fixture.plan, sourceIdPrefix: 'WI-80' };
    allocation[taskId] = { A: { ...source, itemIds: taskId.endsWith('T07') ? ['P-001', 'P-007'] : ['P-002', 'P-004'] },
      B: { ...source, itemIds: taskId.endsWith('T07') ? ['P-003'] : ['P-005', 'P-006', 'P-008', 'P-009'] } };
  }
  if (taskId === 'LATENCY-M1:T04' || taskId === 'LATENCY-M1:T05') {
    const timelineCases = {} as NonNullable<BenchFixtureAllocation['LATENCY-M1:T04']>;
    for (const [index, which] of (['A', 'B'] as const).entries()) {
      const owner = `su-00000000-0000-0000-0000-${String(fixtureSerial * 2 + index).padStart(12, '0')}`;
      timelineCases[which] = { owner, since: clock, until: '2026-11-06T00:10:00.000Z' };
      // More than one reader page, with distinct timestamps and no live
      // session row: the actual historical reader must not hydrate new input.
      await sql`INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text, ingested_at)
        SELECT ${workspaceId}, 'codex', ${owner}, n, ${clock}::timestamptz + n * interval '1 second',
          ${owner}, 'assistant', 'Raw fixture turn ' || n, ${clock}::timestamptz
        FROM generate_series(1, 302) AS n`;
      await sql`INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text, ingested_at)
        VALUES ('default', 'codex', ${owner}, 303, ${clock}::timestamptz + interval '303 seconds',
          ${owner}, 'assistant', 'Legacy default-workspace turn', ${clock})`;
      for (const alias of [false, true]) await sql`INSERT INTO harness_shared.tool_invocations
        (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, status,
          coord_owner_id, invoked_at, duration_ms, call_origin, principal_kind, principal_auth_method,
          principal_trust, metadata_json)
        VALUES (${workspaceId}, 'private-timeline', 'test', 'coord:inbox', 'worker', ${owner}, ${owner}, 'ok',
          ${alias ? `system:worker/${owner}` : owner}, ${clock}::timestamptz + interval '304 seconds', 7,
          'hook', 'harness', 'spawn-url', 'trusted',
          ${JSON.stringify({ requestOrigin: { query: { client: owner } }, fixtureAlias: alias })}::jsonb)`;
      await sql`INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body, ts)
        VALUES (${workspaceId}, 'messages', ${owner}, ${`message-${owner}`},
          ${JSON.stringify({ from: owner, summary: 'Frozen coordination input' })}::jsonb,
          ${clock}::timestamptz + interval '305 seconds')`;
    }
    allocation[taskId] = timelineCases;
  }
  if (taskId === 'LATENCY-M1:T03') {
    const harness = `private-history-${fixtureSerial}`;
    for (const which of ['A', 'B'] as const) {
      const slug = `history-${which.toLowerCase()}`;
      const body = `---\nslug: ${slug}\ntitle: Frozen history ${which}\nstatus: draft\n---\n\n## Work\n\n- **P-001** \`todo\` — Original task.\n\n## Original\n\n` + `Original ${which} é🧪. `.repeat(900);
      await seedPlan(sql, workspaceId, harness, slug, body);
      await sql`INSERT INTO harness_shared.plan_items (workspace_id, harness_slug, plan_slug, item_id, seq, status, item_text)
        VALUES (${workspaceId}, ${harness}, ${slug}, 'P-001', 1, 'todo', 'Original task')`;
      const identity = { ownerId, ownerLabel: 'Private fixture', source: 'static-client' as const, workspaceId, userId: null };
      await sql.begin(tx => recordPlanRevisionInTransaction(tx, { workspaceId, harnessSlug: harness, planSlug: slug, content: body, identity }));
      const clause = { harnessSlug: harness, planSlug: slug, specId: 'SPEC-1', expectedRevision: 0,
        planItemId: 'P-001', behavior: `Original accepted ${which}. `.repeat(800).trim(), behaviorClass: 'concurrency' as const,
        requiredEvidence: ['exact historical readback'], requiredTestLayers: ['integration'], mutationRequired: false,
        lifecycleStatus: 'active' as const, acceptanceRef: 'D-001', actorId: ownerId };
      const written = await sql.begin(tx => setSpecClause(clause, { workspaceId, harnessSlug: harness, executor: tx as unknown as SpecClauseSql }));
      expect(written.status).toBe('created');
      // Preserve the maintained writers' immutable timestamps. Put the cutoff
      // between real writes, rounding PG's sub-millisecond clock up to JS ms.
      const [first] = await sql`SELECT r.created_at AS plan_ms, s.created_at, s.accepted_at,
          ceil(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS db_ms
        FROM harness_shared.plan_revisions r JOIN harness_shared.plan_spec_clause_revisions s
          USING (workspace_id, harness_slug, plan_slug)
        WHERE r.workspace_id = ${workspaceId} AND r.harness_slug = ${harness}
          AND r.plan_slug = ${slug} AND r.seq = 1 AND s.spec_id = 'SPEC-1' AND s.revision = 1`;
      expect(first).toBeDefined();
      expect(first!.accepted_at).not.toBeNull();
      const cutoffMs = Math.max(Date.now(), Number(first!.db_ms), Number(first!.plan_ms),
        new Date(first!.created_at).getTime(), new Date(first!.accepted_at).getTime());
      const specAsOf = new Date(cutoffMs).toISOString();
      await vi.waitFor(async () => {
        expect(Date.now()).toBeGreaterThan(cutoffMs);
        const [db] = await sql`SELECT clock_timestamp() > ${specAsOf}::timestamptz AS after_cutoff`;
        expect(db!.after_cutoff).toBe(true);
      }, { interval: 10, timeout: 2000 });
      await seedPlan(sql, workspaceId, harness, slug, body.replaceAll('Original', 'Later'));
      await sql.begin(tx => recordPlanRevisionInTransaction(tx, { workspaceId, harnessSlug: harness, planSlug: slug,
        content: body.replaceAll('Original', 'Later'), identity }));
      const later = await sql.begin(tx => setSpecClause({ ...clause, expectedRevision: 1, behavior: 'Later accepted behavior' },
        { workspaceId, harnessSlug: harness, executor: tx as unknown as SpecClauseSql }));
      expect(later.status).toBe('revised');
      const chronology = await sql`SELECT r.seq, r.created_at AS plan_ms, s.created_at, s.accepted_at
        FROM harness_shared.plan_revisions r JOIN harness_shared.plan_spec_clause_revisions s
          ON s.workspace_id = r.workspace_id AND s.harness_slug = r.harness_slug
          AND s.plan_slug = r.plan_slug AND s.revision = r.seq AND s.spec_id = 'SPEC-1'
        WHERE r.workspace_id = ${workspaceId} AND r.harness_slug = ${harness}
          AND r.plan_slug = ${slug} ORDER BY r.seq`;
      expect(chronology.map(row => ({ seq: row.seq, planBefore: Number(row.plan_ms) <= cutoffMs,
        specBefore: new Date(row.created_at).getTime() <= cutoffMs && new Date(row.accepted_at).getTime() <= cutoffMs })))
        .toEqual([{ seq: 1, planBefore: true, specBefore: true }, { seq: 2, planBefore: false, specBefore: false }]);
      expect(chronology[0]).toEqual({ seq: 1, plan_ms: first!.plan_ms,
        created_at: first!.created_at, accepted_at: first!.accepted_at });
      allocation['LATENCY-M1:T03'][which] = { harness, slug, revision: 1, specAsOf };
    }
  }
  const task = { benchmark: 'harness-bench' as const, instanceId: taskId, problemStatement: 'Read both exact frozen inputs.',
    repo: checkout, baseCommit: 'a'.repeat(40), graderMeta: { latencyM1: { qualityOracle: { hidden: 'private-answer-reference' } } } };
  const protocol = currentProtocolFixture(`private-${armId}-${taskId.slice(-3).toLowerCase()}-${fixtureSerial}`, 60_000);
  protocol.taskIds = [taskId]; protocol.sampling!.taskRepositories = { [taskId]: 'fixture-repo', 'withheld-1': 'withheld-repo' };
  const snapshot = JSON.stringify({ entries });
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
  const ctx = { workspaceId, uiClientId: ownerId, principal: { slug: ownerId, workspaceId,
    capabilities: new Set(['work_items:read']) }, isSuperuser: true, role: 'worker',
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
    ...hostPorts,
    startGateway: async () => ({ port: 32123, stop: async () => {} } as never) });
  roots.push((await currentBenchTaskProviderCapture(input)).captureRoot);
  const handle = { slug: 'private-assignment', featureId: 'WI-private-assignment', worktreePath: checkout };
  const ports = liveCurrentSuBenchPorts(ctx, assignment.observations, assignment.options, { sql });
  const context = await ports.restoreContext(handle, taskId);
  await ports.launch(currentBenchLaunchRequest(assignment.options, handle, task.problemStatement, context));
  return { input, ctx, assignment, issueIds, allocation, rubricRef, recipes, context, snapshot, checkout, workspaceId };
}

async function readProduct<T>(args: BenchFixtureReadArgs, ctx: PapercuspUnifiedToolContext): Promise<T> {
  let reply = await tool.handler(args, ctx), text = '', pages = 0, expectedHash: string | undefined;
  for (;;) {
    if (!('data' in reply)) throw Error('Private fixture reader returned no data');
    const data = reply.data as Record<string, unknown>;
    if (!data || typeof data !== 'object') throw Error('Private fixture reader returned no structured product data');
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
  it('preserves original task samples and observer refusals through trusted factory composition', async () => {
    const received: Readonly<CurrentBenchTaskEndpointObservation>[] = [];
    const refusal = new Error('parent observer rejected the original result');
    const observeTaskEndpoint = vi.fn((event: Readonly<CurrentBenchTaskEndpointObservation>) => {
      received.push(event);
      if (event.kind === 'result') throw refusal;
    });
    const f = await fixture('cold', 'LATENCY-M1:T01', undefined, { observeTaskEndpoint });
    try {
      const ports = liveCurrentSuBenchPorts(f.ctx, f.assignment.observations, f.assignment.options, { sql: fx.db.adminSql });
      expect(ports.observeTaskEndpoint).toBe(observeTaskEndpoint);
      const entry = Object.freeze({ kind: 'entry' as const, assignmentId: f.context.assignmentId,
        atMs: processMonotonicClock.now(), clock: processMonotonicClock });
      ports.observeTaskEndpoint!(entry);
      expect(received[0]).toBe(entry);
      const result = Object.freeze({ ...entry, kind: 'result' as const,
        atMs: processMonotonicClock.now(), terminalDisposition: 'error' });
      let caught: unknown;
      try { ports.observeTaskEndpoint!(result); } catch (error) { caught = error; }
      expect(caught).toBe(refusal);
      expect(received[1]).toBe(result);
      expect(received).toHaveLength(2);
      expect(received.every(event => event.clock === processMonotonicClock)).toBe(true);
    } finally { await f.assignment.stop(); }
  }, 90_000);

  it.each(['cold', 'warm'] as const)('retains exact coverage IDs and raw eligibility evidence on the %s ceiling', async armId => {
    const sql = fx.db.adminSql;
    const population = async () => canonicalJson(await sql`SELECT to_jsonb(w) AS row
      FROM harness_shared.work_items w WHERE starts_with(feature_id, 'WI-80')
      ORDER BY workspace_id, harness_slug, feature_id`);
    const original = await population();
    expect(JSON.parse(original)).toHaveLength(10_000);
    const unchangedPopulation = async () => {
      const before = JSON.parse(original) as Array<{ row: Record<string, unknown> }>;
      const after = JSON.parse(await population()) as typeof before;
      // Keep failures diagnostic and bounded: serializing both complete PG
      // populations into an assertion diff produces tens of MB of output.
      const changes = after.flatMap(({ row }, index) => {
        const previous = before[index]?.row ?? {};
        const fields = [...new Set([...Object.keys(previous), ...Object.keys(row)])]
          .filter(key => canonicalJson(previous[key]) !== canonicalJson(row[key]));
        return fields.length ? [{ id: row.feature_id, fields }] : [];
      });
      expect({ count: after.length, changes }).toEqual({ count: before.length, changes: [] });
    };
    const observations = [];
    for (const taskId of ['LATENCY-M1:T07', 'LATENCY-M1:T08'] as const) {
      const f = await fixture(armId, taskId);
      // Only the assignment is stubbed. Target resolution uses the actual
      // work-item reader against the migrated private fixture database.
      const assignmentItem = await h.item();
      h.item.mockImplementation((id: string, harness?: string) => id === 'WI-private-assignment'
        ? Promise.resolve(assignmentItem) : h.realItem!(id, harness));
      try {
        const boundary = benchFixtureBoundarySchema.parse(h.ceiling!.denyBenchmarkReadsOutside);
        const before = canonicalJson(await readBenchFixtureSourceSnapshot(boundary, 'A', f.input.scope));
        expect(JSON.parse(before).workItems).toHaveLength(10_000);
        type Coverage = { observedCoveredRefs: string[]; lookups: Array<{ itemId: string;
          implementing: { id: string } | null; stamped: { id: string } | null }>;
          candidates: Array<{ row: Record<string, unknown> }>; edges: Array<{ row: Record<string, unknown> }> };
        for (const which of ['A', 'B'] as const) {
          const result = await readProduct<Coverage>({ operation: 'coverage', case: which }, f.ctx);
          expect(await readProduct<Coverage>({ operation: 'coverage', case: which }, f.ctx)).toEqual(result);
          const ids = result.candidates.map(({ row }) => row.feature_id);
          expect(new Set(ids).size).toBe(ids.length);
          expect(ids).not.toContain('WI-8000010'); expect(ids).not.toContain('WI-8000011');
          for (const { row } of result.candidates) {
            expect(row.workspace_id).toBe(f.workspaceId); expect(row.harness_slug).toBe(fx.fixture.harness);
          }
          for (const lookup of result.lookups) {
            const reference = fx.fixture.coverageReference.find(row => row.item === lookup.itemId)!;
            for (const id of reference.eligibleIds) expect(ids).toContain(id);
            if (['P-001', 'P-003', 'P-007'].includes(lookup.itemId)) {
              expect(lookup.implementing?.id).toBe(reference.eligibleIds[0]);
              expect(lookup.stamped?.id).toBe(reference.eligibleIds[0]);
            }
          }
          if (taskId.endsWith('T08') && which === 'B') {
            expect(result.candidates.find(({ row }) => row.feature_id === 'WI-8000004')!.row.payload).toEqual({
              plan_item: { plan_slug: fx.fixture.plan, item_id: 'P-005', harness_slug: fx.fixture.harness }, _claimHold: true });
            expect(result.candidates.find(({ row }) => row.feature_id === 'WI-8000007')!.row.summary).toBe(`Plan: ${fx.fixture.plan} item P-0060`);
            expect(result.candidates.find(({ row }) => row.feature_id === 'WI-8000008')!.row.summary).toBe(`xPlan: ${fx.fixture.plan} item P-006`);
          }
          observations.push({ taskId, armId, which, result });
        }
        expect(canonicalJson(await readBenchFixtureSourceSnapshot(boundary, 'A', f.input.scope))).toBe(before);
        await unchangedPopulation();
        // A target's raw input mutation must invalidate every further read,
        // even if a cached continuation was already produced.
        // A compensating UPDATE would advance fed_ts/fed_hlc again. Roll back
        // the injected drift so every physical column remains unchanged.
        await expect(sql.begin(async tx => {
          h.sql = tx as unknown as postgres.Sql;
          try {
            await tx`UPDATE harness_shared.work_items SET title = title || ' changed'
              WHERE feature_id = 'WI-8000000' AND workspace_id = ${f.workspaceId}`;
            await expect(tool.handler({ operation: 'coverage', case: 'A' }, f.ctx)).rejects.toThrow(/source content/);
            throw Error('rollback private coverage drift');
          } finally { h.sql = sql; }
        })).rejects.toThrow('rollback private coverage drift');
        await unchangedPopulation();
        await f.assignment.stop();
        await expect(tool.handler({ operation: 'coverage', case: 'A' }, f.ctx)).rejects.toThrow(/lease/);
      } finally { await f.assignment.stop(); }
    }
    await unchangedPopulation();
    const artifactDir = process.env.PAPERCUSP_TEST_ARTIFACT_DIR;
    if (artifactDir) { mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, `coverage-route-${armId}.json`), JSON.stringify({
        phase: 'preparation-only', actualTaskAttempts: 0, observations }, null, 2)); }
  }, 180_000);
  it.each(['cold', 'warm'] as const)('retains actual retrieval clocks through the %s host ceiling', async armId => {
    const f = await fixture(armId, 'LATENCY-M1:T10');
    const observations: unknown[] = [];
    try {
      const boundary = benchFixtureBoundarySchema.parse(h.ceiling!.denyBenchmarkReadsOutside);
      if (boundary.taskId !== 'LATENCY-M1:T10') throw Error('Unexpected retrieval boundary');
      const before = canonicalJson(await readBenchFixtureSourceSnapshot(boundary, 'B', f.input.scope));
      expect(before).not.toContain('expected');
      await expect(tool.handler({ operation: 'retrieval', case: 'A', scenarioId: 'late-timer' }, f.ctx)).rejects.toThrow(/not assigned/);
      const oldBudget = process.env.PAPERCUSP_QUERY_EMBED_ACQUIRE_BUDGET_MS;
      try {
        process.env.PAPERCUSP_QUERY_EMBED_ACQUIRE_BUDGET_MS = '8000';
        await expect(tool.handler({ operation: 'retrieval', case: 'A', scenarioId: 'on-time' }, f.ctx)).rejects.toThrow(/unchanged loaded runtime budget/);
      } finally {
        if (oldBudget === undefined) delete process.env.PAPERCUSP_QUERY_EMBED_ACQUIRE_BUDGET_MS;
        else process.env.PAPERCUSP_QUERY_EMBED_ACQUIRE_BUDGET_MS = oldBudget;
      }
      for (const which of ['A', 'B'] as const) for (const scenarioId of boundary.cases[which].scenarioIds) {
        const reply = await tool.handler({ operation: 'retrieval', case: which, scenarioId }, f.ctx);
        if (!('data' in reply)) throw Error('Missing retrieval observation');
        const data = reply.data as { configuredBudgetMs: number; observation: {
          id: string; marks: Record<string, number | null>; safetyDeadlineFired: boolean;
          embeddingAccepted: boolean; fallback: string | null; cancellation: string | null;
          callerAborted: boolean; violations: { lateAccepted: boolean } } };
        expect(data).not.toHaveProperty('privateFixtureResult');
        expect(data.configuredBudgetMs).toBe(4000);
        expect(data.observation.id).toBe(scenarioId);
        expect(data.observation.safetyDeadlineFired).toBe(false);
        expect(data.observation.marks.callEntryMs).toBe(0);
        expect(data.observation.marks.terminalMs).toBeGreaterThanOrEqual(0);
        expect(data.observation.violations.lateAccepted).toBe(data.observation.embeddingAccepted &&
          data.observation.marks.resultAtMs !== null && data.observation.marks.resultAtMs! > 4000);
        if (scenarioId === 'lexical-fallback') expect(data.observation).toMatchObject({
          embeddingAccepted: false, fallback: 'latency-lexical-001' });
        if (scenarioId.startsWith('abort-')) expect(data.observation).toMatchObject({
          callerAborted: true, cancellation: scenarioId === 'abort-network' ? 'network' : 'queued' });
        observations.push({ which, ...data });
        expect(Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(data) }] }))).toBeLessThanOrEqual(6000);
      }
      expect(observations).toHaveLength(8);
      expect(canonicalJson(await readBenchFixtureSourceSnapshot(boundary, 'B', f.input.scope))).toBe(before);
      await f.assignment.stop();
      await expect(tool.handler({ operation: 'retrieval', case: 'A', scenarioId: 'on-time' }, f.ctx)).rejects.toThrow(/lease/);
    } finally { await f.assignment.stop(); }
    const artifactDir = process.env.PAPERCUSP_TEST_ARTIFACT_DIR;
    if (artifactDir) { mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, `retrieval-route-${armId}.json`), JSON.stringify({
        phase: 'preparation-only', actualTaskAttempts: 0, observations }, null, 2)); }
  }, 180_000);
  it.each(['cold', 'warm'] as const)('retains actual condition diagnosis and complete causal pins on the %s ceiling', async armId => {
    const f = await fixture(armId, 'LATENCY-M1:T09'), sql = fx.db.adminSql;
    try {
      const boundary = benchFixtureBoundarySchema.parse(h.ceiling!.denyBenchmarkReadsOutside);
      const sourceBefore = canonicalJson(await readBenchFixtureSourceSnapshot(boundary, 'A', f.input.scope));
      expect(JSON.parse(sourceBefore).rows).toHaveLength(10_000);
      for (const which of ['A', 'B'] as const) {
        const request = { operation: 'conditions', case: which } as const;
        expect(evaluateSessionConfinement({ toolName: BENCH_PRIVATE_FIXTURE_TOOL,
          args: request, confinement: h.ceiling! }).allowed).toBe(true);
        const response = await tool.handler(request, f.ctx);
        if (!('data' in response)) throw Error('Condition diagnosis returned no product data');
        const result = response.data as { prefix: string; effectiveNowMs: number; durationMs: number;
          startedAtMs: number; completedAtMs: number; envelopeCount: number; foldedStateCount: number;
          states: Array<{ condition_key: string; open: boolean }> };
        // The full 10000-row source remains pinned. The diagnostic must fit
        // one real packet even for the busy prefix's resolution noise.
        expect(response.data).not.toHaveProperty('privateFixtureResult');
        expect(response.data).not.toHaveProperty('envelopes');
        expect(Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(response.data) }] })))
          .toBeLessThanOrEqual(6000);
        expect(result.envelopeCount).toBe(which === 'A' ? 9978 : 2);
        // A shared resolution contributes both prefix keys to the fold.
        expect(result.foldedStateCount).toBe(which === 'A' ? 9977 : 2);
        expect(result.states).toEqual([]);
        expect(result.prefix).toBe(f.allocation['LATENCY-M1:T09']![which].prefix);
        expect(result.durationMs).toBe(result.completedAtMs - result.startedAtMs);
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
        expect(result.effectiveNowMs).toBeLessThanOrEqual(Date.now());
        const repeated = await readProduct<typeof result>(request, f.ctx);
        expect(repeated.envelopeCount).toBe(result.envelopeCount);
        expect(repeated.states).toEqual(result.states);
        // The raw pin retains ten old unresolved holds per prefix even when
        // the current production age filter returns none of those holds.
        const raw = JSON.parse(sourceBefore).rows.map((row: { body: Record<string, unknown> }) => row.body);
        const old = raw.filter((row: Record<string, unknown>) => typeof row.condition_key === 'string' &&
          row.condition_key.startsWith(result.prefix) && row.condition_key.includes('old-'));
        expect(old).toHaveLength(10);
        expect(result.states.filter(row => row.open).map(row => row.condition_key))
          .not.toEqual(fx.fixture.conditionReference[result.prefix as keyof typeof fx.fixture.conditionReference]);
      }
      expect(canonicalJson(await readBenchFixtureSourceSnapshot(boundary, 'A', f.input.scope))).toBe(sourceBefore);
      const [row] = await sql`SELECT body FROM harness_shared.coord_event_log
        WHERE workspace_id = ${f.workspaceId} AND msg_id = 'latency-m1-condition-00000'`;
      try {
        await sql`UPDATE harness_shared.coord_event_log SET body = body || '{"drift":"must refuse"}'::jsonb
          WHERE workspace_id = ${f.workspaceId} AND msg_id = 'latency-m1-condition-00000'`;
        await expect(tool.handler({ operation: 'conditions', case: 'B' }, f.ctx)).rejects.toThrow(/source content or size/);
      } finally {
        await sql`UPDATE harness_shared.coord_event_log SET body = ${JSON.stringify(row!.body)}::text::jsonb
          WHERE workspace_id = ${f.workspaceId} AND msg_id = 'latency-m1-condition-00000'`;
      }
      await f.assignment.stop();
      await expect(tool.handler({ operation: 'conditions', case: 'A' }, f.ctx)).rejects.toThrow(/host lease/);
    } finally { await f.assignment.stop(); }
  }, 90_000);
  if (process.env.PAPERCUSP_LATENCY_FROZEN_CORPUS_FILE) it('retains the complete original raw corpus behind bounded context pages', async () => {
    const artifactDir = process.env.PAPERCUSP_TEST_ARTIFACT_DIR;
    if (!artifactDir?.trim()) throw Error('Original raw context evidence requires PAPERCUSP_TEST_ARTIFACT_DIR');
    const original = readFileSync(process.env.PAPERCUSP_LATENCY_FROZEN_CORPUS_FILE!, 'utf8');
    expect(digest(original)).toBe(process.env.PAPERCUSP_LATENCY_FROZEN_CORPUS_SHA256);
    const { entries } = JSON.parse(original) as { entries: Array<{ key: string; text: string }> };
    expect(entries.map(entry => entry.key)).toEqual(['latency-raw:W1', 'latency-raw:W2', 'latency-raw:W3', 'latency-raw:W1-with-overlap-control']);
    const f = await fixture('cold', 'LATENCY-M1:T04', entries);
    try {
      expect(Buffer.byteLength(f.context.contextText)).toBeLessThan(2000);
      const receipts = [];
      for (const entry of entries) {
        let request: BenchFixtureReadArgs = { operation: 'context', case: 'A', source: 'corpus', entryKey: entry.key };
        const snapshot = await benchFixtureContextSnapshot(h.ceiling!.denyBenchmarkReadsOutside!,
          benchFixtureProductCall(h.ceiling!.denyBenchmarkReadsOutside!, request), f.checkout, f.input.scope);
        let assembled = '', pages = 0, maxEnvelopeBytes = 0;
        for (;;) {
          const data = benchFixtureResultPage(snapshot, request, 6000);
          maxEnvelopeBytes = Math.max(maxEnvelopeBytes, Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(data) }] })));
          const page = data.privateFixtureResult;
          expect(page.offset).toBe(assembled.length); assembled += page.text; pages++;
          if (page.complete) break;
          request = page.next!.args;
        }
        expect(assembled).toBe(snapshot.text);
        expect(digest(assembled)).toBe(snapshot.sha256);
        expect(JSON.parse(assembled).entry).toEqual(entry);
        expect(maxEnvelopeBytes).toBeLessThanOrEqual(6000);
        receipts.push({ key: entry.key, originalTextBytes: Buffer.byteLength(entry.text), originalTextSha256: digest(entry.text),
          resultBytes: snapshot.bytes, resultSha256: snapshot.sha256, pages, maxEnvelopeBytes });
      }
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, 'original-context-paging.json'), canonicalJson({ phase: 'preparation-only',
        actualTaskAttempts: 0, originalCorpusBytes: Buffer.byteLength(original), originalCorpusSha256: digest(original),
        initialContextBytes: Buffer.byteLength(f.context.contextText), initialContextSha256: f.context.contextTextSha256,
        initialContext: f.context.contextText, entries: receipts,
        scope: 'Exact original raw entry bytes and lossless page reconstruction; synthetic private PG source lease; no native or full host qualification.' }), { flag: 'wx' });
    } finally { await f.assignment.stop(); }
  }, 90_000);

  it.each(['cold', 'warm'] as const)('pages exact raw context under the %s factory lease and detects continuation drift', async armId => {
    const entries = [{ key: 'raw:native', text: 'Original é🧪\n"raw" \\ source '.repeat(1200) },
      { key: 'raw:control', text: 'Declared input control only.' }];
    const f = await fixture(armId, 'LATENCY-M1:T01', entries);
    try {
      expect(Buffer.byteLength(f.context.contextText)).toBeLessThan(2000);
      expect(f.context.contextText).not.toContain(entries[0]!.text);
      expect(h.launch.mock.calls[0]![0].brief).toContain(f.context.contextText);
      for (const source of ['corpus', 'memory'] as const) {
        const index = await readProduct<{ source: string; snapshotSha256: string;
          entries: Array<{ key: string; bytes: number; sha256: string }> }>({ operation: 'context', case: 'A', source }, f.ctx);
        expect(index).toEqual({ source, snapshotSha256: digest(f.snapshot),
          entries: entries.map(entry => ({ key: entry.key, bytes: Buffer.byteLength(entry.text), sha256: digest(entry.text) })) });
        const value = await readProduct({ operation: 'context', case: 'B', source, entryKey: entries[0]!.key }, f.ctx);
        expect(value).toEqual({ source, snapshotSha256: digest(f.snapshot), entry: entries[0] });
      }
      const request = { operation: 'context', case: 'A', source: 'corpus', entryKey: entries[0]!.key } as const;
      expect(evaluateSessionConfinement({ toolName: BENCH_PRIVATE_FIXTURE_TOOL, args: request, confinement: h.ceiling! }).allowed).toBe(true);
      await expect(tool.handler({ ...request, entryKey: 'hidden-grader-answers' }, f.ctx)).rejects.toThrow(/entry key/);
      const reply = await tool.handler(request, f.ctx);
      if (!('data' in reply)) throw Error('Expected raw context page');
      const next = (reply.data as { privateFixtureResult: { next: { args: BenchFixtureReadArgs } } }).privateFixtureResult.next.args;
      await expect(tool.handler({ ...next, resultCursor: { ...next.resultCursor!, sha256: '0'.repeat(64) } }, f.ctx)).rejects.toThrow(/cursor differs/);
      const file = join(f.checkout, '.papercusp/benchmark-context/corpus.json');
      writeFileSync(file, JSON.stringify({ entries: [{ key: entries[0]!.key, text: 'Changed bytes' }] }));
      await expect(tool.handler(next, f.ctx)).rejects.toThrow(/bytes differ/);
      writeFileSync(file, f.snapshot);
      await fx.db.adminSql`UPDATE harness_shared.bench_runs SET config = jsonb_set(config,
        '{protocol,context,corpusHash}', ${JSON.stringify('0'.repeat(64))}::text::jsonb)
        WHERE workspace_id = ${f.workspaceId} AND id = ${f.input.hostRunId}`;
      await expect(tool.handler(next, f.ctx)).rejects.toThrow(/frozen preregistration/);
      await fx.db.adminSql`UPDATE harness_shared.bench_runs SET config = jsonb_set(config,
        '{protocol}', ${JSON.stringify(f.input.protocol)}::text::jsonb)
        WHERE workspace_id = ${f.workspaceId} AND id = ${f.input.hostRunId}`;
      await f.assignment.stop();
      await expect(tool.handler(next, f.ctx)).rejects.toThrow(/host lease/);
    } finally { await f.assignment.stop(); }
  }, 90_000);

  it.each(['LATENCY-M1:T04', 'LATENCY-M1:T05'] as const)('reads every %s source through the real timeline with pinned bounds', async taskId => {
    const f = await fixture('cold', taskId);
    try {
      for (const which of ['A', 'B'] as const) {
        const source = f.allocation[taskId]![which];
        let cursor: string | undefined, pages = 0;
        const entries: Array<{ kind: string; ref: string; text: string; auto?: boolean }> = [];
        do {
          const page = await readProduct<{ ok: boolean; owner: string; since: string; until: string;
            entries: typeof entries; hasMore: boolean; nextCursor?: string }>(
            { operation: 'timeline', case: which, ...(cursor ? { cursor } : {}) }, f.ctx);
          expect(page).toMatchObject({ ok: true, ...source });
          entries.push(...page.entries); cursor = page.nextCursor;
          expect(++pages).toBeLessThan(200);
          expect(!!cursor).toBe(page.hasMore);
        } while (cursor);
        expect(pages).toBeGreaterThan(1);
        expect(entries).toHaveLength(306);
        expect(new Set(entries.map(row => `${row.kind}:${row.ref}`)).size).toBe(entries.length);
        expect(entries.filter(row => row.kind === 'turn')).toHaveLength(303);
        expect(entries.filter(row => row.kind === 'tool' && row.auto)).toHaveLength(2);
        expect(entries.filter(row => row.kind === 'coord')).toHaveLength(1);
        expect(entries.some(row => row.text.includes('Legacy default-workspace turn'))).toBe(true);
        expect(JSON.stringify(entries)).not.toContain('private-answer-reference');
      }
      await f.assignment.stop();
      await expect(tool.handler({ operation: 'timeline', case: 'A' }, f.ctx)).rejects.toThrow(/host lease/);
    } finally { await f.assignment.stop(); }
  }, 90_000);

  it.each(['turn', 'alias', 'coord'] as const)('rejects drift in the frozen timeline %s before returning output', async changed => {
    const f = await fixture('warm', 'LATENCY-M1:T05'), sql = fx.db.adminSql;
    const source = f.allocation['LATENCY-M1:T05']!.A;
    try {
      if (changed === 'turn') await sql`UPDATE harness_shared.session_turns SET text = 'Changed legacy input'
        WHERE workspace_id = 'default' AND owner = ${source.owner}`;
      if (changed === 'alias') await sql`UPDATE harness_shared.tool_invocations SET duration_ms = 8
        WHERE coord_owner_id = ${`system:worker/${source.owner}`}`;
      if (changed === 'coord') await sql`UPDATE harness_shared.coord_event_log
        SET body = jsonb_set(body, '{summary}', '"Changed input"'::jsonb)
        WHERE body->>'from' = ${source.owner}`;
      await expect(tool.handler({ operation: 'timeline', case: 'A' }, f.ctx)).rejects.toThrow(/source content or size/);
    } finally { await f.assignment.stop(); }
  }, 90_000);

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
        expect(reply, 'actual saved-recipe page must be readable').toMatchObject({ ok: true });
        recipe += reply.rerunRecipeRead.text ?? reply.rerunRecipeRead.chunk ?? '';
        if (reply.rerunRecipeRead.complete) break;
        expect(reply.rerunRecipeRead.next!.tool).toBe(BENCH_PRIVATE_FIXTURE_TOOL);
        request = reply.rerunRecipeRead.next!.args;
      }
      expect(JSON.parse(recipe)).toEqual(f.recipes[0]);
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
        expect(specs.specs).toEqual([expect.objectContaining({ revision: 1, behavior: `Original accepted ${which}. `.repeat(800).trim() })]);
      }
    } finally { await f.assignment.stop(); }
  }, 90_000);

  it.each(['rubric', 'sibling-recipe', 'creator'] as const)('refuses drift in the pinned %s dependency before returning reader output', async change => {
    const f = await fixture('warm', 'LATENCY-M1:T02'), sql = fx.db.adminSql;
    try {
      if (change === 'rubric') await sql`UPDATE harness_shared.harness_plans SET template_data =
        jsonb_set(template_data, '{criteria,0,method}', '"changed method"') WHERE plan_slug = ${f.rubricRef}`;
      if (change === 'sibling-recipe') await sql`UPDATE harness_shared.engineer_issues SET payload =
        jsonb_set(payload, '{observation,rerunRecipe,selection,evidence,0,evidenceRef}', '"changed recipe"') WHERE issue_id = ${f.issueIds[22]}`;
      if (change === 'creator') await sql`UPDATE harness_shared.engineer_issues SET created_by = 'foreign-author' WHERE issue_id = ${f.issueIds[0]}`;
      await expect(tool.handler({ operation: 'card', case: 'A' }, f.ctx)).rejects.toThrow(/source content or size/);
    } finally { await f.assignment.stop(); }
  }, 90_000);
});
