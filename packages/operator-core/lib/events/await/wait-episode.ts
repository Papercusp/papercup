/** Bounded dependency observations, shared by awaits and routine settlement.
 * The canonical record lives on the driving work item's existing payload. A
 * transport id, session id or declaration rollover is never a budget identity. */
import { createHash, randomUUID } from 'node:crypto';
import type { ProgressLeaseEvidence } from './verified-wait';
import type { ProducerHealthCertificate } from './verified-wait';
import type { TransactionSql } from 'postgres';

export interface WaitEpisodeReference {
  workspaceId: string;
  harness: string;
  drivingWorkItemId: string;
  id: string;
}

export interface WaitEpisodeContract {
  dependencyRef: string;
  predicateKey: string;
  sourceOwnerId: string;
  sourceGeneration: number | null;
  expectedCondition: unknown;
  payloadFilter: unknown;
  noDeltaBudget: number;
  cadenceMs: number;
  evidence: null | {
    writer: string;
    units: string;
    tool: string;
    args: Record<string, unknown>;
    path: string;
  };
  /** Exact, ordered outcomes declared before the first probe. Merely changing
   * a value (including a checkpoint or heartbeat) is never an advance. */
  substages: Array<{ id: string; valueFingerprint: string }>;
}

export interface WaitEpisodeReceipt {
  observationId: string;
  sequence: number;
  revision: number;
  claimToken: string;
  claimedAtMs: number;
  callbacks: string[];
  state: 'pending' | 'settled';
  disposition?: 'rearm' | 'push-only' | 'complete';
}

export interface WaitEpisode extends WaitEpisodeReference {
  version: 1;
  contract: WaitEpisodeContract;
  contractFingerprint: string;
  custodianId: string;
  custodyLineage: string[];
  revision: number;
  state: 'active' | 'unknown' | 'exhausted' | 'cancelled' | 'complete' | 'task-terminal';
  remainingNoDeltaBudget: number;
  stage: number;
  debits: number;
  nextProbeAtMs: number | null;
  receipt: WaitEpisodeReceipt | null;
  settledCallbacks: Record<string, number>;
  lastObservation?: WaitEpisodeObservation;
}

export interface WaitEpisodeObservation {
  kind: 'observed' | 'unknown';
  checkedAtMs: number;
  evidence?: ProgressLeaseEvidence;
  uncertainty?: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}

export function waitEpisodeFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/** Generation is provenance, not permission to replenish the same predicate. */
function contractFingerprint(contract: WaitEpisodeContract): string {
  const { sourceGeneration: _generation, ...frozen } = contract;
  return waitEpisodeFingerprint(frozen);
}

export function createWaitEpisode(input: Omit<WaitEpisodeReference, 'id'> & {
  custodianId: string; contract: WaitEpisodeContract; nowMs: number;
}): WaitEpisode {
  const { contract } = input;
  if (![input.workspaceId, input.harness, input.drivingWorkItemId, input.custodianId,
    contract.dependencyRef, contract.predicateKey, contract.sourceOwnerId].every(value => value?.trim()) ||
    !Number.isSafeInteger(contract.noDeltaBudget) || contract.noDeltaBudget < 1 || contract.noDeltaBudget > 100 ||
    !Number.isSafeInteger(contract.cadenceMs) || contract.cadenceMs < 1 ||
    !Number.isSafeInteger(input.nowMs) || input.nowMs < 0 ||
    (contract.sourceGeneration !== null && (!Number.isSafeInteger(contract.sourceGeneration) || contract.sourceGeneration < 1)) ||
    contract.substages.length > 100 || new Set(contract.substages.map(stage => stage.id)).size !== contract.substages.length ||
    contract.substages.some(stage => !stage.id?.trim() || !/^[a-f0-9]{64}$/.test(stage.valueFingerprint)) ||
    (contract.substages.length > 0 && !contract.evidence)) {
    throw new Error('wait episode requires a scoped, finite, frozen evidence contract');
  }
  // Checkpoint prose and liveness clocks cannot be promoted into budget credits.
  if (contract.substages.length && contract.evidence &&
      /checkpoint|heartbeat|lastActive|lastSeen|updatedAt|updated_at|comment|archive/i.test(contract.evidence.path)) {
    throw new Error('wait episode substages require outcome evidence, not prose or liveness');
  }
  // Stage names alone cannot prove forward progress. Reusing an outcome
  // (including a later A -> B -> A cycle) would credit an unchanged replay.
  if (new Set(contract.substages.map(stage => stage.valueFingerprint)).size !== contract.substages.length) {
    throw new Error('wait episode substages require distinct outcome evidence');
  }
  const id = waitEpisodeFingerprint([input.workspaceId, input.harness, input.drivingWorkItemId,
    contract.dependencyRef, contract.predicateKey]);
  return {
    version: 1, id, workspaceId: input.workspaceId, harness: input.harness,
    drivingWorkItemId: input.drivingWorkItemId, contract: structuredClone(contract),
    contractFingerprint: contractFingerprint(contract), custodianId: input.custodianId,
    custodyLineage: [input.custodianId], revision: 1, state: 'active',
    remainingNoDeltaBudget: contract.noDeltaBudget, stage: 0, debits: 0,
    nextProbeAtMs: input.nowMs + contract.cadenceMs, receipt: null, settledCallbacks: {},
  };
}

