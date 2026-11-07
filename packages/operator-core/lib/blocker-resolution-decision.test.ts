import { describe, expect, it } from 'vitest';
import {
  hasUnresolvedBlockerObligation,
  prepareBlockerDecision,
  readBlockerResolution,
  validateBlockerDecisionEvidence,
  type BlockerEvidenceMeasurement,
  type BlockerDecisionInput,
  type PreparedBlockerDecision,
} from './blocker-resolution-decision';

const ref = { kind: 'state' as const, ref: 'state:dependency.health' };
const actor = { ownerId: 'su-a', sessionId: 'session-a', workItemId: 'WI-1', custodianId: 'su-a' };
const options = { now: () => new Date('2026-11-07T02:00:00Z'), newId: () => 'decision-1' };
const defer = (): BlockerDecisionInput => ({
  schemaVersion: 1, idempotencyKey: 'key-1', disposition: 'defer', symptom: 'Dependency endpoint refused the request',
  investigation: [{ action: 'Read dependency health', outcome: 'Canonical state names the current repair owner', evidenceRefs: [ref] }],
  attempts: [], evidenceRefs: [ref],
  deferral: { reason: 'active-peer', responsibleParty: 'su-b', nextAction: 'Repair owner verifies the endpoint',
    reasonEvidenceRefs: [ref], recheckRef: { kind: 'event', ref: 'dependency:repaired:WI-2' } },
});

