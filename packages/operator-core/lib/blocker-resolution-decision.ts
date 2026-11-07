import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

/** Shared by the existing blocker/park/lifecycle writers. This module prepares a
 * payload patch; the caller must commit it and the paired lifecycle mutation in
 * one transaction. It deliberately owns no table, queue, or background worker. */
const text = (max: number) => z.string().trim().min(1).max(max);
export const blockerEvidenceRefSchema = z.object({
  kind: z.enum(['work-item', 'event', 'state', 'runtime', 'source', 'test', 'doc', 'session', 'authority']),
  ref: text(2000),
}).strict();
const evidence = (max = 16) => z.array(blockerEvidenceRefSchema).min(1).max(max);
const investigationStepSchema = z.object({
  action: text(1000),
  outcome: text(4000),
  evidenceRefs: evidence(),
}).strict();
const common = {
  schemaVersion: z.literal(1),
  idempotencyKey: text(200),
  priorRevision: z.number().int().positive().optional(),
  symptom: text(4000),
  investigation: z.array(investigationStepSchema).min(1).max(16),
  attempts: z.array(investigationStepSchema).max(16).default([]),
  evidenceRefs: evidence(32),
};
export const blockerDecisionInputSchema = z.discriminatedUnion('disposition', [
  z.object({
    ...common,
    disposition: z.literal('self_resolve'),
    verification: z.object({ outcome: text(4000), evidenceRefs: evidence() }).strict(),
  }).strict(),
  z.object({
    ...common,
    disposition: z.literal('defer'),
    deferral: z.object({
      reason: z.enum(['active-peer', 'missing-authority', 'human-action', 'external-dependency', 'technical-limit']),
      reasonEvidenceRefs: evidence(),
      responsibleParty: text(200),
      nextAction: text(2000),
      recheckRef: blockerEvidenceRefSchema,
    }).strict(),
  }).strict(),
]);
export type BlockerDecisionInput = z.infer<typeof blockerDecisionInputSchema>;
export type BlockerEvidenceRef = z.infer<typeof blockerEvidenceRefSchema>;

const recordSchema = z.object({
  id: text(200),
  revision: z.number().int().positive(),
  workItemId: text(200),
  authorId: text(200),
  sessionId: text(200),
  recordedAt: z.string().datetime(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: blockerDecisionInputSchema,
}).strict();
export type BlockerDecisionRecord = z.infer<typeof recordSchema>;
const stateSchema = z.object({ schemaVersion: z.literal(1), history: z.array(recordSchema).min(1) }).strict();
export type BlockerResolutionState = z.infer<typeof stateSchema>;

export type BlockerResolutionRead =
  | { status: 'unproven'; state: null; current: null }
  | { status: 'invalid'; state: null; current: null }
  | { status: 'recorded'; state: BlockerResolutionState; current: BlockerDecisionRecord };

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Legacy blockers stay readable, but never acquire invented investigation. An
 * unreadable version is distinguished from absence so writers cannot erase it. */
export function readBlockerResolution(payload: unknown): BlockerResolutionRead {
  const raw = object(payload).blockerResolution;
  if (raw === undefined) return { status: 'unproven', state: null, current: null };
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) return { status: 'invalid', state: null, current: null };
  return { status: 'recorded', state: parsed.data, current: parsed.data.history.at(-1)! };
}

