/** D-001: one immutable logical binding, append-only native continuation custody.
 * These functions use the supplied transaction, never a same-owner latest row. */
import { isDeepStrictEqual as equal } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { acquirePlanAdvisoryLock, planAdvisoryLockKey } from './agent-tools/plans/plan-lock-key';
import { BLIND_GAP_REVIEW_ACTOR, inspectBlindReviewAdvProfile, verifyBlindReviewRecoveryPort,
  type BlindReviewSessionBinding as Binding, type BlindReviewResumePermit } from './blind-review-session-bindings';
import { isBlindReviewerBackendAgent } from './blind-reviewer-backends';
import type { SessionPortRow } from './session-port/store';
import { findLiveHostAsync } from './events/await/psu-pty-discovery';
import { nativeSessionIdFromHost } from './agent-launch-core';
import { readProcessCgroupPath } from './task-manager/cgroup-read';
import { taskIdFromScopeUnit } from './task-manager/types';

type Sql = ReturnType<typeof getOrgPg>['sql'];
type Native = Parameters<typeof verifyBlindReviewRecoveryPort>[0]['target'] & { resume_claim_key: string | null };
export type BlindReviewEndpoint = { advSessionId: number; nativeSessionId: string;
  modelSpec: string | null; continuationId: number | null };
type Snapshot = { activation: number; owner: string; planHash: string; confinement: Binding['confinementSnapshot'];
  source: BlindReviewEndpoint; target: Omit<BlindReviewEndpoint, 'continuationId'>; backend: string;
  bootstrapHash: string; hashes: { source: string; normalized: string; rendered: string; token: string } };
type Entry = { id: number | string; workspace_id: string; binding_id: number | string;
  reservation_id: number | string | null; event_kind: 'reserved' | 'transferred'; resume_lease_id: string;
  source_adv_session_id: number | string; target_adv_session_id: number | string; port_id: string;
  snapshot: Snapshot; evidence: Record<string, unknown>; created_at: Date | string };
type NativeSnapshot = Pick<Snapshot, 'activation' | 'owner' | 'planHash' | 'confinement' | 'source' | 'backend'> & {
  actor: string; requestHash: string; profile: { spec: unknown; argv: unknown };
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
          !['no-native-open', 'native-started'].includes(String(t.evidence.outcome))) return null;
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
export async function verifyBlindReviewEndpointCaller(tx: Sql, b: Binding, authenticatedAdvSessionId?: number) {
  if (!['ready', 'resuming', 'posted'].includes(b.status) ||
      !Number.isSafeInteger(authenticatedAdvSessionId) || authenticatedAdvSessionId! <= 0) return false;
  const endpoint = await resolveBlindReviewEndpoint(tx, b);
  if (!endpoint || endpoint.advSessionId !== authenticatedAdvSessionId) return false;
  const n = await native(tx, b.workspaceId, endpoint.advSessionId);
  return !!n && n.ended_at === null && profile(n, b.reviewerOwnerId, endpoint);
}

/** Keep the material post and its binding receipt inside this authority scope.
 * Only host-authenticated metadata may supply the native incarnation. */
export async function withAuthenticatedBlindReviewEndpoint<T>(input: {
  workspaceId: string; bindingId: number; reviewerOwnerId: string; authenticatedAdvSessionId?: number;
}, write: (tx: Sql, binding: Binding) => Promise<T>, deps: { sql?: Sql } = {}): Promise<T> {
  return (deps.sql ?? getOrgPg().sql).begin(async raw => {
    const tx = raw as unknown as Sql;
    const { binding } = await lockBlindReviewContinuationScope(tx, input.workspaceId, input.bindingId);
    const [policy] = await tx<Array<{ live: boolean | null }>>`
      SELECT (payload->'sessions'->${binding.reviewerOwnerId}->>'expiresAt')::timestamptz
        > clock_timestamp() AS live FROM harness_shared.operator_session_confinements
      WHERE workspace_id = ${input.workspaceId} FOR SHARE`;
    if (binding.reviewerOwnerId !== input.reviewerOwnerId || policy?.live !== true ||
        !await verifyBlindReviewEndpointCaller(tx, binding, input.authenticatedAdvSessionId))
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
