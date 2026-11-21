/** D-015: one repair lead owns the complete intake. Groups are evidence, never a spawn policy. */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { FrozenCandidateRepairQueue } from './frozen-candidate-repair-queue';
import { normalizeRepoPath } from './frozen-candidate-repair-queue';
import { frozenRepairConvergenceConditionKey } from './frozen-repair-agent-routing';
import { canonicalJson } from '@papercusp/hash-chain';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';

export const REPAIR_GROUP_STRATEGY_ATTEMPTS = 3;
const hash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
const unique = (values: readonly string[]): string[] => [...new Set(values)].sort();
function identities(values: readonly string[]): string[] {
  if (values.some(value => typeof value !== 'string' || !value.trim())) throw new Error('Invalid repair identity');
  return unique(values);
}

export interface RepairLeadIntake {
  id: string;
  reason: string;
  /** Complete source, including signature, native membership, admissions and verification. */
  queue: FrozenCandidateRepairQueue;
}
export interface RepairGroupAttempt {
  id: string;
  strategy: string;
  worker: string;
  atMs: number;
  evidenceRefs: string[];
}
export interface RepairGroupDelivery {
  id: string;
  owner: string;
  offeredAtMs: number;
  pickup: 'pending' | 'confirmed' | 'missed';
  turnStartedAtMs?: number;
  sendLeaseUntilMs?: number;
  sendAttempts?: number;
}
export interface RepairCausalGroup {
  id: string;
  members: string[];
  sourcePaths: string[];
  causeEvidence: string[];
  independentOf: { groupId: string; evidenceRefs: string[] }[];
  /** Independently registered source input; the handoff never closes or steals it. */
  sourceWorkItem?: string;
  owner: string | null;
  disposition: 'lead' | 'delegated';
  attempts: RepairGroupAttempt[];
  verification: string[];
  returns: { from: string; to: string | null; reason: string; atMs: number }[];
  delivery?: RepairGroupDelivery;
}
export interface RepairLeadHandoff {
  schemaVersion: 1;
  pipeline: string;
  candidate: string;
  lead: string | null;
  leadWorkItem: string | null;
  latestIntake: string;
  intakes: RepairLeadIntake[];
  /** Complete current source, including progress; clocks never mint another intake. */
  currentQueue: FrozenCandidateRepairQueue;
  groups: RepairCausalGroup[];
}
export interface RepairLeadObservation {
  owner: string;
  workItem: string;
}
export interface RepairPickupProof {
  deliveryId: string;
  owner: string;
  offeredAtMs: number;
  deliveredAtMs: number | null;
  turnStartedAtMs: number | null;
  turnProof: string | null;
}

export function repairLeadIntake(queue: FrozenCandidateRepairQueue, reason: string): RepairLeadIntake {
  identities(queue.failingTests);
  // Inventory identity is about judged failures, the repair head and actual attempts.
  // Precheck diagnostics retain their full current source without appending another
  // copy of a potentially huge file radius on every heartbeat or completed file.
  const id = hash({ candidate: queue.candidate, repairHead: queue.repairHead, attempts: queue.attempts,
    fixerDispatchReceipt: queue.fixerDispatchReceipt, admissions: queue.admissions,
    failingTests: identities(queue.failingTests),
    signature: [...queue.signature].sort((a, b) => a.id.localeCompare(b.id)),
    legs: queue.legs, failureFrontierCompleteness: queue.failureFrontierCompleteness,
    // Terminal measurements are immutable evidence; running diagnostics are not.
    precheckResult: queue.admissionPrecheck && queue.admissionPrecheck.status !== 'running'
      ? { operationId: queue.admissionPrecheck.operationId, status: queue.admissionPrecheck.status,
          verdict: queue.admissionPrecheck.verdict, measurement: queue.admissionPrecheck.measurement } : null });
  return { id, reason, queue: structuredClone(queue) };
}
const isOpen = (group: RepairCausalGroup, intake: RepairLeadIntake): boolean =>
  group.members.some(member => intake.queue.failingTests.includes(member));

