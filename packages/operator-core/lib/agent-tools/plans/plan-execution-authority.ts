import { isDeepStrictEqual } from 'node:util';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { z } from 'zod';
import { physicalPath } from '../locks/external-path';
import { hasValidGitEntry } from '../locks/valid-git-entry';
import { previewDiscoveryDeclaration, scopedFeasibilityExperimentSchema,
  type ScopedFeasibilityExperiment } from './plan-declarations';

import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import type { AgentIdentity } from '../coordination/identity';
import { acquirePlanRevisionAdvisoryLock, recordPlanRevisionInTransaction, type PlanRevisionSql } from './revisions';
import { acquirePlanAdvisoryLock, planAdvisoryLockKey } from './plan-lock-key';
import { planExecutionMeaning } from './plan-execution-meaning';
import { checkPlanExecutionReadiness, readScopedFeasibilityTestRoutes, type ExecutionPlanBinding } from './plan-execution-guard';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import { parsePlan } from './parser';
import { readPlanLineItems } from './plan-line-graph';
import { renderPlanLines } from './plan-line-render';
import { revalidateOwnerSelectedReviewForStart } from './plan-start-owner-review';
import { formatPlanStartProofRefusal } from './plan-start-proof-refusal';

/** The strict discovery-only operation; no caller-supplied authority fields.
 * questionId's 100-character bound comes from plan-declarations.ts discoveryId.
 * Work-item identities and selections have no additional local processing cap. */
const feasibilityRequestFields = {
  questionId: z.string().min(1).max(100).refine(value => value === value.trim(), 'identity must be exact'),
  workItemId: z.string().min(1).refine(value => value === value.trim(), 'identity must be exact'),
  expectedPlanRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};
export const scopedFeasibilityRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('grant'), ...feasibilityRequestFields }).strict(),
  z.object({ action: z.literal('revoke'), ...feasibilityRequestFields, receiptId: z.string().min(1) }).strict(),
]);
// Separate from ordinary audit so *every* irrelevant field can be rejected.
export const scopedFeasibilityAuditSchema = z.object({
  slug: z.string().min(1), harness: z.string().min(1).optional(),
  phase: z.literal('discovery'), dryRun: z.boolean().default(false),
  feasibility: scopedFeasibilityRequestSchema,
}).strict();

/** Read complete authored data, never a diagnostic preview's bounded projection. */
export function readScopedFeasibilityQuestion(content: string, questionId: string): ScopedFeasibilityExperiment {
  const declaration = previewDiscoveryDeclaration(content);
  if (declaration.status !== 'declared' || !declaration.data)
    throw new Error('feasibility_declaration_missing_or_ambiguous_or_invalid; inspect complete section:Discovery');
  const question = declaration.data.questions.find(question => question.id === questionId);
  if (!question || question.outcome !== 'unresolved' || !question.experiment)
    throw new Error('feasibility_question_not_unresolved_or_selected');
  return question.experiment;
}

/** physicalPath alone cannot prove spelling, unique inodes or ordinary metadata.
 * This is trusted-tool check/use validation, not hostile-filesystem containment. */