/** Caller has authenticated the current work-item assignment under its row
 * lock. Carry updates custody only; even a terminal tombstone is preserved. */
export function carryWaitEpisode(episode: WaitEpisode, input: {
  custodianId: string; contract: WaitEpisodeContract;
}): WaitEpisode {
  if (!input.custodianId.trim() || contractFingerprint(input.contract) !== episode.contractFingerprint) {
    throw new Error('equivalent wait registration cannot replace its frozen evidence contract');
  }
  if (episode.custodianId === input.custodianId &&
      episode.contract.sourceGeneration === input.contract.sourceGeneration) return episode;
  return { ...episode, revision: episode.revision + 1, custodianId: input.custodianId,
    custodyLineage: episode.custodianId === input.custodianId ? episode.custodyLineage
      : [...episode.custodyLineage, input.custodianId],
    // An in-flight predecessor result must not borrow the successor's custody.
    receipt: episode.receipt?.state === 'pending' ? { ...episode.receipt, claimedAtMs: 0 } : episode.receipt,
    contract: { ...episode.contract, sourceGeneration: input.contract.sourceGeneration } };
}

/** Persist the returned revision BEFORE dispatch. Expired claims resume the
 * same logical observation with a rotated token; they never mint another debit. */
export function claimWaitEpisode(episode: WaitEpisode, input: {
  callback: string; nowMs: number; claimToken?: string;
}): { episode: WaitEpisode; receipt: WaitEpisodeReceipt | null } {
  const callback = waitEpisodeFingerprint(input.callback);
  if (episode.state !== 'active' || episode.nextProbeAtMs === null ||
      input.nowMs < episode.nextProbeAtMs || callback in episode.settledCallbacks) return { episode, receipt: null };
  const pending = episode.receipt?.state === 'pending' ? episode.receipt : null;
  if (pending && input.nowMs - pending.claimedAtMs < 120_000) return { episode, receipt: null };
  const sequence = pending?.sequence ?? (episode.receipt?.sequence ?? 0) + 1;
  const revision = episode.revision + 1;
  const receipt: WaitEpisodeReceipt = {
    observationId: pending?.observationId ?? `${episode.id}:${sequence}`, sequence, revision,
    claimToken: input.claimToken ?? randomUUID(), claimedAtMs: input.nowMs,
    callbacks: [...new Set([...(pending?.callbacks ?? []), callback])], state: 'pending',
  };
  return { episode: { ...episode, revision, receipt }, receipt };
}

function evidenceMatches(contract: WaitEpisodeContract, evidence: ProgressLeaseEvidence): boolean {
  const reference = contract.evidence;
  return !!reference && !evidence.uncertainty && evidence.writer === reference.writer &&
    evidence.units === reference.units && evidence.reference.tool === reference.tool &&
    evidence.reference.path === reference.path &&
    waitEpisodeFingerprint(evidence.reference.args) === waitEpisodeFingerprint(reference.args) &&
    evidence.valueFingerprint === waitEpisodeFingerprint(evidence.valuePreview);
}