/** Ordering of object keys is not a payload change; ordering of evidence or
 * investigation steps is. Hash the normalized schema output, including the CAS. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
  );
  return value;
}
export function blockerDecisionRequestHash(input: BlockerDecisionInput): string {
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}

export interface BlockerDecisionActor {
  /** All fields come from authenticated context and the canonical row reader. */
  ownerId: string;
  sessionId: string;
  workItemId: string;
  custodianId: string | null;
}
export type BlockerDecisionProblem = {
  ok: false;
  code: 'blocker_decision_invalid' | 'blocker_decision_state_invalid' | 'blocker_decision_conflict'
    | 'blocker_decision_revision_conflict' | 'blocker_decision_custody' | 'blocker_decision_evidence';
  missing: string[];
  nextAction: string;
};
export type PreparedBlockerDecision = BlockerDecisionProblem | {
  ok: true;
  replayed: boolean;
  record: BlockerDecisionRecord;
  /** CAS against the raw stored value, not a lossy parsed projection. */
  expectedState: unknown;
  state: BlockerResolutionState;
  patch: { blockerResolution: BlockerResolutionState };
};

function problem(code: BlockerDecisionProblem['code'], missing: string[], nextAction: string): BlockerDecisionProblem {
  return { ok: false, code, missing, nextAction };
}

/** Validate shape and prepare immutable provenance/history without mutating the
 * source payload. Evidence existence, live peer ownership, authority, and recheck
 * reachability are measured by the shared boundary validator before persistence;
 * a caller's prose is never proof of any of those facts. */
export function prepareBlockerDecision(
  payload: unknown,
  value: unknown,
  actor: BlockerDecisionActor,
  options: { now?: () => Date; newId?: () => string; effect?: unknown } = {},
): PreparedBlockerDecision {
  const parsed = blockerDecisionInputSchema.safeParse(value);
  if (!parsed.success) return problem('blocker_decision_invalid',
    parsed.error.issues.map((issue) => `${issue.path.join('.') || 'decision'}: ${issue.message}`),
    'Investigate the blocker and supply the listed evidence before deferring; keep custody while the decision is refused.');
  const input = parsed.data;
  if (![actor.ownerId, actor.sessionId, actor.workItemId].every((part) => part.trim())) {
    return problem('blocker_decision_invalid', ['authenticated actor, session, and work item'],
      'Resolve authenticated context before writing a blocker decision.');
  }
  const read = readBlockerResolution(payload);
  if (read.status === 'invalid') return problem('blocker_decision_state_invalid', ['readable stored decision history'],
    'Read the canonical blocker history and repair its version; do not overwrite unknown metadata.');
  // A retry cannot reuse a receipt to authorize a different lifecycle or payload
  // effect. Pure preparation callers retain the original decision-only hash.
  const requestHash = options.effect === undefined ? blockerDecisionRequestHash(input)
    : createHash('sha256').update(JSON.stringify(canonical({ decision: input, effect: options.effect }))).digest('hex');
  const history = read.state?.history ?? [];
  const existing = history.find((record) => record.authorId === actor.ownerId && record.decision.idempotencyKey === input.idempotencyKey);
  if (existing) {
    if (existing.requestHash !== requestHash || existing.workItemId !== actor.workItemId) {
      return problem('blocker_decision_conflict', ['unchanged payload for the original idempotency key'],
        'Read the existing receipt. Use a new key and the current priorRevision for an authorized revision.');
    }
    // A historical replay returns its original receipt, without restoring an old
    // current revision or taking custody back from a later holder.
    return { ok: true, replayed: true, record: existing, expectedState: object(payload).blockerResolution,
      state: read.state!, patch: { blockerResolution: read.state! } };
  }
  if (actor.custodianId !== actor.ownerId) return problem('blocker_decision_custody', ['current custodian authorization'],
    'Coordinate with the canonical current custodian; a decision cannot transfer or bypass its claim.');
  const current = read.current;
  if (current && current.workItemId !== actor.workItemId) return problem('blocker_decision_state_invalid', ['history belongs to this work item'],
    'Read the canonical work-item record; copied blocker history cannot authorize this mutation.');
  // A resolved obligation may begin a new decision. Every other change is an
  // explicit revision; changing the verb or key does not discard the old record.
  const startsNew = !current || (current.decision.disposition === 'self_resolve' && input.priorRevision === undefined);
  if ((!startsNew && input.priorRevision !== current!.revision) || (startsNew && input.priorRevision !== undefined)) {
    return problem('blocker_decision_revision_conflict', [`priorRevision ${current?.revision ?? 'absent for a new decision'}`],
      'Read the current decision and retry with its exact revision; no history or lifecycle state was changed.');
  }
  const record: BlockerDecisionRecord = {
    id: startsNew ? (options.newId ?? randomUUID)() : current!.id,
    revision: startsNew ? 1 : current!.revision + 1,
    workItemId: actor.workItemId,
    authorId: actor.ownerId,
    sessionId: actor.sessionId,
    recordedAt: (options.now ?? (() => new Date()))().toISOString(),
    requestHash,
    decision: input,
  };
  const state: BlockerResolutionState = { schemaVersion: 1, history: [...history, record] };
  return { ok: true, replayed: false, record, expectedState: object(payload).blockerResolution,
    state, patch: { blockerResolution: state } };
}

