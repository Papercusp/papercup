/** Solver reads over the existing benchmark assignment and product readers.
 * No answers, SQL, executable recipes or caller-selected source identities. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './reproducibility/canonical-json';

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
export const benchFixtureAllocationSchema = z.object({
  'LATENCY-M1:T01': cases(card),
  'LATENCY-M1:T02': cases(siblings),
  'LATENCY-M1:T03': cases(plan),
}).strict();
export type BenchFixtureAllocation = z.infer<typeof benchFixtureAllocationSchema>;
const bindingSchema = z.object({ workspaceId: id, runId: id, preregHash: digest,
  assignmentId: z.string().startsWith('bench-assignment:').max(300),
  armId: id, seed: z.number().int().safe().nonnegative() }).strict();
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
  if (!Object.hasOwn(allocation, input.taskId)) return undefined;
  return benchFixtureBoundarySchema.parse({ ...input.binding, taskId: input.taskId,
    fixtureSha256: input.expectedSha256, cases: allocation[input.taskId as keyof BenchFixtureAllocation] });
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