/** Pure reconciliation; unknown ownership/liveness never authorizes a takeover. */
export function reconcileRepairLeadHandoff(input: {
  prior: RepairLeadHandoff | null;
  pipeline: string;
  intake: RepairLeadIntake;
  lead: RepairLeadObservation | null;
  workerStates: ReadonlyMap<string, 'live' | 'ended' | 'unknown'>;
  nowMs: number;
}): RepairLeadHandoff {
  const { intake, nowMs } = input;
  const prior = input.prior;
  if (prior && (prior.schemaVersion !== 1 || prior.pipeline !== input.pipeline || prior.candidate !== intake.queue.candidate)) {
    throw new Error('Repair handoff identity changed; retain and resolve the prior candidate before replacing it');
  }
  const state: RepairLeadHandoff = prior ? structuredClone(prior) : {
    schemaVersion: 1, pipeline: input.pipeline, candidate: intake.queue.candidate,
    lead: null, leadWorkItem: null, latestIntake: intake.id, intakes: [], currentQueue: structuredClone(intake.queue), groups: [],
  };
  if (!state.intakes.some(row => row.id === intake.id)) state.intakes.push(structuredClone(intake));
  state.latestIntake = intake.id;
  state.currentQueue = structuredClone(intake.queue);
  if (input.lead) { state.lead = input.lead.owner; state.leadWorkItem = input.lead.workItem; }
  let triage = state.groups.find(group => group.id === 'shared-cause-triage');
  if (!triage) {
    triage = { id: 'shared-cause-triage', members: [], sourcePaths: [], causeEvidence: [], independentOf: [],
      owner: state.lead, disposition: 'lead', attempts: [], verification: [], returns: [] };
    state.groups.push(triage);
  }
  const tracked = new Set(state.groups.flatMap(group => group.members));
  triage.members = unique([...triage.members, ...intake.queue.failingTests.filter(member => !tracked.has(member))]);
  const receipt = intake.queue.fixerDispatchReceipt;
  if (receipt && !triage.attempts.some(attempt => attempt.id === receipt.spawnId)) {
    triage.attempts.push({ id: receipt.spawnId, strategy: 'automatic-shared-cause-triage', worker: receipt.spawnId,
      atMs: receipt.dispatchedAtMs, evidenceRefs: [`repair-queue:fixerDispatchReceipt:${receipt.spawnId}`] });
  }
  for (const group of state.groups) {
    if (!isOpen(group, intake)) continue;
    const dead = group.owner !== null && input.workerStates.get(group.owner) === 'ended';
    const returning = group.disposition === 'delegated' && (dead || group.delivery?.pickup === 'missed');
    if (returning || (group.disposition === 'lead' && input.lead && group.owner !== state.lead)) {
      if (group.owner) group.returns.push({ from: group.owner, to: input.lead?.owner ?? null,
        reason: dead ? 'worker-ended' : returning ? 'pickup-missed' : 'verified-lead-successor', atMs: nowMs });
      group.owner = input.lead?.owner ?? null;
      group.disposition = 'lead';
      delete group.delivery;
    }
    // A gate succession moves lead custody only, never a live delegated source worker.
    if (group.disposition === 'lead' && input.lead) group.owner = input.lead.owner;
    if (group.owner && input.lead && group.disposition === 'lead') {
      const id = hash([state.candidate, group.id, group.owner, intake.queue.repairHead,
        identities(intake.queue.failingTests), [...intake.queue.signature].sort((a, b) => a.id.localeCompare(b.id)),
        intake.queue.attempts, group.returns.length]);
      if (group.delivery?.id !== id) group.delivery = { id, owner: group.owner, offeredAtMs: nowMs, pickup: 'pending' };
    }
  }
  return state;
}