export function inspectScopedFeasibilitySelection(input: unknown, repositoryRoot: string):
  ScopedFeasibilityExperiment & { repositoryRoot: string; existingTestPaths: string[] } {
  const experiment = scopedFeasibilityExperimentSchema.parse(input);
  if (process.platform !== 'linux' || !isAbsolute(repositoryRoot) || resolve(repositoryRoot) !== repositoryRoot
    || !/^[\x20-\x7e]+$/.test(repositoryRoot) || /[\\*?\[\]{}]/.test(repositoryRoot))
    throw new Error('feasibility_repository_spelling_unsupported');
  // Per-invocation metadata only. Reuse complete sibling listings within one
  // trusted check/use interval; no persistent filesystem snapshot or TTL cache.
  const directories = new Map<string, { exact: Set<string>; folded: Map<string, string[]> }>();
  const checkComponent = (parent: string, segment: string): boolean => {
    let entries = directories.get(parent);
    if (!entries) {
      entries = { exact: new Set(), folded: new Map() };
      for (const bytes of readdirSync(parent, { encoding: 'buffer' })) {
        const name = bytes.toString('latin1');
        entries.exact.add(name);
        if (/^[\x20-\x7e]+$/.test(name)) {
          const fold = name.toLowerCase();
          entries.folded.set(fold, [...(entries.folded.get(fold) ?? []), name]);
        }
      }
      directories.set(parent, entries);
    }
    if (entries.folded.get(segment.toLowerCase())?.some(name => name !== segment))
      throw new Error('feasibility_case_collision:' + join(parent, segment));
    return entries.exact.has(segment);
  };
  let rootWalk = parse(repositoryRoot).root;
  for (const segment of repositoryRoot.slice(rootWalk.length).split('/').filter(Boolean)) {
    if (!checkComponent(rootWalk, segment)) throw new Error('feasibility_repository_spelling_missing');
    rootWalk = join(rootWalk, segment);
    const metadata = lstatSync(rootWalk);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || realpathSync(rootWalk) !== rootWalk)
      throw new Error('feasibility_repository_physical_mismatch');
  }
  if (physicalPath(repositoryRoot) !== repositoryRoot || !hasValidGitEntry(repositoryRoot))
    throw new Error('feasibility_repository_root_invalid');
  const inodes = new Set<string>(), physical = new Set<string>();
  const prospective = new Map<string, string>();
  const existingTestPaths: string[] = [];
  const tests = new Set(experiment.testPaths), fixtures = new Set(experiment.fixturePaths);
  const targets = [...tests, ...fixtures];
  const leaves = new Set(targets);
  for (const target of targets) {
    let current = repositoryRoot, missing = false, prefix = '';
    const segments = target.split('/');
    for (const [index, segment] of segments.entries()) {
      prefix = prefix ? prefix + '/' + segment : segment;
      const folded = prefix.toLowerCase(), previous = prospective.get(folded);
      if (previous !== undefined && previous !== prefix)
        throw new Error('feasibility_selected_case_collision:' + target);
      prospective.set(folded, prefix);
      if (index < segments.length - 1 && leaves.has(prefix))
        throw new Error('feasibility_selected_file_is_parent:' + target);
      if (!missing && !checkComponent(current, segment)) missing = true;
      current = join(current, segment);
      if (missing) continue;
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink() || realpathSync(current) !== current)
        throw new Error('feasibility_symlink_or_alias:' + target);
      if (metadata.isDirectory() && hasValidGitEntry(current))
        throw new Error('feasibility_nested_repository:' + target);
      if (index < segments.length - 1) {
        if (!metadata.isDirectory()) throw new Error('feasibility_parent_not_directory:' + target);
      } else {
        if (!metadata.isFile() || metadata.nlink !== 1) throw new Error('feasibility_not_unique_regular_file:' + target);
        const inode = String(metadata.dev) + ':' + String(metadata.ino);
        if (inodes.has(inode)) throw new Error('feasibility_duplicate_physical_identity:' + target);
        inodes.add(inode);
        if (fixtures.has(target) && (metadata.mode & 0o111) !== 0)
          throw new Error('feasibility_executable_fixture:' + target);
        if (tests.has(target)) existingTestPaths.push(target);
      }
    }
    if (physicalPath(current) !== current || physical.has(current))
      throw new Error('feasibility_physical_identity_collision:' + target);
    physical.add(current);
  }
  const order = (paths: string[]) => [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return { ...experiment, repositoryRoot, testPaths: order(experiment.testPaths),
    fixturePaths: order(experiment.fixturePaths), existingTestPaths: order(existingTestPaths) };
}
export { preservePlanExecutionProgress } from './plan-execution-progress';

