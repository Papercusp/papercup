import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { canonicalJson } from '@papercusp/hash-chain';
import type { ExternalBlockerRecord } from './external-blockers';
import { readExternalBlockers } from './external-blockers';
import type { BlockerEvidenceMeasurement } from './blocker-resolution-decision';
import { gitFilePublicationBindingSchema, readGitFilePublicationCondition } from './git-file-publication-condition';

const relativePath = z.string().min(1).max(1000).refine(path =>
  !path.startsWith('/') && !path.includes('\\') && path.split('/').every(part => part && part !== '.' && part !== '..'),
  'Expected a repository-relative source path');
const servingRuntimeConditionBindingInputSchema = z.object({
  schemaVersion: z.literal(1),
  host: z.string().regex(/^port-[1-9][0-9]{0,4}$/),
  sourceBlobs: z.record(relativePath, z.string().regex(/^[a-f0-9]{40}$/))
    .refine(blobs => Object.keys(blobs).length > 0 && Object.keys(blobs).length <= 32, 'Supply 1–32 exact source blobs'),
  toolSchema: z.object({ tool: z.string().trim().min(1).max(200), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  reason: z.string().trim().min(1).max(2000),
  reasonRef: z.string().trim().min(1).max(1000),
}).strict();
export const runtimeConditionBindingInputSchema = z.union([
  servingRuntimeConditionBindingInputSchema, gitFilePublicationBindingSchema,
]);
export type RuntimeConditionBindingInput = z.infer<typeof runtimeConditionBindingInputSchema>;
const provenance = {
  boundBy: z.string().min(1), boundAt: z.string().datetime({ offset: true }),
};
const storedBindingSchema = z.union([
  servingRuntimeConditionBindingInputSchema.extend(provenance).strict(),
  gitFilePublicationBindingSchema.safeExtend(provenance),
]);
export type RuntimeConditionBinding = z.infer<typeof storedBindingSchema>;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const runtimeConditionRebindInputSchema = z.object({
  expectedBindingSha256: sha256,
  binding: servingRuntimeConditionBindingInputSchema,
  approvalRef: z.string().regex(/^thread-post:[1-9][0-9]*$/).optional(),
}).strict();
export type RuntimeConditionRebindInput = z.infer<typeof runtimeConditionRebindInputSchema>;
const transitionReceiptSchema = z.object({
  schemaVersion: z.literal('runtime-binding-transition-v1'),
  workspaceId: z.string().min(1), harness: z.string().min(1), workItemId: z.string().min(1),
  ref: z.string().min(1), custodianId: z.string().min(1),
  sourcePlanSlug: z.string().min(1).nullable(),
  expectedBindingSha256: sha256, expectedBlockersSha256: sha256,
  binding: servingRuntimeConditionBindingInputSchema,
}).strict();
const transitionAuditSchema = z.object({
  receipt: transitionReceiptSchema,
  priorBinding: storedBindingSchema,
  nextBinding: storedBindingSchema,
  approvalRef: z.string().regex(/^thread-post:[1-9][0-9]*$/),
  approvedBy: z.string().min(1), approvedAt: z.string().datetime({ offset: true }),
  appliedBy: z.string().min(1), appliedAt: z.string().datetime({ offset: true }),
}).strict();
export type RuntimeBindingTransitionAudit = z.infer<typeof transitionAuditSchema>;
export function runtimeBindingSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
type RebindItem = Pick<import('./work-items').WorkItem, 'id' | 'harness' | 'state' | 'assignee' | 'payload'> &
  Partial<Pick<import('./work-items').WorkItem, 'createdBy' | 'terminalOwner' | 'sourcePlanSlug'>>;
type BindingApprovalPost = { authorId: string; body: string; createdAt: string };

/** Same authenticated, local, append-only post authority used by acceptance BAR
 * review. A caller supplies a reference, never a reviewer identity or verdict. */
async function readBindingApproval(ref: string, workspaceId: string): Promise<BindingApprovalPost | null> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const [post] = await sql<Array<{ author_id: string | null; body: string; created_at: Date }>>`
    SELECT author_id, body, created_at FROM harness_shared.coord_thread_posts
     WHERE workspace_id = ${workspaceId} AND id = ${ref.slice('thread-post:'.length)}::bigint
       AND origin = 'local' AND octet_length(body) <= 65536`;
  return post?.author_id?.trim()
    ? { authorId: post.author_id, body: post.body, createdAt: new Date(post.created_at).toISOString() } : null;
}

async function independentBindingReviewer(item: RebindItem, prior: RuntimeConditionBinding,
  reviewer: string, workspaceId: string): Promise<boolean> {
  const [{ acceptanceLineageClosure }, { verificationParties }] = await Promise.all([
    import('./acceptance-author-identity'), import('./harness/improvements/agent-review-policy'),
  ]);
  const parties = verificationParties(item);
  if (parties.invalidCorrectionLineage) return false;
  // Plan-bound upgrades use the canonical BAR review population, including the
  // subject owner and rubric author. The plan's stored pin selects the screen.
  if (item.sourcePlanSlug) {
    const [{ getOrgPg }, { resolveAcceptanceBarApproverScreen }] = await Promise.all([
      import('@papercusp/db-org'), import('./rubrics'),
    ]);
    const { sql } = getOrgPg();
    const [plan] = await sql<Array<{ acceptance_bar_rubric_slug: string | null }>>`
      SELECT acceptance_bar_rubric_slug FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${item.harness}
         AND plan_slug = ${item.sourcePlanSlug}`;
    if (!plan?.acceptance_bar_rubric_slug) return false;
    const screen = await resolveAcceptanceBarApproverScreen({ rubricId: plan.acceptance_bar_rubric_slug,
      applierId: item.assignee ?? undefined });
    if (screen.subjectPlan !== item.sourcePlanSlug || !(await screen.check(reviewer)).eligible) return false;
  }
  const lineage = await acceptanceLineageClosure(reviewer, { workspaceId });
  return ![item.assignee, prior.boundBy, ...parties.reporters, ...parties.implementers]
    .some(id => id === reviewer || (id && lineage.has(id)));
}

/** Preview/apply an exact reviewed pin upgrade through the existing payload CAS.
 * No condition is evaluated here, and no lifecycle or custody field is changed. */
export async function prepareReviewedRuntimeBlockerBinding(
  item: RebindItem, ref: string, input: unknown, actor: { ownerId: string; workspaceId: string },
  deps: {
    readApproval?: typeof readBindingApproval;
    independent?: typeof independentBindingReviewer;
    now?: () => string;
  } = {},
) {
  const refuse = (error: string) => ({ ok: false as const, code: 'runtime_binding_invalid', error });
  if (!actor.workspaceId || !item.harness || !actor.ownerId || item.assignee !== actor.ownerId ||
      ['done', 'resolved', 'closed', 'passed', 'dropped', 'deprecated', 'failed', 'cancelled'].includes(item.state))
    return refuse('Only the current custodian of a non-terminal, scoped item may upgrade its binding.');
  const parsed = runtimeConditionRebindInputSchema.safeParse(input);
  if (!parsed.success) return refuse('Supply exact old-binding hash and strict serving-runtime pins; approvalRef is only for apply.');
  const request = parsed.data;
  const raw = (item.payload as { externalBlockers?: unknown } | null)?.externalBlockers;
  if (!Array.isArray(raw)) return refuse('Stored blocker history is unreadable.');
  const matches = raw.map((row, index) => ({ row, index })).filter(({ row }) => row?.ref === ref && row?.status === 'active');
  if (matches.length !== 1 || matches[0].row.kind !== 'runtime' ||
      !readExternalBlockers(item.payload).some(row => row.ref === ref && row.status === 'active'))
    return refuse('Name exactly one valid active runtime blocker.');
  const { row, index } = matches[0];
  const current = storedBindingSchema.safeParse(row.runtimeConditionBinding);
  const history = z.array(transitionAuditSchema).max(128).safeParse(row.runtimeConditionBindingTransitions === undefined
    ? [] : row.runtimeConditionBindingTransitions);
  if (!current.success || 'kind' in current.data || !history.success)
    return refuse('Only a readable serving-runtime binding with intact audit history may be upgraded.');
  const prior = current.data;
  const scope = { workspaceId: actor.workspaceId, harness: item.harness, workItemId: item.id, ref,
    custodianId: actor.ownerId, sourcePlanSlug: item.sourcePlanSlug ?? null };
  // A successful retry observes the exact resulting binding and retained receipt;
  // it does not append a second audit entry or authenticate a different effect.
  const last = history.data.at(-1);
  if (last && request.approvalRef === last.approvalRef &&
      isDeepStrictEqual(last.nextBinding, prior) &&
      isDeepStrictEqual(last.receipt, { ...scope, schemaVersion: 'runtime-binding-transition-v1',
        expectedBindingSha256: request.expectedBindingSha256,
        expectedBlockersSha256: last.receipt.expectedBlockersSha256, binding: request.binding }))
    return { ok: true as const, changed: false as const, replayed: true as const };
  if (runtimeBindingSha256(prior) !== request.expectedBindingSha256)
    return refuse('Stored binding changed; read it and obtain a fresh exact review.');
  const next = request.binding;
  if (next.host !== prior.host || next.toolSchema.tool !== prior.toolSchema.tool ||
      !isDeepStrictEqual(Object.keys(next.sourceBlobs).sort(), Object.keys(prior.sourceBlobs).sort()))
    return refuse('A pin upgrade must preserve the original host, public tool and source path set.');
  if (isDeepStrictEqual(next.sourceBlobs, prior.sourceBlobs) && next.toolSchema.sha256 === prior.toolSchema.sha256)
    return refuse('A reviewed upgrade must change exact source/schema pins.');
  if (history.data.length === 128) return refuse('Binding audit history is full; never discard prior reviews.');
  const receipt = transitionReceiptSchema.parse({ schemaVersion: 'runtime-binding-transition-v1', ...scope,
    expectedBindingSha256: request.expectedBindingSha256, expectedBlockersSha256: runtimeBindingSha256(raw), binding: next });
  if (!request.approvalRef) return { ok: true as const, changed: false as const, preview: receipt };
  try {
    const post = await (deps.readApproval ?? readBindingApproval)(request.approvalRef, actor.workspaceId);
    if (!post) return refuse('Approval must be an authenticated workspace-local reviewer post.');
    // Exactly one JSON value: prose, multiple receipts and caller-authored signer
    // fields cannot silently select a different approved effect.
    const approved = transitionReceiptSchema.safeParse(JSON.parse(post.body));
    if (!approved.success || !isDeepStrictEqual(approved.data, receipt))
      return refuse('Reviewer receipt does not approve this exact custody, history and binding transition.');
    if (!await (deps.independent ?? independentBindingReviewer)(item, prior, post.authorId, actor.workspaceId))
      return refuse('The approving author must be independent of this binding and its implementation lineage.');
    const now = (deps.now ?? (() => new Date().toISOString()))();
    const nextBinding = { ...next, boundBy: actor.ownerId, boundAt: now };
    const audit = transitionAuditSchema.parse({ receipt, priorBinding: prior, nextBinding,
      approvalRef: request.approvalRef, approvedBy: post.authorId, approvedAt: post.createdAt,
      appliedBy: actor.ownerId, appliedAt: now });
    const blockers = [...raw];
    blockers[index] = { ...row, runtimeConditionBinding: nextBinding,
      runtimeConditionBindingTransitions: [...history.data, audit] };
    return { ok: true as const, changed: true as const, blockers, audit };
  } catch { return refuse('Authenticated review or implementation-lineage evidence is unreadable; no binding was changed.'); }
}

/** Metadata compatibility only: the custodian declares what the old alias meant.
 * This does not measure recovery, change the original ref/status, or release custody.
 * The writer fences custody and the original blocker array in the same payload CAS. */
export function prepareRuntimeBlockerBinding(
  item: { state: string; assignee: string | null; payload: unknown },
  ref: string, input: unknown, actor: string, now = new Date().toISOString(),
): { ok: true; changed: boolean; blockers: ExternalBlockerRecord[] } | { ok: false; code: string; error: string } {
  const refuse = (error: string) => ({ ok: false as const, code: 'runtime_binding_invalid', error });
  if (item.assignee !== actor || !actor ||
      ['done', 'resolved', 'closed', 'passed', 'dropped', 'deprecated', 'failed', 'cancelled'].includes(item.state)) {
    return refuse('Only the current custodian of a non-terminal item may bind its runtime condition.');
  }
  const parsed = runtimeConditionBindingInputSchema.safeParse(input);
  if (!parsed.success) return refuse('Supply a strict source/schema or git-file-publication binding with reason and reasonRef.');
  if ('kind' in parsed.data && parsed.data.kind === 'git-file-publication' &&
      ref !== `git-sync:file-acceptance:${parsed.data.filePath}`) {
    return refuse('Publication proof must name the exact original file-acceptance alias.');
  }
  const blockers = readExternalBlockers(item.payload);
  const matches = blockers.map((row, index) => ({ row, index }))
    .filter(({ row }) => row.ref === ref && row.status === 'active');
  if (matches.length !== 1 || matches[0].row.kind !== 'runtime') return refuse('Name exactly one active runtime blocker.');
  const { row, index } = matches[0];
  if (row.runtimeConditionBinding !== undefined) {
    const stored = storedBindingSchema.safeParse(row.runtimeConditionBinding);
    if (!stored.success) return refuse('Stored runtime binding is unreadable; do not overwrite it.');
    const { boundBy: _actor, boundAt: _time, ...prior } = stored.data;
    return isDeepStrictEqual(prior, parsed.data) ? { ok: true, changed: false, blockers }
      : refuse('A runtime condition is already bound; replacing it requires a separate reviewed transition.');
  }
  blockers[index] = { ...row, runtimeConditionBinding: { ...parsed.data, boundBy: actor, boundAt: now } };
  return { ok: true, changed: true, blockers };
}

/** Fingerprint the actual loaded public argument schema, never a checkout file. */
export async function readRuntimeToolSchemaIdentity(toolName: string) {
  const { listAllProjectedTools } = await import('@papercusp/tooldef');
  const tool = listAllProjectedTools().find(entry => entry.expose.mcp?.name === toolName);
  if (!tool?.inputSchema) return null;
  return { tool: toolName, sha256: createHash('sha256').update(canonicalJson(tool.inputSchema)).digest('hex') };
}

export async function readRuntimeBlockerCondition(blocker: { kind: string; ref: string; runtimeConditionBinding?: unknown }, root?: string | null):
Promise<BlockerEvidenceMeasurement> {
  const unknown = (detail: string): BlockerEvidenceMeasurement => ({ status: 'unknown', detail });
  if (blocker.kind !== 'runtime') return unknown('canonical runtime blocker is required');
  const parsed = storedBindingSchema.safeParse(blocker.runtimeConditionBinding);
  if (!parsed.success) return unknown('runtime alias needs an audited source/schema binding before resolution');
  const binding = parsed.data;
  // Only the publication variant carries `kind` (the serving schema is strict), so the
  // `in` test alone is exact. TS does not narrow the false branch of
  // `'kind' in b && b.kind === …`, which left the serving fields below typed as the union.
  if ('kind' in binding) {
    if (blocker.ref !== `git-sync:file-acceptance:${binding.filePath}`) return unknown('publication binding does not match its original alias');
    return readGitFilePublicationCondition(binding, root);
  }
  try {
    const [{ getServingHostIdentity }, { runtimeObservabilityHealth }] = await Promise.all([
      import('./serving-host-identity'), import('./observability/runtime'),
    ]);
    const host = getServingHostIdentity();
    const artifact = runtimeObservabilityHealth().artifact;
    if (host.host !== binding.host || !host.processId || !host.buildSha || artifact?.status !== 'measured' ||
        !artifact.sourceSha.startsWith(host.buildSha) || !/^[a-f0-9]{64}$/.test(artifact.bundleSha256) ||
        !/^[a-f0-9]{64}$/.test(artifact.manifestSha256)) return unknown('named serving process has no bound boot artifact measurement');
    const schema = await readRuntimeToolSchemaIdentity(binding.toolSchema.tool);
    if (!schema) return unknown('loaded public tool schema is unavailable');
    const paths = Object.keys(binding.sourceBlobs);
    if (paths.some(path => !artifact.sourceBlobs[path])) return unknown('boot artifact omits required source containment');
    const satisfied = paths.every(path => artifact.sourceBlobs[path] === binding.sourceBlobs[path]) &&
      schema.sha256 === binding.toolSchema.sha256;
    return { status: 'available', condition: satisfied ? 'satisfied' : 'pending', reachable: true,
      responsibleParty: `runtime:${binding.host}` };
  } catch { return unknown('runtime artifact/schema evidence reader failed'); }
}