/** Once observed, an unresolved obligation survives status/edge/verb changes.
 * Canonical current blockers are always included, including legacy unproven rows. */
export function hasUnresolvedBlockerObligation(payload: unknown, state?: string): boolean {
  const row = object(payload);
  const read = readBlockerResolution(payload);
  return read.status === 'invalid'
    || (read.status === 'recorded' && read.current.decision.disposition === 'defer')
    || ['blocked', 'needs-human'].includes(state ?? '')
    || (Array.isArray(row.externalBlockers) && row.externalBlockers.some((blocker) => object(blocker).status === 'active'));
}

/** Internal reader result, never accepted in a tool payload. A condition is a
 * measured predicate, not an inference from a reference's existence or prose.
 * subjectWorkItemId may only come from canonical provenance (e.g. a test run's
 * work-item binding); a caller mentioning an item in test output is not binding. */
export type BlockerEvidenceMeasurement =
  | { status: 'absent' | 'unknown'; detail: string }
  | {
    status: 'available';
    condition?: 'satisfied' | 'pending';
    reachable?: boolean;
    subjectWorkItemId?: string;
    /** Host-resolved tenant/harness identity; aliases share a condition only
     * when their canonical readers return this exact identity. */
    conditionIdentity?: string;
    responsibleParty?: string;
    liveOwnerId?: string;
    authorityDenied?: boolean;
    humanAction?: boolean;
    unsafeToAttempt?: boolean;
  };

const evidenceKey = (ref: BlockerEvidenceRef) => JSON.stringify([ref.kind, ref.ref]);

/** Shared pre-mutation check for agent-controlled boundaries. Its context is
 * assembled from the authenticated caller and canonical blocker/dependency rows,
 * never from request fields. Existing boundary-specific authority/hold checks
 * still apply after this check. An exact stored replay needs no new measurement:
 * callers return its original receipt without repeating the lifecycle effect. */
