/** Solver reads over the existing benchmark assignment and product readers.
 * No answers, SQL, executable recipes or caller-selected source identities. */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './reproducibility/canonical-json';
import { resolveDb, type DbScope } from './reproducibility/db';
import { readBenchmarkContextSources, readFrozenBenchmarkSnapshot, type BenchmarkContextInput } from './reproducibility/context';
import { currentBenchmarkProtocolSchema } from './reproducibility/schema';
import { toolInvocationOwnerPredicate } from '../agent-tools/sessions/automatic-tool-names';

export const BENCH_PRIVATE_FIXTURE_TOOL = 'benchmark:read-private-fixture';
const id = z.string().trim().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const card = z.object({ issueId: id, comparisonTime: z.string().datetime({ offset: true }).optional() }).strict();
const siblings = card.extend({ rubricRef: id, subjectRef: id,
  comparisonTime: z.string().datetime({ offset: true }) }).strict();
const plan = z.object({ harness: id, slug: id,
  revision: z.union([z.number().int().safe().positive(), digest]),
  specAsOf: z.string().datetime({ offset: true }) }).strict();
const timeline = z.object({
  owner: z.string().regex(/^su-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
  since: z.string().datetime({ offset: true }), until: z.string().datetime({ offset: true }),
}).strict().refine(value => Date.parse(value.until) > Date.parse(value.since),
  'Private timeline requires an increasing frozen window.');
const cases = <T extends z.ZodTypeAny>(schema: T) => z.object({ A: schema, B: schema }).strict();
const sourcePin = z.object({ sha256: digest, bytes: z.number().int().positive().max(16 * 1024 * 1024) }).strict();
const verification = z.object({ inputs: cases(sourcePin), promptSha256: digest, oracleSha256: digest }).strict();
export const benchFixtureAllocationSchema = z.object({
  'LATENCY-M1:T01': cases(card),
  'LATENCY-M1:T02': cases(siblings),
  'LATENCY-M1:T03': cases(plan),
  'LATENCY-M1:T04': cases(timeline).optional(),
  'LATENCY-M1:T05': cases(timeline).optional(),
  verification: z.object({ 'LATENCY-M1:T01': verification.optional(),
    'LATENCY-M1:T02': verification.optional(), 'LATENCY-M1:T03': verification.optional(),
    'LATENCY-M1:T04': verification.optional(), 'LATENCY-M1:T05': verification.optional() }).strict().optional(),
}).strict();
export type BenchFixtureAllocation = z.infer<typeof benchFixtureAllocationSchema>;
const bindingSchema = z.object({ workspaceId: id, runId: id, preregHash: digest,
  assignmentId: z.string().startsWith('bench-assignment:').max(300),
  armId: id, seed: z.number().int().safe().nonnegative(),
  lease: z.object({ hostRunId: id, id: z.string().uuid(), expiresAt: z.string().datetime() }).strict().optional(),
  sourcePins: cases(sourcePin).optional() }).strict();
export const benchFixtureBoundarySchema = z.discriminatedUnion('taskId', [
  bindingSchema.extend({ taskId: z.literal('LATENCY-M1:T01'), fixtureSha256: digest, cases: cases(card) }).strict(),
  bindingSchema.extend({ taskId: z.literal('LATENCY-M1:T02'), fixtureSha256: digest, cases: cases(siblings) }).strict(),
  bindingSchema.extend({ taskId: z.literal('LATENCY-M1:T03'), fixtureSha256: digest, cases: cases(plan) }).strict(),
  bindingSchema.extend({ taskId: z.literal('LATENCY-M1:T04'), fixtureSha256: digest, cases: cases(timeline) }).strict(),
  bindingSchema.extend({ taskId: z.literal('LATENCY-M1:T05'), fixtureSha256: digest, cases: cases(timeline) }).strict(),
]);
export type BenchFixtureReadBoundary = z.infer<typeof benchFixtureBoundarySchema>;
export const validBenchFixtureReadBoundary = (value: unknown): value is BenchFixtureReadBoundary =>
  benchFixtureBoundarySchema.safeParse(value).success;
export const benchFixtureAllocationSha256 = (allocation: BenchFixtureAllocation) =>
  createHash('sha256').update(canonicalJson(benchFixtureAllocationSchema.parse(allocation))).digest('hex');

/** The host supplies allocation bytes; the frozen arm pins their digest. Never
 * derive source IDs from a prompt, grader metadata or solver request. */
export function freezeBenchFixtureReadBoundary(input: {
  binding: z.infer<typeof bindingSchema>; taskId: string;
  expectedSha256: string; allocation: BenchFixtureAllocation;
}): BenchFixtureReadBoundary | undefined {
  const allocation = benchFixtureAllocationSchema.parse(input.allocation);
  if (benchFixtureAllocationSha256(allocation) !== input.expectedSha256)
    throw new Error('Private benchmark fixture allocation differs from its frozen arm.');
  if (!['LATENCY-M1:T01', 'LATENCY-M1:T02', 'LATENCY-M1:T03', 'LATENCY-M1:T04', 'LATENCY-M1:T05'].includes(input.taskId)) return undefined;
  const taskId = input.taskId as BenchFixtureReadBoundary['taskId'];
  if (!allocation[taskId]) throw new Error('Private benchmark task has no frozen source allocation.');
  return benchFixtureBoundarySchema.parse({ ...input.binding, taskId: input.taskId,
    fixtureSha256: input.expectedSha256, cases: allocation[taskId],
    ...(allocation.verification?.[taskId] ? { sourcePins: allocation.verification[taskId]!.inputs } : {}) });
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
function exposesHiddenOracle(value: unknown, oracleText?: string): boolean {
  if (typeof value === 'string') {
    if (oracleText && value.includes(oracleText)) return true;
    // Context entries can contain JSON as text; inspect its decoded fields too.
    if (/^\s*[\[{]/.test(value)) {
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { return false; }
      return exposesHiddenOracle(parsed, oracleText);
    }
    return false;
  }
  return !!value && typeof value === 'object' &&
    (oracleText !== undefined && canonicalJson(value) === oracleText ||
      Object.entries(value).some(([key, child]) =>
        ['qualityOracle', 'graderMeta', 'hiddenGraderAnswers'].includes(key) || exposesHiddenOracle(child, oracleText)));
}
/** Fingerprint stored source material, independently of reader projections.
 * Product output can improve between phases; the underlying inputs cannot.
 * These queries read the existing scorecard/revision stores in the private DB. */
export async function readBenchFixtureSourceSnapshot(boundary: BenchFixtureReadBoundary,
  which: 'A' | 'B', scope: DbScope): Promise<unknown> {
  const { sql, ws } = resolveDb(scope);
  if (ws !== boundary.workspaceId) throw new Error('Private fixture source workspace differs.');
  if (boundary.taskId === 'LATENCY-M1:T04' || boundary.taskId === 'LATENCY-M1:T05') {
    const source = boundary.cases[which];
    // Pin the reader's complete source population, including automatic calls,
    // trusted spawn aliases and legacy default-workspace turns. These are raw
    // stored inputs, not the reader's projection or the independent oracle.
    const turns = await sql`SELECT to_jsonb(s) AS row FROM harness_shared.session_turns s
      WHERE (workspace_id = ${ws} OR workspace_id = 'default') AND owner = ${source.owner}
        AND COALESCE(ts, ingested_at) >= ${source.since}::timestamptz
        AND COALESCE(ts, ingested_at) < ${source.until}::timestamptz
      ORDER BY workspace_id, source_kind, session_id, turn_idx LIMIT 10001`;
    const tools = await sql`SELECT to_jsonb(t) AS row FROM harness_shared.tool_invocations t
      WHERE ${toolInvocationOwnerPredicate(sql, source.owner)}
        AND invoked_at >= ${source.since}::timestamptz AND invoked_at < ${source.until}::timestamptz
      ORDER BY id LIMIT 10001`;
    const coord = await sql`SELECT to_jsonb(c) AS row FROM harness_shared.coord_event_log c
      WHERE surface = 'messages' AND body->>'from' = ${source.owner}
        AND ts >= ${source.since}::timestamptz AND ts < ${source.until}::timestamptz
      ORDER BY ts, writer_key, msg_id LIMIT 10001`;
    if ([turns, tools, coord].some(rows => rows.length > 10000) || !turns.length && !tools.length && !coord.length)
      throw new Error('Private fixture timeline source is missing or oversized.');
    return { window: source, turns, tools, coord };
  }
  if (boundary.taskId === 'LATENCY-M1:T01' || boundary.taskId === 'LATENCY-M1:T02') {
    const source = boundary.cases[which];
    if (!source.comparisonTime) throw new Error('Private fixture source requires its frozen comparison clock.');
    const cards = await sql<{ issue_id: string; created_by: string | null; created_at: Date;
      observation: Record<string, unknown> | null }[]>`SELECT issue_id, created_by, created_at, payload->'observation' AS observation
      FROM harness_shared.engineer_issues WHERE workspace_id = ${ws} AND issue_id = ${source.issueId}
        AND created_at <= ${source.comparisonTime}::timestamptz`;
    if (cards.length !== 1 || !cards[0]!.observation) throw new Error('Private fixture source card is missing.');
    const card = { ...cards[0], created_at: new Date(cards[0]!.created_at).toISOString() };
    // The product readers also resolve rubric definitions and supersession
    // against sibling cards. Pin those inputs, including post-clock relations;
    // freezing only the selected observation misses changes to read-time truth.
    const rubricRef = cards[0]!.observation!.rubricRef;
    if (typeof rubricRef !== 'string' || !rubricRef) throw new Error('Private fixture source rubric is missing.');
    const history = await sql`SELECT issue_id, created_by, created_at, payload->'observation' AS observation
      FROM harness_shared.engineer_issues WHERE workspace_id = ${ws}
        AND payload->'observation'->>'rubricRef' = ${rubricRef}
      ORDER BY created_at DESC, issue_id DESC LIMIT 10001`;
    if (history.length > 10000) throw new Error('Private fixture related history is oversized.');
    const rubricRefs = [rubricRef, 'grading-integrity'], seen = new Set<string>();
    const rubrics: unknown[] = [];
    while (rubricRefs.length) {
      const ref = rubricRefs.shift()!;
      if (seen.has(ref)) continue;
      if (seen.size >= 64) throw new Error('Private fixture rubric dependency population is oversized.');
      seen.add(ref);
      const definitions = await sql`SELECT harness_slug, plan_slug, version, status, archived, content_hash, template_data
        FROM harness_shared.harness_plans WHERE workspace_id = ${ws} AND plan_slug = ${ref}
          AND template = 'rubric' AND template_slug IS NULL ORDER BY harness_slug LIMIT 2`;
      if (definitions.length > 1) throw new Error('Private fixture rubric dependency is ambiguous.');
      for (const definition of definitions) {
        const revisions = await sql`SELECT seq, content_hash, content_snapshot, created_at
          FROM harness_shared.plan_revisions WHERE workspace_id = ${ws}
            AND harness_slug = ${definition.harness_slug} AND plan_slug = ${ref} ORDER BY seq LIMIT 10001`;
        if (revisions.length > 10000) throw new Error('Private fixture rubric history is oversized.');
        rubrics.push({ definition, revisions: revisions.map(row => ({ ...row, created_at: new Date(Number(row.created_at)).toISOString() })) });
        const data = definition.template_data;
        if (typeof data?.classRef === 'string') rubricRefs.push(data.classRef);
        if (Array.isArray(data?.composes)) for (const parent of data.composes)
          if (typeof parent === 'string') rubricRefs.push(parent);
      }
    }
    const dependencies = { history: history.map(row => ({ ...row, created_at: new Date(row.created_at).toISOString() })), rubrics };
    if (boundary.taskId === 'LATENCY-M1:T01') return { card, ...dependencies };
    const siblingSource = boundary.cases[which];
    const rows = await sql`SELECT issue_id, created_at, payload->'observation' AS observation
      FROM harness_shared.engineer_issues WHERE workspace_id = ${ws}
        AND payload->'observation'->>'rubricRef' = ${siblingSource.rubricRef}
        AND payload->'observation'->'subject'->>'ref' = ${siblingSource.subjectRef}
        AND created_at <= ${siblingSource.comparisonTime}::timestamptz
      ORDER BY created_at DESC, issue_id DESC LIMIT 10001`;
    if (!rows.length || rows.length > 10000 || !rows.some(row => row.issue_id === siblingSource.issueId))
      throw new Error('Private fixture sibling source is incomplete or oversized.');
    return { card, siblings: rows.map(row => ({ ...row, created_at: new Date(row.created_at).toISOString() })), ...dependencies };
  }
  if (boundary.taskId !== 'LATENCY-M1:T03') throw new Error('Private fixture source task is undeclared.');
  const source = boundary.cases[which];
  const rows = await sql`SELECT id, seq, content_hash, content_snapshot, created_at
    FROM harness_shared.plan_revisions WHERE workspace_id = ${ws} AND harness_slug = ${source.harness}
      AND plan_slug = ${source.slug}
      AND ${typeof source.revision === 'number' ? sql`seq = ${source.revision}` :
        sql`content_hash = ${source.revision} AND content_snapshot_hash = content_hash`}
      AND created_at <= ${Date.parse(source.specAsOf)}::bigint ORDER BY seq DESC LIMIT 1`;
  if (rows.length !== 1) throw new Error('Private fixture historical plan/spec pairing is unavailable.');
  const specs = await sql`SELECT DISTINCT ON (r.spec_id) to_jsonb(r) AS revision, c.source_val_id
    FROM harness_shared.plan_spec_clause_revisions r JOIN harness_shared.plan_spec_clauses c
      USING (workspace_id, harness_slug, plan_slug, spec_id)
    WHERE r.workspace_id = ${ws} AND r.harness_slug = ${source.harness} AND r.plan_slug = ${source.slug}
      AND GREATEST(r.created_at, COALESCE(r.accepted_at, r.created_at)) <= ${source.specAsOf}::timestamptz
    ORDER BY r.spec_id, r.revision DESC LIMIT 10001`;
  if (!specs.length || specs.length > 10000) throw new Error('Private fixture historical specs are missing or oversized.');
  return { plan: { ...rows[0], created_at: new Date(Number(rows[0]!.created_at)).toISOString() }, specs };
}

export async function requireBenchFixtureSourcePins(boundary: BenchFixtureReadBoundary, scope: DbScope,
  rejectOracle?: string): Promise<void> {
  if (!boundary.sourcePins) throw new Error('Private fixture requires immutable content and size pins.');
  for (const which of ['A', 'B'] as const) {
    const snapshot = await readBenchFixtureSourceSnapshot(boundary, which, scope), text = canonicalJson(snapshot);
    const pin = boundary.sourcePins[which];
    if (Buffer.byteLength(text) !== pin.bytes || sha256(text) !== pin.sha256)
      throw new Error('Private fixture source content or size differs from its frozen input.');
    if (exposesHiddenOracle(snapshot, rejectOracle))
      throw new Error('Private fixture source exposes a hidden grading oracle.');
  }
}

export async function requireBenchFixturePreflight(boundary: BenchFixtureReadBoundary, allocation: BenchFixtureAllocation,
  task: { problemStatement: string; graderMeta: Record<string, unknown> }, scope: DbScope,
  context: Pick<BenchmarkContextInput, 'context' | 'snapshotRoot'>): Promise<void> {
  const pin = allocation.verification?.[boundary.taskId];
  const oracle = (task.graderMeta.latencyM1 as { qualityOracle?: unknown } | undefined)?.qualityOracle;
  if (!pin || !oracle || typeof oracle !== 'object' || Array.isArray(oracle))
    throw new Error('Private fixture preflight requires the separately pinned task and hidden oracle.');
  const oracleText = canonicalJson(oracle);
  if (sha256(task.problemStatement) !== pin.promptSha256 || sha256(oracleText) !== pin.oracleSha256 ||
      exposesHiddenOracle(task.problemStatement, oracleText))
    throw new Error('Private fixture task bytes or hidden oracle exclusion differs from its frozen input.');
  for (const bytes of Object.values(readBenchmarkContextSources(context))) {
    if (exposesHiddenOracle(JSON.parse(bytes.toString('utf8')), oracleText))
      throw new Error('Private fixture context exposes a hidden grading oracle.');
  }
  await requireBenchFixtureSourcePins(boundary, scope, oracleText);
}

/** Use the operational run's existing checkpoint for read authority. Persisted
 * session confinement is a ceiling, not evidence that its issuing host lives.
 * A bounded lease cannot be renewed or recovered by a solver or a copied host. */
export async function allocateBenchFixtureReadLease(input: {
  scope: DbScope; hostRunId: string; protocol: unknown; loopId: string;
  boundary: BenchFixtureReadBoundary; maxWallClockMs: number;
}) {
  const { sql, ws } = resolveDb(input.scope);
  if (ws !== input.boundary.workspaceId || input.boundary.lease ||
      !Number.isSafeInteger(input.maxWallClockMs) || input.maxWallClockMs <= 0)
    throw new Error('Private fixture lease requires the exact bounded host assignment.');
  const lease = { hostRunId: input.hostRunId, id: randomUUID(),
    expiresAt: new Date(Date.now() + input.maxWallClockMs).toISOString() };
  const boundary = benchFixtureBoundarySchema.parse({ ...input.boundary, lease });
  const key = boundary.assignmentId;
  await sql.begin(async tx => {
    const [row] = await tx<{ status: string; config: { current?: { preregHash?: string };
      loopId?: string; protocol?: unknown; privateFixtureReads?: Record<string, unknown> } }[]>`
      SELECT status, config FROM harness_shared.bench_runs
      WHERE workspace_id = ${ws} AND id = ${input.hostRunId} FOR UPDATE`;
    if (!row || row.status !== 'running' || row.config.current?.preregHash !== boundary.preregHash ||
        row.config.loopId !== input.loopId || canonicalJson(row.config.protocol) !== canonicalJson(input.protocol) ||
        row.config.privateFixtureReads?.[key])
      throw new Error('Private fixture lease has no unused matching live host checkpoint.');
    await tx`UPDATE harness_shared.bench_runs SET config = jsonb_set(config, '{privateFixtureReads}',
      COALESCE(config->'privateFixtureReads', '{}'::jsonb) ||
        ${JSON.stringify({ [key]: { boundary, status: 'active' } })}::text::jsonb)
      WHERE workspace_id = ${ws} AND id = ${input.hostRunId}`;
  });
  let revoking: Promise<void> | undefined;
  return { boundary, revoke: () => revoking ??= (async () => {
    await sql`UPDATE harness_shared.bench_runs SET config = jsonb_set(config,
      ${['privateFixtureReads', key, 'status']}::text[], '"revoked"'::jsonb)
      WHERE workspace_id = ${ws} AND id = ${input.hostRunId}
        AND config->'privateFixtureReads'->${key}->'boundary' = ${JSON.stringify(boundary)}::text::jsonb`;
  })() };
}

/** Rechecked before AND after a product read, including in-flight stop races.
 * Run cancellation, expiry, lost checkpoints and altered bindings fail closed. */
export async function requireBenchFixtureReadLease(boundary: BenchFixtureReadBoundary, scope: DbScope = {}): Promise<void> {
  const pinned = benchFixtureBoundarySchema.parse(boundary), { sql, ws } = resolveDb(scope);
  if (!pinned.lease || ws !== pinned.workspaceId || Date.parse(pinned.lease.expiresAt) <= Date.now())
    throw new Error('Private fixture read requires a live host lease.');
  const [row] = await sql<{ live: boolean }[]>`SELECT true AS live FROM harness_shared.bench_runs
    WHERE workspace_id = ${ws} AND id = ${pinned.lease.hostRunId} AND status = 'running'
      AND config->'current'->>'preregHash' = ${pinned.preregHash}
      AND config->'protocol'->>'runId' = ${pinned.runId}
      AND config->'privateFixtureReads'->${pinned.assignmentId}->>'status' = 'active'
      AND config->'privateFixtureReads'->${pinned.assignmentId}->'boundary' = ${JSON.stringify(pinned)}::text::jsonb
      AND now() < ${pinned.lease.expiresAt}::timestamptz`;
  if (!row?.live) throw new Error('Private fixture read requires its active operational host lease.');
}

const common = z.object({ case: z.enum(['A', 'B']),
  resultCursor: z.object({ sha256: digest, offset: z.number().int().safe().nonnegative() }).strict().optional() });
const offset = z.number().int().safe().nonnegative();
export const benchFixtureReadArgs = z.discriminatedUnion('operation', [
  common.extend({ operation: z.literal('card'), criterionKey: id.optional(),
    indexOffset: offset.optional(), evidenceOffset: offset.optional(), rerunRecipeOffset: offset.optional() }).strict(),
  common.extend({ operation: z.literal('siblings'), cursor: z.object({
    createdAt: z.string().datetime({ offset: true }), issueId: id }).strict().optional() }).strict(),
  common.extend({ operation: z.literal('plan') }).strict(),
  common.extend({ operation: z.literal('specs') }).strict(),
  common.extend({ operation: z.literal('timeline'), cursor: z.string().min(1).max(512).optional() }).strict(),
  common.extend({ operation: z.literal('context'), source: z.enum(['corpus', 'memory']),
    entryKey: z.string().min(1).max(4096).optional() }).strict(),
]);
export type BenchFixtureReadArgs = z.infer<typeof benchFixtureReadArgs>;
export type BenchFixtureProductCall = { tool: 'scorecards:get' | 'scorecards:list' | 'plans:get' | 'plans:get-specs' | 'sessions:timeline' | 'frozen-context';
  args: Record<string, unknown> };

/** Raw inputs use the existing physical context and operational lease. The
 * protocol supplies the hashes; the held-item ceiling supplies the checkout.
 * Continuations re-read pinned bytes instead of copying a multi-MB corpus into
 * the checkpoint on each read. They use the same lossless result page format. */
export async function benchFixtureContextSnapshot(boundary: BenchFixtureReadBoundary, call: BenchFixtureProductCall,
  checkout: string, scope: DbScope) {
  if (call.tool !== 'frozen-context') throw new Error('Private context operation is undeclared.');
  await requireBenchFixtureReadLease(boundary, scope);
  const { sql, ws } = resolveDb(scope);
  const [row] = await sql`SELECT config->'protocol' AS protocol FROM harness_shared.bench_runs
    WHERE workspace_id = ${ws} AND id = ${boundary.lease!.hostRunId}`;
  if (!row?.protocol || sha256(canonicalJson(row.protocol)) !== boundary.preregHash)
    throw new Error('Private context protocol differs from its frozen preregistration.');
  const context = currentBenchmarkProtocolSchema.shape.context.parse(row.protocol.context);
  const source = z.enum(['corpus', 'memory']).parse(call.args.source), expected = context[`${source}Hash`];
  const snapshot = readFrozenBenchmarkSnapshot(checkout, source, expected, context.forbiddenSources);
  const entry = call.args.entryKey === undefined ? undefined : snapshot.entries.find(entry => entry.key === call.args.entryKey);
  if (call.args.entryKey !== undefined && !entry) throw new Error('Private context entry key is not in its frozen snapshot.');
  const text = canonicalJson({ source, snapshotSha256: expected,
    ...(entry ? { entry } : { entries: snapshot.entries.map(entry => ({ key: entry.key,
      bytes: Buffer.byteLength(entry.text), sha256: sha256(entry.text) })) }) });
  return { text, sha256: sha256(text), bytes: Buffer.byteLength(text) };
}

/** Lossless result continuations live on the SAME operational lease. Only the
 * actual product reader can create one; a cursor cannot select another source.
 * This extends the existing checkpoint, rather than admitting scratch-file tools. */
export async function benchFixtureResultSnapshot(boundary: BenchFixtureReadBoundary,
  call: BenchFixtureProductCall, scope: DbScope, text?: string) {
  await requireBenchFixtureReadLease(boundary, scope);
  const { sql, ws } = resolveDb(scope), key = sha256(canonicalJson(call));
  const parse = (value: unknown) => {
    const stored = z.object({ text: z.string(), sha256: digest, bytes: z.number().int().positive() }).strict().parse(value);
    if (Buffer.byteLength(stored.text) !== stored.bytes || sha256(stored.text) !== stored.sha256)
      throw new Error('Private fixture result snapshot is corrupt.');
    return stored;
  };
  if (text === undefined) {
    const [row] = await sql`SELECT config->'privateFixtureReads'->${boundary.assignmentId}->'results'->${key} AS snapshot
      FROM harness_shared.bench_runs WHERE workspace_id = ${ws} AND id = ${boundary.lease!.hostRunId}`;
    if (!row?.snapshot) throw new Error('Private fixture result continuation has no retained product read.');
    return parse(row.snapshot);
  }
  const snapshot = { text, sha256: sha256(text), bytes: Buffer.byteLength(text) };
  if (!snapshot.bytes || snapshot.bytes > 16 * 1024 * 1024)
    throw new Error('Private fixture result exceeds its bounded checkpoint.');
  return sql.begin(async tx => {
    const [row] = await tx`SELECT config->'privateFixtureReads'->${boundary.assignmentId}->'results' AS results
      FROM harness_shared.bench_runs WHERE workspace_id = ${ws} AND id = ${boundary.lease!.hostRunId}
        AND status = 'running' AND config->'privateFixtureReads'->${boundary.assignmentId}->>'status' = 'active'
        AND config->'privateFixtureReads'->${boundary.assignmentId}->'boundary' = ${JSON.stringify(boundary)}::text::jsonb
        AND now() < ${boundary.lease!.expiresAt}::timestamptz FOR UPDATE`;
    if (!row) throw new Error('Private fixture result lost its active host lease.');
    const results = row.results ?? {};
    if (results[key]) {
      const existing = parse(results[key]);
      if (existing.sha256 !== snapshot.sha256) throw new Error('Private fixture product output changed within its frozen read.');
      return existing;
    }
    if (Object.keys(results).length >= 128 || Buffer.byteLength(JSON.stringify({ ...results, [key]: snapshot })) > 16 * 1024 * 1024)
      throw new Error('Private fixture result population exceeds its bounded checkpoint.');
    await tx`UPDATE harness_shared.bench_runs SET config = jsonb_set(config,
      ${['privateFixtureReads', boundary.assignmentId, 'results']}::text[],
      ${JSON.stringify({ ...results, [key]: snapshot })}::text::jsonb)
      WHERE workspace_id = ${ws} AND id = ${boundary.lease!.hostRunId}`;
    return snapshot;
  });
}

/** Account for both JSON escape layers used by the MCP text envelope. */
export function benchFixtureResultFits(data: unknown, budgetBytes: number) {
  return Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(data) }] })) <= budgetBytes - 512;
}