/** One explicit causal group, assigned to an existing worker. This function never launches one. */
export function delegateRepairCausalGroup(state: RepairLeadHandoff, input: {
  id: string; caller: string; worker: string; members: readonly string[]; sourcePaths: readonly string[];
  causeEvidence: readonly string[]; independentOf: readonly { groupId: string; evidenceRefs: readonly string[] }[];
  sourceWorkItem: string; strategy: string; attemptId: string; atMs: number;
}): RepairLeadHandoff {
  if (!state.lead || input.caller !== state.lead) throw new Error('Only the verified repair lead may delegate');
  if (!input.id.trim() || input.id === 'shared-cause-triage' || !input.worker.trim() || !input.strategy.trim() ||
      !input.attemptId.trim() || !input.sourceWorkItem.trim()) throw new Error('Incomplete repair group assignment');
  const members = identities(input.members);
  const paths = unique(identities(input.sourcePaths).map(normalizeRepoPath));
  if (input.sourcePaths.some(path => normalizeRepoPath(path) !== path || path.split('/').some(part => !part || part === '..' || part === '.'))) {
    throw new Error('Repair source paths must be complete canonical repository-relative file identities');
  }
  const causeEvidence = identities(input.causeEvidence);
  if (!members.length || !paths.length || !causeEvidence.length) throw new Error('Delegation requires measured cause, membership and source paths');
  const prior = state.groups.find(group => group.id === input.id);
  const replay = prior?.attempts.find(attempt => attempt.id === input.attemptId);
  if (replay) {
    if (replay.worker !== input.worker || replay.strategy !== input.strategy ||
        JSON.stringify(prior!.members) !== JSON.stringify(members) || JSON.stringify(prior!.sourcePaths) !== JSON.stringify(paths)) {
      throw new Error('Repair attempt id reused for different work');
    }
    return state;
  }
  if (prior && prior.attempts.filter(attempt => attempt.strategy === input.strategy).length >= REPAIR_GROUP_STRATEGY_ATTEMPTS) {
    throw new Error('Same repair strategy has exhausted its three-launch budget; return the group to the lead');
  }
  const intake = state.intakes.find(row => row.id === state.latestIntake)!;
  if (members.some(member => !intake.queue.failingTests.includes(member) && !prior?.members.includes(member))) {
    throw new Error('Group includes a failure outside the measured intake');
  }
  if (!members.some(member => intake.queue.failingTests.includes(member))) throw new Error('No open failure remains in this group');
  for (const other of state.groups) {
    if (other.id === input.id || (other.id !== 'shared-cause-triage' && !isOpen(other, intake))) continue;
    if (other.id !== 'shared-cause-triage' && members.some(member => other.members.includes(member))) throw new Error('Repair group membership overlaps');
    if (other.sourcePaths.length > 0) {
      if (paths.some(path => other.sourcePaths.some(active => path === active || path.startsWith(active + '/') || active.startsWith(path + '/')))) {
        throw new Error('Repair source paths overlap an active group');
      }
      if (!input.independentOf.some(proof => proof.groupId === other.id && identities(proof.evidenceRefs).length)) {
        throw new Error('Independent cause evidence is required for every active sibling group');
      }
    }
  }
  if (prior?.disposition === 'delegated') throw new Error('An active repair group already has a worker');
  if (prior && JSON.stringify(prior.members) !== JSON.stringify(members)) throw new Error('A retry must retain the complete causal group membership');
  const next = structuredClone(state);
  const group: RepairCausalGroup = { id: input.id, members, sourcePaths: paths, causeEvidence,
    independentOf: input.independentOf.map(proof => ({ groupId: proof.groupId, evidenceRefs: identities(proof.evidenceRefs) })),
    sourceWorkItem: input.sourceWorkItem, owner: input.worker, disposition: 'delegated',
    attempts: [...(prior?.attempts ?? []), { id: input.attemptId, strategy: input.strategy, worker: input.worker,
      atMs: input.atMs, evidenceRefs: causeEvidence }], verification: [...(prior?.verification ?? [])], returns: [...(prior?.returns ?? [])],
    delivery: { id: hash([state.candidate, input.id, input.attemptId, input.worker]), owner: input.worker,
      offeredAtMs: input.atMs, pickup: 'pending' } };
  next.groups = next.groups.filter(row => row.id !== input.id);
  next.groups.push(group);
  next.groups.find(row => row.id === 'shared-cause-triage')!.members =
    next.groups.find(row => row.id === 'shared-cause-triage')!.members.filter(member => !members.includes(member));
  return next;
}

