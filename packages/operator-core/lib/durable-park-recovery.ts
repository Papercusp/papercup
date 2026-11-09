/** Automatic park recovery composes the existing producer-health await store.
 * These decisions run under the admission row lock; none grants custody, clears
 * a safety hold, or establishes that a release condition has been satisfied. */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { DurableParkReleaseContract } from './work-items-durable-park-audit';
import type { ProducerHealthCertificate } from './events/await/verified-wait';
import type { SessionState } from './agent-tools/coordination/presence-wakeability';

export interface ParkRecoveryPolicy {
  initialMs: number;
  extensionMs: number;
  maxExtensions: number;
  maxAgeMs: number;
}

export const AUTOMATIC_PARK_RECOVERY_POLICY: Readonly<ParkRecoveryPolicy> = Object.freeze({
  initialMs: 30 * 60_000,
  extensionMs: 30 * 60_000,
  maxExtensions: 2,
  maxAgeMs: 90 * 60_000,
});
export const PARK_RECOVERY_PRODUCER = 'durable-park-recovery';
export const PARK_RECOVERY_CHECK_INTERVAL_MS = 60_000;

/** Inputs come from durable task-scoped writers, never session liveness. The
 * sequence is a writer's monotonic ledger/revision number for this subject. */
export interface ParkProgressEvidence {
  kind: 'checkpoint' | 'task' | 'test' | 'artifact' | 'publication';
  subjectRef: string;
  sequence: number;
  persistedAtMs: number;
  evidenceRef: string;
}

export interface ParkRecoveryReceipt {
  version: 1;
  id: string;
  workspaceId: string;
  harness: string;
  workItemId: string;
  custodianId: string;
  condition: Pick<DurableParkReleaseContract, 'condition' | 'trigger' | 'owner'>;
  generation: number | null;
  dependencyRefs: string[];
  admittedAtMs: number;
  deadlineMs: number;
  absoluteDeadlineMs: number;
  policy: ParkRecoveryPolicy;
  extensions: number;
  state: 'waiting' | 'recovery' | 'retired';
  progress: Record<string, ParkProgressEvidence>;
}

const PROGRESS_KINDS = new Set(['checkpoint', 'task', 'test', 'artifact', 'publication']);
const progressKey = (evidence: ParkProgressEvidence) => JSON.stringify([evidence.kind, evidence.subjectRef]);
const instant = (value: number) => Number.isSafeInteger(value) && value >= 0;

export function validateParkRecoveryPolicy(policy: ParkRecoveryPolicy): void {
  if (![policy.initialMs, policy.extensionMs, policy.maxAgeMs].every(value =>
    Number.isSafeInteger(value) && value > 0) ||
    !Number.isSafeInteger(policy.maxExtensions) || policy.maxExtensions < 0 ||
    policy.initialMs > policy.maxAgeMs) {
    throw new RangeError('automatic park recovery requires a finite valid policy');
  }
}

function validEvidence(evidence: ParkProgressEvidence): boolean {
  return PROGRESS_KINDS.has(evidence.kind) && Boolean(evidence.subjectRef?.trim()) &&
    Number.isSafeInteger(evidence.sequence) && evidence.sequence >= 0 &&
    instant(evidence.persistedAtMs) && Boolean(evidence.evidenceRef?.trim());
}

/** Server-derived admission. Persist this complete value with the park and await,
 * and read it on replay rather than deriving another id or resetting its clock. */
