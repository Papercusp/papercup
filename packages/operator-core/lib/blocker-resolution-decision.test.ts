import { describe, expect, it } from 'vitest';
import { updateExternalBlockerHistory } from './external-blockers';
import {
  hasUnresolvedBlockerObligation,
  prepareBlockerDecision,
  readBlockerResolution,
  projectBlockerResolution,
  validateBlockerDecisionEvidence,
  BLOCKER_EVIDENCE_REF_GRAMMAR,
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

describe('host unmeasured runtime provenance', () => {
  it('admits only an exact host-bound pending commit settlement as an event recheck', async () => {
    const runtime = { kind: 'runtime' as const, ref: 'legacy-native-condition' };
    const remedy = { kind: 'source' as const, ref: 'package.json' };
    const recheckRef = { kind: 'event' as const, ref: 'work-item:settled:WI-2' };
    const scope = { workspaceId: 'w', harnessSlug: 'h', workItemId: 'WI-1', custodianId: 'su-a' };
    const input: BlockerDecisionInput = { schemaVersion: 1, idempotencyKey: 'pending-settlement', disposition: 'defer',
      symptom: 'Verified repair awaits committed identity', evidenceRefs: [runtime, remedy],
      investigation: [{ action: 'Read original condition', outcome: 'Unmeasured', evidenceRefs: [runtime] }],
      attempts: [{ action: 'Verify repair', outcome: 'Pending settlement', evidenceRefs: [remedy] }],
      deferral: { reason: 'technical-limit', responsibleParty: 'su-a', nextAction: 'Consume exact settlement',
        reasonEvidenceRefs: [runtime], recheckRef } };
    const settlement = { status: 'available' as const, condition: 'pending' as const, reachable: true,
      responsibleParty: 'su-a', canonicalWorkItemId: 'WI-2',
      pendingCommitSettlement: { generation: 1, evidenceHash: 'e'.repeat(64) } };
    const check = (measurement: BlockerEvidenceMeasurement, ref = recheckRef) => validateBlockerDecisionEvidence(
      { ...input, deferral: { ...input.deferral, recheckRef: ref } },
      { ownerId: 'su-a', workItemId: 'WI-1', obligationRefs: [runtime], unmeasuredRuntimeDeferral: scope,
        readEvidence: async evidence => evidence.kind === 'runtime'
          ? { status: 'unmeasured-runtime', ref: runtime.ref, scope, detail: 'Original predicate remains unmeasured' }
          : evidence.kind === 'event' ? measurement : { status: 'available' } });
    expect(await check(settlement)).toEqual({ ok: true });
    for (const override of [{ pendingCommitSettlement: undefined },
      { pendingCommitSettlement: { generation: 0, evidenceHash: 'e'.repeat(64) } },
      { pendingCommitSettlement: { generation: 1, evidenceHash: 'invalid' } },
      { canonicalWorkItemId: 'WI-other' }, { canonicalWorkItemId: 'WI-1' },
      { responsibleParty: 'su-b' }, { condition: 'satisfied' as const }, { reachable: false }]) {
      expect(await check({ ...settlement, ...override })).toMatchObject({ ok: false });
    }
    expect(await check(settlement, { kind: 'event', ref: 'work-item:done:WI-2' })).toMatchObject({ ok: false });
    expect(await check(settlement, { kind: 'event', ref: 'arbitrary:pending:WI-2' })).toMatchObject({ ok: false });
  });
  it('requires the exact canonical obligation and matching authenticated scope', async () => {
    const runtime = { kind: 'runtime' as const, ref: 'legacy-native-condition' };
    const remedy = { kind: 'source' as const, ref: 'package.json' };
    const recheck = { kind: 'work-item' as const, ref: 'h#WI-2' };
    const scope = { workspaceId: 'w', harnessSlug: 'h', workItemId: 'WI-1', custodianId: 'su-a' };
    const measurement = { status: 'unmeasured-runtime' as const, ref: runtime.ref, scope, detail: 'Original predicate unmeasured' };
    const input: BlockerDecisionInput = { schemaVersion: 1, idempotencyKey: 'unmeasured', disposition: 'defer',
      symptom: 'Legacy runtime lacks an adapter', evidenceRefs: [runtime, remedy],
      investigation: [{ action: 'Read canonical condition', outcome: 'Unmeasured', evidenceRefs: [runtime] }],
      attempts: [{ action: 'Attempt safe inspection', outcome: 'No recovery verdict', evidenceRefs: [remedy] }],
      deferral: { reason: 'technical-limit', responsibleParty: 'su-a', nextAction: 'Continue owned recheck',
        reasonEvidenceRefs: [runtime], recheckRef: recheck } };
    const readEvidence = async (evidence: { kind: string }) => evidence.kind === 'runtime' ? measurement
      : evidence.kind === 'work-item' ? { status: 'available' as const, condition: 'pending' as const,
        reachable: true, responsibleParty: 'su-a', canonicalWorkItemId: 'WI-2' } : { status: 'available' as const };
    const context = { ownerId: 'su-a', workItemId: 'WI-1', obligationRefs: [runtime],
      unmeasuredRuntimeDeferral: scope, readEvidence };
    expect(await validateBlockerDecisionEvidence(input, context)).toEqual({ ok: true });
    for (const badScope of [undefined, { ...scope, workspaceId: 'other' }, { ...scope, harnessSlug: 'other' },
      { ...scope, workItemId: 'WI-other' }, { ...scope, custodianId: 'su-other' }]) {
      expect(await validateBlockerDecisionEvidence(input, { ...context, unmeasuredRuntimeDeferral: badScope })).toMatchObject({ ok: false });
    }
    expect(await validateBlockerDecisionEvidence(input, { ...context, obligationRefs: [] })).toMatchObject({ ok: false });
  });
});

describe('canonical blocker decision views', () => {
  it('distinguishes blocker-free, unproven and unreadable histories without inventing evidence', () => {
    expect(projectBlockerResolution({}, { id: 'WI-1', state: 'open' })).toBeUndefined();
    expect(projectBlockerResolution({}, { id: 'WI-1', state: 'blocked' }))
      .toMatchObject({ status: 'unproven', nudge: expect.stringContaining('Investigate') });
    expect(projectBlockerResolution({ blockerResolution: { schemaVersion: 99 } }, { id: 'WI-1' }))
      .toMatchObject({ status: 'invalid', nudge: expect.stringContaining('unknown metadata') });
  });

  it('preserves canonical identity, provenance and accountable action without nagging a recorded deferral', () => {
    const first = prepareBlockerDecision({}, defer(), actor, options);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('fixture refused');
    const revised = prepareBlockerDecision(first.patch, { ...defer(), idempotencyKey: 'key-2', priorRevision: 1 }, actor, options);
    if (!revised.ok) throw new Error('revision refused');
    const view = projectBlockerResolution(revised.patch, { id: 'WI-1', harness: 'papercusp' });
    expect(view).toMatchObject({
      status: 'recorded', current: { id: 'decision-1', revision: 2, authorId: 'su-a',
        sessionId: 'session-a', recordedAt: '2026-11-07T02:00:00.000Z',
        deferral: { responsibleParty: 'su-b', nextAction: 'Repair owner verifies the endpoint' } },
      history: { total: 2, prior: [{ id: 'decision-1', revision: 1, disposition: 'defer' }], omitted: 0 },
      investigation: { rows: defer().investigation, omitted: 0 },
    });
    expect(view).not.toHaveProperty('nudge');
    expect(view?.readRef.args).toMatchObject({ id: 'WI-1', harness: 'papercusp', payloadTier: 'full',
      projection: { pick: ['results[].workItem.payload.blockerResolution'] } });
  });

  it('bounds large histories using whole-record omissions and an exact recovery reference', () => {
    const input = defer();
    input.symptom = 's'.repeat(4000);
    input.investigation = Array.from({ length: 16 }, () => ({ ...input.investigation[0], outcome: 'x'.repeat(4000) }));
    input.attempts = input.investigation;
    if (input.disposition !== 'defer') throw new Error('fixture is a deferral');
    input.deferral.nextAction = 'a'.repeat(2000);
    const prepared = prepareBlockerDecision({}, input, actor, options);
    if (!prepared.ok) throw new Error('fixture refused');
    const view = projectBlockerResolution(prepared.patch, { id: 'WI-1', harness: 'papercusp' });
    expect(JSON.stringify(view).length).toBeLessThanOrEqual(2200);
    expect(view).toMatchObject({ status: 'recorded', current: { id: 'decision-1' },
      omittedFields: ['current.deferral', 'current.symptom'],
      investigation: { rows: [], omitted: 16 }, attempts: { rows: [], omitted: 16 } });
    expect(view?.readRef.args.id).toBe('WI-1');
    expect(JSON.stringify(view)).not.toContain('TRUNCATED');
  });
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
  it('names every accepted verification ref format in the refusal, derived from the grammar (EI-28983003176099299)', async () => {
    const input = resolve() as Extract<BlockerDecisionInput, { disposition: 'self_resolve' }>;
    // The deadlocked agent cited a passing test run: the row exists but measures no condition.
    input.verification.evidenceRefs = [{ kind: 'test', ref: 'testing:runs:group-a:42' }];
    const result = await validateBlockerDecisionEvidence(input, context(async (r) => r.kind === 'test'
      ? { status: 'available' } : { status: 'available', condition: 'satisfied' }));
    expect(result).toMatchObject({ ok: false, code: 'blocker_decision_evidence' });
    const refusal = (result as { missing: string[] }).missing.find((line) => line.startsWith('measured verification bound'));
    expect(refusal).toBeDefined();
    const [accepted, existenceOnly] = refusal!.split(`subjectWorkItemId ${actor.workItemId}.`);
    expect(existenceOnly).toBeDefined();
    for (const [kind, grammar] of Object.entries(BLOCKER_EVIDENCE_REF_GRAMMAR)) {
      const named = `${kind} {ref: ${grammar.ref}}`;
      expect(grammar.measures ? accepted : existenceOnly).toContain(named);
      expect(grammar.measures ? existenceOnly : accepted).not.toContain(named);
    }
    expect(existenceOnly).toContain('test {ref: testing:runs:RUN_GROUP:ROW_ID}');
  });
  it('accepts a completed related condition only with measured canonical identity', async () => {
    const input = resolve() as Extract<BlockerDecisionInput, { disposition: 'self_resolve' }>;
    const witness = { kind: 'work-item' as const, ref: 'harness-b#WI-2' };
    const edge = { kind: 'work-item' as const, ref: 'WI-2' };
    input.verification.evidenceRefs = [witness];
    const identity = JSON.stringify(['work-item', 'workspace-a', 'harness-b', 'WI-2']);
    const scoped = { ...context(async () => ({ status: 'available' as const,
      condition: 'satisfied' as const, conditionIdentity: identity })),
      obligationRefs: [], relatedConditionRefs: [edge] };
    expect(await validateBlockerDecisionEvidence(input, scoped)).toEqual({ ok: true });
    expect((await validateBlockerDecisionEvidence(input, { ...scoped,
      readEvidence: async r => ({ status: 'available', condition: 'satisfied',
        conditionIdentity: r.ref === edge.ref ? identity
          : JSON.stringify(['work-item', 'workspace-a', 'harness-c', 'WI-2']) }) })).ok).toBe(false);
    for (const readEvidence of [async () => ({ status: 'unknown' as const, detail: 'unmeasured' }),
      async () => ({ status: 'available' as const, condition: 'pending' as const,
        conditionIdentity: identity })]) {
      expect((await validateBlockerDecisionEvidence(input, { ...scoped, readEvidence })).ok).toBe(false);
    }
  });
  it('keeps every unresolved obligation when accepting a related completed witness', async () => {
    const input = resolve() as Extract<BlockerDecisionInput, { disposition: 'self_resolve' }>;
    const witness = { kind: 'work-item' as const, ref: 'harness-b#WI-2' };
    input.verification.evidenceRefs = [witness];
    const result = await validateBlockerDecisionEvidence(input, {
      ...context(async r => r.ref === witness.ref
        ? { status: 'available', condition: 'satisfied' } : pending), relatedConditionRefs: [witness],
    });
    expect(result).toMatchObject({ ok: false, missing: [expect.stringContaining('unresolved canonical condition')] });
  });
  it('supersedes a lapsed active-peer recheck only with a citation and verification bound to this item (EI-28983003176099299)', async () => {
    const recheck = { kind: 'work-item' as const, ref: 'EI-2' };
    const proof = { kind: 'test' as const, ref: 'testing:runs:group-1:7' };
    const priorDeferral: Extract<BlockerDecisionInput, { disposition: 'defer' }>['deferral'] = {
      reason: 'active-peer', responsibleParty: 'su-b', nextAction: 'su-b lands EI-2',
      reasonEvidenceRefs: [recheck], recheckRef: recheck,
    };
    const input = resolve() as Extract<BlockerDecisionInput, { disposition: 'self_resolve' }>;
    input.verification.evidenceRefs = [proof];
    input.evidenceRefs = [ref, recheck];
    const scoped = (custody: Record<string, unknown>, opts: { bound?: string; deferral?: typeof priorDeferral } = {}) => ({
      ...context(async (r): Promise<BlockerEvidenceMeasurement> => r.ref === recheck.ref
        ? { ...pending, ...custody } as BlockerEvidenceMeasurement
        : r.ref === proof.ref ? { status: 'available', condition: 'satisfied', subjectWorkItemId: opts.bound ?? 'WI-1' }
          : { status: 'available', condition: 'satisfied' }),
      obligationRefs: [recheck], priorDeferral: opts.deferral ?? priorDeferral,
    });
    const lapsed = { liveOwnerId: undefined };
    // The named custodian, or a new live custodian, still holds the dependency: it binds.
    expect(await validateBlockerDecisionEvidence(input, scoped({}))).toMatchObject({
      ok: false, missing: [expect.stringContaining('unresolved canonical condition work-item:EI-2')] });
    expect((await validateBlockerDecisionEvidence(input, scoped({ liveOwnerId: 'su-c', responsibleParty: 'su-c' }))).ok).toBe(false);
    // Custody lapsed (custodian presence went stale, or the item was released): superseded.
    expect(await validateBlockerDecisionEvidence(input, scoped(lapsed))).toEqual({ ok: true });
    expect(await validateBlockerDecisionEvidence(input, scoped({ ...lapsed, responsibleParty: undefined }))).toEqual({ ok: true });
    // ...but never silently, never on unbound proof, and never for a non-custody deferral.
    expect(await validateBlockerDecisionEvidence({ ...input, evidenceRefs: [ref] }, scoped(lapsed))).toMatchObject({
      ok: false, missing: [expect.stringContaining('lapsed active-peer recheck work-item:EI-2')] });
    expect((await validateBlockerDecisionEvidence(input, scoped(lapsed, { bound: 'WI-9' }))).ok).toBe(false);
    expect((await validateBlockerDecisionEvidence(input, scoped(lapsed, {
      deferral: { ...priorDeferral, reason: 'external-dependency' } }))).ok).toBe(false);
    expect((await validateBlockerDecisionEvidence(input, { ...scoped(lapsed), priorDeferral: undefined })).ok).toBe(false);
    // An unmeasurable custody fact keeps the obligation (fails closed).
    const unreadable = { ...scoped(lapsed), priorDeferral: { ...priorDeferral,
      reasonEvidenceRefs: [{ kind: 'work-item' as const, ref: 'EI-404' }] } };
    const readEvidence = unreadable.readEvidence;
    expect((await validateBlockerDecisionEvidence(input, { ...unreadable,
      readEvidence: async (r) => r.ref === 'EI-404' ? { status: 'unknown', detail: 'reader down' } : readEvidence(r) })).ok).toBe(false);
  });
  it('does not use verification-only related conditions to justify a deferral', async () => {
    const result = await validateBlockerDecisionEvidence(defer(), {
      ...context(async () => pending), obligationRefs: [], relatedConditionRefs: [ref],
    });
    expect(result.ok).toBe(false);
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

  it('retains source provenance on system decisions', () => {
    const system = 'system:plan-item-lane-sync';
    const input = { kind: 'event' as const, ref: 'plan-lane:fixture#P-001',
      summary: 'Canonical prerequisite is blocked', evidence: 'plan:fixture#P-001' };
    const observed = updateExternalBlockerHistory({}, input, system, '2026-11-07T02:00:00Z');
    const payload = { externalBlockers: observed.blockers };
    expect(payload.externalBlockers).toMatchObject([{ createdBy: system, evidence: input.evidence, status: 'active' }]);
    expect(readBlockerResolution(payload)).toMatchObject({ status: 'unproven' });
    expect(hasUnresolvedBlockerObligation(payload, 'open')).toBe(true);
    const cleared = updateExternalBlockerHistory(payload, { ...input, clear: true },
      'system:dependency-clear', '2026-11-07T02:01:00Z');
    expect(cleared.blockers).toMatchObject([{ createdBy: system, clearedBy: 'system:dependency-clear',
      evidence: input.evidence, status: 'cleared' }]);
    expect(readBlockerResolution({ externalBlockers: cleared.blockers })).toMatchObject({ status: 'unproven' });
    expect(hasUnresolvedBlockerObligation({ externalBlockers: cleared.blockers }, 'open')).toBe(false);
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