export function recordRepairGroupVerification(state: RepairLeadHandoff, input: {
  groupId: string; caller: string; evidenceRefs: readonly string[];
}): RepairLeadHandoff {
  const next = structuredClone(state);
  const group = next.groups.find(row => row.id === input.groupId);
  if (!group || (input.caller !== group.owner && input.caller !== state.lead)) throw new Error('Only the group worker or repair lead may record verification');
  const evidence = identities(input.evidenceRefs);
  if (!evidence.length) throw new Error('Verification requires recorded evidence');
  group.verification = unique([...group.verification, ...evidence]);
  return next;
}

/** A queue count or current presence cannot manufacture per-delivery turn-start proof. */
export function recordRepairLeadPickup(state: RepairLeadHandoff, proofs: readonly RepairPickupProof[], nowMs: number): RepairLeadHandoff {
  const next = structuredClone(state);
  for (const group of next.groups) {
    const delivery = group.delivery;
    if (!delivery || delivery.pickup === 'confirmed') continue;
    for (const proof of proofs) {
      if (proof.deliveryId !== delivery.id || proof.owner !== delivery.owner || proof.offeredAtMs < delivery.offeredAtMs) continue;
      if ((proof.turnProof === 'host-attested' || proof.turnProof === 'observed') && proof.deliveredAtMs !== null &&
          proof.turnStartedAtMs !== null && proof.deliveredAtMs >= delivery.offeredAtMs &&
          proof.turnStartedAtMs >= proof.deliveredAtMs && proof.turnStartedAtMs <= nowMs) {
        delivery.pickup = 'confirmed'; delivery.turnStartedAtMs = proof.turnStartedAtMs; break;
      }
      if (proof.turnProof === 'not-picked-up') delivery.pickup = 'missed';
    }
  }
  return next;
}