export interface ExecutionStartScope { workspaceId: string; harnessSlug: string; planSlug: string }
export type ExecutionPlanRow = Record<string, unknown> & { content: string; content_hash: string };
const feasibilityHistoryMarker = 'plans:audit scoped-feasibility:';
const feasibilityEventSchema = z.object({
  schema: z.literal('scoped-feasibility-v1'), action: z.enum(['grant', 'revoke']),
  scope: z.object({ workspaceId: z.string().min(1), harnessSlug: z.string().min(1), planSlug: z.string().min(1) }).strict(),
  actorId: z.string().min(1), workItemId: z.string().min(1),
  questionId: feasibilityRequestFields.questionId, claimTakenAt: z.string().min(1),
  planRevision: feasibilityRequestFields.expectedPlanRevision, planContentHash: z.string().min(1),
  planSnapshot: z.record(z.string(), z.unknown()), repositoryRoot: z.string().min(1),
  experiment: scopedFeasibilityExperimentSchema, issuedAt: z.string().min(1), expiresAt: z.string().min(1),
  replacedReceiptId: z.string().min(1).nullable(), revokedReceiptId: z.string().min(1).nullable(),
}).strict().superRefine((event, ctx) => {
  if ((event.action === 'grant') !== (event.revokedReceiptId === null))
    ctx.addIssue({ code: 'custom', path: ['revokedReceiptId'], message: 'must identify exactly a revoked grant' });
});
type FeasibilityEvent = z.infer<typeof feasibilityEventSchema>;
export interface ScopedFeasibilityHistoryRow {
  seq: number; content_snapshot: string; content_hash: string; rationale: string | null; author_id: string;
}
const feasibilityReceiptId = (scope: ExecutionStartScope, seq: number): string =>
  'scoped-feasibility-v1:' + JSON.stringify([scope.workspaceId, scope.harnessSlug, scope.planSlug, seq]);

/** Complete ordered history: no row/text prefix decides authority. Newer unknown
 * or malformed events cannot expose an older usable grant. Scope stays exact. */
export function readScopedFeasibilityHistory(rows: ScopedFeasibilityHistoryRow[], scope: ExecutionStartScope):
  Map<string, { event: FeasibilityEvent; receiptId: string; seq: number }> {
  const latest = new Map<string, { event: FeasibilityEvent; receiptId: string; seq: number }>();
  let previousSeq = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.seq) || row.seq <= previousSeq)
      throw new Error('feasibility_history_ambiguous_order');
    previousSeq = row.seq;
    let value: unknown;
    try { value = JSON.parse(row.content_snapshot); } catch {
      if (row.rationale?.startsWith(feasibilityHistoryMarker)) throw new Error('feasibility_history_malformed');
      continue;
    }
    const tagged = typeof value === 'object' && value !== null && 'schema' in value
      && typeof value.schema === 'string' && value.schema.startsWith('scoped-feasibility-');
    if (!tagged && !row.rationale?.startsWith(feasibilityHistoryMarker)) continue;
    const parsed = feasibilityEventSchema.safeParse(value);
    if (!parsed.success) throw new Error('feasibility_history_invalid_event:' + parsed.error.message);
    const event = parsed.data;
    if (!isDeepStrictEqual(event.scope, scope) || row.author_id !== event.actorId
      || row.content_hash !== event.planContentHash)
      throw new Error('feasibility_history_scope_or_author_mismatch');
    const key = JSON.stringify([event.workItemId, event.questionId]);
    const prior = latest.get(key);
    if (event.action === 'grant' && prior?.event.action === 'grant'
      && prior.event.actorId === event.actorId && prior.event.claimTakenAt === event.claimTakenAt
      && event.replacedReceiptId !== prior.receiptId)
      throw new Error('feasibility_history_replacement_required');
    if (event.action === 'revoke' && (!prior || prior.event.action !== 'grant'
      || event.revokedReceiptId !== prior.receiptId || prior.event.actorId !== event.actorId
      || prior.event.claimTakenAt !== event.claimTakenAt))
      throw new Error('feasibility_history_revoke_mismatch');
    if (event.replacedReceiptId !== null && (!prior || prior.event.action !== 'grant'
      || event.replacedReceiptId !== prior.receiptId || prior.event.actorId !== event.actorId
      || prior.event.claimTakenAt !== event.claimTakenAt))
      throw new Error('feasibility_history_replacement_mismatch');
    latest.set(key, { event, receiptId: feasibilityReceiptId(scope, row.seq), seq: row.seq });
  }
  return latest;
}

