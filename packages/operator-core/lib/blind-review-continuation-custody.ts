/** D-001: one immutable logical binding, append-only native continuation custody.
 * These functions use the supplied transaction, never a same-owner latest row. */
import { isDeepStrictEqual as equal } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { acquirePlanAdvisoryLock, planAdvisoryLockKey } from './agent-tools/plans/plan-lock-key';
import { BLIND_GAP_REVIEW_ACTOR, inspectBlindReviewAdvProfile, verifyBlindReviewRecoveryPort,
  type BlindReviewSessionBinding as Binding, type BlindReviewResumePermit } from './blind-review-session-bindings';
import { isBlindReviewerBackendAgent } from './blind-reviewer-backends';
import { runtimeLifecycleLockKey, RUNTIME_RESOURCE_KINDS,
  type RuntimeLease, type RuntimeResourceIntent } from './blind-review-runtime-custody';
import type { RuntimeNamespaceBackend } from './blind-review-runtime-lifecycle';
import type { SessionPortRow } from './session-port/store';
import { findLiveHostAsync } from './events/await/psu-pty-discovery';
import { nativeSessionIdFromHost } from './agent-launch-core';
import { readProcessCgroupPath } from './task-manager/cgroup-read';
import { taskIdFromScopeUnit } from './task-manager/types';
import { readProcessIdentity } from './process-identity';
import type { RequestOriginMetadata } from '@papercusp/agent-mcp';
import { z } from 'zod';
import { retainRequestPrincipal, type HostRequestPrincipalResolver } from './auth/require-principal';
import { coveringDelegations } from './governance-policy/authority';
import { lockPolicyChainForWorkspace } from './governance-policy/store';
import { chainRevision } from './governance-policy/control';
import { acceptanceLineageClosure, areAcceptanceLineageRelated, isAcceptanceAuthorIdentity,
  resolvePlanImplementerIdentities } from './acceptance-author-identity';
import { decideSensitiveAction, getSensitiveAction, SensitiveActionError, sensitivePayloadHash,
  executeSensitiveActionInTransaction, LEGACY_ADOPTION_ACTION,
  type SensitiveActionRequest } from './governance-policy/sensitive-action';
export { LEGACY_ADOPTION_ACTION } from './governance-policy/sensitive-action';

type Sql = ReturnType<typeof getOrgPg>['sql'];
type Native = Parameters<typeof verifyBlindReviewRecoveryPort>[0]['target'] & { resume_claim_key: string | null };
export type BlindReviewEndpoint = { advSessionId: number; nativeSessionId: string;
  modelSpec: string | null; continuationId: number | null; requiresNativeProof?: true };
type Snapshot = { activation: number; owner: string; planHash: string; confinement: Binding['confinementSnapshot'];
  source: BlindReviewEndpoint; target: Omit<BlindReviewEndpoint, 'continuationId'>; backend: string;
  bootstrapHash: string; hashes: { source: string; normalized: string; rendered: string; token: string } };
type Entry = { id: number | string; workspace_id: string; binding_id: number | string;
  reservation_id: number | string | null; event_kind: 'reserved' | 'transferred'; resume_lease_id: string;
  source_adv_session_id: number | string; target_adv_session_id: number | string; port_id: string;
  snapshot: Snapshot; evidence: Record<string, unknown>; created_at: Date | string };
type NativeSnapshot = Pick<Snapshot, 'activation' | 'owner' | 'planHash' | 'confinement' | 'source' | 'backend'> & {
  actor: string; requestHash: string; profile: { spec: unknown; argv: unknown };
  managedSuccession?: { request: ManagedSuccessionRequest; hostIdentity: string; authority: unknown };
};
type NativeEntry = Omit<Entry, 'event_kind' | 'snapshot' | 'port_id'> & {
  event_kind: 'native-reserved' | 'native-admitted' | 'native-settled'; attempt_key: string;
  snapshot: NativeSnapshot; port_id: null;
};
type CustodyEntry = Entry | NativeEntry;
const refuse = (code: string): never => { throw new Error(code); };
function requestHash(request: Record<string, unknown>): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v)
      .filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, canonical(value)])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex');
}

/** D011: these are immutable approval pins, never a launch/admission capability.
 * Only the authenticated HTTP adapter may prepare their measured server snapshot. */
const legacyText = z.string().min(1).max(200);
const legacyHash = z.string().regex(/^[a-f0-9]{64}$/);
const legacyEndpoint = z.object({ advSessionId: z.number().int().positive(), nativeSessionId: legacyText }).strict();
const legacyAuth = z.object({ kind: z.literal('user'), slug: legacyText, workspaceId: legacyText,
  trust: z.literal('verified'), authMethod: z.literal('cookie-session') }).strict();
const legacyApproval = z.object({ schema: z.literal('blind-review-legacy-adoption-approval/v1'),
  humanReason: z.string().trim().min(1).max(4000), requestPayloadHash: legacyHash, auth: legacyAuth }).strict();
const retainedLegacyHumans = new WeakSet<HostRequestPrincipalResolver>();
export const legacyAdoptionPayloadSchema = z.object({
  schema: z.literal('blind-review-legacy-adoption/v1'), attemptKey: z.string().uuid(),
  bootstrapKey: z.string().uuid(), operationDigest: legacyHash, workspaceId: legacyText,
  harnessSlug: legacyText, planSlug: legacyText, planRevision: z.number().int().positive(), planHash: legacyHash,
  activationAuditSeq: z.number().int().positive(), bindingId: z.number().int().positive(), reviewerOwnerId: legacyText,
  original: legacyEndpoint,
  observed: legacyEndpoint.extend({ startedAt: z.string().datetime(), endedAt: z.string().datetime(),
    lifetimeEvidenceHash: legacyHash }).strict(),
  target: legacyEndpoint, bindingHistoryHash: legacyHash, outstandingEffectsHash: legacyHash,
  independenceEvidenceHash: legacyHash, confinementHash: legacyHash, profileHash: legacyHash,
  launchParentOwner: z.literal(BLIND_GAP_REVIEW_ACTOR), accountRoute: z.literal('auto'),
  backend: z.enum(['claude', 'codex', 'omp']), modelSpec: legacyText.nullable(),
  activation: z.object({ specificationRevision: legacyText, stateRevision: legacyText }).strict(),
  qualification: z.object({ apiManifestHash: legacyHash, launcherManifestHash: legacyHash,
    plannedHostManifestHash: legacyHash, executedInputsHash: legacyHash, dependencyManifestHash: legacyHash }).strict(),
  policy: z.object({ targetLayerId: legacyText, authorityLayerId: legacyText,
    baseVersion: z.number().int().positive(), chainRevision: z.string().min(1).max(4000) }).strict(),
  preparedPrincipal: legacyText, authorizedExecutor: z.string().regex(/^user:\S+$/),
  bootstrapPiSessionId: legacyText, bootstrapExpiresAt: z.string().datetime(),
  revocation: z.literal('permanent-root-cutoff-no-reopen'),
}).strict();
export type LegacyAdoptionPayload = z.infer<typeof legacyAdoptionPayloadSchema>;

/** Validate the stored discriminator AND its envelope; generic policy apply must
 * never reinterpret a different action or a caller-supplied payload as adoption. */
export function validateLegacyAdoptionRequest(request: SensitiveActionRequest): LegacyAdoptionPayload {
  const parsed = legacyAdoptionPayloadSchema.safeParse(request.payload);
  if (request.actionKind !== LEGACY_ADOPTION_ACTION || !parsed.success)
    throw new SensitiveActionError('invalid', 'not an exact legacy adoption request');
  const p = parsed.data;
  if (request.workspaceId !== p.workspaceId || request.preparedBy !== p.preparedPrincipal ||
      request.targetLayerId !== p.policy.targetLayerId || request.authorityLayerId !== p.policy.authorityLayerId ||
      request.targetLayerId !== request.authorityLayerId || request.baseVersion !== p.policy.baseVersion ||
      request.chainRevision !== p.policy.chainRevision || request.payloadHash !== sensitivePayloadHash(p) ||
      p.preparedPrincipal === p.authorizedExecutor || p.original.advSessionId !== p.observed.advSessionId ||
      p.original.advSessionId !== p.target.advSessionId || p.target.nativeSessionId === p.original.nativeSessionId ||
      p.target.nativeSessionId === p.observed.nativeSessionId ||
      Date.parse(p.observed.startedAt) > Date.parse(p.observed.endedAt))
    throw new SensitiveActionError('payload-mismatch', 'legacy adoption envelope or immutable tuple mismatch');
  return p;
}

/** Retain ACTUAL request credentials. This function accepts Headers, never a
 * serialized Principal, actor label, approval envelope or role assertion. */
export async function retainLegacyAdoptionHuman(headers: Headers, workspaceId: string): Promise<HostRequestPrincipalResolver> {
  if (!(headers instanceof Headers)) throw new SensitiveActionError('forbidden', 'authenticated request headers required');
  const retained = await retainRequestPrincipal(headers, workspaceId);
  const principal = retained && await retained();
  if (!principal || principal.kind !== 'user' || principal.workspaceId !== workspaceId ||
      principal.trust !== 'verified' || principal.authMethod !== 'cookie-session')
    throw new SensitiveActionError('forbidden', 'legacy adoption requires a verified workspace cookie session');
  retainedLegacyHumans.add(retained!);
  return retained!;
}

/** Existing HTTP decide dispatch calls this only after reading stored actionKind.
 * The caller supplies the human reason/decision; provenance comes from transport. */
export async function decideLegacyAdoption(input: {
  workspaceId: string; requestId: string; decision: 'approve' | 'deny'; reason: string;
}, headers: Headers, deps: { sql?: Sql } = {}) {
  input = z.object({ workspaceId: legacyText, requestId: legacyText, decision: z.enum(['approve', 'deny']),
    reason: z.string().trim().min(1).max(4000) }).strict().parse(input);
  const resolve = await retainLegacyAdoptionHuman(headers, input.workspaceId);
  const sql = deps.sql ?? getOrgPg().sql;
  const request = await getSensitiveAction(input.requestId, sql);
  if (!request || request.workspaceId !== input.workspaceId)
    throw new SensitiveActionError('not-found', 'legacy adoption request not found in this workspace');
  validateLegacyAdoptionRequest(request);
  const principal = await resolve();
  if (!principal) throw new SensitiveActionError('forbidden', 'decision session no longer valid');
  return decideSensitiveAction({ requestId: request.requestId, approver: 'user:' + principal.slug,
    decision: input.decision, reason: input.reason }, sql, resolve);
}

/** The policy/provenance part of reserve/admit/settle, INSIDE the existing
 * custody transaction after request/approval locks and before custody/native locks.
 * This does not prove independence, measured pins, source qualification or host
 * admission; those remain mandatory at the caller's effect boundary. */
export async function lockLegacyAdoptionAuthorization(tx: Sql, request: SensitiveActionRequest,
  resolve: HostRequestPrincipalResolver, recovery = false): Promise<LegacyAdoptionPayload> {
  if (typeof (tx as unknown as { savepoint?: unknown }).savepoint !== 'function')
    throw new SensitiveActionError('invalid', 'legacy adoption authorization requires an existing transaction');
  const p = validateLegacyAdoptionRequest(request);
  if (typeof resolve !== 'function' || !retainedLegacyHumans.has(resolve))
    throw new SensitiveActionError('forbidden', 'retained request capability required');
  const principal = await resolve();
  if (!principal || principal.kind !== 'user' || principal.trust !== 'verified' ||
      principal.authMethod !== 'cookie-session' || principal.workspaceId !== p.workspaceId ||
      'user:' + principal.slug !== p.authorizedExecutor)
    throw new SensitiveActionError('forbidden', 'executing cookie session is no longer the approved human');
  const approvers = new Set<string>();
  for (const approval of request.approvals) {
    let evidence: z.infer<typeof legacyApproval>;
    try { evidence = legacyApproval.parse(JSON.parse(approval.reason)); }
    catch { throw new SensitiveActionError('forbidden', 'approval lacks authenticated adoption provenance'); }
    if (approval.decision !== 'approve' || approval.approver !== 'user:' + evidence.auth.slug ||
        evidence.auth.workspaceId !== p.workspaceId || evidence.requestPayloadHash !== request.payloadHash ||
        approval.approver === request.preparedBy || approvers.has(approval.approver))
      throw new SensitiveActionError('forbidden', 'approval provenance does not match this request');
    approvers.add(approval.approver);
  }
  if (!(request.status === 'approved' || recovery && request.status === 'executed') ||
      approvers.size < request.requiredApprovals || request.requiredApprovals < 1)
    throw new SensitiveActionError('not-approved', 'distinct authenticated approvals required');
  const load = await lockPolicyChainForWorkspace(p.workspaceId, tx);
  if (load.status !== 'ok') throw new SensitiveActionError('stale', 'workspace policy chain unavailable');
  const leaf = load.chain.at(-1)!;
  if (leaf.layerId !== p.policy.targetLayerId || leaf.scopeRef !== p.workspaceId ||
      leaf.version !== p.policy.baseVersion || chainRevision(load.chain) !== p.policy.chainRevision)
    throw new SensitiveActionError('stale', 'workspace policy chain changed after preparation');
  const grants = await coveringDelegations([p.preparedPrincipal, p.authorizedExecutor, ...approvers],
    p.policy.authorityLayerId, { sql: tx, lock: 'share' });
  const allows = (id: string, capability: 'prepare' | 'approve') => grants.some(g =>
    g.principal === id && g.capabilities.includes(capability));
  if (!allows(p.preparedPrincipal, 'prepare') || !allows(p.authorizedExecutor, 'prepare') ||
      [...approvers].some(id => !allows(id, 'approve')))
    throw new SensitiveActionError('forbidden', 'live preparation, execution and approval delegations required');
  // Re-resolve after ALL policy/delegation waits; a revoked cookie cannot ride a
  // once-valid pre-lock principal through to the custody effect.
  const current = await resolve();
  if (!current || current.slug !== principal.slug || current.workspaceId !== principal.workspaceId ||
      current.kind !== principal.kind || current.trust !== principal.trust || current.authMethod !== principal.authMethod)
    throw new SensitiveActionError('forbidden', 'executing cookie session changed during authorization');
  return p;
}

/** Host-local producer, never a body/simulation supplied by the caller. Missing
 * canonical identity, effect-census or qualification producers refuse by default.
 * Private fixtures may supply a producer; that is not source qualification. */
export type LegacyAdoptionEvidence = { bindingHistory: unknown; outstandingEffects: unknown;
  independence: unknown; qualification: LegacyAdoptionPayload['qualification'] };