export function settleWaitEpisode(episode: WaitEpisode, receipt: WaitEpisodeReceipt,
  observation: WaitEpisodeObservation): { episode: WaitEpisode; accepted: boolean } {
  const pending = episode.receipt;
  if (episode.state !== 'active' || pending?.state !== 'pending' ||
      episode.revision !== receipt.revision || pending.claimToken !== receipt.claimToken ||
      pending.observationId !== receipt.observationId || pending.sequence !== receipt.sequence) {
    return { episode, accepted: false };
  }
  const untrusted = !!observation.evidence && !evidenceMatches(episode.contract, observation.evidence);
  const unknown = observation.kind === 'unknown' || untrusted;
  const nextStage = episode.contract.substages[episode.stage];
  const advance = !unknown && !!nextStage && !!observation.evidence &&
    observation.evidence.valueFingerprint === nextStage.valueFingerprint;
  const remaining = unknown ? episode.remainingNoDeltaBudget : advance
    ? episode.contract.noDeltaBudget : episode.remainingNoDeltaBudget - 1;
  const state = unknown ? 'unknown' : remaining <= 0 ? 'exhausted' : 'active';
  const settledCallbacks = { ...episode.settledCallbacks };
  for (const callback of pending.callbacks) settledCallbacks[callback] = receipt.sequence;
  return { accepted: true, episode: { ...episode, revision: episode.revision + 1,
    state, remainingNoDeltaBudget: remaining, stage: episode.stage + (advance ? 1 : 0),
    debits: episode.debits + (unknown || advance ? 0 : 1), settledCallbacks,
    nextProbeAtMs: state === 'active' ? observation.checkedAtMs + episode.contract.cadenceMs : null,
    lastObservation: untrusted ? { ...observation, kind: 'unknown', uncertainty: 'evidence contract mismatch' } : observation,
    receipt: { ...pending, state: 'settled', disposition: state === 'active' ? 'rearm' : 'push-only' },
  } };
}

/** Only the authenticated final event / terminal task writer calls this. A
 * substage, elapsed time or resolver's `progressing` label cannot close it. */
export function retireWaitEpisode(episode: WaitEpisode,
  state: 'cancelled' | 'complete' | 'task-terminal'): WaitEpisode {
  if (episode.state === 'complete' || episode.state === 'task-terminal' || episode.state === state) return episode;
  return { ...episode, revision: episode.revision + 1, state, nextProbeAtMs: null,
    receipt: episode.receipt ? { ...episode.receipt, state: 'settled',
      disposition: state === 'complete' || state === 'task-terminal' ? 'complete' : 'push-only' } : null };
}

type EpisodeItem = { workspace_id: string; harness_slug: string; feature_id: string;
  taken_by: string | null; status: string | null; payload: Record<string, unknown> | null };
const terminal = new Set(['done', 'resolved', 'dropped', 'cancelled', 'declined', 'shipped']);

function episodes(payload: EpisodeItem['payload']): Record<string, WaitEpisode> {
  const value = payload?.waitEpisodes;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, WaitEpisode> : {};
}

/** All episode mutations use event-key -> driving-item -> await lock order.
 * Existing assignment writers own custody; this code never transfers a claim. */
export async function lockWaitEpisodeItem(tx: TransactionSql, ref: WaitEpisodeReference): Promise<{
  item: EpisodeItem; episode: WaitEpisode;
}> {
  const [item] = await tx<EpisodeItem[]>`SELECT workspace_id, harness_slug, feature_id, taken_by, status, payload
    FROM harness_shared.work_items WHERE workspace_id=${ref.workspaceId}
      AND harness_slug=${ref.harness} AND feature_id=${ref.drivingWorkItemId} FOR UPDATE`;
  const episode = episodes(item?.payload)[ref.id];
  if (!item || !episode || episode.workspaceId !== ref.workspaceId || episode.harness !== ref.harness ||
      episode.drivingWorkItemId !== ref.drivingWorkItemId || episode.id !== ref.id || episode.version !== 1) {
    throw new Error('wait episode lost its canonical driving item');
  }
  return { item, episode };
}

/** The explicit revision predicate is a second fence alongside the item lock:
 * callers cannot accidentally persist a result built before an authenticated carry. */