export function benchFixtureResultPage(snapshot: { text: string; sha256: string; bytes: number },
  request: BenchFixtureReadArgs, budgetBytes: number) {
  const offset = request.resultCursor?.offset ?? 0;
  if (request.resultCursor && request.resultCursor.sha256 !== snapshot.sha256 || offset > snapshot.text.length)
    throw new Error('Private fixture result cursor differs from its retained product read.');
  let length = Math.min(2048, snapshot.text.length - offset);
  for (;;) {
    const end = offset + length, complete = end === snapshot.text.length;
    const data = { ok: true, privateFixtureResult: { encoding: 'json-utf16-chunks', sha256: snapshot.sha256,
      bytes: snapshot.bytes, totalChars: snapshot.text.length, offset, text: snapshot.text.slice(offset, end), complete,
      next: complete ? null : { tool: BENCH_PRIVATE_FIXTURE_TOOL,
        args: { ...request, resultCursor: { sha256: snapshot.sha256, offset: end } } } } };
    if (benchFixtureResultFits(data, budgetBytes)) return data;
    if (length <= 1) throw new Error('Private fixture result door cannot fit a lossless continuation.');
    length = Math.floor(length / 2);
  }
}

/** Compile an argument-aware proxy call. Raw product verbs remain outside the
 * native tool ceiling; the existing handlers perform the actual read. */