const progressFields = ['execution_start_revision_seq', 'execution_start_invalidation', 'rendered_content', 'content', 'content_hash', 'version', 'updated_at',
  'updated', 'status', 'op_status', 'op_updated_at', 'op_started_at', 'items', 'decisions', 'title',
  'now_state', 'now_next', 'now_note', 'now_note_version', 'now_note_updated_at', 'fed_ts', 'fed_hlc', 'origin'];

/** Structured execution inputs are part of the immutable start snapshot. */
export function executionPlanInputs(row: ExecutionPlanRow): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !progressFields.includes(key)));
}

/** Normalize only catalog-typed timestamps, including pre-normalization receipts.
 * PostgreSQL keeps microseconds; Date.parse/toISOString would discard authority
 * inputs below a millisecond. Nested JSON and timestamp-looking text stay opaque. */
async function normalizeExecutionTimestamps(sql: PlanRevisionSql, inputs: Record<string, unknown>[]): Promise<ExecutionPlanRow[]> {
  if (inputs.some(input => !input || typeof input !== 'object' || Array.isArray(input))) throw new Error('invalid_execution_inputs');
  const results = await sql<{ normalized: ExecutionPlanRow }[]>`
    SELECT (SELECT COALESCE(jsonb_object_agg(e.key, CASE
      WHEN a.atttypid='timestamptz'::regtype AND jsonb_typeof(e.value)='string' THEN
        CASE WHEN isfinite((e.value #>> '{}')::timestamptz) THEN
          to_jsonb(to_char((e.value #>> '{}')::timestamptz AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00')
        ELSE to_jsonb((e.value #>> '{}')::timestamptz) END
      WHEN a.atttypid='timestamp'::regtype AND jsonb_typeof(e.value)='string'
        THEN to_jsonb((e.value #>> '{}')::timestamp)
      ELSE e.value END), '{}'::jsonb)
      FROM jsonb_each(i.input) e
      LEFT JOIN pg_attribute a ON a.attrelid='harness_shared.harness_plans'::regclass
        AND a.attname=e.key AND a.attnum>0 AND NOT a.attisdropped) AS normalized
      FROM jsonb_array_elements(${JSON.stringify(inputs)}::text::jsonb) WITH ORDINALITY AS i(input, ordinal)
      ORDER BY i.ordinal`;
  return results.map(result => result.normalized);
}

export async function readExecutionPlanRow(scope: ExecutionStartScope): Promise<ExecutionPlanRow | null> {
  const { sql } = getOrgPg();
  return readExecutionSnapshot(sql, scope);
}

async function readExecutionSnapshot(sql: PlanRevisionSql, scope: ExecutionStartScope,
  lock = false): Promise<ExecutionPlanRow | null> {
  const rows = await sql<{ row: ExecutionPlanRow }[]>`
    SELECT to_jsonb(p) - ARRAY(SELECT attname::text FROM pg_attribute
      WHERE attrelid='harness_shared.harness_plans'::regclass AND attgenerated<>'' AND NOT attisdropped) AS row
    FROM harness_shared.harness_plans p
     WHERE workspace_id=${scope.workspaceId} AND harness_slug=${scope.harnessSlug} AND plan_slug=${scope.planSlug}
     ${lock ? sql`FOR UPDATE` : sql``}`;
  const row = rows[0]?.row;
  if (!row) return null;
  const items = await readPlanLineItems(
    sql as never,
    { ...scope, slug: scope.planSlug },
    { items: row.items, content: row.content },
  );
  const [normalized] = await normalizeExecutionTimestamps(sql, [row]);
  return { ...normalized!, rendered_content: renderPlanLines(row.content, items) };
}

type ScopedFeasibilityRequest = z.infer<typeof scopedFeasibilityRequestSchema>;
type ScopedFeasibilitySelection = ReturnType<typeof inspectScopedFeasibilitySelection>;