describe('canonical blocker decision evidence', () => {
  const pending = { status: 'available', condition: 'pending', reachable: true,
    liveOwnerId: 'su-b', responsibleParty: 'su-b' } as const;
  const context = (readEvidence: (ref: { kind: string; ref: string }) => Promise<BlockerEvidenceMeasurement>) => ({
    ownerId: 'su-a', workItemId: 'WI-1', obligationRefs: [ref], readEvidence,
  });
  const resolve = (): BlockerDecisionInput => {
    const { deferral: _unused, ...base } = defer() as Extract<BlockerDecisionInput, { disposition: 'defer' }>;
    return { ...base, disposition: 'self_resolve', verification: { outcome: 'Probe recovered', evidenceRefs: [ref] } };
  };
  it('fails closed on nonexistent, unmeasured and throwing evidence before mutation', async () => {
    for (const read of [async () => ({ status: 'absent', detail: 'not found' } as const),
      async () => ({ status: 'unknown', detail: 'resolver unavailable' } as const),
      async (): Promise<BlockerEvidenceMeasurement> => { throw new Error('outage'); }]) {
      expect(await validateBlockerDecisionEvidence(defer(), context(read))).toMatchObject({
        ok: false, code: 'blocker_decision_evidence', nextAction: expect.stringContaining('keep custody'),
      });
    }
  });
  it('requires live canonical peer custody rather than a name or an existing reference', async () => {
    expect(await validateBlockerDecisionEvidence(defer(), context(async () => pending))).toEqual({ ok: true });
    for (const fact of [{ status: 'available' }, { ...pending, liveOwnerId: undefined },
      { ...pending, liveOwnerId: 'su-c' }, { ...pending, condition: 'satisfied' }]) {
      expect((await validateBlockerDecisionEvidence(defer(), context(async () => fact as BlockerEvidenceMeasurement))).ok).toBe(false);
    }
  });
  it('requires reason evidence tied to the canonical blocked work', async () => {
    expect((await validateBlockerDecisionEvidence(defer(), { ...context(async () => pending), obligationRefs: [] })).ok).toBe(false);
    expect(await validateBlockerDecisionEvidence(defer(), { ...context(async () => ({ ...pending, subjectWorkItemId: 'WI-1' })),
      obligationRefs: [] })).toEqual({ ok: true });
  });
  it('matches dependency aliases only through measured canonical identity', async () => {
    const input = defer() as Extract<BlockerDecisionInput, { disposition: 'defer' }>;
    const qualified = { kind: 'work-item' as const, ref: 'harness-b#WI-2' };
    const bare = { kind: 'work-item' as const, ref: 'WI-2' };
    input.evidenceRefs = [qualified];
    input.investigation[0].evidenceRefs = [qualified];
    input.deferral.reasonEvidenceRefs = [qualified];
    input.deferral.recheckRef = qualified;
    const identity = JSON.stringify(['work-item', 'workspace-a', 'harness-b', 'WI-2']);
    const scoped = { ...context(async () => ({ ...pending, conditionIdentity: identity })), obligationRefs: [bare] };
    expect(await validateBlockerDecisionEvidence(input, scoped)).toEqual({ ok: true });
    expect((await validateBlockerDecisionEvidence(input, { ...scoped,
      readEvidence: async ref => ({ ...pending, conditionIdentity: ref.ref === bare.ref ? identity
        : JSON.stringify(['work-item', 'workspace-a', 'harness-c', 'WI-2']) }) })).ok).toBe(false);
    expect((await validateBlockerDecisionEvidence(input, { ...scoped,
      readEvidence: async () => pending })).ok).toBe(false);
  });
  it('rejects unreachable, already-satisfied and narrative-only rechecks', async () => {
    for (const fact of [{ ...pending, reachable: false }, { ...pending, condition: 'satisfied' }, { status: 'available' }]) {
      expect((await validateBlockerDecisionEvidence(defer(), context(async (r) => r.kind === 'event'
        ? fact as BlockerEvidenceMeasurement : pending))).ok).toBe(false);
    }
    const input = defer() as Extract<BlockerDecisionInput, { disposition: 'defer' }>;
    input.deferral.recheckRef = { kind: 'source', ref: 'src/repair.ts' };
    expect((await validateBlockerDecisionEvidence(input, context(async () => pending))).ok).toBe(false);
  });
  it('does not accept unrelated passing proof or partial remediation as resolution', async () => {
    const satisfied = { status: 'available', condition: 'satisfied' } as const;
    expect(await validateBlockerDecisionEvidence(resolve(), context(async () => satisfied))).toEqual({ ok: true });
    const input = resolve() as Extract<BlockerDecisionInput, { disposition: 'self_resolve' }>;
    input.verification.evidenceRefs = [{ kind: 'test', ref: 'testing:runs:99' }];
    expect((await validateBlockerDecisionEvidence(input, context(async () => satisfied))).ok).toBe(false);
    expect((await validateBlockerDecisionEvidence(input, context(async (r) => r.kind === 'test'
      ? { ...satisfied, subjectWorkItemId: 'WI-1' } : pending))).ok).toBe(false);
  });
  it('checks measured authority human and external reasons without widening authority', async () => {
    for (const [reason, fact] of [
      ['missing-authority', { ...pending, authorityDenied: true }],
      ['human-action', { ...pending, humanAction: true }],
      ['external-dependency', pending],
    ] as const) {
      const input = defer() as Extract<BlockerDecisionInput, { disposition: 'defer' }>;
      input.deferral.reason = reason;
      expect(await validateBlockerDecisionEvidence(input, context(async () => fact))).toEqual({ ok: true });
      expect((await validateBlockerDecisionEvidence(input, context(async () => ({ status: 'available' })))).ok).toBe(false);
      input.deferral.responsibleParty = 'someone-else';
      expect((await validateBlockerDecisionEvidence(input, context(async () => fact))).ok).toBe(false);
    }
  });
  it('requires a safe attempt or measured unsafe-attempt reason for a technical limit', async () => {
    const input = defer() as Extract<BlockerDecisionInput, { disposition: 'defer' }>;
    input.deferral.reason = 'technical-limit'; input.deferral.responsibleParty = 'su-a';
    expect((await validateBlockerDecisionEvidence(input, context(async () => pending))).ok).toBe(false);
    expect(await validateBlockerDecisionEvidence(input, context(async () => ({ ...pending, unsafeToAttempt: true })))).toEqual({ ok: true });
    input.attempts = [{ action: 'Run bounded recovery probe', outcome: 'Still unavailable', evidenceRefs: [ref] }];
    expect(await validateBlockerDecisionEvidence(input, context(async () => pending))).toEqual({ ok: true });
  });
  it('measures duplicate refs once and bounds reader concurrency', async () => {
    const seen: string[] = [];
    expect(await validateBlockerDecisionEvidence(defer(), context(async (r) => { seen.push(r.ref); return pending; }))).toEqual({ ok: true });
    expect(seen).toEqual(['state:dependency.health', 'dependency:repaired:WI-2']);
  });
});
function success(value: PreparedBlockerDecision) {
  if (!value.ok) throw new Error(JSON.stringify(value));
  return value;
}
const recorded = () => success(prepareBlockerDecision({}, defer(), actor, options));