export async function validateBlockerDecisionEvidence(
  input: BlockerDecisionInput,
  context: {
    ownerId: string;
    workItemId: string;
    obligationRefs: readonly BlockerEvidenceRef[];
    readEvidence: (ref: BlockerEvidenceRef) => Promise<BlockerEvidenceMeasurement>;
  },
): Promise<{ ok: true } | BlockerDecisionProblem> {
  const refs = [
    ...context.obligationRefs,
    ...input.evidenceRefs,
    ...input.investigation.flatMap((step) => step.evidenceRefs),
    ...input.attempts.flatMap((step) => step.evidenceRefs),
    ...(input.disposition === 'defer'
      ? [...input.deferral.reasonEvidenceRefs, input.deferral.recheckRef]
      : input.verification.evidenceRefs),
  ];
  const unique = new Map(refs.map((ref) => [evidenceKey(ref), ref]));
  const refuse = (missing: string[]) => problem('blocker_decision_evidence', missing,
    'Read the named canonical evidence and investigate the remaining condition; keep custody while the decision is refused.');
  if (unique.size > 64) return refuse(['at most 64 distinct evidence references per decision']);
  const measured = new Map<string, BlockerEvidenceMeasurement>();
  const entries = [...unique.entries()];
  // Bound parallel canonical reads. A failed resolver is unknown, never absence
  // or permission to release. Each distinct ref is measured once per request.
  for (let offset = 0; offset < entries.length; offset += 8) {
    await Promise.all(entries.slice(offset, offset + 8).map(async ([key, ref]) => {
      try { measured.set(key, await context.readEvidence(ref)); }
      catch { measured.set(key, { status: 'unknown', detail: 'canonical reader failed' }); }
    }));
  }
  const missing: string[] = [];
  for (const [key, ref] of entries) {
    const value = measured.get(key)!;
    if (value.status !== 'available') missing.push(`${ref.kind}:${ref.ref}: ${value.status} (${value.detail})`);
  }
  if (missing.length) return refuse(missing);
  const value = (ref: BlockerEvidenceRef) => measured.get(evidenceKey(ref)) as Extract<BlockerEvidenceMeasurement, { status: 'available' }>;
  const obligations = new Set(context.obligationRefs.map(evidenceKey));
  const conditionIdentities = new Set(context.obligationRefs.map(ref => value(ref).conditionIdentity).filter(Boolean));
  const relevant = (ref: BlockerEvidenceRef) => obligations.has(evidenceKey(ref)) ||
    (Boolean(value(ref).conditionIdentity) && conditionIdentities.has(value(ref).conditionIdentity)) ||
    value(ref).subjectWorkItemId === context.workItemId;
  if (input.disposition === 'self_resolve') {
    if (!input.verification.evidenceRefs.some((ref) => relevant(ref) && value(ref).condition === 'satisfied')) {
      missing.push('measured verification bound to this work item or its canonical blocker condition');
    }
    for (const ref of context.obligationRefs) {
      if (value(ref).condition !== 'satisfied') missing.push(`unresolved canonical condition ${ref.kind}:${ref.ref}`);
    }
  } else {
    const { reason, reasonEvidenceRefs, responsibleParty, recheckRef } = input.deferral;
    const facts = reasonEvidenceRefs.filter(relevant).map(value);
    const recheck = value(recheckRef);
    if (!['work-item', 'state', 'event'].includes(recheckRef.kind) || recheck.reachable !== true || recheck.condition !== 'pending') {
      missing.push('reachable, still-pending event, state predicate or work-item recheck');
    }
    switch (reason) {
      case 'active-peer':
        if (responsibleParty === context.ownerId || !facts.some((fact) => fact.liveOwnerId === responsibleParty && fact.condition === 'pending')) {
          missing.push('current live peer custody of the canonical unresolved dependency');
        }
        break;
      case 'missing-authority':
        if (!facts.some((fact) => fact.authorityDenied === true && fact.responsibleParty === responsibleParty)) {
          missing.push('canonical authority denial and its accountable authority holder');
        }
        break;
      case 'human-action':
        if (!facts.some((fact) => fact.humanAction === true && fact.responsibleParty === responsibleParty && fact.condition === 'pending')) {
          missing.push('canonical human capability requiring the named responsible party');
        }
        break;
      case 'external-dependency':
        if (!facts.some((fact) => fact.condition === 'pending' && fact.responsibleParty === responsibleParty && !fact.humanAction)) {
          missing.push('canonical pending external dependency and accountable source');
        }
        break;
      case 'technical-limit':
        if (responsibleParty !== context.ownerId || !facts.some((fact) => fact.condition === 'pending') ||
            (!input.attempts.length && !facts.some((fact) => fact.unsafeToAttempt === true))) {
          missing.push('investigated pending technical limit, retained responsibility, and attempted safe remedy or measured unsafe-attempt reason');
        }
        break;
    }
  }
  return missing.length ? refuse(missing) : { ok: true };
}