async function readScopedFeasibilityClaim(sql: PlanRevisionSql, scope: ExecutionStartScope,
  identity: AgentIdentity, workItemId: string, lock = false): Promise<string> {
  const rows = await sql<{ claim_taken_at: string | null }[]>`
    SELECT to_char(w.taken_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00' AS claim_taken_at
      FROM harness_shared.work_items w
     WHERE w.workspace_id=${scope.workspaceId} AND w.harness_slug=${scope.harnessSlug}
       AND w.feature_id=${workItemId} AND w.taken_by=${identity.ownerId} AND w.taken_at IS NOT NULL
       AND (w.source_plan_slug=${scope.planSlug} OR w.plan_slug=${scope.planSlug})
       AND NOT(w.status=ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))
       ${lock ? sql`FOR UPDATE` : sql``}`;
  if (rows.length !== 1 || !rows[0]?.claim_taken_at) throw new Error('feasibility_current_linked_custody_required');
  return rows[0].claim_taken_at;
}

async function readScopedFeasibilityEvents(sql: PlanRevisionSql, scope: ExecutionStartScope) {
  // The complete spine is authoritative, including events after ordinary revisions.
  // No LIMIT or diagnostic projection may expose a superseded grant.
  const rows = await sql<ScopedFeasibilityHistoryRow[]>`
    SELECT seq,content_snapshot,content_hash,rationale,author_id FROM harness_shared.plan_revisions
     WHERE workspace_id=${scope.workspaceId} AND harness_slug=${scope.harnessSlug} AND plan_slug=${scope.planSlug}
     ORDER BY seq`;
  return readScopedFeasibilityHistory(rows, scope);
}

function prepareScopedFeasibilityPlan(row: ExecutionPlanRow | null, request: ScopedFeasibilityRequest,
  repositoryRoot: string): ScopedFeasibilitySelection {
  if (!row || row.status !== 'draft' || parsePlan(String(row.rendered_content)).frontmatter.status !== 'draft')
    throw new Error('feasibility_unresolved_draft_required');
  if (row.version !== request.expectedPlanRevision) throw new Error('feasibility_plan_revision_mismatch');
  return inspectScopedFeasibilitySelection(
    readScopedFeasibilityQuestion(String(row.rendered_content), request.questionId), repositoryRoot);
}

/** Existing plans:audit Discovery branch only. The root is resolved by its host,
 * never read from the request. Slow router preparation finishes before the write
 * transaction; its final locks fence both the complete plan and claim generation.
 * Appending this immutable event does not update the plan body or its version. */