export function createParkRecoveryReceipt(input: {
  workspaceId: string;
  harness: string;
  workItemId: string;
  custodianId?: string;
  condition: ParkRecoveryReceipt['condition'];
  generation: number | null;
  dependencyRefs?: string[];
  admittedAtMs: number;
  baseline?: ParkProgressEvidence[];
  policy?: ParkRecoveryPolicy;
}): ParkRecoveryReceipt {
  const policy = { ...(input.policy ?? AUTOMATIC_PARK_RECOVERY_POLICY) };
  validateParkRecoveryPolicy(policy);
  if (!instant(input.admittedAtMs) || !instant(input.admittedAtMs + policy.maxAgeMs) ||
    typeof input.harness !== 'string' ||
    ![input.workspaceId, input.workItemId, input.condition.condition,
      input.condition.trigger, input.condition.owner].every(value => value?.trim()) ||
    (input.generation !== null && (!Number.isSafeInteger(input.generation) || input.generation < 1))) {
    throw new Error('automatic park recovery requires complete scoped admission identity');
  }
  const condition = { condition: input.condition.condition, trigger: input.condition.trigger,
    owner: input.condition.owner };
  const custodianId = input.custodianId ?? condition.owner;
  if (!custodianId.trim()) throw new Error('automatic park recovery requires its delivery custodian');
  const dependencyRefs = [...new Set(input.dependencyRefs ?? [])].sort();
  if (dependencyRefs.some(ref => !ref.trim())) throw new Error('empty park dependency identity');
  const progress: ParkRecoveryReceipt['progress'] = {};
  for (const evidence of input.baseline ?? []) {
    if (!validEvidence(evidence) || evidence.persistedAtMs > input.admittedAtMs ||
      ![input.workItemId, ...dependencyRefs].includes(evidence.subjectRef)) {
      throw new Error('invalid automatic park recovery baseline');
    }
    const key = progressKey(evidence);
    const prior = progress[key];
    if (!prior || evidence.sequence > prior.sequence) progress[key] = { ...evidence };
  }
  const id = `park-recovery:${createHash('sha256').update(JSON.stringify([
    input.workspaceId, input.harness, input.workItemId, custodianId, condition, input.generation,
    dependencyRefs, input.admittedAtMs,
  ])).digest('hex')}`;
  return { version: 1, id, workspaceId: input.workspaceId, harness: input.harness,
    workItemId: input.workItemId, custodianId, condition, generation: input.generation, dependencyRefs,
    admittedAtMs: input.admittedAtMs, deadlineMs: input.admittedAtMs + policy.initialMs,
    absoluteDeadlineMs: input.admittedAtMs + policy.maxAgeMs, policy, extensions: 0,
    state: 'waiting', progress };
}

/** The durable caller serializes this decision with timeout on the SAME row.
 * Expiry is inclusive: evidence arriving at/after a deadline cannot resurrect it. */
export function renewParkRecovery(
  receipt: ParkRecoveryReceipt,
  evidence: ParkProgressEvidence,
  nowMs: number,
): { accepted: boolean; receipt: ParkRecoveryReceipt } {
  validateParkRecoveryPolicy(receipt.policy);
  const prior = receipt.progress[progressKey(evidence)];
  if (!instant(nowMs) || receipt.state !== 'waiting' || nowMs >= receipt.deadlineMs ||
    nowMs >= receipt.absoluteDeadlineMs || receipt.extensions >= receipt.policy.maxExtensions ||
    !validEvidence(evidence) ||
    ![receipt.workItemId, ...receipt.dependencyRefs].includes(evidence.subjectRef) ||
    evidence.persistedAtMs <= receipt.admittedAtMs || evidence.persistedAtMs > nowMs ||
    (prior && (evidence.sequence <= prior.sequence || evidence.persistedAtMs <= prior.persistedAtMs ||
      evidence.evidenceRef === prior.evidenceRef))) {
    return { accepted: false, receipt };
  }
  const deadlineMs = Math.min(receipt.deadlineMs + receipt.policy.extensionMs, receipt.absoluteDeadlineMs);
  if (deadlineMs <= receipt.deadlineMs) return { accepted: false, receipt };
  return { accepted: true, receipt: { ...receipt, deadlineMs, extensions: receipt.extensions + 1,
    progress: { ...receipt.progress, [progressKey(evidence)]: { ...evidence } } } };
}

/** Notification authority only. The recovery id is admission's stable identity;
 * no event, deadline, or successor election can turn it into qualification. */
export function expireParkRecovery(receipt: ParkRecoveryReceipt, nowMs: number): ParkRecoveryReceipt {
  if (!instant(nowMs)) throw new RangeError('invalid recovery clock');
  return receipt.state === 'waiting' && nowMs >= receipt.deadlineMs
    ? { ...receipt, state: 'recovery' } : receipt;
}

export function parkRecoveryCertificate(receipt: ParkRecoveryReceipt,
  checkedAtMs = receipt.admittedAtMs): ProducerHealthCertificate {
  return { version: 1, producer: { kind: PARK_RECOVERY_PRODUCER, id: receipt.id },
    owner: { ownerId: receipt.custodianId, workItemId: receipt.workItemId },
    issuedAtMs: receipt.admittedAtMs, lastProgressAtMs: null, lastFireAtMs: null,
    expectedCadenceMs: receipt.policy.initialMs, verificationDeadlineMs: receipt.deadlineMs,
    details: { parkRecovery: receipt,
      nextCheckAtMs: Math.min(checkedAtMs + PARK_RECOVERY_CHECK_INTERVAL_MS, receipt.deadlineMs) } };
}