/** Canonical ledger census, not physical absence or source qualification. Read
 * under the caller's custody transaction. Keep original NULL request metadata
 * and old elections verbatim; an empty owner/task filter is not an effect oracle.
 * JSONB projections retain timestamp values in the approval hash (Date objects
 * would otherwise have no enumerable fields in sensitivePayloadHash).
 */
export async function readLegacyAdoptionHistoryAndEffects(tx: Sql, payload: LegacyAdoptionPayload) {
  if (typeof (tx as unknown as { savepoint?: unknown }).savepoint !== 'function')
    throw new SensitiveActionError('invalid', 'history/effects evidence requires the custody transaction');
  const p = legacyAdoptionPayloadSchema.parse(payload);
  type Row = Record<string, unknown>;
  const bounded = (name: string, rows: Array<{ row: Row }>) => {
    if (rows.length > 128 || Buffer.byteLength(JSON.stringify(rows)) > 2 * 1024 * 1024)
      throw new SensitiveActionError('forbidden', name + ' census incomplete');
    return rows.map(r => r.row);
  };
  const bindings = bounded('binding history', await tx<Array<{ row: Row }>>`
    SELECT to_jsonb(b) AS row FROM harness_shared.plan_blind_review_sessions b
    WHERE b.workspace_id = ${p.workspaceId} AND
      ((b.harness_slug = ${p.harnessSlug} AND b.plan_slug = ${p.planSlug}) OR b.replacement_of IN
        (SELECT id FROM harness_shared.plan_blind_review_sessions WHERE workspace_id = ${p.workspaceId}
          AND harness_slug = ${p.harnessSlug} AND plan_slug = ${p.planSlug})) ORDER BY b.id LIMIT 129`);
  const original = bindings.find(b => Number(b.id) === p.bindingId);
  if (!original || original.harness_slug !== p.harnessSlug || original.plan_slug !== p.planSlug ||
      Number(original.activation_audit_seq) !== p.activationAuditSeq || original.replacement_of !== null ||
      original.attempt_seq !== 0 || original.reviewer_owner_id !== p.reviewerOwnerId ||
      Number(original.adv_session_id) !== p.original.advSessionId || original.native_session_id !== p.original.nativeSessionId)
    throw new SensitiveActionError('stale', 'original binding/election changed');
  if (bindings.some(b => b.harness_slug !== p.harnessSlug || b.plan_slug !== p.planSlug))
    throw new SensitiveActionError('forbidden', 'foreign replacement history');
  const audits = bounded('activation history', await tx<Array<{ row: Row }>>`
    SELECT to_jsonb(a) AS row FROM harness_shared.plan_audits a WHERE workspace_id = ${p.workspaceId}
      AND harness_slug = ${p.harnessSlug} AND plan_slug = ${p.planSlug} AND audit_kind = 'activation'
    ORDER BY audit_seq LIMIT 129`);
  const activation = audits.find(a => Number(a.audit_seq) === p.activationAuditSeq);
  if (!activation || Number(activation.audited_plan_revision_seq) !== p.planRevision ||
      activation.audited_plan_content_hash !== p.planHash || audits.at(-1) !== activation)
    throw new SensitiveActionError('stale', 'canonical activation election changed');
  const reviews = bounded('review history', await tx<Array<{ row: Row }>>`
    SELECT to_jsonb(r) AS row FROM harness_shared.plan_blind_reviews r WHERE workspace_id = ${p.workspaceId}
      AND plan_slug = ${p.planSlug} ORDER BY id LIMIT 129`);
  const bindingIds = bindings.map(b => Number(b.id));
  const owners = [...new Set(bindings.flatMap(b => typeof b.reviewer_owner_id === 'string' ? [b.reviewer_owner_id] : []))];
  const advIds = [...new Set(bindings.flatMap(b => b.adv_session_id === null ? [] : [Number(b.adv_session_id)]))];
  const natives = [...new Set([p.observed.nativeSessionId, ...bindings.flatMap(b =>
    typeof b.native_session_id === 'string' ? [b.native_session_id] : [])])];
  const custody = bounded('continuation effects', await tx<Array<{ row: Row }>>`
    SELECT to_jsonb(c) AS row FROM harness_shared.blind_review_continuation_custody c
    WHERE workspace_id = ${p.workspaceId} AND binding_id = ANY(${tx.array(bindingIds)}::bigint[]) ORDER BY id LIMIT 129`);
  const leases = bounded('runtime leases', await tx<Array<{ row: Row }>>`
    SELECT to_jsonb(l) AS row FROM harness_shared.blind_review_runtime_leases l
    WHERE workspace_id = ${p.workspaceId} AND binding_id = ANY(${tx.array(bindingIds)}::bigint[]) ORDER BY id LIMIT 129`);
  const leaseIds = leases.map(l => String(l.id));
  const admissions = bounded('runtime admissions', await tx<Array<{ row: Row }>>`
    SELECT to_jsonb(a) AS row FROM harness_shared.blind_review_runtime_admissions a
    WHERE workspace_id = ${p.workspaceId} AND lease_id::text = ANY(${tx.array(leaseIds)}) ORDER BY id LIMIT 129`);
  const resources = bounded('runtime resources', await tx<Array<{ row: Row }>>`
    SELECT to_jsonb(r) AS row FROM harness_shared.blind_review_runtime_resources r
    WHERE workspace_id = ${p.workspaceId} AND lease_id::text = ANY(${tx.array(leaseIds)}) ORDER BY id LIMIT 129`);
  const nativeRows = bounded('native lifetimes', await tx<Array<{ row: Row }>>`
    SELECT jsonb_build_object('id', id, 'owner', coord_owner_id, 'native', session_id, 'backend', agent,
      'startedAt', started_at, 'endedAt', ended_at, 'resumeClaim', resume_claim_key,
      'portId', port_id, 'portStatus', port_status) AS row FROM harness_shared.adv_sessions
    WHERE workspace_id = ${p.workspaceId} AND (id = ANY(${tx.array(advIds)}::bigint[]) OR
      coord_owner_id = ANY(${tx.array(owners)}) OR session_id = ANY(${tx.array(natives)})) ORDER BY id LIMIT 129`);
  const allAdvIds = nativeRows.map(n => Number(n.id));
  const ports = bounded('port effects', await tx<Array<{ row: Row }>>`
    SELECT to_jsonb(s) AS row FROM harness_shared.session_ports s WHERE workspace_id = ${p.workspaceId}
      AND (source_adv_session_id = ANY(${tx.array(allAdvIds)}::bigint[]) OR target_adv_session_id = ANY(${tx.array(allAdvIds)}::bigint[]))
    ORDER BY id LIMIT 129`);
  const launchKeys = bindings.flatMap(b => typeof b.launch_key === 'string' ? [b.launch_key] : []);
  launchKeys.push('bootstrap-su:' + p.bootstrapKey);
  // Include historical owner occurrences in every maintained launch-summary
  // shape, plus unassigned recruiter attempts overlapping the observed lifetime.
  const launches = bounded('launch effects', await tx<Array<{ row: Row }>>`
    SELECT to_jsonb(l) AS row FROM harness_shared.agent_launch_idempotency l WHERE workspace_id = ${p.workspaceId}
      AND (idempotency_key = ANY(${tx.array(launchKeys)}) OR launched_by = ANY(${tx.array(owners)}) OR
        EXISTS (SELECT 1 FROM unnest(${tx.array(owners)}::text[]) AS o(owner)
          WHERE jsonb_path_exists(l.summary, '$.**.ownerId ? (@ == $owner)', jsonb_build_object('owner', o.owner))
            OR l.summary->'ownerIds' ? o.owner) OR
        (launched_by = ${BLIND_GAP_REVIEW_ACTOR} AND launched_at BETWEEN
          extract(epoch FROM ${p.observed.startedAt}::timestamptz) * 1000 AND
          extract(epoch FROM ${p.observed.endedAt}::timestamptz) * 1000)) ORDER BY idempotency_key LIMIT 129`);
  const taskIds = new Set<string>(), pids = new Set<number>();
  let visited = 0;
  const handles = (value: unknown, depth = 0): void => {
    if (++visited > 16384 || depth > 64) throw new SensitiveActionError('forbidden', 'launch handle census incomplete');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'taskId' && typeof child === 'string') taskIds.add(child);
      if (['pid', 'terminalPid'].includes(key) && Number.isSafeInteger(child) && Number(child) > 0) pids.add(Number(child));
      handles(child, depth + 1);
    }
  };
  for (const launch of launches) handles(launch.summary);
  for (const resource of resources) handles(resource.identity);
  const tasks = bounded('task effects', await tx<Array<{ row: Row }>>`
    WITH RECURSIVE candidates AS (
      SELECT t.* FROM harness_shared.task_ledger t WHERE workspace_id = ${p.workspaceId} AND
        (task_id = ANY(${tx.array([...taskIds])}) OR pid = ANY(${tx.array([...pids])}::integer[]) OR
          launched_by = ANY(${tx.array(owners)}) OR session_id = ANY(${tx.array([...natives, ...owners])}) OR
          detail->>'coordOwnerId' = ANY(${tx.array(owners)}) OR detail->>'advSessionId' = ANY(${tx.array(allAdvIds.map(String))}) OR
          plan_slug = ${p.planSlug} OR (started_at <= ${p.observed.endedAt}::timestamptz AND
            (ended_at IS NULL OR ended_at >= ${p.observed.startedAt}::timestamptz) AND
            (class IN ('agent-session', 'pty') OR launched_by IN (${BLIND_GAP_REVIEW_ACTOR}, 'system:blind-review-runtime-broker'))))
      UNION
      SELECT child.* FROM harness_shared.task_ledger child JOIN candidates parent ON
        child.parent_task_id = parent.task_id OR child.root_task_id = parent.task_id
      WHERE child.workspace_id = ${p.workspaceId}
    ) SELECT to_jsonb(c) AS row FROM candidates c ORDER BY task_id LIMIT 129`);
  const unresolved: string[] = [];
  if (original.review_id !== null || reviews.some(r => Number(r.activation_audit_seq) === p.activationAuditSeq)) unresolved.push('current-review');
  if (bindings.some(b => Number(b.id) !== p.bindingId && Number(b.activation_audit_seq) === p.activationAuditSeq && b.status !== 'failed'))
    unresolved.push('competing-election');
  if (custody.length) unresolved.push('prior-continuation-effects');
  if (nativeRows.some(n => n.endedAt === null || n.resumeClaim !== null)) unresolved.push('native-lifetime-or-resume');
  if (ports.some(s => !['failed', 'expired', 'cancelled'].includes(String(s.status)))) unresolved.push('port-effects');
  if (leases.some(l => l.state !== 'released')) unresolved.push('runtime-effects');
  if (launches.some(l => (l.summary as Row | null)?.launchState !== 'completed')) unresolved.push('launch-outcome');
  if (tasks.some(t => !['exited', 'killed', 'timed_out', 'ended_unobserved'].includes(String(t.state)) || t.ended_at === null))
    unresolved.push('task-outcome');
  return {
    bindingHistory: { schema: 'blind-review-legacy-history/v1' as const, workspaceId: p.workspaceId,
      harnessSlug: p.harnessSlug, planSlug: p.planSlug, bindings, audits, reviews },
    outstandingEffects: { schema: 'blind-review-legacy-effects/v1' as const,
      custody, leases, admissions, resources, natives: nativeRows, ports, launches, tasks, unresolved,
      // A released row or empty candidate population cannot attest physical
      // absence. Aggregate admission still needs independent kernel/creator
      // census and measured source/dependency qualification at each boundary.
      physicalQualification: 'required' as const },
  };
}

/** Physical absence of recorded runtime leases only, not unrecorded processes
 * or executed source. The caller owns the custody transaction: no new pool
 * connection or nested begin. These nonblocking xact locks conflict with the
 * maintained creator's session locks and last until outer commit/rollback.
 */