export async function recordScopedFeasibilityAudit(scope: ExecutionStartScope, identity: AgentIdentity,
  input: unknown, repositoryRoot: string, dryRun = false) {
  const request = scopedFeasibilityRequestSchema.parse(input);
  if (!identity.ownerId || identity.workspaceId !== scope.workspaceId)
    throw new Error('feasibility_actor_scope_mismatch');
  const expected = await readExecutionPlanRow(scope);
  const prepared = prepareScopedFeasibilityPlan(expected, request, repositoryRoot);
  const { sql } = getOrgPg();
  const expectedClaim = await readScopedFeasibilityClaim(sql, scope, identity, request.workItemId);
  if (request.action === 'grant') {
    if (!prepared.existingTestPaths.length) throw new Error('feasibility_existing_routable_test_required');
    const routes = await readScopedFeasibilityTestRoutes(prepared.existingTestPaths, prepared.repositoryRoot);
    if (routes.some(route => !route.ok)) throw new Error('feasibility_selected_test_unroutable:' + JSON.stringify(routes));
  }
  return withWorkspace(scope.workspaceId, async tx => {
    await acquirePlanAdvisoryLock(tx, planAdvisoryLockKey(scope.workspaceId, scope.harnessSlug, scope.planSlug));
    await acquirePlanRevisionAdvisoryLock(tx, scope.workspaceId, scope.harnessSlug, scope.planSlug);
    const row = await readExecutionSnapshot(tx, scope, true);
    if (!row || !isDeepStrictEqual(row, expected)) throw new Error('feasibility_plan_changed_before_issuance');
    const claimTakenAt = await readScopedFeasibilityClaim(tx, scope, identity, request.workItemId, true);
    if (claimTakenAt !== expectedClaim) throw new Error('feasibility_claim_changed_before_issuance');
    const selection = prepareScopedFeasibilityPlan(row, request, repositoryRoot);
    if (!isDeepStrictEqual(selection, prepared)) throw new Error('feasibility_selection_changed_before_issuance');
    const latest = (await readScopedFeasibilityEvents(tx, scope)).get(JSON.stringify([request.workItemId, request.questionId]));
    const active = latest?.event.action === 'grant' ? latest : undefined;
    const sameCustody = active?.event.actorId === identity.ownerId && active.event.claimTakenAt === claimTakenAt;
    if (request.action === 'revoke' && (!active || !sameCustody || active.receiptId !== request.receiptId))
      throw new Error('feasibility_revoke_current_receipt_required');
    const replacedReceiptId = request.action === 'grant' && sameCustody ? active!.receiptId : null;
    const revokedReceiptId = request.action === 'revoke' ? request.receiptId : null;
    const bindings = { action: request.action, planRevision: request.expectedPlanRevision,
      planContentHash: row.content_hash, questionId: request.questionId, workItemId: request.workItemId,
      actorId: identity.ownerId, ...scope, repositoryRoot: selection.repositoryRoot,
      testPaths: selection.testPaths, fixturePaths: selection.fixturePaths };
    // A preview has no immutable event identity and cannot replace/revoke a grant.
    if (dryRun) return { ...bindings, usable: false as const, dryRun: true as const };
    const [clock] = await tx<{ issued_at: string; expires_at: string }[]>`
      WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS issued)
      SELECT to_char(issued AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00' AS issued_at,
        to_char((issued + ${selection.lifetimeSec} * interval '1 second') AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00' AS expires_at FROM clock`;
    if (!clock) throw new Error('feasibility_database_clock_unavailable');
    const { existingTestPaths: _existing, repositoryRoot: _root, ...experiment } = selection;
    const event = feasibilityEventSchema.parse({ schema: 'scoped-feasibility-v1', action: request.action,
      scope, actorId: identity.ownerId, workItemId: request.workItemId, questionId: request.questionId,
      claimTakenAt, planRevision: request.expectedPlanRevision, planContentHash: row.content_hash,
      planSnapshot: row, repositoryRoot: selection.repositoryRoot, experiment,
      issuedAt: clock.issued_at, expiresAt: clock.expires_at, replacedReceiptId, revokedReceiptId });
    const recorded = await recordPlanRevisionInTransaction(tx, { ...scope, identity,
      content: JSON.stringify(event), contentHash: row.content_hash,
      rationale: feasibilityHistoryMarker + request.action });
    const receiptId = feasibilityReceiptId(scope, recorded.seq);
    return { ...bindings, usable: request.action === 'grant', receiptId, eventRef: receiptId,
      issuedAt: event.issuedAt, expiresAt: event.expiresAt, replacedReceiptId,
      ...(request.action === 'revoke' ? { revokedReceiptId } : {}) };
  });
}

/** Canonical start calls this after its final promotion, admission and binding legs. */
export async function recordPlanExecutionStart(scope: ExecutionStartScope, identity: AgentIdentity,
  expected: ExecutionPlanRow): Promise<{ seq: number; contentHash: string }> {
  // Readiness uses independent connections and may perform slow policy reads.
  // Finish it before opening the write transaction: an otherwise idle transaction
  // can expire while those readers run. The locked, full-snapshot comparison below
  // fences plan changes made during readiness. Selected external evidence is
  // separately fenced and revalidated on the write transaction below.
  let requiresOwnerSelectedReview = true;
  const blockers = await checkPlanExecutionReadiness({ planSlug: scope.planSlug, harnessSlug: scope.harnessSlug },
    scope.workspaceId, undefined, 'start', required => { requiresOwnerSelectedReview = required; });
  if (blockers.length) throw new Error(formatPlanStartProofRefusal(blockers));
  return withWorkspace(scope.workspaceId, async tx => {
    await acquirePlanAdvisoryLock(tx, planAdvisoryLockKey(scope.workspaceId, scope.harnessSlug, scope.planSlug));
    const row = await readExecutionSnapshot(tx, scope, true);
    if (!row || !isDeepStrictEqual(row, expected)) throw new Error('plan_changed_before_start_proof');
    if (requiresOwnerSelectedReview) await revalidateOwnerSelectedReviewForStart(tx, scope,
      [row.owner, row.acceptance_bar_seeded_by].filter((id): id is string => typeof id === 'string'));
    const revision = await recordPlanRevisionInTransaction(tx, {
      ...scope, identity, contentHash: row.content_hash,
      content: JSON.stringify({ schema: 'plan-execution-start-v1', scope, body: row.rendered_content, inputs: executionPlanInputs(row) }),
      rationale: 'plans:start completed canonical promotion, admission and claim binding',
    });
    await tx`SELECT set_config('papercusp.execution_start',
      ${JSON.stringify([scope.workspaceId, scope.harnessSlug, scope.planSlug, row.content_hash, revision.seq])}, true)`;
    const updated = await tx<{ seq: number }[]>`
      UPDATE harness_shared.harness_plans SET execution_start_revision_seq=${revision.seq}
       WHERE workspace_id=${scope.workspaceId} AND harness_slug=${scope.harnessSlug} AND plan_slug=${scope.planSlug}
         AND content_hash=${row.content_hash}
       RETURNING execution_start_revision_seq AS seq`;
    if (updated[0]?.seq == null || Number(updated[0].seq) !== revision.seq)
      throw new Error('plan_start_proof_not_recorded');
    return revision;
  });
}