export interface ParkRecoveryAdmission {
  receipt: ParkRecoveryReceipt;
  awaitId: number;
  recoveryWorkItemId?: string;
}

/** An exact retry is read-only even if the original park is now a blocker.
 * The transactional admission repeats this check after taking its row lock. */
export function matchingParkRecoveryAdmission(value: unknown, input: {
  workItemId: string; parkedBy: string; releaseContract: DurableParkReleaseContract;
}): ParkRecoveryAdmission | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const payload = value as Record<string, unknown>;
  const prior = (payload?.claim_hold_release as { recovery?: ParkRecoveryAdmission } | undefined)?.recovery;
  return payload?._claimHold === true && prior?.receipt?.workItemId === input.workItemId &&
    prior.receipt.custodianId === input.parkedBy &&
    prior.receipt.condition.condition === input.releaseContract.condition &&
    prior.receipt.condition.trigger === input.releaseContract.trigger &&
    prior.receipt.condition.owner === input.releaseContract.owner ? prior : undefined;
}

/** An unchanged result must roll back the surrounding release/decision/checkpoint
 * too. The public release catches this only outside its transaction, before any
 * remote lane, claim-watch or coordination-lease cleanup. */
export class ParkRecoveryAdmissionUnchanged extends Error {
  readonly code = 'park_recovery_admission_unchanged';
  constructor(readonly disposition: 'already-satisfied' | 'replayed',
    readonly admission?: ParkRecoveryAdmission) {
    super(`automatic park admission ${disposition}`);
  }
}

/** Release calls this before acquiring the item write lock. Producer settlement
 * takes the same event-key -> item order, so admission must never invert it. */