/** Namespace-only update under a row lock; source input and every earlier intake survive. */
export async function updateStoredRepairLeadHandoff<T>(sql: Sql, input: {
  workspaceId: string; workItem: string; conditionKey: string;
}, update: (prior: RepairLeadHandoff | null, tx: TransactionSql) => Promise<{ state: RepairLeadHandoff; result: T }>): Promise<T> {
  return sql.begin(async tx => {
    const rows = await tx<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM harness_shared.work_items
       WHERE workspace_id = ${input.workspaceId} AND feature_id = ${input.workItem}
         AND condition_key = ${input.conditionKey} FOR UPDATE`;
    const payload = rows[0]?.payload;
    if (!payload || !payload._bridge) throw new Error('Repair handoff must use a bridge-owned incident; independent source work is protected');
    const prior = payload.frozenRepairHandoff as RepairLeadHandoff | undefined;
    if (prior && prior.schemaVersion !== 1) throw new Error('Unsupported repair handoff schema; preserve its source');
    const { state, result } = await update(prior ?? null, tx);
    await tx`UPDATE harness_shared.work_items
      SET payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{frozenRepairHandoff}', ${JSON.stringify(state)}::text::jsonb),
          updated_ts = ${Date.now()}
      WHERE workspace_id = ${input.workspaceId} AND feature_id = ${input.workItem}
        AND condition_key = ${input.conditionKey}`;
    return result;
  }) as Promise<T>;
}

export interface RouteRepairLeadResult { workItem: string; lead: string | null; pickup: 'pending' | 'confirmed' | 'unassigned' }
/** A failed prefix must not strand later durable outbox intents. The lease bounds
 * one pass; actual worker strategy budgets are independent of message transport. */
export async function sendPendingRepairLeadHandoffs(
  groups: readonly RepairCausalGroup[], send: (group: RepairCausalGroup) => Promise<void>,
): Promise<void> {
  const failures: unknown[] = [];
  for (let offset = 0; offset < groups.length; offset += 12) {
    const outcomes = await Promise.allSettled(groups.slice(offset, offset + 12).map(send));
    for (const outcome of outcomes) if (outcome.status === 'rejected') failures.push(outcome.reason);
  }
  if (failures.length) throw new AggregateError(failures, 'Repair handoff delivery incomplete; durable pending intents remain recoverable');
}

export async function routeFrozenRepairToLead(input: {
  workspaceId: string; pipeline: string; queue: FrozenCandidateRepairQueue; reason: string;
  assignment?: Parameters<typeof delegateRepairCausalGroup>[1];
  verification?: Parameters<typeof recordRepairGroupVerification>[1];
}): Promise<RouteRepairLeadResult> {
  const { acquireConditionOwner, readLiveGateOwnerForAssignment } = await import('../coord/condition-bridge');
  const { getOrgPg } = await import('@papercusp/db-org');
  const { resolveSessionStates } = await import('../agent-tools/coordination/liveness-oracle');
  const { sendMessage } = await import('../agent-tools/coordination/messages');
  const { wakeRecipients } = await import('../agent-tools/coordination/inbox-wake');
  const { listDeliveriesForSources } = await import('../events/await/store');
  const { getPresence } = await import('../agent-tools/coordination/presence');
  const conditionKey = frozenRepairConvergenceConditionKey(input.pipeline);
  const acquired = await acquireConditionOwner(conditionKey, {
    harness: input.pipeline, workspaceId: input.workspaceId, severity: 'critical',
    title: `[${input.pipeline}] repair lead owns the complete frozen failure inventory`,
    summary: 'Read payload.frozenRepairHandoff for every recorded intake, causal group, attempt and pickup. ' +
      'Start with shared-cause triage; per-file coverage never launches workers. The live gate owner alone admits fixes and verifies the final gate.',
  });
  if (!acquired.workItem || acquired.skipped || acquired.duplicateLeftOpen) throw new Error('Repair condition owner could not be established');
  const sql = getOrgPg().sql;
  const observed = await readLiveGateOwnerForAssignment(input.pipeline);
  const lead = observed.ok && observed.heldByLiveHolder && observed.ownership.takenBy && observed.ownership.workItem
    ? { owner: observed.ownership.takenBy, workItem: observed.ownership.workItem } : null;
  const workItem = acquired.workItem;
  const ownerRows = await sql<{ payload: { frozenRepairHandoff?: RepairLeadHandoff } }[]>`
    SELECT payload FROM harness_shared.work_items WHERE workspace_id = ${input.workspaceId} AND feature_id = ${workItem}`;
  const owners = unique([...(ownerRows[0]?.payload?.frozenRepairHandoff?.groups ?? []).flatMap(group => group.owner ? [group.owner] : []),
    ...(input.assignment ? [input.assignment.worker] : [])]);
  const observations = owners.length ? await resolveSessionStates(owners.map(ownerId => ({ ownerId })), {
    hydratePerId: true, psuHostPositiveAuthority: true,
  }) : new Map();
  const workerStates = new Map<string, 'live' | 'ended' | 'unknown'>(owners.map(owner => [owner,
    observations.get(owner)?.sessionState === 'ended' ? 'ended' :
      ['live', 'parked'].includes(observations.get(owner)?.sessionState ?? '') ? 'live' : 'unknown']));
  if (input.assignment) {
    if (!lead || input.assignment.caller !== lead.owner || workerStates.get(input.assignment.worker) !== 'live') {
      throw new Error('Group delegation requires the verified lead and an existing live worker');
    }
    const { getWorkItem } = await import('../work-items');
    const source = await getWorkItem(input.assignment.sourceWorkItem, input.pipeline);
    if (!source || ANY_FAMILY_TERMINAL_STATES.includes(source.state) || source.assignee !== input.assignment.worker) {
      throw new Error('The causal group needs an independently registered source item held by its worker');
    }
  }
  const committed = await updateStoredRepairLeadHandoff(sql, { workspaceId: input.workspaceId, workItem, conditionKey }, async (prior, tx) => {
    const nowMs = Date.now();
    const deliveries = prior?.groups.flatMap(group => group.delivery ? [group.delivery] : []) ?? [];
    const sources = deliveries.map(delivery => 'frozen-repair-handoff:' + delivery.id);
    const rows = await listDeliveriesForSources(sources, tx);
    const proofs: RepairPickupProof[] = rows.map(row => ({ deliveryId: row.source!.slice('frozen-repair-handoff:'.length),
      owner: row.subscriberId, offeredAtMs: new Date(row.createdAt).getTime(),
      deliveredAtMs: row.deliveredAt ? new Date(row.deliveredAt).getTime() : null,
      turnStartedAtMs: row.turnStartedAt ? new Date(row.turnStartedAt).getTime() : null, turnProof: row.turnProof }));
    const picked = prior ? recordRepairLeadPickup(prior, proofs, nowMs) : null;
    // Fence the elected leader at the write, rather than trusting a pre-transaction observation.
    const leadRows = lead ? await tx<{ taken_by: string | null }[]>`SELECT taken_by FROM harness_shared.work_items
      WHERE workspace_id = ${input.workspaceId} AND feature_id = ${lead.workItem} AND taken_by = ${lead.owner}` : [];
    const currentLead = leadRows.length ? lead : null;
    if ((input.assignment || input.verification) && !currentLead) throw new Error('Repair lead ownership changed before the group write');
    let state = reconcileRepairLeadHandoff({ prior: picked, pipeline: input.pipeline, intake: repairLeadIntake(input.queue, input.reason),
      lead: currentLead, workerStates, nowMs });
    if (input.assignment && currentLead) {
      // The first split must be disjoint from the lead's own current edits too.
      // An empty current_files lane is discovery-only and adds no fictitious edit scope.
      const presence = await getPresence(currentLead.owner, tx as unknown as Sql);
      state.groups.find(group => group.id === 'shared-cause-triage')!.sourcePaths =
        unique((presence?.currentFiles ?? []).map(normalizeRepoPath));
    }
    if (input.assignment) state = delegateRepairCausalGroup(state, input.assignment);
    if (input.verification) state = recordRepairGroupVerification(state, input.verification);
    const claimed: string[] = [];
    const existing = new Set(rows.filter(row => deliveries.some(delivery => row.subscriberId === delivery.owner &&
      row.source === 'frozen-repair-handoff:' + delivery.id)).map(row => row.source));
    for (const group of state.groups) {
      const delivery = group.delivery;
      if (!currentLead || !delivery || delivery.pickup !== 'pending' || existing.has('frozen-repair-handoff:' + delivery.id) ||
          (delivery.sendLeaseUntilMs ?? 0) > nowMs) continue;
      delivery.sendLeaseUntilMs = nowMs + 60_000;
      delivery.sendAttempts = (delivery.sendAttempts ?? 0) + 1;
      claimed.push(delivery.id);
    }
    return { state, result: { state, claimed, currentLead } };
  });
  const result = committed.state;
  // An outbox intent is committed before sending. Stable message/source ids make crash replay idempotent.
  const pending = result.groups.filter(group => group.delivery && committed.claimed.includes(group.delivery.id));
   await sendPendingRepairLeadHandoffs(pending, async group => {
    const delivery = group.delivery;
    if (!delivery) return;
    const source = 'frozen-repair-handoff:' + delivery.id;
    const summary = `[${input.pipeline}] ${group.members.length} recorded failures await ${group.disposition === 'lead' ? 'repair lead triage' : 'causal group repair'}`;
    try {
      await sendMessage({ ownerId: 'system:frozen-repair-handoff', ownerLabel: 'Frozen repair handoff',
        source: 'static-client', workspaceId: input.workspaceId, userId: null }, {
        to: [delivery.owner], msgId: source, summary, expectsReply: true,
        body: `Read work_items:get { id:'${workItem}', payloadTier:'full' } → payload.frozenRepairHandoff. ` +
          `Group ${group.id}; complete inventory ${result.latestIntake}; lead ${result.lead ?? 'not yet verified'}. ` +
          'Start with shared-cause triage. Delegate only evidence-backed independent causes with disjoint source edits; record members, attempts and verification. ' +
          'Preserve independent source work. The existing gate lead alone owns admission and final gate verification.',
      });
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error;
    }
    await wakeRecipients([delivery.owner], { source, workspaceId: input.workspaceId, summary,
      payload: { workItemId: workItem, deliveryId: delivery.id } });
    });
  const active = result.groups.filter(group => group.disposition === 'lead' && group.delivery);
  return { workItem, lead: committed.currentLead?.owner ?? null,
    pickup: !committed.currentLead ? 'unassigned' : active.length > 0 && active.every(group => group.delivery?.pickup === 'confirmed') ? 'confirmed' : 'pending' };
}