export function benchFixtureProductCall(boundary: BenchFixtureReadBoundary, rawArgs: unknown): BenchFixtureProductCall {
  const pinned = benchFixtureBoundarySchema.parse(boundary), args = benchFixtureReadArgs.parse(rawArgs);
  if (args.operation === 'context') return { tool: 'frozen-context', args: { source: args.source,
    ...(args.entryKey !== undefined ? { entryKey: args.entryKey } : {}) } };
  const source = pinned.cases[args.case];
  if (args.operation === 'card' && 'issueId' in source) {
    const { operation: _, case: __, resultCursor: ___, ...paging } = args;
    if (paging.criterionKey !== undefined && paging.indexOffset !== undefined ||
        paging.evidenceOffset !== undefined && paging.criterionKey === undefined ||
        paging.rerunRecipeOffset !== undefined &&
          (pinned.taskId !== 'LATENCY-M1:T02' || Object.keys(paging).length !== 1))
      throw new Error('Private fixture card continuation has incompatible selectors.');
    return { tool: 'scorecards:get', args: { issueId: source.issueId,
      ...(source.comparisonTime ? { comparisonTime: source.comparisonTime } : {}), ...paging } };
  }
  if (args.operation === 'siblings' && pinned.taskId === 'LATENCY-M1:T02') {
    const source = pinned.cases[args.case];
    return { tool: 'scorecards:list', args: { rubricRef: source.rubricRef, subjectRef: source.subjectRef,
      comparisonTime: source.comparisonTime, historyMode: 'review-history', includeSuperseded: true,
      includeRetracted: true, detail: 'full', limit: 20, ...(args.cursor ? { cursor: args.cursor } : {}) } };
  }
  if (pinned.taskId === 'LATENCY-M1:T03') {
    const source = pinned.cases[args.case];
    if (args.operation === 'plan') return { tool: 'plans:get', args: {
      harness: source.harness, slug: source.slug, revision: source.revision, mode: 'full', includeEnrichments: false } };
    if (args.operation === 'specs') return { tool: 'plans:get-specs', args: {
      harness: source.harness, slug: source.slug, asOf: source.specAsOf } };
  }
  if (args.operation === 'timeline' && (pinned.taskId === 'LATENCY-M1:T04' || pinned.taskId === 'LATENCY-M1:T05')) {
    return { tool: 'sessions:timeline', args: { ...pinned.cases[args.case], limit: 300,
      include_auto: true, group_repeated: false, ...(args.cursor ? { cursor: args.cursor } : {}) } };
  }
  throw new Error('Private fixture operation is not declared for this benchmark task.');
}