export async function lockParkRecoveryCondition(tx: TransactionSql, trigger: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'event-announce:' + trigger}, 0))`;
}

/** A blocker preflight can observe qualification after the public admission
 * probe. Resolve that winner under the same producer lock before returning a
 * stale deferral refusal. This performs no park, claim or decision writes. */
export async function assertParkRecoveryPendingInTransaction(tx: Sql | TransactionSql, trigger: string): Promise<void> {
  await lockParkRecoveryCondition(tx as TransactionSql, trigger);
  const [{ inspectEventKey }, { readEventConditionReachability }] = await Promise.all([
    import('./events/await/store'), import('./external-condition-reachability'),
  ]);
  const snapshot = await inspectEventKey(trigger, tx as TransactionSql);
  const condition = await readEventConditionReachability(trigger, {
    requireSpecificCondition: true, inspect: async () => snapshot,
  });
  if (condition.authoritative && condition.basis === 'fired' && !condition.uncertifiedReason) {
    throw new ParkRecoveryAdmissionUnchanged('already-satisfied');
  }
}

/** Run within the caller's release transaction. Share the producer's declaration
 * lock before qualifying the CURRENT expected condition and registering an
 * unbound, session-independent await. A release that already writes the item
 * must call lockParkRecoveryCondition before its first item write. */
export async function admitParkRecoveryInTransaction(tx: TransactionSql, input: {
  workspaceId: string;
  harness: string;
  workItemId: string;
  parkedBy: string;
  parkedReason?: string;
  releaseContract: DurableParkReleaseContract;
}): Promise<ParkRecoveryAdmission> {
  const [{ inspectEventKey, registerAwait }, { readEventConditionReachability },
    { assertDurableParkReleaseContract }] = await Promise.all([
    import('./events/await/store'), import('./external-condition-reachability'),
    import('./durable-park-release-contract'),
  ]);
  assertDurableParkReleaseContract(input.releaseContract);
  const trigger = input.releaseContract.trigger;
  await lockParkRecoveryCondition(tx, trigger);
  const [item] = await tx<{ payload: Record<string, unknown> | null }[]>`
    SELECT payload FROM harness_shared.work_items
     WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harness}
       AND feature_id = ${input.workItemId} FOR UPDATE`;
  if (!item) throw new Error('automatic park admission lost its canonical work-item');
  const prior = (item.payload?.claim_hold_release as { recovery?: ParkRecoveryAdmission } | undefined)?.recovery;
  const replay = matchingParkRecoveryAdmission(item.payload, input);
  if (replay) throw new ParkRecoveryAdmissionUnchanged('replayed', replay);
  const snapshot = await inspectEventKey(trigger, tx);
  const condition = await readEventConditionReachability(trigger, {
    requireSpecificCondition: true, inspect: async () => snapshot,
  });
  if (condition.authoritative && condition.basis === 'fired' && !condition.uncertifiedReason) {
    throw new ParkRecoveryAdmissionUnchanged('already-satisfied');
  }
  const declaration = snapshot.announcements.find(row => !row.supersededAt);
  const { finishedWorkItemIdOfDoneKey } = await import('./work-item-ref-blocker-auto-clear');
  const dependency = finishedWorkItemIdOfDoneKey(trigger);
  const dependencyRefs = dependency && dependency !== input.workItemId ? [dependency] : [];
  const baseline = await readParkProgressInTransaction(tx, { ...input, dependencyRefs });
  const admittedAtMs = Date.now();
  const receipt = createParkRecoveryReceipt({ workspaceId: input.workspaceId, harness: input.harness,
    workItemId: input.workItemId, custodianId: input.parkedBy, condition: input.releaseContract,
    generation: declaration?.causalGeneration ?? null, admittedAtMs, baseline, dependencyRefs });
  if (prior?.awaitId && prior.receipt?.id) {
    await tx`UPDATE harness_shared.event_awaits
      SET cancelled_at = now(), cancel_reason = 'park-recovery-superseded', verification_claimed_at = NULL
      WHERE id = ${prior.awaitId} AND producer_health->'producer'->>'id' = ${prior.receipt.id}
        AND fired_at IS NULL AND cancelled_at IS NULL`;
  }
  const contract = { ...input.releaseContract,
    evidence: condition.evidence,
    reachability: condition.verdict === 'reachable' ? 'reachable' : condition.verdict === 'impossible'
      ? 'unreachable' : condition.verdict === 'unknown' ? 'unknown' : 'blocked',
  };
  const patch = { _claimHold: true, claim_hold_by: input.parkedBy,
    claim_hold_at: new Date(admittedAtMs).toISOString(),
    ...(input.parkedReason ? { claim_hold_reason: input.parkedReason } : {}), claim_hold_release: contract };
  await tx`UPDATE harness_shared.work_items
    SET payload = (COALESCE(payload, '{}'::jsonb) - 'claim_hold_recheck') || ${JSON.stringify(patch)}::text::jsonb
    WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harness}
      AND feature_id = ${input.workItemId}`;
  // A stable per-obligation subscriber avoids consuming another manual wait for
  // the same owner/key. No boundTo: release/lifecycle/death must not retire it.
  // The timer is independent of producer notifications: a subset/mismatched
  // producer fire must not consume the fallback. Its verifier separately reads
  // the complete current condition before retiring or recovering the admission.
  const awaited = await registerAwait({ subscriberId: receipt.id, eventKey: `${receipt.id}:deadline`,
    policy: 'wake', once: true, timeoutBehavior: 'wake',
    timeoutSec: receipt.policy.initialMs / 1000, note: receipt.id,
    producerHealthCertificate: parkRecoveryCertificate(receipt) }, tx);
  await tx`UPDATE harness_shared.event_awaits
    SET expires_ts = to_timestamp(${receipt.deadlineMs} / 1000.0) WHERE id = ${awaited.id}`;
  const admission = { receipt, awaitId: awaited.id };
  await tx`UPDATE harness_shared.work_items
    SET payload = jsonb_set(payload, '{claim_hold_release,recovery}', ${JSON.stringify(admission)}::text::jsonb)
    WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harness}
      AND feature_id = ${input.workItemId}`;
  return admission;
}

/** Read the checkpoint BODY writer, not row touches/unchanged attestations or
 * session heartbeat. Hash and body timestamp must both advance before renewal.
 * The canonical scope helper preserves operator-scope (empty harness) identity. */
export async function readParkProgressInTransaction(tx: TransactionSql, input: {
  workspaceId: string; harness: string; workItemId: string; dependencyRefs?: string[];
}): Promise<ParkProgressEvidence[]> {
  const { workItemCheckpointScope } = await import('./work-item-checkpoint');
  const refs = [...new Set([input.workItemId, ...(input.dependencyRefs ?? [])])];
  const scopes = refs.map(ref => workItemCheckpointScope(input.harness, ref));
  const rows = await tx<{ scope: string; note: string | null; body_ts: string | number | null }[]>`
    SELECT scope, note, body_ts FROM harness_shared.carry_notes
     WHERE workspace_id = ${input.workspaceId} AND scope = ANY(${scopes}::text[])`;
  return rows.flatMap(row => {
    const atMs = Number(row.body_ts);
    const index = scopes.indexOf(row.scope);
    if (index < 0 || row.body_ts == null || !instant(atMs) || !row.note?.trim()) return [];
    return [{ kind: 'checkpoint' as const, subjectRef: refs[index], sequence: atMs,
      persistedAtMs: atMs,
      evidenceRef: `checkpoint:${row.scope}:${createHash('sha256').update(row.note).digest('hex')}` }];
  });
}

export type ParkRecoveryCheckResult = {
  disposition: 'unchanged' | 'renewed' | 'waiting' | 'retired' | 'recovery';
  admission?: ParkRecoveryAdmission;
};

/** The same event-key -> obligation -> await lock order as admission and producer
 * settlement. Re-read the persisted admission under these locks: a verifier's
 * claimed snapshot is not authority to renew an already expired/replaced row.
 * This transition NEVER changes the obligation's custody, qualification, locks,
 * safety holds or acceptance. A qualified condition retires only the fallback. */
export async function checkParkRecoveryInTransaction(tx: TransactionSql, input: {
  awaitId: number; receipt: ParkRecoveryReceipt; nowMs?: number;
}): Promise<ParkRecoveryCheckResult> {
  const [{ inspectEventKey }, { readEventConditionReachability }] = await Promise.all([
    import('./events/await/store'), import('./external-condition-reachability'),
  ]);
  const identity = input.receipt;
  await lockParkRecoveryCondition(tx, identity.condition.trigger);
  const [item] = await tx<{ payload: Record<string, unknown> | null }[]>`
    SELECT payload FROM harness_shared.work_items
     WHERE workspace_id = ${identity.workspaceId} AND harness_slug = ${identity.harness}
       AND feature_id = ${identity.workItemId} FOR UPDATE`;
  const [awaited] = await tx<{ fired_at: unknown; cancelled_at: unknown }[]>`
    SELECT fired_at, cancelled_at FROM harness_shared.event_awaits
     WHERE id = ${input.awaitId} AND producer_health->'producer'->>'id' = ${identity.id}
     FOR UPDATE`;
  if (!awaited || awaited.fired_at || awaited.cancelled_at) return { disposition: 'unchanged' };
  const storedAdmission = (item?.payload?.claim_hold_release as { recovery?: ParkRecoveryAdmission } | undefined)?.recovery;
  const contract = item?.payload?.claim_hold_release as Partial<ParkRecoveryReceipt['condition']> | undefined;
  if (!storedAdmission || storedAdmission.awaitId !== input.awaitId || storedAdmission.receipt.id !== identity.id ||
    item?.payload?._claimHold !== true ||
    contract?.condition !== storedAdmission.receipt.condition.condition ||
    contract.trigger !== storedAdmission.receipt.condition.trigger || contract.owner !== storedAdmission.receipt.condition.owner) {
    await tx`UPDATE harness_shared.event_awaits
      SET cancelled_at = now(), cancel_reason = 'park-recovery-superseded', verification_claimed_at = NULL
      WHERE id = ${input.awaitId}`;
    return { disposition: 'retired' };
  }
  let admission: ParkRecoveryAdmission = storedAdmission;
  const nowMs = input.nowMs ?? Date.now();
  if (!instant(nowMs)) throw new RangeError('invalid park recovery check clock');
  let receipt = admission.receipt;
  const snapshot = await inspectEventKey(receipt.condition.trigger, tx);
  const condition = await readEventConditionReachability(receipt.condition.trigger, {
    requireSpecificCondition: true, inspect: async () => snapshot,
  });
  let disposition: ParkRecoveryCheckResult['disposition'] = 'waiting';
  if (condition.authoritative && condition.basis === 'fired' && !condition.uncertifiedReason) {
    receipt = { ...receipt, state: 'retired' };
    disposition = 'retired';
  } else {
    receipt = expireParkRecovery(receipt, nowMs);
    if (receipt.state === 'waiting') {
      const evidence = await readParkProgressInTransaction(tx, receipt);
      for (const candidate of evidence) {
        const renewal = renewParkRecovery(receipt, candidate, nowMs);
        if (renewal.accepted) { receipt = renewal.receipt; disposition = 'renewed'; break; }
      }
    } else if (receipt.state === 'recovery') {
      disposition = 'recovery';
      if (!admission.recoveryWorkItemId) {
        const { upsertConditionWorkItemInTransaction } = await import('./coord/condition-upsert');
        const action = await upsertConditionWorkItemInTransaction(tx, receipt.id, {
          workspaceId: receipt.workspaceId, harness: receipt.harness || 'operator', kind: 'task',
          createdBy: 'system:durable-park-recovery',
          title: `Recover parked delivery ${receipt.workItemId}`,
          summary: `The bounded park for ${receipt.workItemId} expired without complete current qualification. ` +
            `Read the original obligation and condition ${receipt.condition.trigger}; diagnose the silent prerequisite, ` +
            'restore accountable progress or report the concrete blocker. This action grants no custody of the original ' +
            'obligation, no release of locks/safety holds, and no qualification or acceptance bypass.',
          payload: { parkRecovery: { receiptId: receipt.id, workspaceId: receipt.workspaceId,
            harness: receipt.harness, workItemId: receipt.workItemId, condition: receipt.condition } },
        });
        if (!action.id) throw new Error('automatic park recovery registration returned no action');
        admission = { ...admission, recoveryWorkItemId: action.id };
      }
    }
  }
  admission = { ...admission, receipt };
  const certificate = parkRecoveryCertificate(receipt, nowMs);
  await tx`UPDATE harness_shared.work_items
    SET payload = jsonb_set(payload, '{claim_hold_release,recovery}', ${JSON.stringify(admission)}::text::jsonb)
    WHERE workspace_id = ${receipt.workspaceId} AND harness_slug = ${receipt.harness}
      AND feature_id = ${receipt.workItemId}`;
  await tx`UPDATE harness_shared.event_awaits
    SET producer_health = ${JSON.stringify(certificate)}::text::jsonb,
      expires_ts = to_timestamp(${receipt.deadlineMs} / 1000.0), verification_claimed_at = NULL,
      cancelled_at = CASE WHEN ${receipt.state === 'retired'} THEN now() ELSE NULL END,
      cancel_reason = CASE WHEN ${receipt.state === 'retired'} THEN 'park-recovery-condition-qualified' ELSE NULL END
    WHERE id = ${input.awaitId}`;
  return { disposition, admission };
}

export interface ParkRecoveryOwnerFacts {
  states: ReadonlyMap<string, SessionState | null>;
  successors: readonly string[];
}
export function selectParkRecoveryOwner(currentCustodian: string, incumbent: string | null,
  facts: ParkRecoveryOwnerFacts): string | null {
  const live = (id: string) => ['live', 'parked'].includes(facts.states.get(id) ?? '');
  return [currentCustodian, incumbent, ...facts.successors].find((id): id is string => Boolean(id && live(id))) ?? null;
}

async function readParkRecoveryOwners(input: {
  receipt: ParkRecoveryReceipt; currentCustodian: string; incumbent: string | null;
}): Promise<ParkRecoveryOwnerFacts> {
  const [{ defaultDirectiveRoutingDeps }, { resolveLiveRoleHolders }, { resolveSessionStates }] = await Promise.all([
    import('./owner-directive-routing'), import('./agent-tools/coordination/role-slot-live-resolve'),
    import('./agent-tools/coordination/liveness-oracle'),
  ]);
  const routing = defaultDirectiveRoutingDeps();
  const { receipt, currentCustodian, incumbent } = input;
  const fleets = await routing.lastFleets(receipt.workspaceId, [currentCustodian]);
  const leaders = await routing.fleetLeaders(receipt.workspaceId, [...fleets.values()]);
  const roles = await resolveLiveRoleHolders('su', { workspaceId: receipt.workspaceId, potSlug: receipt.harness || null });
  const successors = [...new Set([...leaders.values()].filter((id): id is string => Boolean(id)).concat(roles.sort()))];
  const candidates = [...new Set([currentCustodian, ...(incumbent ? [incumbent] : []), ...successors])];
  const verdicts = await resolveSessionStates(candidates.map(ownerId => ({ ownerId })),
    { hydrateBatch: true, psuHostPositiveAuthority: true });
  return { states: new Map(candidates.map(id => [id, verdicts.get(id)?.sessionState ?? null])), successors };
}

export type ParkRecoveryOwnerReader = typeof readParkRecoveryOwners;
export const isParkRecoveryTimer = (key: string) => /^park-recovery:[a-f0-9]{64}:deadline$/.test(key);

/** Re-evaluate the delivery owner on EVERY pump attempt. The synthetic timer
 * names an obligation, never a mortal session. Election mutates only the recovery
 * ACTION's claim and its delivery target. Dead owners cannot consume the wake;
 * a crash/retry keeps the original receipt, action and delivery identities. */
export async function routeParkRecoveryDeliveryInTransaction(tx: TransactionSql, input: {
  awaitId: number; deliveryId: number; owners?: ParkRecoveryOwnerReader;
}): Promise<{ disposition: 'target' | 'pending' | 'retired'; ownerId?: string; actionId?: string }> {
  const [timer] = await tx<{ producer_health: ProducerHealthCertificate | null }[]>`
    SELECT producer_health FROM harness_shared.event_awaits WHERE id=${input.awaitId}`;
  const receipt = timer?.producer_health?.details?.parkRecovery as ParkRecoveryReceipt | undefined;
  if (!receipt || timer.producer_health?.producer.kind !== PARK_RECOVERY_PRODUCER) return { disposition: 'retired' };
  await lockParkRecoveryCondition(tx, receipt.condition.trigger);
  const [item] = await tx<{ payload: Record<string, unknown>; taken_by: string | null }[]>`
    SELECT payload, taken_by FROM harness_shared.work_items
    WHERE workspace_id=${receipt.workspaceId} AND harness_slug=${receipt.harness}
      AND feature_id=${receipt.workItemId} FOR UPDATE`;
  const [awaited] = await tx<{ cancelled_at: unknown }[]>`
    SELECT cancelled_at FROM harness_shared.event_awaits WHERE id=${input.awaitId} FOR UPDATE`;
  const admission = (item?.payload?.claim_hold_release as { recovery?: ParkRecoveryAdmission } | undefined)?.recovery;
  const contract = item?.payload?.claim_hold_release as Partial<ParkRecoveryReceipt['condition']> | undefined;
  if (!awaited || awaited.cancelled_at || !admission || admission.receipt.id !== receipt.id ||
    admission.receipt.state !== 'recovery' || !admission.recoveryWorkItemId || item?.payload?._claimHold !== true ||
    contract?.condition !== receipt.condition.condition || contract.trigger !== receipt.condition.trigger ||
    contract.owner !== receipt.condition.owner) return { disposition: 'retired' };
  const [action] = await tx<{ taken_by: string | null; status: string; payload: Record<string, unknown> }[]>`
    SELECT taken_by, status, payload FROM harness_shared.work_items
     WHERE workspace_id=${receipt.workspaceId} AND feature_id=${admission.recoveryWorkItemId}
       AND payload->'parkRecovery'->>'receiptId'=${receipt.id} FOR UPDATE`;
  if (!action) throw new Error('automatic park recovery lost its durable action');
  const { ANY_FAMILY_TERMINAL_STATES } = await import('./work-item-dispatch-states');
  if ((ANY_FAMILY_TERMINAL_STATES as readonly string[]).includes(action.status)) return { disposition: 'retired' };
  const currentCustodian = item.taken_by || receipt.custodianId;
  const facts = await (input.owners ?? readParkRecoveryOwners)({ receipt, currentCustodian, incumbent: action.taken_by });
  const ownerId = selectParkRecoveryOwner(currentCustodian, action.taken_by, facts);
  if (!ownerId) return { disposition: 'pending', actionId: admission.recoveryWorkItemId };
  // A lease is changed ONLY on the recovery task, never on the parked obligation.
  await tx`UPDATE harness_shared.work_items SET taken_by=${ownerId},
    taken_at=CASE WHEN taken_by IS DISTINCT FROM ${ownerId} THEN clock_timestamp() ELSE taken_at END,
    expires_at=CASE WHEN taken_by IS DISTINCT FROM ${ownerId} THEN clock_timestamp()+interval '7 days' ELSE expires_at END
    WHERE workspace_id=${receipt.workspaceId} AND feature_id=${admission.recoveryWorkItemId}`;
  await tx`UPDATE harness_shared.event_wake_deliveries SET subscriber_id=${ownerId}
    WHERE id=${input.deliveryId} AND await_id=${input.awaitId}`;
  return { disposition: 'target', ownerId, actionId: admission.recoveryWorkItemId };
}
