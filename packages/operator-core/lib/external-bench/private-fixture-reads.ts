/** Solver reads over the existing benchmark assignment and product readers.
 * No answers, SQL, executable recipes or caller-selected source identities. */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './reproducibility/canonical-json';
import { resolveDb, type DbScope } from './reproducibility/db';

export const BENCH_PRIVATE_FIXTURE_TOOL = 'benchmark:read-private-fixture';
const id = z.string().trim().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const card = z.object({ issueId: id, comparisonTime: z.string().datetime({ offset: true }).optional() }).strict();
const siblings = card.extend({ rubricRef: id, subjectRef: id,
  comparisonTime: z.string().datetime({ offset: true }) }).strict();
const plan = z.object({ harness: id, slug: id,
  revision: z.union([z.number().int().safe().positive(), digest]),
  specAsOf: z.string().datetime({ offset: true }) }).strict();
const cases = <T extends z.ZodTypeAny>(schema: T) => z.object({ A: schema, B: schema }).strict();
const sourcePin = z.object({ sha256: digest, bytes: z.number().int().positive().max(16 * 1024 * 1024) }).strict();
const verification = z.object({ inputs: cases(sourcePin), promptSha256: digest, oracleSha256: digest }).strict();
export const benchFixtureAllocationSchema = z.object({
  'LATENCY-M1:T01': cases(card),
  'LATENCY-M1:T02': cases(siblings),
  'LATENCY-M1:T03': cases(plan),
  verification: z.object({ 'LATENCY-M1:T01': verification.optional(),
    'LATENCY-M1:T02': verification.optional(), 'LATENCY-M1:T03': verification.optional() }).strict().optional(),
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
  if (!['LATENCY-M1:T01', 'LATENCY-M1:T02', 'LATENCY-M1:T03'].includes(input.taskId)) return undefined;
  const taskId = input.taskId as 'LATENCY-M1:T01' | 'LATENCY-M1:T02' | 'LATENCY-M1:T03';
  return benchFixtureBoundarySchema.parse({ ...input.binding, taskId: input.taskId,
    fixtureSha256: input.expectedSha256, cases: allocation[taskId],
    ...(allocation.verification?.[taskId] ? { sourcePins: allocation.verification[taskId]!.inputs } : {}) });
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** Fingerprint stored source material, independently of reader projections.
 * Product output can improve between phases; the underlying inputs cannot.
 * These queries read the existing scorecard/revision stores in the private DB. */
export async function readBenchFixtureSourceSnapshot(boundary: BenchFixtureReadBoundary,
  which: 'A' | 'B', scope: DbScope): Promise<unknown> {
  const { sql, ws } = resolveDb(scope);
  if (ws !== boundary.workspaceId) throw new Error('Private fixture source workspace differs.');
  if (boundary.taskId === 'LATENCY-M1:T01' || boundary.taskId === 'LATENCY-M1:T02') {
    const source = boundary.cases[which];
    if (!source.comparisonTime) throw new Error('Private fixture source requires its frozen comparison clock.');
    const cards = await sql`SELECT issue_id, created_at, payload->'observation' AS observation
      FROM harness_shared.engineer_issues WHERE workspace_id = ${ws} AND issue_id = ${source.issueId}
        AND created_at <= ${source.comparisonTime}::timestamptz`;
    if (cards.length !== 1 || !cards[0]!.observation) throw new Error('Private fixture source card is missing.');
    const card = { ...cards[0], created_at: new Date(cards[0]!.created_at).toISOString() };
    if (boundary.taskId === 'LATENCY-M1:T01') return { card };
    const siblingSource = boundary.cases[which];
    const rows = await sql`SELECT issue_id, created_at, payload->'observation' AS observation
      FROM harness_shared.engineer_issues WHERE workspace_id = ${ws}
        AND payload->'observation'->>'rubricRef' = ${siblingSource.rubricRef}
        AND payload->'observation'->'subject'->>'ref' = ${siblingSource.subjectRef}
        AND created_at <= ${siblingSource.comparisonTime}::timestamptz
      ORDER BY created_at DESC, issue_id DESC LIMIT 10001`;
    if (!rows.length || rows.length > 10000 || !rows.some(row => row.issue_id === siblingSource.issueId))
      throw new Error('Private fixture sibling source is incomplete or oversized.');
    return { card, siblings: rows.map(row => ({ ...row, created_at: new Date(row.created_at).toISOString() })) };
  }
  const source = boundary.cases[which];
  const rows = await sql`SELECT id, seq, content_hash, content_snapshot, created_at
    FROM harness_shared.plan_revisions WHERE workspace_id = ${ws} AND harness_slug = ${source.harness}
      AND plan_slug = ${source.slug}
      AND ${typeof source.revision === 'number' ? sql`seq = ${source.revision}` :
        sql`content_hash = ${source.revision} AND content_snapshot_hash = content_hash`}
      AND created_at <= ${source.specAsOf}::timestamptz ORDER BY seq DESC LIMIT 1`;
  if (rows.length !== 1) throw new Error('Private fixture historical plan/spec pairing is unavailable.');
  const specs = await sql`SELECT DISTINCT ON (r.spec_id) to_jsonb(r) AS revision, c.source_val_id
    FROM harness_shared.plan_spec_clause_revisions r JOIN harness_shared.plan_spec_clauses c
      USING (workspace_id, harness_slug, plan_slug, spec_id)
    WHERE r.workspace_id = ${ws} AND r.harness_slug = ${source.harness} AND r.plan_slug = ${source.slug}
      AND GREATEST(r.created_at, COALESCE(r.accepted_at, r.created_at)) <= ${source.specAsOf}::timestamptz
    ORDER BY r.spec_id, r.revision DESC LIMIT 10001`;
  if (!specs.length || specs.length > 10000) throw new Error('Private fixture historical specs are missing or oversized.');
  return { plan: { ...rows[0], created_at: new Date(rows[0]!.created_at).toISOString() }, specs };
}

export async function requireBenchFixtureSourcePins(boundary: BenchFixtureReadBoundary, scope: DbScope,
  rejectOracle?: string): Promise<void> {
  if (!boundary.sourcePins) throw new Error('Private fixture requires immutable content and size pins.');
  for (const which of ['A', 'B'] as const) {
    const snapshot = await readBenchFixtureSourceSnapshot(boundary, which, scope), text = canonicalJson(snapshot);
    const pin = boundary.sourcePins[which];
    if (Buffer.byteLength(text) !== pin.bytes || sha256(text) !== pin.sha256)
      throw new Error('Private fixture source content or size differs from its frozen input.');
    const containsHiddenFields = (value: unknown): boolean => !!value && typeof value === 'object' &&
      Object.entries(value).some(([key, child]) => ['qualityOracle', 'graderMeta', 'hiddenGraderAnswers'].includes(key) || containsHiddenFields(child));
    if (containsHiddenFields(snapshot) || rejectOracle && text.includes(rejectOracle))
      throw new Error('Private fixture source exposes a hidden grading oracle.');
  }
}

export async function requireBenchFixturePreflight(boundary: BenchFixtureReadBoundary, allocation: BenchFixtureAllocation,
  task: { problemStatement: string; graderMeta: Record<string, unknown> }, scope: DbScope): Promise<void> {
  const pin = allocation.verification?.[boundary.taskId];
  const oracle = (task.graderMeta.latencyM1 as { qualityOracle?: unknown } | undefined)?.qualityOracle;
  if (!pin || !oracle || typeof oracle !== 'object' || Array.isArray(oracle))
    throw new Error('Private fixture preflight requires the separately pinned task and hidden oracle.');
  const oracleText = canonicalJson(oracle);
  if (sha256(task.problemStatement) !== pin.promptSha256 || sha256(oracleText) !== pin.oracleSha256 ||
      task.problemStatement.includes(oracleText))
    throw new Error('Private fixture task bytes or hidden oracle exclusion differs from its frozen input.');
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

const common = z.object({ case: z.enum(['A', 'B']) });
const offset = z.number().int().safe().nonnegative();
export const benchFixtureReadArgs = z.discriminatedUnion('operation', [
  common.extend({ operation: z.literal('card'), criterionKey: id.optional(),
    indexOffset: offset.optional(), evidenceOffset: offset.optional(), rerunRecipeOffset: offset.optional() }).strict(),
  common.extend({ operation: z.literal('siblings'), cursor: z.object({
    createdAt: z.string().datetime({ offset: true }), issueId: id }).strict().optional() }).strict(),
  common.extend({ operation: z.literal('plan') }).strict(),
  common.extend({ operation: z.literal('specs') }).strict(),
]);
export type BenchFixtureReadArgs = z.infer<typeof benchFixtureReadArgs>;
export type BenchFixtureProductCall = { tool: 'scorecards:get' | 'scorecards:list' | 'plans:get' | 'plans:get-specs';
  args: Record<string, unknown> };

/** Compile an argument-aware proxy call. Raw product verbs remain outside the
 * native tool ceiling; the existing handlers perform the actual read. */
export function benchFixtureProductCall(boundary: BenchFixtureReadBoundary, rawArgs: unknown): BenchFixtureProductCall {
  const pinned = benchFixtureBoundarySchema.parse(boundary), args = benchFixtureReadArgs.parse(rawArgs);
  const source = pinned.cases[args.case];
  if (args.operation === 'card' && 'issueId' in source) {
    const { operation: _, case: __, ...paging } = args;
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