export async function readLegacyAdoptionRuntimeAbsence(tx: Sql, payload: LegacyAdoptionPayload,
  deps: { backend?: Pick<RuntimeNamespaceBackend, 'inspect'> } = {}) {
  if (typeof (tx as unknown as { savepoint?: unknown }).savepoint !== 'function')
    throw new SensitiveActionError('invalid', 'runtime absence requires the custody transaction');
  const p = legacyAdoptionPayloadSchema.parse(payload);
  const leases = await tx<RuntimeLease[]>`SELECT l.* FROM harness_shared.blind_review_runtime_leases l
    JOIN harness_shared.plan_blind_review_sessions b ON b.workspace_id = l.workspace_id AND b.id = l.binding_id
    WHERE b.workspace_id = ${p.workspaceId} AND b.harness_slug = ${p.harnessSlug} AND b.plan_slug = ${p.planSlug}
    ORDER BY l.id LIMIT 129`;
  if (leases.length > 128 || Buffer.byteLength(JSON.stringify(leases)) > 2 * 1024 * 1024)
    throw new SensitiveActionError('forbidden', 'runtime lease census incomplete');
  // Fence EVERY creator before inspecting. Waiting here could deadlock with a
  // creator needing the custody/policy locks already held by this transaction.
  for (const lease of leases) {
    const [lock] = await tx<Array<{ held: boolean }>>`SELECT pg_try_advisory_xact_lock(
      hashtextextended(${runtimeLifecycleLockKey(p.workspaceId, lease.id)}, 0)) AS held`;
    if (lock?.held !== true) throw new SensitiveActionError('forbidden', 'runtime creator is not fenced');
  }
  const backend = deps.backend ?? (await import('./blind-review-runtime-backend')).createLinuxRuntimeNamespaceBackend();
  const observations = [];
  const signal = AbortSignal.timeout(5_000);
  let resourceBytes = 0;
  for (const lease of leases) {
    signal.throwIfAborted();
    // A released row alone is not physical evidence. Reconcile unfinished
    // cutoffs separately; this reader must never repair or reopen a lease.
    if (lease.state !== 'released' || !lease.revoked_at)
      throw new SensitiveActionError('forbidden', 'runtime cutoff is not settled');
    const resources = await tx<RuntimeResourceIntent[]>`SELECT * FROM harness_shared.blind_review_runtime_resources
      WHERE workspace_id = ${p.workspaceId} AND lease_id = ${lease.id} ORDER BY id LIMIT 65`;
    resourceBytes += Buffer.byteLength(JSON.stringify(resources));
    if (resources.length > 64 || resourceBytes > 2 * 1024 * 1024)
      throw new SensitiveActionError('forbidden', 'runtime resource census incomplete');
    let onAbort!: () => void;
    const timeout = new Promise<never>((_, reject) => {
      onAbort = () => reject(new SensitiveActionError('forbidden', 'runtime absence observation timed out'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    let proof: Awaited<ReturnType<RuntimeNamespaceBackend['inspect']>>;
    try { proof = await Promise.race([backend.inspect(lease, resources, signal), timeout]); }
    finally { signal.removeEventListener('abort', onAbort); }
    signal.throwIfAborted();
    const absent = new Set(proof.absentIntentIds), kinds = new Set(proof.checkedKinds);
    if (proof.scopeAbsent !== true || proof.creatorStopped !== true || absent.size !== resources.length ||
        !resources.every(resource => absent.has(resource.id)) || kinds.size !== RUNTIME_RESOURCE_KINDS.length ||
        !RUNTIME_RESOURCE_KINDS.every(kind => kinds.has(kind)))
      throw new SensitiveActionError('forbidden', 'runtime physical absence is not verified');
    observations.push({ leaseId: lease.id, leaseEpoch: String(lease.lease_epoch),
      resourceIds: resources.map(resource => resource.id), proof });
  }
  return { schema: 'blind-review-legacy-runtime-absence/v1' as const,
    scope: 'recorded-plan-runtime-leases' as const, observations,
    processQualification: 'required' as const, sourceQualification: 'required' as const };
}

/** Canonical identity evidence only; this is neither source qualification nor an
 * execution capability. The caller already holds the plan/binding transaction.
 * Approval identities are checked at consumption, but are kept outside the
 * preparation hash: adding a decision must not itself invalidate that hash. */
export async function readLegacyAdoptionIndependence(tx: Sql, payload: LegacyAdoptionPayload,
  approvingHumans: readonly string[] = []) {
  if (typeof (tx as unknown as { savepoint?: unknown }).savepoint !== 'function')
    throw new SensitiveActionError('invalid', 'independence evidence requires the custody transaction');
  const p = legacyAdoptionPayloadSchema.parse(payload), opts = { sql: tx, workspaceId: p.workspaceId };
  const unavailable = (message: string): never => { throw new SensitiveActionError('forbidden', message); };
  const [plan] = await tx<Array<{ owner: string | null; content_hash: string | null }>>`
    SELECT owner, content_hash FROM harness_shared.harness_plans WHERE workspace_id = ${p.workspaceId}
      AND harness_slug = ${p.harnessSlug} AND plan_slug = ${p.planSlug}`;
  if (!plan?.owner?.trim() || plan.content_hash !== p.planHash)
    unavailable('canonical current author or exact plan hash unavailable');
  const revisions = await tx<Array<{ author_id: string | null }>>`
    SELECT author_id FROM harness_shared.plan_revisions WHERE workspace_id = ${p.workspaceId}
      AND harness_slug = ${p.harnessSlug} AND plan_slug = ${p.planSlug} ORDER BY seq LIMIT 129`;
  if (!revisions.length || revisions.length > 128 || revisions.some(r => !r.author_id?.trim()))
    unavailable('canonical plan author census incomplete');
  const implementers = await resolvePlanImplementerIdentities(p.planSlug, { ...opts, maxRows: 128 });
  const authors = [...new Set([plan!.owner!, ...revisions.map(r => r.author_id!)])].sort();
  const excluded = [...new Set([...authors, ...implementers, p.preparedPrincipal])].sort();
  if (excluded.length > 128 || approvingHumans.length > 128 ||
      approvingHumans.some(id => !/^user:\S+$/.test(id)))
    unavailable('canonical independence population unavailable or oversized');

  type Party = { identity: string; mapping: { kind: 'user'; userId: string; authSessions: string[] }
    | { kind: 'agent'; advIds: number[] }; aliases: string[]; lineage: Record<string, string[]> };
  const cache = new Map<string, Party>();
  const party = async (identity: string): Promise<Party> => {
    const cached = cache.get(identity); if (cached) return cached;
    // These are issuer-owned user/session records, never labels, UI identity
    // fallbacks, caller assertions, gossip or a shared system:superuser key.
    // Revoked historical sessions remain aliases for independence purposes.
    const users = await tx<Array<{ id: string }>>`
      SELECT u.id::text AS id FROM harness_shared.users u
       WHERE (u.id::text = ${identity} OR 'user:' || u.id::text = ${identity}
         OR EXISTS (SELECT 1 FROM harness_shared.power_user_sessions s
           WHERE s.workspace_id = ${p.workspaceId} AND s.user_id = u.id::text
             AND s.auth_session_id = ${identity}))
         AND (EXISTS (SELECT 1 FROM harness_shared.user_sessions s
           WHERE s.workspace_id = ${p.workspaceId} AND s.user_id = u.id)
           OR EXISTS (SELECT 1 FROM harness_shared.power_user_sessions s
             WHERE s.workspace_id = ${p.workspaceId} AND s.user_id = u.id::text))
       ORDER BY u.id LIMIT 2`;
    if (users.length > 1) unavailable('ambiguous authenticated identity mapping');
    let mapping: Party['mapping'], aliases: string[];
    if (users.length === 1) {
      const userId = users[0]!.id;
      const sessions = await tx<Array<{ auth_session_id: string }>>`
        SELECT auth_session_id FROM harness_shared.power_user_sessions
         WHERE workspace_id = ${p.workspaceId} AND user_id = ${userId}
         ORDER BY auth_session_id LIMIT 129`;
      if (sessions.length > 128 || sessions.some(s => !s.auth_session_id?.trim()))
        unavailable('authenticated alias census incomplete');
      mapping = { kind: 'user', userId, authSessions: sessions.map(s => s.auth_session_id) };
      aliases = [...new Set([identity, userId, 'user:' + userId, ...mapping.authSessions])].sort();
    } else {
      const native = await tx<Array<{ id: string | number; launch_parent_owner: string | null }>>`
        SELECT id, launch_parent_owner FROM harness_shared.adv_sessions
         WHERE workspace_id = ${p.workspaceId} AND coord_owner_id = ${identity} ORDER BY id LIMIT 129`;
      if (!native.length || native.length > 128 || native.some(n => !n.launch_parent_owner?.trim()))
        unavailable('canonical identity mapping or launch provenance unavailable');
      mapping = { kind: 'agent', advIds: native.map(n => Number(n.id)) }; aliases = [identity];
    }
    const lineage: Record<string, string[]> = {};
    for (const alias of aliases) {
      const nodes = await acceptanceLineageClosure(alias, { ...opts, requireComplete: true });
      if (mapping.kind === 'agent' && nodes.size < 2)
        unavailable('agent lineage census has no canonical provenance');
      lineage[alias] = [...nodes].sort();
    }
    const result: Party = { identity, mapping, aliases, lineage }; cache.set(identity, result); return result;
  };
  const independent = async (candidate: Party, forbidden: Party) => {
    for (const a of candidate.aliases) for (const b of forbidden.aliases) {
      if (candidate.lineage[a]!.includes(b) || forbidden.lineage[b]!.includes(a))
        unavailable('adoption identities share an author, implementer or reviewer lineage');
    }
    if (await isAcceptanceAuthorIdentity(forbidden.identity, candidate.identity, opts) ||
        await areAcceptanceLineageRelated(forbidden.identity, candidate.identity, opts))
      unavailable('adoption identities are not independent');
  };
  const exclusions: Party[] = [];
  for (const identity of excluded) exclusions.push(await party(identity));
  const reviewer = await party(p.reviewerOwnerId), executor = await party(p.authorizedExecutor);
  if (executor.mapping.kind !== 'user') unavailable('executor has no authenticated human mapping');
  for (const forbidden of exclusions) await independent(reviewer, forbidden);
  for (const forbidden of [...exclusions, reviewer]) await independent(executor, forbidden);
  const independence = { schema: 'blind-review-legacy-independence/v1' as const,
    workspaceId: p.workspaceId, harnessSlug: p.harnessSlug, planSlug: p.planSlug, planHash: p.planHash,
    authors, implementers, preparer: p.preparedPrincipal, reviewer: p.reviewerOwnerId,
    executor: p.authorizedExecutor, parties: [...cache.values()].sort((a, b) => a.identity.localeCompare(b.identity)) };
  const approvalEvidence: Party[] = [];
  for (const identity of [...new Set(approvingHumans)].sort()) {
    const human = await party(identity);
    if (human.mapping.kind !== 'user') unavailable('approver has no authenticated human mapping');
    for (const forbidden of [...exclusions, reviewer]) await independent(human, forbidden);
    approvalEvidence.push(human);
  }
  return { independence, approvalEvidence };
}

type LegacyAdoptionDeps = { sql?: Sql; readEvidence?:
  (tx: Sql, payload: LegacyAdoptionPayload) => Promise<LegacyAdoptionEvidence> };
const legacyFenceResult = z.object({ rootId: z.number().int().positive(),
  attemptKey: z.string().uuid(), bindingId: z.number().int().positive(), bootstrapKey: z.string().uuid(),
  operationDigest: legacyHash, bootstrapPiSessionId: legacyText,
  expiresAt: z.string().datetime(), state: z.literal('fenced') }).strict();
export type LegacyAdoptionFence = z.infer<typeof legacyFenceResult>;
const legacyClock = async (tx: Sql) => (await tx<Array<{ now: Date }>>`
  SELECT clock_timestamp() AS now`)[0]!.now;

/** Reserve only: no credential issuance, host, native publication or posting.
 * Scope -> request/approvals -> policy/delegations -> custody -> native -> replay.
 * The shared executor commits its consumed mark with every fence effect. */
export async function reserveLegacyAdoption(input: {
  workspaceId: string; bindingId: number; requestId: string; expectedPayloadHash: string;
}, requestPrincipal: HostRequestPrincipalResolver, deps: LegacyAdoptionDeps = {}): Promise<LegacyAdoptionFence> {
  input = z.object({ workspaceId: legacyText, bindingId: z.number().int().positive(),
    requestId: legacyText, expectedPayloadHash: legacyHash }).strict().parse(input);
  if (typeof requestPrincipal !== 'function' || !retainedLegacyHumans.has(requestPrincipal))
    throw new SensitiveActionError('forbidden', 'retained adoption cookie request required');
  const sql = deps.sql ?? getOrgPg().sql;
  const outcome = await sql.begin(async raw => {
    const tx = raw as unknown as Sql;
    const { binding: b, planHash } = await lockBlindReviewContinuationScope(tx, input.workspaceId, input.bindingId);
    await tx`SELECT request_id FROM harness_shared.sensitive_action_requests
      WHERE request_id = ${input.requestId} FOR UPDATE`;
    const request = await getSensitiveAction(input.requestId, tx);
    if (!request || request.workspaceId !== input.workspaceId)
      throw new SensitiveActionError('not-found', 'adoption request not found in this workspace');
    const p = validateLegacyAdoptionRequest(request);
    if (p.bindingId !== b.id || request.payloadHash !== input.expectedPayloadHash)
      throw new SensitiveActionError('payload-mismatch', 'adoption scope or approved hash differs');
    if (request.status === 'executed') {
      await tx`SELECT approver FROM harness_shared.sensitive_action_approvals
        WHERE request_id = ${request.requestId} ORDER BY approver FOR SHARE`;
      await lockLegacyAdoptionAuthorization(tx, request, requestPrincipal, true);
      const result = legacyFenceResult.parse(request.result);
      const rows = await tx`SELECT * FROM harness_shared.blind_review_continuation_custody
        WHERE workspace_id = ${b.workspaceId} AND binding_id = ${b.id} ORDER BY id LIMIT 65 FOR SHARE`;
      const root = rows.find(row => Number(row.id) === result.rootId);
      const [receipt] = await tx`SELECT summary FROM harness_shared.agent_launch_idempotency
        WHERE workspace_id = ${b.workspaceId} AND idempotency_key = ${'bootstrap-su:' + p.bootstrapKey} FOR SHARE`;
      if (rows.length !== 1 || !root || root.event_kind !== 'legacy-fenced' || root.reservation_id !== null ||
          root.attempt_key !== p.attemptKey || Number(root.source_adv_session_id) !== p.original.advSessionId ||
          Number(root.target_adv_session_id) !== p.target.advSessionId || root.port_id !== null ||
          root.snapshot.payloadHash !== request.payloadHash || root.snapshot.requestId !== request.requestId ||
          !equal(root.snapshot.payload, p) || !equal(root.evidence.result, result) ||
          !equal(receipt?.summary, { legacyAdoption: result, requestId: request.requestId, payloadHash: request.payloadHash }) ||
          result.bindingId !== b.id || result.attemptKey !== p.attemptKey || result.bootstrapKey !== p.bootstrapKey ||
          result.operationDigest !== p.operationDigest || result.bootstrapPiSessionId !== p.bootstrapPiSessionId ||
          b.resumeLeaseId !== root.resume_lease_id || b.status !== 'resuming' ||
          !(Date.parse(result.expiresAt) > (await legacyClock(tx)).getTime()))
        throw new SensitiveActionError('replayed', 'committed adoption root/result/receipt is unavailable or changed');
      // Read-only lost-response recovery: no renewal, repair, issuance or launch.
      return { ok: true as const, result };
    }
    return executeSensitiveActionInTransaction(raw, { requestId: request.requestId,
      executor: p.authorizedExecutor, expectedPayloadHash: input.expectedPayloadHash, requestPrincipal },
    async (sp, approved) => {
      await lockLegacyAdoptionAuthorization(sp, approved, requestPrincipal);
      if (p.harnessSlug !== b.harnessSlug || p.planSlug !== b.planSlug || p.planHash !== planHash ||
          p.activationAuditSeq !== Number(b.activationAuditSeq) || p.reviewerOwnerId !== b.reviewerOwnerId ||
          p.original.advSessionId !== b.advSessionId || p.original.nativeSessionId !== b.nativeSessionId ||
          p.modelSpec !== b.modelSpec || sensitivePayloadHash(b.confinementSnapshot) !== p.confinementHash ||
          b.reviewId !== null || !['ready', 'resuming'].includes(b.status))
        throw new SensitiveActionError('stale', 'binding, activation, confinement or plan pins changed');
      const [revision] = await sp`SELECT seq, content_hash FROM harness_shared.plan_revisions
        WHERE workspace_id = ${b.workspaceId} AND harness_slug = ${b.harnessSlug} AND plan_slug = ${b.planSlug}
        ORDER BY seq DESC LIMIT 1 FOR SHARE`;
      if (Number(revision?.seq) !== p.planRevision || revision?.content_hash !== p.planHash)
        throw new SensitiveActionError('stale', 'exact plan revision changed');
      if (!deps.readEvidence) throw new SensitiveActionError('forbidden', 'canonical adoption evidence reader unavailable');
      const measured = await deps.readEvidence(sp, p);
      if (sensitivePayloadHash(measured.bindingHistory) !== p.bindingHistoryHash ||
          sensitivePayloadHash(measured.outstandingEffects) !== p.outstandingEffectsHash ||
          sensitivePayloadHash(measured.independence) !== p.independenceEvidenceHash ||
          !equal(measured.qualification, p.qualification))
        throw new SensitiveActionError('stale', 'measured history, effects, independence or source pins changed');
      const prior = await sp`SELECT id FROM harness_shared.blind_review_continuation_custody
        WHERE workspace_id = ${b.workspaceId} AND binding_id = ${b.id} ORDER BY id LIMIT 65 FOR SHARE`;
      if (prior.length) throw new SensitiveActionError('stale', 'prior custody effects require disposition');
      const runtimes = await sp`SELECT id, state FROM harness_shared.blind_review_runtime_leases
        WHERE workspace_id = ${b.workspaceId} AND binding_id = ${b.id} ORDER BY id FOR UPDATE`;
      const n = await native(sp, b.workspaceId, b.advSessionId);
      const [lifetime] = await sp<Array<{ started: Date; ended: Date | null }>>`
        SELECT started_at AS started, ended_at AS ended FROM harness_shared.adv_sessions
        WHERE workspace_id = ${b.workspaceId} AND id = ${b.advSessionId}`;
      if (!n || !n.ended_at || !lifetime?.ended || n.coord_owner_id !== b.reviewerOwnerId ||
          n.session_id !== p.observed.nativeSessionId || n.agent !== p.backend || n.resume_claim_key !== null ||
          !profile(n, b.reviewerOwnerId, { nativeSessionId: p.observed.nativeSessionId, modelSpec: p.modelSpec }) ||
          sensitivePayloadHash({ backend: n.agent, spec: n.launch_spec, argv: n.launch_argv }) !== p.profileHash ||
          lifetime.started.toISOString() !== p.observed.startedAt || lifetime.ended.toISOString() !== p.observed.endedAt ||
          sensitivePayloadHash({ advSessionId: Number(n.id), nativeSessionId: n.session_id,
            startedAt: lifetime.started.toISOString(), endedAt: lifetime.ended.toISOString() }) !== p.observed.lifetimeEvidenceHash)
        throw new SensitiveActionError('stale', 'observed ended native lifetime or profile changed');
      const now = await legacyClock(sp);
      const expiresAt = new Date(Math.min(Date.parse(p.bootstrapExpiresAt), Date.parse(approved.executeBy!),
        now.getTime() + 60_000)).toISOString();
      if (!(Date.parse(expiresAt) > now.getTime())) throw new SensitiveActionError('stale', 'bootstrap window closed');
      if (b.resumeLeaseId && b.resumeLeaseExpiresAt && Date.parse(b.resumeLeaseExpiresAt) > now.getTime())
        throw new SensitiveActionError('stale', 'another recruiter lease is live');
      const leaseId = randomUUID();
      const [allocated] = await sp`SELECT nextval('harness_shared.blind_review_continuation_custody_id_seq') AS id`;
      const result: LegacyAdoptionFence = { rootId: Number(allocated!.id), attemptKey: p.attemptKey, bindingId: b.id,
        bootstrapKey: p.bootstrapKey, operationDigest: p.operationDigest, bootstrapPiSessionId: p.bootstrapPiSessionId,
        expiresAt, state: 'fenced' };
      await sp`INSERT INTO harness_shared.blind_review_continuation_custody
        (id, workspace_id, binding_id, event_kind, attempt_key, resume_lease_id, source_adv_session_id,
         target_adv_session_id, port_id, snapshot, evidence)
        VALUES (${result.rootId}, ${b.workspaceId}, ${b.id}, 'legacy-fenced', ${p.attemptKey}, ${leaseId}, ${b.advSessionId},
          ${b.advSessionId}, NULL, ${JSON.stringify({ requestId: approved.requestId,
            payloadHash: approved.payloadHash, payload: p, measured })}::jsonb, ${JSON.stringify({ result })}::jsonb)`;
      await sp`UPDATE harness_shared.plan_blind_review_sessions SET status = 'resuming', resume_lease_id = ${leaseId},
        resume_lease_expires_at = ${expiresAt} WHERE workspace_id = ${b.workspaceId} AND id = ${b.id}`;
      for (const runtime of runtimes) if (['allocating', 'ready', 'releasing'].includes(runtime.state))
        await sp`UPDATE harness_shared.blind_review_runtime_leases SET state = 'releasing',
          revoked_at = COALESCE(revoked_at, clock_timestamp()),
          release_reason = COALESCE(release_reason, 'legacy-adoption-fenced'), updated_at = clock_timestamp()
          WHERE workspace_id = ${b.workspaceId} AND id = ${runtime.id}`;
      await sp`INSERT INTO harness_shared.agent_launch_idempotency
        (workspace_id, idempotency_key, launched_at, launched_by, summary)
        VALUES (${b.workspaceId}, ${'bootstrap-su:' + p.bootstrapKey}, ${(await legacyClock(sp)).getTime()},
          ${BLIND_GAP_REVIEW_ACTOR}, ${JSON.stringify({ legacyAdoption: result,
            requestId: approved.requestId, payloadHash: approved.payloadHash })}::jsonb)`;
      return result;
    }, legacyClock);
  });
  if (!outcome.ok) throw outcome.error;
  return outcome.result;
}

const managedSuccessionSchema = z.object({
  requestKey: z.string().uuid(), ownerId: z.string().min(1).max(200), advSessionId: z.number().int().positive(),
  hostPid: z.number().int().positive(), hostStartedAt: z.number().int().positive(),
  hostCodeVersion: z.string().regex(/^[a-f0-9]{64}$/), predecessorPid: z.number().int().positive(),
  predecessorGeneration: z.number().int().positive(), successorGeneration: z.number().int().positive(),
  sourceNativeSessionId: z.string().min(1).max(200), successorNativeSessionId: z.string().min(1).max(200).nullable(),
  predecessorExited: z.literal(true),
}).strict();
export type ManagedSuccessionRequest = z.infer<typeof managedSuccessionSchema>;
export type BlindReviewManagedSuccessionPermit = {
  bindingId: number; reservationId: number; attemptKey: string; receiptId: string;
};
type ManagedDeps = { sql?: Sql; findHost?: typeof findLiveHostAsync;
  processIdentity?: typeof readProcessIdentity; exited?: (pid: number) => boolean };
function processExited(pid: number) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

/** This is an exact ADV/custody lookup, never a same-owner latest-row search.
 * A recruiter launch with missing storage/binding is restricted, not unbound. */
async function managedBinding(tx: Sql, workspaceId: string, advSessionId: number) {
  const [adv] = await tx<Array<{ coord_owner_id: string | null; launch_spec: { launchedBy?: string } | null }>>`
    SELECT coord_owner_id, launch_spec FROM harness_shared.adv_sessions
    WHERE workspace_id = ${workspaceId} AND id = ${advSessionId}`;
  if (!adv) return refuse('managed_source_missing');
  let [binding] = await tx<Array<{ id: number | string }>>`SELECT id FROM harness_shared.plan_blind_review_sessions
    WHERE workspace_id = ${workspaceId} AND adv_session_id = ${advSessionId}
      AND reviewer_owner_id = ${adv.coord_owner_id} AND launch_parent_owner = ${BLIND_GAP_REVIEW_ACTOR}`;
  const installed = await blindReviewContinuationStorageInstalled(tx);
  if (!binding && installed) [binding] = await tx<Array<{ id: number | string }>>`
    SELECT c.binding_id AS id FROM harness_shared.blind_review_continuation_custody c
    JOIN harness_shared.plan_blind_review_sessions b ON b.id = c.binding_id AND b.workspace_id = c.workspace_id
    WHERE c.workspace_id = ${workspaceId} AND c.target_adv_session_id = ${advSessionId}
      AND b.reviewer_owner_id = ${adv.coord_owner_id} AND b.launch_parent_owner = ${BLIND_GAP_REVIEW_ACTOR}
    ORDER BY c.id DESC LIMIT 1`;
  if (!binding) return adv.launch_spec?.launchedBy === BLIND_GAP_REVIEW_ACTOR ? refuse('binding_not_found') : null;
  if (!installed) return refuse('continuation_storage_unavailable');
  return lockBlindReviewContinuationScope(tx, workspaceId, Number(binding.id));
}

async function managedAuthority(tx: Sql, b: Binding, source: Native) {
  const [row] = await tx`SELECT request_hash, request_snapshot, replacement_of, attempt_seq, review_id
    FROM harness_shared.plan_blind_review_sessions WHERE workspace_id = ${b.workspaceId} AND id = ${b.id}`;
  const [brief] = await tx`SELECT control_state->'activation' AS activation FROM harness_shared.session_briefs
    WHERE workspace_id = ${b.workspaceId} AND owner_id = ${b.reviewerOwnerId} FOR SHARE`;
  const [policy] = await tx<Array<{ live: boolean }>>`SELECT
    (payload->'sessions'->${b.reviewerOwnerId}->>'expiresAt')::timestamptz > clock_timestamp() AS live
    FROM harness_shared.operator_session_confinements WHERE workspace_id = ${b.workspaceId} FOR SHARE`;
  const activation = brief?.activation;
  const spec = source.launch_spec as { specificationRevision?: string; stateRevision?: string } | null;
  const original = row?.replacement_of === null && row.attempt_seq === 0 &&
    row.request_hash === null && row.request_snapshot === null;
  const replacement = row?.replacement_of !== null && Number(row?.replacement_of) > 0 &&
    Number.isInteger(row?.attempt_seq) && row!.attempt_seq > 0 &&
    typeof row!.request_hash === 'string' && /^[a-f0-9]{64}$/.test(row!.request_hash) &&
    row!.request_snapshot !== null && typeof row!.request_snapshot === 'object' && !Array.isArray(row!.request_snapshot);
  if (!row || policy?.live !== true || activation?.status !== 'applied' || !activation.applied ||
      !(original || replacement) ||
      !equal(activation.desired, activation.applied) || !spec?.specificationRevision || !spec.stateRevision ||
      spec.specificationRevision !== activation.applied.specificationRevision ||
      spec.stateRevision !== activation.applied.stateRevision) return refuse('managed_authority_stale');
  return { activation, replacementRequest: { sourceBindingId: row.replacement_of,
    hash: row.request_hash, snapshot: row.request_snapshot }, attemptSeq: row.attempt_seq, reviewId: row.review_id ?? null };
}

async function managedHost(request: ManagedSuccessionRequest, successor: boolean, deps: ManagedDeps) {
  const host = await (deps.findHost ?? findLiveHostAsync)(request.ownerId);
  const observed = host as (NonNullable<typeof host> & { managedSuccession?: ManagedSuccessionRequest }) | null;
  const identity = host && (deps.processIdentity ?? readProcessIdentity)(host.pid);
  if (!host || !identity || host.pid !== request.hostPid || host.startedAt !== request.hostStartedAt ||
      host.ownerId !== request.ownerId || Number(host.advSessionId) !== request.advSessionId ||
      host.hostCodeVersion !== request.hostCodeVersion || !equal(observed?.managedSuccession, request) ||
      host.childGeneration !== (successor ? request.successorGeneration : request.predecessorGeneration) ||
      (!successor && host.ptyPid !== request.predecessorPid) ||
      !(deps.exited ?? processExited)(request.predecessorPid) ||
      successor && (!host.ptyPid || host.ptyPid === request.predecessorPid ||
        !(deps.processIdentity ?? readProcessIdentity)(host.ptyPid))) return refuse('managed_host_unverified');
  return { host, identity };
}

/** The managed host calls this AFTER observed predecessor exit, BEFORE spawn.
 * Admission and the recruiter lease commit on the existing append-only seam.
 * A lost reply leaves both endpoints denied; retrying the exact request is safe. */
export async function reserveBlindReviewManagedSuccession(workspaceId: string, value: unknown,
  deps: ManagedDeps = {}): Promise<BlindReviewManagedSuccessionPermit | null> {
  const request = managedSuccessionSchema.parse(value);
  if (request.successorGeneration !== request.predecessorGeneration + 1 ||
      request.successorNativeSessionId === request.sourceNativeSessionId) return refuse('managed_request_invalid');
  return (deps.sql ?? getOrgPg().sql).begin(async raw => {
    const tx = raw as unknown as Sql;
    const scope = await managedBinding(tx, workspaceId, request.advSessionId);
    if (!scope) return null;
    const { binding: b, planHash } = scope;
    if (b.reviewerOwnerId !== request.ownerId) return refuse('managed_request_invalid');
    const entries = await tx<CustodyEntry[]>`SELECT * FROM harness_shared.blind_review_continuation_custody
      WHERE workspace_id = ${workspaceId} AND binding_id = ${b.id} ORDER BY id LIMIT 65 FOR SHARE`;
    const r = entries.at(-2), a = entries.at(-1);
    const source = await native(tx, workspaceId, request.advSessionId);
    if (!source || source.resume_claim_key !== null) return refuse('managed_source_invalid');
    const { identity } = await managedHost(request, false, deps);
    const authority = await managedAuthority(tx, b, source);
    if (r?.event_kind === 'native-reserved' && a?.event_kind === 'native-admitted' &&
        equal(r.snapshot.managedSuccession?.request, request)) {
      requireLease(b, r.resume_lease_id);
      if (!equal(r.snapshot.managedSuccession, { request, hostIdentity: identity, authority }) ||
          !profile(source, b.reviewerOwnerId, r.snapshot.source) ||
          !equal(r.snapshot.profile, { spec: source.launch_spec, argv: source.launch_argv }) ||
          Number(a.reservation_id) !== Number(r.id) || typeof a.evidence.admissionReceiptId !== 'string')
        return refuse('managed_reservation_mismatch');
      return { bindingId: b.id, reservationId: Number(r.id), attemptKey: r.attempt_key,
        receiptId: a.evidence.admissionReceiptId };
    }
    const endpoint = await resolveBlindReviewEndpoint(tx, b);
    if (b.status !== 'ready' || !endpoint || endpoint.advSessionId !== request.advSessionId ||
        endpoint.nativeSessionId !== request.sourceNativeSessionId || !profile(source, b.reviewerOwnerId, endpoint))
      return refuse('managed_source_invalid');
    const leaseId = randomUUID(), attemptKey = randomUUID(), receiptId = randomUUID();
    const snapshot: NativeSnapshot = { activation: b.activationAuditSeq, owner: b.reviewerOwnerId,
      planHash, confinement: b.confinementSnapshot, source: endpoint, backend: source.agent!,
      actor: BLIND_GAP_REVIEW_ACTOR, requestHash: requestHash(request as unknown as Record<string, unknown>),
      profile: { spec: source.launch_spec, argv: source.launch_argv },
      managedSuccession: { request, hostIdentity: identity, authority } };
    await tx`UPDATE harness_shared.plan_blind_review_sessions SET status = 'resuming',
      resume_lease_id = ${leaseId}, resume_lease_expires_at = clock_timestamp() + interval '10 minutes', updated_at = now()
      WHERE workspace_id = ${workspaceId} AND id = ${b.id}`;
    const [reserved] = await tx<Array<{ id: number | string }>>`INSERT INTO harness_shared.blind_review_continuation_custody
      (workspace_id, binding_id, event_kind, attempt_key, resume_lease_id, source_adv_session_id,
       target_adv_session_id, port_id, snapshot, evidence)
      VALUES (${workspaceId}, ${b.id}, 'native-reserved', ${attemptKey}, ${leaseId}, ${endpoint.advSessionId},
        ${endpoint.advSessionId}, NULL, ${tx.json(snapshot as never)}, '{}') RETURNING id`;
    await tx`INSERT INTO harness_shared.blind_review_continuation_custody
      (workspace_id, binding_id, reservation_id, event_kind, attempt_key, resume_lease_id,
       source_adv_session_id, target_adv_session_id, port_id, snapshot, evidence)
      VALUES (${workspaceId}, ${b.id}, ${reserved!.id}, 'native-admitted', ${attemptKey}, ${leaseId},
        ${endpoint.advSessionId}, ${endpoint.advSessionId}, NULL, ${tx.json(snapshot as never)},
        ${tx.json({ admissionReceiptId: receiptId })})`;
    return { bindingId: b.id, reservationId: Number(reserved!.id), attemptKey, receiptId };
  }) as Promise<BlindReviewManagedSuccessionPermit | null>;
}

/** Atomic with the generic native writer. Unreserved legacy callbacks cannot
 * rewrite an immutable blind binding; same-endpoint retries remain idempotent. */
export async function withBlindReviewManagedReanchor<T>(tx: Sql, input: {
  workspaceId: string; advSessionId: number; nativeSessionId: string;
  permit?: BlindReviewManagedSuccessionPermit;
}, write: () => Promise<T>, deps: ManagedDeps = {}): Promise<T> {
  const scope = await managedBinding(tx, input.workspaceId, input.advSessionId);
  if (!scope) return write();
  const { binding: b, planHash } = scope;
  const endpoint = await resolveBlindReviewEndpoint(tx, b);
  const source = await native(tx, input.workspaceId, input.advSessionId);
  if (endpoint?.advSessionId === input.advSessionId && endpoint.nativeSessionId === input.nativeSessionId &&
      source && profile(source, b.reviewerOwnerId, endpoint)) {
    if (input.permit) {
      const p = input.permit;
      const [settled] = await tx<NativeEntry[]>`SELECT * FROM harness_shared.blind_review_continuation_custody
        WHERE workspace_id = ${b.workspaceId} AND binding_id = ${b.id} AND id = ${endpoint.continuationId}`;
      if (!settled || p.bindingId !== b.id || Number(settled.reservation_id) !== p.reservationId ||
          settled.attempt_key !== p.attemptKey || settled.evidence.admissionReceiptId !== p.receiptId ||
          !settled.snapshot.managedSuccession) return refuse('managed_reservation_mismatch');
      const m = settled.snapshot.managedSuccession;
      const observed = await managedHost(m.request, true, deps);
      if (observed.identity !== m.hostIdentity || observed.host.nativeSessionId !== input.nativeSessionId)
        return refuse('managed_successor_unverified');
    }
    return write();
  }
  const p = input.permit;
  if (!p || p.bindingId !== b.id || !source) return refuse('managed_reservation_required');
  requireLease(b, b.resumeLeaseId ?? '');
  const entries = await tx<CustodyEntry[]>`SELECT * FROM harness_shared.blind_review_continuation_custody
    WHERE workspace_id = ${b.workspaceId} AND binding_id = ${b.id} ORDER BY id LIMIT 65 FOR SHARE`;
  const r = entries.at(-2), a = entries.at(-1);
  if (r?.event_kind !== 'native-reserved' || a?.event_kind !== 'native-admitted' ||
      Number(r.id) !== p.reservationId || r.attempt_key !== p.attemptKey || r.resume_lease_id !== b.resumeLeaseId ||
      Number(a.reservation_id) !== Number(r.id) || a.attempt_key !== r.attempt_key ||
      a.evidence.admissionReceiptId !== p.receiptId || !equal(a.snapshot, r.snapshot) ||
      r.snapshot.planHash !== planHash || !r.snapshot.managedSuccession) return refuse('managed_reservation_mismatch');
  const m = r.snapshot.managedSuccession, request = m.request;
  const prior = replayCustody(entries.slice(0, -2), b, planHash, { advSessionId: b.advSessionId,
    nativeSessionId: b.nativeSessionId, modelSpec: b.modelSpec, continuationId: null });
  if (!prior || !equal(prior, r.snapshot.source) || !profile(source, b.reviewerOwnerId, prior) ||
      source.resume_claim_key !== null || !equal(r.snapshot.profile, { spec: source.launch_spec, argv: source.launch_argv }) ||
      !equal(m.authority, await managedAuthority(tx, b, source)) ||
      request.successorNativeSessionId !== null && request.successorNativeSessionId !== input.nativeSessionId)
    return refuse('managed_reservation_mismatch');
  const observed = await managedHost(request, true, deps);
  if (observed.identity !== m.hostIdentity || observed.host.nativeSessionId !== input.nativeSessionId)
    return refuse('managed_successor_unverified');
  const evidence = { outcome: 'managed-native-started', attemptKey: r.attempt_key, requestHash: r.snapshot.requestHash,
    admissionReceiptId: p.receiptId, nativeSessionId: input.nativeSessionId, advSessionId: input.advSessionId,
    hostIdentity: observed.identity, successorGeneration: request.successorGeneration, successorPid: observed.host.ptyPid };
  if (!replayCustody([...entries, { ...r, id: -1, event_kind: 'native-settled', reservation_id: r.id, evidence }],
      b, planHash, { advSessionId: b.advSessionId, nativeSessionId: b.nativeSessionId,
        modelSpec: b.modelSpec, continuationId: null })) return refuse('managed_reservation_mismatch');
  const result = await write();
  // Recheck the host after the writer, before either native or custody commits.
  const again = await managedHost(request, true, deps);
  if (again.identity !== observed.identity || again.host.ptyPid !== observed.host.ptyPid ||
      again.host.nativeSessionId !== observed.host.nativeSessionId) return refuse('managed_successor_unverified');
  await tx`INSERT INTO harness_shared.blind_review_continuation_custody
    (workspace_id, binding_id, reservation_id, event_kind, attempt_key, resume_lease_id,
     source_adv_session_id, target_adv_session_id, port_id, snapshot, evidence)
    VALUES (${b.workspaceId}, ${b.id}, ${r.id}, 'native-settled', ${r.attempt_key}, ${r.resume_lease_id},
      ${r.source_adv_session_id}, ${r.target_adv_session_id}, NULL, ${tx.json(r.snapshot as never)}, ${tx.json(evidence)})`;
  await tx`UPDATE harness_shared.plan_blind_review_sessions SET status = 'ready', resume_lease_id = NULL,
    resume_lease_expires_at = NULL, updated_at = now() WHERE workspace_id = ${b.workspaceId} AND id = ${b.id}`;
  return result;
}

/** The same fresh pool verdict used by account status. An owner routing fence
 * is authority, not a provider refusal; stale/missing measurements stay unknown. */
export async function blindReviewProviderWall(workspaceId: string, agent: string) {
  const backend = agent === 'claude' ? 'claude' : agent === 'codex' ? 'codex' : null;
  if (!backend) return null;
  const [{ accountStatus }, { getAccountOverride }, { assessGoalHolderLaunchCapacity, holderLaunchTarget }] =
    await Promise.all([import('./deployment/account-pool-store'), import('./deployment/account-session-override'),
      import('./goals/holder-launch-capacity')]);
  const [rows, override] = await Promise.all([accountStatus(workspaceId), getAccountOverride(workspaceId)]);
  const verdict = assessGoalHolderLaunchCapacity(rows, holderLaunchTarget({ agent: backend, account: 'auto' }), Date.now(), override);
  return verdict.kind === 'deferred' && verdict.binding !== 'session-override' ? verdict : null;
}

/** The audit sequence alone does not identify the plan the author activated.
 * Keep the immutable revision identity and the locked live body in agreement. */
async function currentActivation(tx: Sql, b: Pick<Binding,
  'workspaceId' | 'harnessSlug' | 'planSlug' | 'activationAuditSeq'>, planHash: string) {
  const [a] = await tx<Array<{ audit_seq: number | string; audited_plan_content_hash: string;
    revision_hash: string | null }>>`
    SELECT a.audit_seq, a.audited_plan_content_hash, r.content_hash AS revision_hash
    FROM (SELECT * FROM harness_shared.plan_audits
      WHERE workspace_id = ${b.workspaceId} AND harness_slug = ${b.harnessSlug}
        AND plan_slug = ${b.planSlug} AND audit_kind = 'activation'
      ORDER BY audit_seq DESC LIMIT 1) a
    JOIN harness_shared.plan_revisions r ON r.workspace_id = a.workspace_id
      AND r.harness_slug = a.harness_slug AND r.plan_slug = a.plan_slug
      AND r.id = a.audited_plan_revision_id AND r.seq = a.audited_plan_revision_seq
    FOR SHARE OF r`;
  return !!a && Number(a.audit_seq) === b.activationAuditSeq &&
    a.audited_plan_content_hash === planHash && a.revision_hash === planHash;
}

export async function blindReviewContinuationStorageInstalled(tx: Sql) {
  const [r] = await tx<Array<{ installed: boolean }>>`
    SELECT to_regclass('harness_shared.blind_review_continuation_custody') IS NOT NULL AS installed`;
  if (typeof r?.installed !== 'boolean') return refuse('continuation_storage_unknown');
  return r.installed;
}

/** Caller holds plan and binding locks until its operation commits. An unknown
 * launch outcome denies BOTH endpoints forever until this reservation resolves;
 * lease expiry does not turn uncertainty into an ordinary retry. */
export async function resolveBlindReviewEndpoint(tx: Sql, b: Pick<Binding, 'id' | 'workspaceId' |
  'harnessSlug' | 'planSlug' | 'activationAuditSeq' | 'reviewerOwnerId' | 'advSessionId' |
  'nativeSessionId' | 'modelSpec' | 'confinementSnapshot'>): Promise<BlindReviewEndpoint | null> {
  let endpoint: BlindReviewEndpoint = { advSessionId: b.advSessionId, nativeSessionId: b.nativeSessionId,
    modelSpec: b.modelSpec, continuationId: null };
  const [plan] = await tx<Array<{ content_hash: string }>>`
    SELECT content_hash FROM harness_shared.harness_plans WHERE workspace_id = ${b.workspaceId}
      AND harness_slug = ${b.harnessSlug} AND plan_slug = ${b.planSlug} FOR SHARE`;
  if (!plan || !await currentActivation(tx, b, plan.content_hash)) return null;
  if (!await blindReviewContinuationStorageInstalled(tx)) return endpoint;
  const entries = await tx<CustodyEntry[]>`SELECT * FROM harness_shared.blind_review_continuation_custody
    WHERE workspace_id = ${b.workspaceId} AND binding_id = ${b.id} ORDER BY id LIMIT 65 FOR SHARE`;
  return replayCustody(entries, b, plan.content_hash, endpoint);
}

function replayCustody(entries: CustodyEntry[], b: Pick<Binding, 'id' | 'workspaceId' |
  'activationAuditSeq' | 'reviewerOwnerId' | 'confinementSnapshot'>, planHash: string,
  endpoint: BlindReviewEndpoint): BlindReviewEndpoint | null {
  if (entries.length > 64) return null;
  for (let i = 0; i < entries.length; i += 2) {
    const r = entries[i]!;
    let t = entries[i + 1];
    if (r.event_kind === 'native-reserved') {
      const s = r.snapshot;
      const admitted = t?.event_kind === 'native-admitted' ? t : null;
      if (admitted) {
        if (Number(admitted.reservation_id) !== Number(r.id) || admitted.attempt_key !== r.attempt_key ||
            admitted.workspace_id !== r.workspace_id || Number(admitted.binding_id) !== Number(r.binding_id) ||
            admitted.resume_lease_id !== r.resume_lease_id || admitted.port_id !== null ||
            String(admitted.source_adv_session_id) !== String(r.source_adv_session_id) ||
            String(admitted.target_adv_session_id) !== String(r.target_adv_session_id) ||
            !equal(admitted.snapshot, s) || typeof admitted.evidence.admissionReceiptId !== 'string' ||
            !admitted.evidence.admissionReceiptId) return null;
        t = entries[i + 2];
        i++;
      }
      if (!t || t.event_kind !== 'native-settled' || Number(t.reservation_id) !== Number(r.id) ||
          r.reservation_id !== null || r.port_id !== null || t.port_id !== null ||
          r.workspace_id !== b.workspaceId || t.workspace_id !== b.workspaceId ||
          Number(r.binding_id) !== b.id || Number(t.binding_id) !== b.id ||
          !r.attempt_key || t.attempt_key !== r.attempt_key || r.resume_lease_id !== t.resume_lease_id ||
          Number(r.source_adv_session_id) !== endpoint.advSessionId ||
          Number(r.target_adv_session_id) !== endpoint.advSessionId ||
          String(t.source_adv_session_id) !== String(r.source_adv_session_id) ||
          String(t.target_adv_session_id) !== String(r.target_adv_session_id) || !equal(s, t.snapshot) ||
          s.activation !== b.activationAuditSeq || s.owner !== b.reviewerOwnerId || s.planHash !== planHash ||
          s.actor !== BLIND_GAP_REVIEW_ACTOR || !equal(s.source, endpoint) ||
          !equal(s.confinement, b.confinementSnapshot) || !isBlindReviewerBackendAgent(s.backend) ||
          !/^[a-f0-9]{64}$/.test(s.requestHash) ||
          t.evidence.attemptKey !== r.attempt_key || t.evidence.requestHash !== s.requestHash ||
          !['no-native-open', 'native-started', ...(s.managedSuccession ? ['managed-native-started'] : [])]
            .includes(String(t.evidence.outcome))) return null;
      if (s.managedSuccession) {
        const m = s.managedSuccession, p = m.request;
        if (!admitted || t.evidence.outcome !== 'managed-native-started' ||
            s.requestHash !== requestHash(p as unknown as Record<string, unknown>) ||
            p.ownerId !== s.owner || p.advSessionId !== endpoint.advSessionId ||
            p.sourceNativeSessionId !== endpoint.nativeSessionId || !p.predecessorExited ||
            p.successorGeneration !== p.predecessorGeneration + 1 ||
            !m.hostIdentity || !m.authority ||
            t.evidence.admissionReceiptId !== admitted.evidence.admissionReceiptId ||
            t.evidence.hostIdentity !== m.hostIdentity || t.evidence.successorGeneration !== p.successorGeneration ||
            t.evidence.advSessionId !== endpoint.advSessionId ||
            typeof t.evidence.nativeSessionId !== 'string' || !t.evidence.nativeSessionId ||
            t.evidence.nativeSessionId === endpoint.nativeSessionId ||
            p.successorNativeSessionId !== null && p.successorNativeSessionId !== t.evidence.nativeSessionId ||
            typeof t.evidence.successorPid !== 'number' || t.evidence.successorPid <= 0) return null;
        endpoint = { ...endpoint, nativeSessionId: t.evidence.nativeSessionId,
          continuationId: Number(t.id), requiresNativeProof: true };
        continue;
      }
      if (t.evidence.outcome === 'native-started') {
        if (!admitted || t.evidence.admissionReceiptId !== admitted.evidence.admissionReceiptId ||
            t.evidence.nativeSessionId !== endpoint.nativeSessionId ||
            t.evidence.advSessionId !== endpoint.advSessionId ||
            typeof t.evidence.admissionReceiptId !== 'string' || !t.evidence.admissionReceiptId ||
            typeof t.evidence.taskId !== 'string' || !t.evidence.taskId) return null;
        endpoint = { ...endpoint, continuationId: Number(t.id) };
      } else if (admitted) return null;
      continue;
    }
    if (r.event_kind !== 'reserved') return null;
    const s = r.snapshot;
    if (r.event_kind !== 'reserved' || r.reservation_id !== null || !t ||
        t.event_kind !== 'transferred' || Number(t.reservation_id) !== Number(r.id) ||
        t.workspace_id !== b.workspaceId || Number(t.binding_id) !== b.id ||
        r.resume_lease_id !== t.resume_lease_id || r.port_id !== t.port_id ||
        String(r.source_adv_session_id) !== String(t.source_adv_session_id) ||
        String(r.target_adv_session_id) !== String(t.target_adv_session_id) || !equal(s, t.snapshot) ||
        s.activation !== b.activationAuditSeq || s.owner !== b.reviewerOwnerId ||
        s.planHash !== planHash ||
        !equal(s.confinement, b.confinementSnapshot) || !equal(s.source, endpoint) ||
        s.source.advSessionId !== Number(r.source_adv_session_id) ||
        s.target.advSessionId !== Number(r.target_adv_session_id) ||
        !isBlindReviewerBackendAgent(s.backend) || !s.target.nativeSessionId) return null;
    endpoint = { ...s.target, continuationId: Number(t.id) };
  }
  return endpoint;
}

/** Commit BEFORE calling the launcher. The original tuple is never rewritten. */
export async function reserveBlindReviewNativeAttempt(input: {
  permit: BlindReviewResumePermit; request: Record<string, unknown>;
}, deps: { sql?: Sql } = {}): Promise<BlindReviewResumePermit> {
  const { permit: p, request } = input;
  return (deps.sql ?? getOrgPg().sql).begin(async raw => {
    const tx = raw as unknown as Sql;
    const { binding: b, planHash } = await lockBlindReviewContinuationScope(tx, p.workspaceId, p.bindingId);
    requireLease(b, p.leaseId);
    if (!await blindReviewContinuationStorageInstalled(tx)) return refuse('continuation_storage_unavailable');
    const endpoint = await resolveBlindReviewEndpoint(tx, b);
    const source = endpoint && await native(tx, b.workspaceId, endpoint.advSessionId);
    if (!endpoint || !source || source.ended_at == null || source.resume_claim_key !== null ||
        !profile(source, b.reviewerOwnerId, endpoint) || p.recoveryBackend ||
        p.planSlug !== b.planSlug || p.activationAuditSeq !== b.activationAuditSeq ||
        p.reviewerOwnerId !== b.reviewerOwnerId || p.advSessionId !== endpoint.advSessionId ||
        p.nativeSessionId !== endpoint.nativeSessionId ||
        !equal(request.resume, { sessionId: endpoint.nativeSessionId }) || request.fork !== false ||
        request.headless !== true || request.harness !== b.harnessSlug ||
        Object.keys(request).some(key => !['resume', 'fork', 'headless', 'harness', 'brief', 'idempotencyKey'].includes(key)) ||
        typeof request.idempotencyKey !== 'string' || !request.idempotencyKey) return refuse('native_attempt_invalid');
    const snapshot: NativeSnapshot = { activation: b.activationAuditSeq, owner: b.reviewerOwnerId,
      planHash, confinement: b.confinementSnapshot, source: endpoint, backend: source.agent!,
      actor: BLIND_GAP_REVIEW_ACTOR, requestHash: requestHash(request),
      profile: { spec: source.launch_spec, argv: source.launch_argv } };
    const attemptKey = randomUUID();
    const [r] = await tx<Array<{ id: number | string }>>`INSERT INTO harness_shared.blind_review_continuation_custody
      (workspace_id, binding_id, event_kind, attempt_key, resume_lease_id, source_adv_session_id,
       target_adv_session_id, port_id, snapshot, evidence)
      VALUES (${b.workspaceId}, ${b.id}, 'native-reserved', ${attemptKey}, ${p.leaseId},
        ${endpoint.advSessionId}, ${endpoint.advSessionId}, NULL, ${tx.json(snapshot as never)}, '{}') RETURNING id`;
    return { ...p, nativeAttempt: { id: Number(r!.id), key: attemptKey, requestHash: snapshot.requestHash } };
  }) as Promise<BlindReviewResumePermit>;
}

/** Private preparation admission. The product resolver above has NO bypass.
 * Only this exact last reservation can inspect its preceding settled history. */
async function admitNativeAttempt(tx: Sql, p: BlindReviewResumePermit, claimKey: string | null = null) {
  const { binding: b, planHash } = await lockBlindReviewContinuationScope(tx, p.workspaceId, p.bindingId);
  requireLease(b, p.leaseId);
  const entries = await tx<CustodyEntry[]>`SELECT * FROM harness_shared.blind_review_continuation_custody
    WHERE workspace_id = ${b.workspaceId} AND binding_id = ${b.id} ORDER BY id LIMIT 65 FOR SHARE`;
  const r = entries.at(-1);
  if (!r || r.event_kind !== 'native-reserved' || Number(r.id) !== p.nativeAttempt?.id ||
      r.attempt_key !== p.nativeAttempt.key || r.snapshot.requestHash !== p.nativeAttempt.requestHash ||
      r.resume_lease_id !== p.leaseId || r.snapshot.actor !== BLIND_GAP_REVIEW_ACTOR ||
      r.snapshot.activation !== b.activationAuditSeq || r.snapshot.planHash !== planHash ||
      r.snapshot.owner !== b.reviewerOwnerId || !equal(r.snapshot.confinement, b.confinementSnapshot) ||
      p.planSlug !== b.planSlug || p.activationAuditSeq !== b.activationAuditSeq ||
      p.reviewerOwnerId !== b.reviewerOwnerId || p.recoveryBackend) return refuse('native_attempt_invalid');
  const endpoint = replayCustody(entries.slice(0, -1), b, planHash, { advSessionId: b.advSessionId,
    nativeSessionId: b.nativeSessionId, modelSpec: b.modelSpec, continuationId: null });
  const source = endpoint && await native(tx, b.workspaceId, endpoint.advSessionId);
  if (!endpoint || !equal(endpoint, r.snapshot.source) || p.advSessionId !== endpoint.advSessionId ||
      p.nativeSessionId !== endpoint.nativeSessionId || Number(r.source_adv_session_id) !== endpoint.advSessionId ||
      Number(r.target_adv_session_id) !== endpoint.advSessionId || r.port_id !== null ||
      !source || source.ended_at == null ||
      source.resume_claim_key !== claimKey || !profile(source, b.reviewerOwnerId, endpoint) ||
      source.agent !== r.snapshot.backend ||
      !equal({ spec: source.launch_spec, argv: source.launch_argv }, r.snapshot.profile)) return refuse('native_attempt_invalid');
  return { binding: b, endpoint, reservation: r };
}

export type BlindReviewNativeLaunchControl = {
  binding: Binding; endpoint: BlindReviewEndpoint;
  beforeNativeCreate: (claimKey: string | null, admissionReceiptId: string) => Promise<void>;
  confirmedStart: (proof: { nativeSessionId: string; admissionReceiptId: string; taskId: string }) => Promise<void>;
};

/** Reconcile a surviving exact native start after the launcher's host lost its
 * closure. This is a read/prove path, never effect admission or no-open proof.
 * Kernel cgroup membership joins the current managed host to the enrolled task;
 * owner/native identity alone cannot distinguish another same-owner process.
 * An unavailable local witness leaves the reservation unresolved. */
export async function reconcileBlindReviewNativeStart(tx: Sql, binding: Binding, deps: {
  findHost?: typeof findLiveHostAsync; readCgroup?: typeof readProcessCgroupPath;
} = {}): Promise<BlindReviewEndpoint | null> {
  const { binding: b, planHash } = await lockBlindReviewContinuationScope(tx, binding.workspaceId, binding.id);
  const entries = await tx<CustodyEntry[]>`SELECT * FROM harness_shared.blind_review_continuation_custody
    WHERE workspace_id = ${b.workspaceId} AND binding_id = ${b.id} ORDER BY id LIMIT 65 FOR SHARE`;
  const r = entries.at(-2), a = entries.at(-1);
  if (entries.length > 63 || r?.event_kind !== 'native-reserved' || a?.event_kind !== 'native-admitted' ||
      b.status !== 'resuming' || b.resumeLeaseId !== r.resume_lease_id ||
      typeof a.evidence.admissionReceiptId !== 'string') return null;
  const receiptId = a.evidence.admissionReceiptId;
  const [receipt] = await tx`SELECT receipt_id FROM harness_shared.resource_governor_admissions
    WHERE workspace_id = ${b.workspaceId} AND receipt_id = ${receiptId}
      AND namespace = 'agent-process' AND admission_class = 'agent' AND state = 'running'
      AND idempotency_key = ${`blind-review-native:${r.attempt_key}`}
      AND record->'metadata'->>'launchedBy' = ${BLIND_GAP_REVIEW_ACTOR}
      AND record->'metadata'->>'targetOwnerId' = ${b.reviewerOwnerId}
      AND record->'metadata'->>'blindReviewAttemptKey' = ${r.attempt_key} FOR SHARE`;
  const tasks = await tx<Array<{ task_id: string; scope_unit: string | null }>>`
    SELECT task_id, scope_unit FROM harness_shared.task_ledger
    WHERE workspace_id = ${b.workspaceId} AND launched_by = ${BLIND_GAP_REVIEW_ACTOR}
      AND class = 'agent-session' AND state = 'running' AND ended_at IS NULL AND pid > 0
      AND started_at >= ${r.created_at}
      AND detail->>'coordOwnerId' = ${b.reviewerOwnerId}
      AND detail->>'blindReviewAttemptKey' = ${r.attempt_key}
      AND detail->>'blindReviewAdmissionReceiptId' = ${receiptId}
      AND detail->>'blindReviewNativeSessionId' = ${r.snapshot.source.nativeSessionId}
    LIMIT 2 FOR SHARE`;
  const task = tasks[0];
  if (!receipt || tasks.length !== 1 || !task?.scope_unit ||
      taskIdFromScopeUnit(task.scope_unit) !== task.task_id) return null;
  const source = await native(tx, b.workspaceId, Number(r.source_adv_session_id));
  if (!source || source.ended_at !== null || source.resume_claim_key !== null ||
      source.agent !== r.snapshot.backend || !profile(source, b.reviewerOwnerId, r.snapshot.source) ||
      !equal({ spec: source.launch_spec, argv: source.launch_argv }, r.snapshot.profile)) return null;
  const findHost = deps.findHost ?? findLiveHostAsync, readCgroup = deps.readCgroup ?? readProcessCgroupPath;
  const host = await findHost(b.reviewerOwnerId);
  if (!host || host.ownerId !== b.reviewerOwnerId || Number(host.advSessionId) !== Number(source.id) ||
      !Number.isSafeInteger(host.ptyPid) || host.ptyPid! <= 0 ||
      !(host.startedAt >= new Date(r.created_at).getTime()) ||
      nativeSessionIdFromHost(host) !== r.snapshot.source.nativeSessionId ||
      !readCgroup(host.pid)?.split('/').includes(task.scope_unit)) return null;
  const again = await findHost(b.reviewerOwnerId);
  if (!again || !equal({ pid: host.pid, adv: host.advSessionId, start: host.startedAt,
      child: host.ptyPid, generation: host.childGeneration, native: nativeSessionIdFromHost(host) },
    { pid: again.pid, adv: again.advSessionId, start: again.startedAt,
      child: again.ptyPid, generation: again.childGeneration, native: nativeSessionIdFromHost(again) }) ||
      !readCgroup(again.pid)?.split('/').includes(task.scope_unit)) return null;
  const evidence = { outcome: 'native-started', attemptKey: r.attempt_key, requestHash: r.snapshot.requestHash,
    nativeSessionId: r.snapshot.source.nativeSessionId, advSessionId: Number(source.id),
    admissionReceiptId: receiptId, taskId: task.task_id,
    reconciledHost: { pid: host.pid, startedAt: host.startedAt, childGeneration: host.childGeneration ?? null } };
  // Reuse the product replay validator for every immutable reservation/admission
  // pin. No special ignore-pending flag reaches posting/runtime resolution.
  const endpoint = replayCustody([...entries, { ...r, id: -1, reservation_id: r.id,
    event_kind: 'native-settled', evidence }], b, planHash, { advSessionId: b.advSessionId,
    nativeSessionId: b.nativeSessionId, modelSpec: b.modelSpec, continuationId: null });
  if (!endpoint) return null;
  const [settled] = await tx<Array<{ id: number | string }>>`INSERT INTO harness_shared.blind_review_continuation_custody
    (workspace_id, binding_id, reservation_id, event_kind, attempt_key, resume_lease_id,
     source_adv_session_id, target_adv_session_id, port_id, snapshot, evidence)
    VALUES (${b.workspaceId}, ${b.id}, ${r.id}, 'native-settled', ${r.attempt_key}, ${r.resume_lease_id},
      ${r.source_adv_session_id}, ${r.target_adv_session_id}, NULL, ${tx.json(r.snapshot as never)},
      ${tx.json(evidence)}) RETURNING id`;
  return { ...endpoint, continuationId: Number(settled!.id) };
}

/** A return-shaped provider refusal is not proof. The recruiter must read the
 * canonical exact-attempt settlement before it can move to a port backend. */
export async function verifyBlindReviewNativeNoOpen(p: BlindReviewResumePermit, deps: { sql?: Sql } = {}) {
  if (!p.nativeAttempt) return false;
  return (deps.sql ?? getOrgPg().sql).begin(async raw => {
    const tx = raw as unknown as Sql;
    const { binding: b } = await lockBlindReviewContinuationScope(tx, p.workspaceId, p.bindingId);
    requireLease(b, p.leaseId);
    const [r] = await tx<NativeEntry[]>`SELECT * FROM harness_shared.blind_review_continuation_custody
      WHERE workspace_id = ${b.workspaceId} AND binding_id = ${b.id} AND reservation_id = ${p.nativeAttempt!.id}
        AND event_kind = 'native-settled' FOR SHARE`;
    return !!r && r.attempt_key === p.nativeAttempt!.key && r.resume_lease_id === p.leaseId &&
      r.snapshot.requestHash === p.nativeAttempt!.requestHash && r.evidence.outcome === 'no-native-open' &&
      !!await resolveBlindReviewEndpoint(tx, b);
  }) as Promise<boolean>;
}

/** Only the canonical launcher calls these closure-bound writers. JSON receipts,
 * isError, exit codes and missing hosts never settle an effect boundary. A crash
 * anywhere leaves the durable reservation unresolved. */
export async function withBlindReviewNativeLaunch<T>(input: {
  permit?: BlindReviewResumePermit; request: Record<string, unknown>; workspaceId: string;
  actor: string | null; systemRecruiter: boolean; confinement: unknown;
}, run: (control: BlindReviewNativeLaunchControl | null) => Promise<T>, deps: { sql?: Sql } = {}): Promise<T> {
  const p = input.permit;
  if (!p || p.recoveryBackend) return run(null);
  if (!p.nativeAttempt || input.actor !== BLIND_GAP_REVIEW_ACTOR || !input.systemRecruiter ||
      input.workspaceId !== p.workspaceId || requestHash(input.request) !== p.nativeAttempt.requestHash)
    return refuse('native_attempt_invalid');
  const sql = deps.sql ?? getOrgPg().sql;
  const admitted = await sql.begin(tx => admitNativeAttempt(tx as unknown as Sql, p));
  if (!equal(input.confinement, admitted.binding.confinementSnapshot)) return refuse('confinement_mismatch');
  let crossed = false, settled = false;
  let effectAdmission: { id: number; receiptId: string } | null = null;
  const settle = async (evidence: Record<string, unknown>) => {
    await sql.begin(async raw => {
      const tx = raw as unknown as Sql;
      const { binding: b, planHash } = await lockBlindReviewContinuationScope(tx, p.workspaceId, p.bindingId);
      const r = admitted.reservation;
      // Expiry cannot manufacture no-open proof, nor invalidate a real exact
      // receipt. Another lease/activation/profile still fails closed.
      if (b.resumeLeaseId !== p.leaseId || b.status !== 'resuming' || planHash !== r.snapshot.planHash ||
          !equal(b.confinementSnapshot, r.snapshot.confinement)) return refuse('native_attempt_invalid');
      const [last] = await tx<CustodyEntry[]>`SELECT * FROM harness_shared.blind_review_continuation_custody
        WHERE workspace_id = ${b.workspaceId} AND binding_id = ${b.id} ORDER BY id DESC LIMIT 1 FOR SHARE`;
      if (!last || Number(last.id) !== (effectAdmission?.id ?? Number(r.id))) return refuse('native_attempt_replayed');
      if (evidence.outcome === 'native-started') {
        const [task] = await tx`SELECT task_id FROM harness_shared.task_ledger
          WHERE workspace_id = ${b.workspaceId} AND task_id = ${String(evidence.taskId)}
            AND launched_by = ${BLIND_GAP_REVIEW_ACTOR} AND class = 'agent-session'
            AND detail->>'coordOwnerId' = ${b.reviewerOwnerId}
            AND detail->>'blindReviewAttemptKey' = ${r.attempt_key}
            AND detail->>'blindReviewAdmissionReceiptId' = ${String(evidence.admissionReceiptId)}
            AND detail->>'blindReviewNativeSessionId' = ${r.snapshot.source.nativeSessionId} AND pid > 0 FOR SHARE`;
        if (!task || evidence.admissionReceiptId !== effectAdmission?.receiptId) return refuse('native_receipt_invalid');
      }
      const proof = { ...evidence, attemptKey: r.attempt_key, requestHash: r.snapshot.requestHash };
      await tx`INSERT INTO harness_shared.blind_review_continuation_custody
        (workspace_id, binding_id, reservation_id, event_kind, attempt_key, resume_lease_id,
         source_adv_session_id, target_adv_session_id, port_id, snapshot, evidence)
        VALUES (${b.workspaceId}, ${b.id}, ${r.id}, 'native-settled', ${r.attempt_key}, ${p.leaseId},
          ${r.source_adv_session_id}, ${r.target_adv_session_id}, NULL,
          ${tx.json(r.snapshot as never)}, ${tx.json(proof as never)})`;
    });
    settled = true;
  };
  try {
    return await run({ binding: admitted.binding, endpoint: admitted.endpoint,
      beforeNativeCreate: async (claimKey, admissionReceiptId) => {
        if (crossed || settled) return refuse('native_attempt_replayed');
        // A lost admission-commit reply is not evidence of no native open.
        crossed = true;
        effectAdmission = await sql.begin(async raw => {
          const tx = raw as unknown as Sql;
          const { reservation: r, binding: b } = await admitNativeAttempt(tx, p, claimKey);
          const [receipt] = await tx`SELECT receipt_id FROM harness_shared.resource_governor_admissions
            WHERE workspace_id = ${b.workspaceId} AND receipt_id = ${admissionReceiptId}
              AND namespace = 'agent-process' AND admission_class = 'agent' AND state = 'running'
              AND idempotency_key = ${`blind-review-native:${r.attempt_key}`}
              AND record->'metadata'->>'launchedBy' = ${BLIND_GAP_REVIEW_ACTOR}
              AND record->'metadata'->>'targetOwnerId' = ${b.reviewerOwnerId}
              AND record->'metadata'->>'blindReviewAttemptKey' = ${r.attempt_key} FOR SHARE`;
          if (!receipt) return refuse('native_receipt_invalid');
          const [a] = await tx<Array<{ id: number | string }>>`INSERT INTO harness_shared.blind_review_continuation_custody
            (workspace_id, binding_id, reservation_id, event_kind, attempt_key, resume_lease_id,
             source_adv_session_id, target_adv_session_id, port_id, snapshot, evidence)
            VALUES (${b.workspaceId}, ${b.id}, ${r.id}, 'native-admitted', ${r.attempt_key}, ${p.leaseId},
              ${r.source_adv_session_id}, ${r.target_adv_session_id}, NULL, ${tx.json(r.snapshot as never)},
              ${tx.json({ admissionReceiptId })}) RETURNING id`;
          return { id: Number(a!.id), receiptId: admissionReceiptId };
        });
      },
      confirmedStart: async proof => {
        if (!crossed || !effectAdmission || settled || proof.nativeSessionId !== admitted.endpoint.nativeSessionId ||
            !proof.admissionReceiptId || !proof.taskId) return refuse('native_attempt_invalid');
        await settle({ outcome: 'native-started', ...proof, advSessionId: admitted.endpoint.advSessionId });
      } });
  } finally {
    if (!crossed && !settled) await settle({ outcome: 'no-native-open' });
  }
}

async function native(tx: Sql, ws: string, id: number): Promise<Native | null> {
  const [r] = await tx<Native[]>`SELECT * FROM harness_shared.adv_sessions
    WHERE workspace_id = ${ws} AND id = ${id} FOR UPDATE`;
  return r ?? null;
}
function profile(n: Native, owner: string, endpoint: Pick<BlindReviewEndpoint, 'nativeSessionId' | 'modelSpec'>) {
  const inspected = inspectBlindReviewAdvProfile(n, { workspaceId: n.workspace_id,
    reviewerOwnerId: owner, advSessionId: Number(n.id), nativeSessionId: endpoint.nativeSessionId,
    launchParentOwner: BLIND_GAP_REVIEW_ACTOR });
  return n.session_id === endpoint.nativeSessionId && inspected.ok &&
    inspected.accountRoute === 'auto' && inspected.modelSpec === endpoint.modelSpec;
}

/** Transport verified advSessionId is host metadata, never a request argument.
 * Its locked native row proves the other half of the authenticated endpoint. */
export async function verifyBlindReviewEndpointCaller(tx: Sql, b: Binding, authenticatedAdvSessionId?: number,
  authenticatedNative?: RequestOriginMetadata['nativeSession']) {
  if (!['ready', 'resuming', 'posted'].includes(b.status) ||
      !Number.isSafeInteger(authenticatedAdvSessionId) || authenticatedAdvSessionId! <= 0) return false;
  const endpoint = await resolveBlindReviewEndpoint(tx, b);
  if (!endpoint || endpoint.advSessionId !== authenticatedAdvSessionId) return false;
  if (endpoint.requiresNativeProof && (authenticatedNative?.binding !== 'bound' ||
      authenticatedNative.candidateAdvSessionId !== endpoint.advSessionId ||
      authenticatedNative.valueFingerprint !== createHash('sha256').update(endpoint.nativeSessionId).digest('hex')))
    return false;
  const n = await native(tx, b.workspaceId, endpoint.advSessionId);
  return !!n && n.ended_at === null && profile(n, b.reviewerOwnerId, endpoint);
}

/** Keep the material post and its binding receipt inside this authority scope.
 * Only host-authenticated metadata may supply the native incarnation. */
export async function withAuthenticatedBlindReviewEndpoint<T>(input: {
  workspaceId: string; bindingId: number; reviewerOwnerId: string; authenticatedAdvSessionId?: number;
  authenticatedNative?: RequestOriginMetadata['nativeSession'];
}, write: (tx: Sql, binding: Binding) => Promise<T>, deps: { sql?: Sql } = {}): Promise<T> {
  return (deps.sql ?? getOrgPg().sql).begin(async raw => {
    const tx = raw as unknown as Sql;
    const { binding } = await lockBlindReviewContinuationScope(tx, input.workspaceId, input.bindingId);
    const [policy] = await tx<Array<{ live: boolean | null }>>`
      SELECT (payload->'sessions'->${binding.reviewerOwnerId}->>'expiresAt')::timestamptz
        > clock_timestamp() AS live FROM harness_shared.operator_session_confinements
      WHERE workspace_id = ${input.workspaceId} FOR SHARE`;
    if (binding.reviewerOwnerId !== input.reviewerOwnerId || policy?.live !== true ||
        !await verifyBlindReviewEndpointCaller(tx, binding, input.authenticatedAdvSessionId, input.authenticatedNative))
      return refuse('authenticated_reviewer_endpoint_mismatch');
    return write(tx, binding);
  }) as Promise<T>;
}

/** Central lock order: plan advisory -> plan row -> binding -> confinement ->
 * custody -> native/port rows. All authority-changing callers use this scope. */
export async function lockBlindReviewContinuationScope(tx: Sql, workspaceId: string, bindingId: number) {
  const [scope] = await tx<Array<{ harness_slug: string; plan_slug: string }>>`
    SELECT harness_slug, plan_slug FROM harness_shared.plan_blind_review_sessions
    WHERE workspace_id = ${workspaceId} AND id = ${bindingId}`;
  if (!scope) return refuse('binding_not_found');
  await acquirePlanAdvisoryLock(tx, planAdvisoryLockKey(workspaceId, scope.harness_slug, scope.plan_slug));
  await tx`SELECT set_config('lock_timeout', '5000', true)`;
  const [plan] = await tx<Array<{ content_hash: string }>>`SELECT content_hash FROM harness_shared.harness_plans
    WHERE workspace_id = ${workspaceId} AND harness_slug = ${scope.harness_slug}
      AND plan_slug = ${scope.plan_slug} FOR SHARE`;
  const [r] = await tx`SELECT * FROM harness_shared.plan_blind_review_sessions
    WHERE workspace_id = ${workspaceId} AND id = ${bindingId} FOR UPDATE`;
  if (!plan || !r || r.harness_slug !== scope.harness_slug || r.plan_slug !== scope.plan_slug ||
      r.launch_parent_owner !== BLIND_GAP_REVIEW_ACTOR || r.account_route !== 'auto' ||
      !r.reviewer_owner_id || !r.native_session_id || !r.adv_session_id) return refuse('binding_unavailable');
  if (!await currentActivation(tx, { workspaceId, harnessSlug: scope.harness_slug,
    planSlug: scope.plan_slug, activationAuditSeq: Number(r.activation_audit_seq) }, plan.content_hash))
    return refuse('activation_audit_mismatch');
  const [successor] = await tx`SELECT id FROM harness_shared.plan_blind_review_sessions
    WHERE workspace_id = ${workspaceId} AND plan_slug = ${scope.plan_slug}
      AND activation_audit_seq = ${r.activation_audit_seq} AND id > ${bindingId} AND status <> 'failed' LIMIT 1`;
  if (successor) return refuse('binding_superseded');
  const [policy] = await tx`SELECT payload->'sessions'->${r.reviewer_owner_id}->'confinement' AS confinement
    FROM harness_shared.operator_session_confinements WHERE workspace_id = ${workspaceId} FOR SHARE`;
  if (!policy?.confinement || !equal(policy.confinement, r.confinement_snapshot)) return refuse('confinement_mismatch');
  const binding: Binding = { id: Number(r.id), workspaceId, harnessSlug: r.harness_slug, planSlug: r.plan_slug,
    activationAuditSeq: r.activation_audit_seq, reviewerOwnerId: r.reviewer_owner_id,
    advSessionId: Number(r.adv_session_id), nativeSessionId: r.native_session_id,
    launchParentOwner: r.launch_parent_owner, accountRoute: r.account_route, modelSpec: r.model_spec,
    confinementSnapshot: r.confinement_snapshot, status: r.status, resumeLeaseId: r.resume_lease_id,
    resumeLeaseExpiresAt: r.resume_lease_expires_at instanceof Date ? r.resume_lease_expires_at.toISOString()
      : r.resume_lease_expires_at, reviewId: r.review_id == null ? null : Number(r.review_id) };
  return { binding, planHash: plan.content_hash };
}
function requireLease(b: Binding, leaseId: string) {
  if (b.status !== 'resuming' || b.resumeLeaseId !== leaseId || !b.resumeLeaseExpiresAt ||
      !(Date.parse(b.resumeLeaseExpiresAt) > Date.now())) refuse('resume_lease_lost');
}
async function portRow(tx: Sql, ws: string, id: string): Promise<SessionPortRow> {
  const [p] = await tx`SELECT * FROM harness_shared.session_ports
    WHERE workspace_id = ${ws} AND id = ${id} FOR UPDATE`;
  if (!p) return refuse('recovery_port_invalid');
  return { id: p.id, workspaceId: p.workspace_id, idempotencyKey: p.logical_request_key ?? p.idempotency_key,
    protocolVersion: p.protocol_version, sourceAdvSessionId: Number(p.source_adv_session_id),
    targetAdvSessionId: p.target_adv_session_id == null ? null : Number(p.target_adv_session_id),
    sourceBackend: p.source_backend, targetBackend: p.target_backend, targetModel: p.target_model,
    status: p.status, sourceHash: p.source_hash, normalizedHash: p.normalized_hash,
    renderedHash: p.rendered_hash, tokenHash: p.token_hash, artifactPath: p.artifact_path,
    metadata: p.metadata, error: p.error, preparedAt: String(p.prepared_at), pendingAt: String(p.pending_at),
    deliveredAt: String(p.delivered_at), failedAt: p.failed_at == null ? null : String(p.failed_at),
    expiresAt: p.expires_at instanceof Date ? p.expires_at.toISOString() : String(p.expires_at) };
}
const hashes = (p: SessionPortRow) => ({ source: p.sourceHash, normalized: p.normalizedHash,
  rendered: p.renderedHash, token: p.tokenHash });
type ReserveInput = { workspaceId: string; bindingId: number; leaseId: string; portId: string };

/** Bootstrap derives recruiter provenance from the locked logical binding, not
 * launched_by, a claimed owner, or mutable port metadata. This does not grant
 * endpoint authority: the reservation below must commit before native launch. */
export async function authorizeBlindReviewPortBootstrap(input: {
  workspaceId: string; portId: string; targetAdvSessionId: number; agent: string;
  model: string | null; account: string | null; headless: boolean;
}, deps: { sql?: Sql } = {}): Promise<(ReserveInput & { launchParentOwner: string }) | null> {
  return (deps.sql ?? getOrgPg().sql).begin(async raw => {
    const tx = raw as unknown as Sql;
    // Scope discovery is non-locking. Acquire the plan before native/port locks.
    const [portScope] = await tx<Array<{ source_adv_session_id: number | string }>>`
      SELECT source_adv_session_id FROM harness_shared.session_ports
      WHERE workspace_id = ${input.workspaceId} AND id = ${input.portId}`;
    if (!portScope) return refuse('recovery_port_invalid');
    const [sourceScope] = await tx<Native[]>`SELECT * FROM harness_shared.adv_sessions
      WHERE workspace_id = ${input.workspaceId} AND id = ${portScope.source_adv_session_id}`;
    let [candidate] = await tx<Array<{ id: number | string }>>`
      SELECT id FROM harness_shared.plan_blind_review_sessions WHERE workspace_id = ${input.workspaceId}
        AND adv_session_id = ${portScope.source_adv_session_id} AND launch_parent_owner = ${BLIND_GAP_REVIEW_ACTOR}`;
    const installed = await blindReviewContinuationStorageInstalled(tx);
    if (!candidate && installed) [candidate] = await tx<Array<{ id: number | string }>>`
      SELECT binding_id AS id FROM harness_shared.blind_review_continuation_custody
      WHERE workspace_id = ${input.workspaceId} AND target_adv_session_id = ${portScope.source_adv_session_id}
      ORDER BY id DESC LIMIT 1`;
    const recruiterSource = (sourceScope?.launch_spec as { launchedBy?: string } | null)?.launchedBy === BLIND_GAP_REVIEW_ACTOR;
    if (!candidate) return recruiterSource ? refuse('binding_not_found') : null;
    if (!installed) return refuse('continuation_storage_unavailable');
    const { binding } = await lockBlindReviewContinuationScope(tx, input.workspaceId, Number(candidate.id));
    if (!binding.resumeLeaseId) return refuse('resume_lease_lost');
    requireLease(binding, binding.resumeLeaseId);
    const endpoint = await resolveBlindReviewEndpoint(tx, binding);
    if (!endpoint || endpoint.advSessionId !== Number(portScope.source_adv_session_id)) return refuse('continuation_uncertain');
    const source = await native(tx, input.workspaceId, endpoint.advSessionId);
    const target = await native(tx, input.workspaceId, input.targetAdvSessionId);
    const port = await portRow(tx, input.workspaceId, input.portId);
    if (!source || source.ended_at == null || source.resume_claim_key !== null ||
        !profile(source, binding.reviewerOwnerId, endpoint) || !target || target.ended_at !== null ||
        target.coord_owner_id !== binding.reviewerOwnerId || !target.session_id ||
        port.sourceAdvSessionId !== endpoint.advSessionId || port.targetAdvSessionId !== input.targetAdvSessionId ||
        target.port_id !== port.id || Number(target.port_source_adv_session_id) !== endpoint.advSessionId ||
        port.status !== 'pending' || port.sourceBackend !== source.agent || port.targetBackend !== target.agent ||
        target.agent !== input.agent || !isBlindReviewerBackendAgent(input.agent) || target.agent === source.agent ||
        port.targetModel !== input.model || input.account !== 'auto' || input.headless !== true ||
        port.metadata.sourceCoordOwnerId !== binding.reviewerOwnerId ||
        port.metadata.targetCoordOwnerId !== binding.reviewerOwnerId ||
        port.metadata.targetNativeSessionId !== target.session_id) return refuse('recovery_port_invalid');
    return { workspaceId: input.workspaceId, bindingId: binding.id, leaseId: binding.resumeLeaseId,
      portId: port.id, launchParentOwner: binding.launchParentOwner };
  }) as Promise<(ReserveInput & { launchParentOwner: string }) | null>;
}

/** A persistence acknowledgement may settle only the exact pre-native custody
 * reservation. Port delivery itself cannot mint a blind-review endpoint. */
export async function finalizeBlindReviewPortCustody(input: {
  workspaceId: string; portId: string; targetAdvSessionId: number;
}, deps: { sql?: Sql } = {}) {
  const sql = deps.sql ?? getOrgPg().sql;
  if (!await blindReviewContinuationStorageInstalled(sql)) return null;
  const [r] = await sql<Entry[]>`SELECT * FROM harness_shared.blind_review_continuation_custody
    WHERE workspace_id = ${input.workspaceId} AND port_id = ${input.portId} AND event_kind = 'reserved'`;
  if (!r) return null;
  if (Number(r.target_adv_session_id) !== input.targetAdvSessionId) return refuse('recovery_port_invalid');
  return finalizeBlindReviewContinuation({ workspaceId: input.workspaceId, bindingId: Number(r.binding_id),
    leaseId: r.resume_lease_id, reservationId: Number(r.id) }, { sql });
}

/** The maintained port writer must have pinned its exact prepared target before
 * this call. This reservation must commit BEFORE native execution can begin. */
export async function reserveBlindReviewContinuation(input: ReserveInput, deps: { sql?: Sql } = {}) {
  const sql = deps.sql ?? getOrgPg().sql;
  return sql.begin(async raw => {
    const tx = raw as unknown as Sql;
    const { binding: b, planHash } = await lockBlindReviewContinuationScope(tx, input.workspaceId, input.bindingId);
    requireLease(b, input.leaseId);
    const [existing] = await tx<Entry[]>`SELECT * FROM harness_shared.blind_review_continuation_custody
      WHERE workspace_id = ${input.workspaceId} AND binding_id = ${b.id}
        AND resume_lease_id = ${input.leaseId} AND event_kind = 'reserved' FOR SHARE`;
    if (existing) {
      if (existing.port_id !== input.portId || existing.snapshot.planHash !== planHash) return refuse('continuation_conflict');
      return { reservationId: Number(existing.id) };
    }
    const sourceEndpoint = await resolveBlindReviewEndpoint(tx, b);
    if (!sourceEndpoint) return refuse('continuation_uncertain');
    const source = await native(tx, b.workspaceId, sourceEndpoint.advSessionId);
    const port = await portRow(tx, b.workspaceId, input.portId);
    const target = port.targetAdvSessionId == null ? null : await native(tx, b.workspaceId, port.targetAdvSessionId);
    const targetEndpoint = target && { advSessionId: Number(target.id), nativeSessionId: target.session_id!, modelSpec: port.targetModel };
    if (!source || source.ended_at == null || source.resume_claim_key !== null ||
        !profile(source, b.reviewerOwnerId, sourceEndpoint) || !target || !targetEndpoint ||
        target.ended_at !== null || !target.session_id || target.session_id === source.session_id ||
        !profile(target, b.reviewerOwnerId, targetEndpoint) || target.agent === source.agent ||
        port.sourceAdvSessionId !== sourceEndpoint.advSessionId || port.sourceBackend !== source.agent ||
        port.targetBackend !== target.agent || !['pending', 'delivered'].includes(port.status) ||
        target.port_id !== port.id || Number(target.port_source_adv_session_id) !== sourceEndpoint.advSessionId ||
        port.metadata.sourceCoordOwnerId !== b.reviewerOwnerId || port.metadata.targetCoordOwnerId !== b.reviewerOwnerId ||
        port.metadata.targetNativeSessionId !== target.session_id ||
        typeof port.metadata.bootstrapRequestHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(port.metadata.bootstrapRequestHash) ||
        Object.values(hashes(port)).some(h => !/^[a-f0-9]{64}$/.test(h)) ||
        !(Date.parse(port.expiresAt) > Date.now())) return refuse('recovery_port_invalid');
    const snapshot: Snapshot = { activation: b.activationAuditSeq, owner: b.reviewerOwnerId, planHash,
      confinement: b.confinementSnapshot, source: sourceEndpoint, target: targetEndpoint,
      backend: target.agent!, bootstrapHash: port.metadata.bootstrapRequestHash, hashes: hashes(port) };
    const [entry] = await tx<Array<{ id: number | string }>>`INSERT INTO harness_shared.blind_review_continuation_custody
      (workspace_id, binding_id, event_kind, resume_lease_id, source_adv_session_id, target_adv_session_id,
       port_id, snapshot, evidence) VALUES (${b.workspaceId}, ${b.id}, 'reserved', ${input.leaseId},
        ${sourceEndpoint.advSessionId}, ${targetEndpoint.advSessionId}, ${port.id}, ${tx.json(snapshot as never)}, '{}') RETURNING id`;
    return { reservationId: Number(entry!.id) };
  });
}

/** Consumes the existing lease and appends custody in the SAME transaction.
 * Port delivery proves history persistence only; model pickup is separate. */
export async function finalizeBlindReviewContinuation(input: Omit<ReserveInput, 'portId'> & { reservationId: number },
  deps: { sql?: Sql } = {}) {
  const sql = deps.sql ?? getOrgPg().sql;
  return sql.begin(async raw => {
    const tx = raw as unknown as Sql;
    const { binding: b, planHash } = await lockBlindReviewContinuationScope(tx, input.workspaceId, input.bindingId);
    const [r] = await tx<Entry[]>`SELECT * FROM harness_shared.blind_review_continuation_custody
      WHERE workspace_id = ${b.workspaceId} AND binding_id = ${b.id} AND id = ${input.reservationId}
        AND event_kind = 'reserved' FOR SHARE`;
    if (!r || r.resume_lease_id !== input.leaseId || r.snapshot.planHash !== planHash ||
        !equal(r.snapshot.confinement, b.confinementSnapshot)) return refuse('continuation_conflict');
    const [done] = await tx<Entry[]>`SELECT * FROM harness_shared.blind_review_continuation_custody
      WHERE workspace_id = ${b.workspaceId} AND reservation_id = ${r.id} AND event_kind = 'transferred' FOR SHARE`;
    if (done) {
      const endpoint = await resolveBlindReviewEndpoint(tx, b);
      if (!endpoint || endpoint.continuationId !== Number(done.id)) return refuse('continuation_conflict');
      return endpoint;
    }
    requireLease(b, input.leaseId);
    const source = await native(tx, b.workspaceId, Number(r.source_adv_session_id));
    const target = await native(tx, b.workspaceId, Number(r.target_adv_session_id));
    const port = await portRow(tx, b.workspaceId, r.port_id);
    if (!source || !target || !equal(hashes(port), r.snapshot.hashes) ||
        port.metadata.bootstrapRequestHash !== r.snapshot.bootstrapHash ||
        !profile(source, b.reviewerOwnerId, r.snapshot.source) || !profile(target, b.reviewerOwnerId, r.snapshot.target) ||
        target.session_id !== r.snapshot.target.nativeSessionId || target.agent !== r.snapshot.backend ||
        port.targetAdvSessionId !== r.snapshot.target.advSessionId) return refuse('recovery_port_invalid');
    const proof = verifyBlindReviewRecoveryPort({ binding: { ...b, ...r.snapshot.source }, source, target, port });
    if (!proof.ok) return refuse(proof.code);
    const [entry] = await tx<Array<{ id: number | string }>>`INSERT INTO harness_shared.blind_review_continuation_custody
      (workspace_id, binding_id, reservation_id, event_kind, resume_lease_id, source_adv_session_id,
       target_adv_session_id, port_id, snapshot, evidence)
      VALUES (${b.workspaceId}, ${b.id}, ${r.id}, 'transferred', ${input.leaseId}, ${r.source_adv_session_id},
        ${r.target_adv_session_id}, ${r.port_id}, ${tx.json(r.snapshot as never)}, ${tx.json(port.metadata as never)}) RETURNING id`;
    const changed = await tx`UPDATE harness_shared.plan_blind_review_sessions SET status = 'ready',
      resume_lease_id = NULL, resume_lease_expires_at = NULL, updated_at = clock_timestamp()
      WHERE workspace_id = ${b.workspaceId} AND id = ${b.id} AND resume_lease_id = ${input.leaseId}
        AND resume_lease_expires_at > clock_timestamp() AND status = 'resuming' RETURNING id`;
    if (changed.length !== 1) return refuse('resume_lease_lost');
    return { ...r.snapshot.target, continuationId: Number(entry!.id) };
  });
}