describe('blocker resolution decisions', () => {
  it('binds retry identity to the paired lifecycle and payload effect', () => {
    const effect = { state: 'blocked', patch: { checkpoint: 'investigated' }, unset: [] };
    const first = success(prepareBlockerDecision({}, defer(), actor, { ...options, effect }));
    expect(success(prepareBlockerDecision(first.patch, defer(), actor, { effect })).replayed).toBe(true);
    for (const changed of [{ ...effect, state: 'open' }, { ...effect, patch: { checkpoint: 'changed' } },
      { ...effect, unset: ['checkpoint'] }]) {
      expect(prepareBlockerDecision(first.patch, defer(), actor, { effect: changed }))
        .toMatchObject({ ok: false, code: 'blocker_decision_conflict' });
    }
  });
  it('preserves authenticated decision provenance and exact retry history', () => {
    const first = recorded();
    expect(first.record).toMatchObject({ id: 'decision-1', revision: 1, authorId: 'su-a', sessionId: 'session-a',
      workItemId: 'WI-1', recordedAt: '2026-11-07T02:00:00.000Z' });
    const replay = success(prepareBlockerDecision(first.patch, defer(), { ...actor, custodianId: 'su-b' },
      { now: () => new Date('2026-12-01'), newId: () => 'must-not-be-used' }));
    expect(replay.replayed).toBe(true);
    expect(replay.record).toEqual(first.record);
    expect(replay.state.history).toHaveLength(1);
    expect(prepareBlockerDecision({}, { ...defer(), authorId: 'forged' }, actor)).toMatchObject({ ok: false, code: 'blocker_decision_invalid' });
  });

  it('conflicts on changed payload under the same author and idempotency key', () => {
    const first = recorded();
    const snapshot = structuredClone(first.patch);
    expect(prepareBlockerDecision(first.patch, { ...defer(), symptom: 'Different evidence' }, actor)).toMatchObject({
      ok: false, code: 'blocker_decision_conflict',
    });
    expect(first.patch).toEqual(snapshot);
  });

  it('requires current custodian and predecessor CAS for a new revision', () => {
    const first = recorded();
    const next = { ...defer(), idempotencyKey: 'key-2', priorRevision: 1 };
    expect(prepareBlockerDecision(first.patch, { ...next, priorRevision: 2 }, actor)).toMatchObject({
      ok: false, code: 'blocker_decision_revision_conflict',
    });
    expect(prepareBlockerDecision(first.patch, next, { ...actor, custodianId: 'su-b' })).toMatchObject({
      ok: false, code: 'blocker_decision_custody',
    });
    const revised = success(prepareBlockerDecision(first.patch, next, actor, options));
    expect(revised.record).toMatchObject({ id: first.record.id, revision: 2 });
    expect(revised.state.history[0]).toEqual(first.record);
  });

  it('does not regress current history when an old receipt is replayed', () => {
    const first = recorded();
    const second = success(prepareBlockerDecision(first.patch, { ...defer(), idempotencyKey: 'key-2', priorRevision: 1 }, actor, options));
    const replay = success(prepareBlockerDecision(second.patch, defer(), actor, options));
    expect(replay.record.revision).toBe(1);
    expect(replay.state.history).toEqual(second.state.history);
    expect(readBlockerResolution(replay.patch).current?.revision).toBe(2);
  });

  it('requires measured verification for self resolution', () => {
    const { deferral: _deferral, ...base } = defer() as Extract<BlockerDecisionInput, { disposition: 'defer' }>;
    const resolve = { ...base, disposition: 'self_resolve', verification: { outcome: 'Endpoint probe succeeded', evidenceRefs: [ref] } };
    expect(prepareBlockerDecision({}, { ...resolve, verification: undefined }, actor)).toMatchObject({ ok: false, code: 'blocker_decision_invalid' });
    expect(prepareBlockerDecision({}, { ...resolve, verification: { outcome: 'trust me', evidenceRefs: [] } }, actor)).toMatchObject({ ok: false });
    expect(success(prepareBlockerDecision({}, resolve, actor, options)).record.decision).toMatchObject({ disposition: 'self_resolve' });
  });

  it('validates evidenced deferral reasons', () => {
    const input = defer() as Extract<BlockerDecisionInput, { disposition: 'defer' }>;
    for (const reason of ['outside-my-lane', 'not-mine', 'filed-a-bug']) {
      expect(prepareBlockerDecision({}, { ...input, deferral: { ...input.deferral, reason } }, actor)).toMatchObject({ ok: false });
    }
    for (const field of ['responsibleParty', 'nextAction', 'recheckRef', 'reasonEvidenceRefs']) {
      expect(prepareBlockerDecision({}, { ...input, deferral: { ...input.deferral, [field]: undefined } }, actor)).toMatchObject({ ok: false });
    }
    expect(prepareBlockerDecision({}, { ...input, investigation: [] }, actor)).toMatchObject({ ok: false });
    // This is structural validation only. Live reason/authority/reachability
    // measurements remain mandatory at the guarded boundary before a write.
    for (const reason of ['active-peer', 'missing-authority', 'human-action', 'external-dependency', 'technical-limit']) {
      expect(prepareBlockerDecision({}, { ...input, deferral: { ...input.deferral, reason } }, actor).ok).toBe(true);
    }
  });

  it('reports missing decision evidence with a safe next action', () => {
    const result = prepareBlockerDecision({}, { ...defer(), investigation: [], evidenceRefs: [] }, actor);
    expect(result).toMatchObject({ ok: false, code: 'blocker_decision_invalid', nextAction: expect.stringContaining('keep custody') });
    if (!result.ok) expect(result.missing.join(' ')).toMatch(/investigation/);
  });

  it('retains unresolved obligations across label changes', () => {
    const first = recorded();
    for (const state of ['open', 'todo', 'wip']) expect(hasUnresolvedBlockerObligation(first.patch, state)).toBe(true);
    expect(hasUnresolvedBlockerObligation({ externalBlockers: [{ status: 'active' }] }, 'open')).toBe(true);
    expect(hasUnresolvedBlockerObligation({}, 'blocked')).toBe(true);
    expect(hasUnresolvedBlockerObligation({}, 'open')).toBe(false);
  });

  it('keeps legacy blockers unproven and refuses to erase unreadable history', () => {
    expect(readBlockerResolution({ externalBlockers: [{ status: 'active' }] })).toMatchObject({ status: 'unproven' });
    const payload = { blockerResolution: { schemaVersion: 2, history: [] }, untouched: true };
    expect(prepareBlockerDecision(payload, defer(), actor)).toMatchObject({ ok: false, code: 'blocker_decision_state_invalid' });
    expect(payload).toEqual({ blockerResolution: { schemaVersion: 2, history: [] }, untouched: true });
    expect(hasUnresolvedBlockerObligation(payload)).toBe(true);
  });

  it('rejects copied history from another work item', () => {
    const first = recorded();
    expect(prepareBlockerDecision(first.patch, { ...defer(), idempotencyKey: 'key-2', priorRevision: 1 },
      { ...actor, workItemId: 'WI-other' })).toMatchObject({ ok: false, code: 'blocker_decision_state_invalid' });
  });
});