/** Preserve real output; only translate read-continuation addresses so the
 * confined solver can follow them without admitting raw product verbs. */
export function benchFixtureReadContinuations(value: unknown, call: BenchFixtureProductCall,
  request: BenchFixtureReadArgs): unknown {
  if (call.tool !== 'scorecards:get' || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const row = value as Record<string, unknown>;
  const translate = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const address = value as Record<string, unknown>;
    if (address.tool !== call.tool || !address.args || typeof address.args !== 'object' || Array.isArray(address.args)) return value;
    const next = address.args as Record<string, unknown>;
    if (next.issueId === call.args.issueId &&
        (next.comparisonTime === undefined || next.comparisonTime === call.args.comparisonTime) &&
        Object.keys(next).every(key => ['issueId', 'comparisonTime', 'criterionKey', 'indexOffset', 'evidenceOffset', 'rerunRecipeOffset'].includes(key))) {
      const { issueId: _, comparisonTime: __, ...paging } = next;
      const args = benchFixtureReadArgs.safeParse({ operation: 'card', case: request.case, ...paging });
      if (args.success) return { ...address, tool: BENCH_PRIVATE_FIXTURE_TOOL, args: args.data };
    }
    return value;
  };
  const envelope = (value: unknown, criteria: boolean) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const page = value as Record<string, unknown>;
    return { ...page, ...('read' in page ? { read: translate(page.read) } : {}),
      ...('next' in page ? { next: translate(page.next) } : {}),
      ...(criteria && Array.isArray(page.criteria) ? { criteria: page.criteria.map(entry => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
        return { ...entry, ...('read' in entry ? { read: translate(entry.read) } : {}) };
      }) } : {}) };
  };
  // Never traverse scorecard/recipe bodies: they may themselves contain tool
  // addresses, and T02 requires the exact original stored recipe as data.
  return { ...row,
    ...('evidenceRead' in row ? { evidenceRead: envelope(row.evidenceRead, true) } : {}),
    ...('rerunRecipeRead' in row ? { rerunRecipeRead: envelope(row.rerunRecipeRead, false) } : {}) };
}