/** Read the exact same-scope reference; caller properties and rationale grant nothing. */
export async function readPlanExecutionStart(binding: ExecutionPlanBinding, workspaceId: string): Promise<string[]> {
  const { sql } = getOrgPg();
  const rows = await sql<{ row: ExecutionPlanRow; snapshot: string | null }[]>`
    SELECT to_jsonb(p) - ARRAY(SELECT attname::text FROM pg_attribute
      WHERE attrelid='harness_shared.harness_plans'::regclass AND attgenerated<>'' AND NOT attisdropped) AS row,
      r.content_snapshot AS snapshot
      FROM harness_shared.harness_plans p
      LEFT JOIN harness_shared.plan_revisions r ON r.workspace_id=p.workspace_id
        AND r.harness_slug=p.harness_slug AND r.plan_slug=p.plan_slug AND r.seq=p.execution_start_revision_seq
     WHERE p.workspace_id=${workspaceId} AND p.plan_slug=${binding.planSlug}
       AND (${binding.harnessSlug}::text IS NULL OR p.harness_slug=${binding.harnessSlug})`;
  if (rows.length !== 1) return [rows.length ? 'plan_scope_ambiguous' : 'bound_plan_missing'];
  const { row, snapshot } = rows[0]!;
  if (!['ready', 'active', 'awaiting-acceptance'].includes(String(row.status))) return [`plan_status:${row.status ?? 'unknown'}`];
  if (row.execution_start_revision_seq == null) return ['plan_not_started'];
  if (!snapshot) return ['plan_start_revision_missing'];
  try {
    const receipt = JSON.parse(snapshot);
    const scope = { workspaceId, harnessSlug: row.harness_slug, planSlug: binding.planSlug };
    if (receipt.schema !== 'plan-execution-start-v1' || !isDeepStrictEqual(receipt.scope, scope)
      || typeof receipt.body !== 'string') return ['plan_start_revision_invalid'];
    // Both validations use the row and receipt read above. Start the catalog
    // read with the graph read so their round trips do not serialize on the
    // native guard's deadline. Keep the meaning check first for refusal precedence.
    const [lines, inputs] = await Promise.allSettled([
      readPlanLineItems(sql,
        { workspaceId, harnessSlug: String(row.harness_slug), slug: binding.planSlug },
        { items: row.items, content: row.content }),
      normalizeExecutionTimestamps(sql, [receipt.inputs, executionPlanInputs(row)]),
    ]);
    if (lines.status === 'rejected') return ['plan_start_revision_invalid'];
    if (planExecutionMeaning(receipt.body) !== planExecutionMeaning(renderPlanLines(row.content, lines.value)))
      return ['plan_start_revision_stale'];
    if (inputs.status === 'rejected') return ['plan_start_revision_invalid'];
    const [stored, current] = inputs.value;
    if (!stored || !current) return ['plan_start_revision_invalid'];
    if (!isDeepStrictEqual(executionPlanInputs(stored), current))
      return ['plan_start_revision_stale'];
    return [];
  } catch { return ['plan_start_revision_invalid']; }
}