export async function persistWaitEpisode(tx: TransactionSql, episode: WaitEpisode,
  priorRevision: number | null): Promise<void> {
  const rows = await tx`UPDATE harness_shared.work_items
    SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('waitEpisodes',
      COALESCE(payload->'waitEpisodes', '{}'::jsonb) || jsonb_build_object(${episode.id}::text, ${JSON.stringify(episode)}::text::jsonb))
    WHERE workspace_id=${episode.workspaceId} AND harness_slug=${episode.harness}
      AND feature_id=${episode.drivingWorkItemId}
      AND (payload->'waitEpisodes'->${episode.id}->>'revision') IS NOT DISTINCT FROM ${priorRevision === null ? null : String(priorRevision)}::text
    RETURNING feature_id`;
  if (rows.length !== 1) throw new Error('wait episode revision CAS lost');
}

/** Ordinary productive loops and ambient subscriptions never enroll. Admission
 * requires current driving custody AND a stored, exact dependency (typed event
 * blocker, durable park or the routine's structured blockedOn/monitor policy).
 * An explicit lease driver narrows that lookup; it cannot supply authority. */
export async function admitWaitEpisode(tx: TransactionSql, input: {
  eventWorkspaceId: string; subscriberId: string; eventKey: string;
  payloadFilter: unknown; certificate: ProducerHealthCertificate | null;
  timeoutSec: number | null;
}): Promise<{ certificate: ProducerHealthCertificate; episode: WaitEpisode } | null> {
  const lease = input.certificate?.progressLease;
  if (input.certificate?.producer.kind === 'durable-park-recovery') return null;
  const drivingContext = input.certificate?.producer.kind === 'bounded-dependency'
    ? input.certificate.details?.drivingContext as { workspaceId: string; harness: string; workItemId: string; noDeltaBudget?: number } | undefined : undefined;
  const explicitDriver = lease?.drivingWorkItemId ?? drivingContext?.workItemId ?? null;
  const ws = lease?.resolver.workspaceId ?? drivingContext?.workspaceId ?? input.eventWorkspaceId;
  const harness = lease?.resolver.harnessSlug ?? drivingContext?.harness ?? null;
  const candidates = await tx<EpisodeItem[]>`
    SELECT w.workspace_id, w.harness_slug, w.feature_id, w.taken_by, w.status, w.payload
    FROM harness_shared.work_items w
    WHERE w.workspace_id=${ws} AND w.taken_by=${input.subscriberId}
      AND (${explicitDriver}::text IS NULL OR w.feature_id=${explicitDriver})
      AND (${harness}::text IS NULL OR w.harness_slug=${harness})
      AND (
        EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(w.payload->'externalBlockers', '[]'::jsonb)) b
          WHERE b->>'status'='active' AND b->>'kind' IN ('event','gate') AND b->>'ref'=${input.eventKey})
        OR (w.payload->>'_claimHold'='true' AND w.payload->'claim_hold_release'->>'trigger'=${input.eventKey})
        OR EXISTS (SELECT 1 FROM harness_shared.routines r
          WHERE r.workspace_id=w.workspace_id AND r.target_owner_id=${input.subscriberId}
            AND r.active=true AND r.payload_template->>'workItem'=w.feature_id
            AND (r.payload_template->'blockedOn'->>'event'=${input.eventKey}
              OR (r.payload_template->'blockedOn'->>'kind'='event' AND r.payload_template->'blockedOn'->>'ref'=${input.eventKey})
              OR r.payload_template->'monitor'->>'predicateKey'=${input.eventKey}))
      ) LIMIT 2`;
  if (!candidates.length) {
    if (explicitDriver) throw new Error('wait episode driver is not currently held with this identified dependency');
    return null;
  }
  if (candidates.length !== 1) throw new Error('wait episode has ambiguous driving custody; name driving_work_item_id');
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'event-announce:' + input.eventKey}, 0))`;
  const ref = candidates[0];
  const [item] = await tx<EpisodeItem[]>`SELECT workspace_id, harness_slug, feature_id, taken_by, status, payload
    FROM harness_shared.work_items WHERE workspace_id=${ref.workspace_id}
      AND harness_slug=${ref.harness_slug} AND feature_id=${ref.feature_id} FOR UPDATE`;
  if (!item || item.taken_by !== input.subscriberId) throw new Error('wait episode driving custody changed during admission');
  const [declaration] = await tx`SELECT subscriber_id, causal_generation, logical_gate_key, expected_condition
    FROM harness_shared.event_awaits WHERE workspace_id=${input.eventWorkspaceId}
      AND event_key=${input.eventKey} AND policy='announce'
    ORDER BY causal_generation DESC NULLS LAST, id DESC LIMIT 1`;
  const dependencyRef = declaration?.logical_gate_key ?? input.eventKey;
  // One canonical dependency slot prevents a changed predicate/fingerprint from
  // being disguised as a fresh objective merely by changing its transport id.
  const prior = Object.values(episodes(item.payload)).find(value => value.contract.dependencyRef === dependencyRef);
  const contract: WaitEpisodeContract = {
    dependencyRef, predicateKey: declaration?.logical_gate_key ?? input.eventKey,
    sourceOwnerId: declaration?.subscriber_id ?? input.certificate?.owner.ownerId ?? input.eventKey,
    sourceGeneration: declaration?.causal_generation == null ? null : Number(declaration.causal_generation),
    expectedCondition: declaration?.expected_condition ?? null, payloadFilter: input.payloadFilter,
    noDeltaBudget: lease?.noDeltaBudget ?? prior?.contract.noDeltaBudget ?? drivingContext?.noDeltaBudget ?? 1,
    cadenceMs: input.certificate?.expectedCadenceMs ?? prior?.contract.cadenceMs ?? (input.timeoutSec ?? 1800) * 1000,
    evidence: lease ? { writer: lease.writer, units: lease.units, tool: lease.resolver.tool,
      args: lease.resolver.args, path: lease.resolver.path } : prior?.contract.evidence ?? null,
    substages: lease?.substages ?? prior?.contract.substages ?? [],
  };
  let episode = prior ? carryWaitEpisode(prior, { custodianId: input.subscriberId, contract })
    : createWaitEpisode({ workspaceId: item.workspace_id, harness: item.harness_slug,
      drivingWorkItemId: item.feature_id, custodianId: input.subscriberId, contract,
      nowMs: Math.min(Date.now(), input.certificate?.issuedAtMs ?? Date.now()) });
  if (terminal.has(item.status ?? '')) episode = retireWaitEpisode(episode, 'task-terminal');
  await persistWaitEpisode(tx, episode, prior?.revision ?? null);
  const [previousAwait] = prior ? await tx`SELECT producer_health FROM harness_shared.event_awaits
    WHERE workspace_id=${input.eventWorkspaceId} AND producer_health->'waitEpisode'->>'id'=${episode.id}
    ORDER BY id DESC LIMIT 1` : [];
  const previousHealth = previousAwait?.producer_health as ProducerHealthCertificate | undefined;
  // Exactly one push continuation, including across authenticated successors and
  // equivalent declarations. Cancellation/exhaustion never restores allowance.
  await tx`UPDATE harness_shared.event_awaits SET cancelled_at=now(), cancel_reason='superseded-by-registration'
    WHERE workspace_id=${input.eventWorkspaceId} AND policy<>'announce'
      AND producer_health->'waitEpisode'->>'id'=${episode.id}
      AND fired_at IS NULL AND cancelled_at IS NULL`;
  const certificate: ProducerHealthCertificate = {
    ...(input.certificate ?? previousHealth ?? { version: 1, producer: { kind: 'bounded-dependency', id: episode.id },
      owner: { ownerId: contract.sourceOwnerId, workItemId: null }, issuedAtMs: Date.now(),
      lastProgressAtMs: null, lastFireAtMs: null, expectedCadenceMs: contract.cadenceMs,
      verificationDeadlineMs: episode.nextProbeAtMs ?? Date.now() }),
    waitEpisode: { workspaceId: episode.workspaceId, harness: episode.harness,
      drivingWorkItemId: episode.drivingWorkItemId, id: episode.id },
    // Re-registration preserves the host's settlement witness, never a supplied receipt.
    waitEpisodeReceipt: episode.receipt ?? undefined,
  };
  // Omission on re-arm is not a new verifier. Retain the admitted resolver and
  // bind only its execution principal to the authenticated current custodian.
  if (!certificate.progressLease && previousHealth?.progressLease) certificate.progressLease = previousHealth.progressLease;
  if (certificate.progressLease) certificate.progressLease = { ...certificate.progressLease,
    subscriberId: input.subscriberId, resolver: { ...certificate.progressLease.resolver, onBehalfOf: input.subscriberId } };
  return { certificate, episode };
}

export function waitEpisodeItemIsTerminal(item: { status: string | null }): boolean {
  return terminal.has(item.status ?? '');
}
