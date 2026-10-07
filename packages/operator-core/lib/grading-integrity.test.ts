import { describe, expect, it, vi } from 'vitest';
import { poolVerdictByProvider, type AccountStatusRow } from './deployment/account-pool-store';
import type { Rubric } from './rubrics';
import type { ScorecardRow } from './scorecards';
import type { TaskRow } from './task-manager/types';
import type { CoordEnvelope } from '@papercusp/coordination';
import type { OrgSql } from './work-items';
import {
  dispatchPendingGradingAudits,
  confirmPendingGradingAuditReservation,
  notifyRetainedGradingAuditor,
  GRADING_AUDIT_BACKLOG_SCAN_LIMIT,
  GRADING_AUDIT_DISPATCH_CONCURRENCY,
  GRADING_AUDIT_DISPATCH_LIMIT,
  GRADING_AUDIT_FAILURE_BACKOFF_MS,
  GRADING_AUDIT_RESERVATION_TTL_MS,
  GRADING_AUDIT_QUOTA_BACKOFF_DEFAULT_MS,
  GRADING_AUDIT_QUOTA_BACKOFF_MAX_MS,
  GRADING_AUDIT_QUOTA_BACKOFF_MIN_MS,
  GRADING_AUDIT_DISPATCH_ACTOR,
  GRADING_INTEGRITY_RUBRIC_REF,
  gradingAuditFallbackVerdictCanServe,
  gradingAuditorLaunchCtx,
  readGradingAuditDispatchSuppression,
  reconcilePendingGradingAudits,
  resolveGradingAuditQuotaBackoff,
  type GradingAuditReservationResult,
  type DispatchPendingGradingAuditsDeps,
  type DispatchPendingGradingAuditsInput,
} from './grading-integrity';

type ListScorecards = NonNullable<DispatchPendingGradingAuditsDeps['listScorecards']>;
type GetRubric = NonNullable<DispatchPendingGradingAuditsDeps['getRubric']>;
type Launch = NonNullable<DispatchPendingGradingAuditsDeps['launch']>;
type GetTask = NonNullable<DispatchPendingGradingAuditsDeps['getTask']>;
type ConfirmReservation = NonNullable<DispatchPendingGradingAuditsDeps['confirmReservation']>;
type ListTasks = NonNullable<DispatchPendingGradingAuditsDeps['listTasks']>;
type LaunchResult = Awaited<ReturnType<Launch>>;
type ReadCurrentGeneration = NonNullable<DispatchPendingGradingAuditsDeps['readCurrentGeneration']>;
type GenerationAncestry = NonNullable<DispatchPendingGradingAuditsDeps['generationAncestry']>;

// Keep the mock result shape explicit without using `as never` at a mock call;
// the cast is isolated here so the escape guard still typechecks every install site.
function launchResult(data: unknown): LaunchResult {
  return { data } as LaunchResult;
}

const ctx = { workspaceId: 'ws-test', harnessSlug: 'papercusp' } as DispatchPendingGradingAuditsInput['ctx'];

describe('grading audit stand-down owner scope', () => {
  it('suppresses only the scorecard author named by the active stand-down set', async () => {
    const listWorkspaceWideLoopStanddownOwners = vi.fn(async () => new Set(['su-paused']));

    const paused = await readGradingAuditDispatchSuppression('ws-test', {
      listWorkspaceWideLoopStanddownOwners,
      targetOwnerId: 'su-paused',
    });
    const resumed = await readGradingAuditDispatchSuppression('ws-test', {
      listWorkspaceWideLoopStanddownOwners,
      targetOwnerId: 'su-resumed',
    });
    const unknown = await readGradingAuditDispatchSuppression('ws-test', {
      listWorkspaceWideLoopStanddownOwners,
    });

    expect(paused).toMatchObject({ reason: 'workspace-wide-loop-standdown', targetOwnerId: 'su-paused' });
    expect(resumed).toBeNull();
    expect(unknown).toMatchObject({ reason: 'workspace-wide-loop-standdown', pausedOwnerCount: 1 });
    expect(listWorkspaceWideLoopStanddownOwners).toHaveBeenCalledTimes(3);
  });
});

// Fresh auditors launch as the system dispatch actor, never as the dispatching
// caller — the caller is often the card author (EI-23911815311476758). Spelled
// out literally rather than via gradingAuditorLaunchCtx(ctx) so a regression in
// that helper cannot also rewrite the expectation.
const auditorCtx = {
  ...ctx,
  uiClientId: null,
  isSuperuser: false,
  isPowerUser: false,
  principal: { kind: 'system', slug: GRADING_AUDIT_DISPATCH_ACTOR, workspaceId: 'ws-test' },
  ownerId: GRADING_AUDIT_DISPATCH_ACTOR,
  ownerLabel: 'grading audit dispatch',
  userId: null,
};

function card(issueId: string, over: Partial<ScorecardRow> = {}): ScorecardRow {
  return {
    issueId,
    createdAt: '2026-08-28T00:00:00.000Z',
    createdBy: 'evaluator',
    rubricRef: 'standard-rubric',
    ratings: {},
    nKeys: 0,
    missingKeys: [],
    extraKeys: [],
    rubricResolved: true,
    synthesized: false,
    linkedItems: [],
    gradingAudit: {
      state: 'pending',
      metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
      stampedAt: '2026-08-28T00:00:00.000Z',
    },
    ...over,
  } as ScorecardRow;
}

function standardRubric(): Rubric {
  return { kind: 'standard' } as Rubric;
}

function deps() {
  const route = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['route']>>().mockResolvedValue({
    state: 'fallback',
    reason: 'existing router: no_qualified_responder',
  });
  const listScorecards = vi.fn<ListScorecards>().mockResolvedValue([]);
  const getRubric = vi.fn<GetRubric>().mockResolvedValue(standardRubric());
  const launch = vi
    .fn<Launch>()
    .mockResolvedValue(launchResult({ deduped: false, launch: { opened: 1, tasks: [{ taskId: 'task-audit' }] } }));
  const reserve = vi.fn(
    async (): Promise<GradingAuditReservationResult> => ({
      status: 'claimed',
      reservation: { key: 'grading-audit:test', reservedAt: '2026-09-08T00:00:00.000Z' },
    }),
  );
  const release = vi.fn(async () => true);
  const confirmReservation = vi.fn<ConfirmReservation>().mockResolvedValue(true);
  const listTasks = vi.fn<ListTasks>().mockResolvedValue([]);
  const getTask = vi.fn<GetTask>().mockResolvedValue({ state: 'running' } as Awaited<ReturnType<GetTask>>);
  const notifyRetainedAuditor = vi.fn<typeof notifyRetainedGradingAuditor>()
    .mockResolvedValue({ state: 'delivered', ownerId: 'su-independent', msgId: 'renewal-1', queued: 1, pickupConfirmed: false });
  const readCurrentGeneration = vi.fn<ReadCurrentGeneration>().mockResolvedValue({
    deployedSha: '2222222',
    hostStartedAt: null,
    bootHeadSha: null,
    scoutCodeHash: null,
    staleHost: false,
  });
  const generationAncestry = vi.fn<GenerationAncestry>().mockReturnValue(true);
  const listWorkspaceWideLoopStanddownOwners = vi.fn(async (_workspaceId: string, _nowMs: number) => new Set<string>());
  return {
    listScorecards,
    getRubric,
    launch,
    route,
    reserve,
    confirmReservation,
    release,
    listTasks,
    getTask,
    notifyRetainedAuditor,
    readCurrentGeneration,
    generationAncestry,
    listWorkspaceWideLoopStanddownOwners,
  };
}

describe('retained grading auditor lease delivery (EI-25289706163098558)', () => {
  type RenewalDeps = NonNullable<Parameters<typeof notifyRetainedGradingAuditor>[1]>;
  function fixture() {
    const target = card('EI-renew', { createdBy: 'su-author', evidenceFingerprint: 'exact-fingerprint' });
    const task = { taskId: 'task-retained', workspaceId: 'ws-test', class: 'agent-session', state: 'running',
      workItemId: target.issueId, detail: { label: 'grading-audit:EI-renew:relay-route', coordOwnerId: 'su-independent' },
      // The launcher is deliberately NOT the task owner.
      launchedBy: 'su-author',
    } as unknown as TaskRow;
    const input = { card: target, task, workspaceId: 'ws-test', harness: 'papercusp',
      reservation: { key: 'grading-audit:EI-renew', reservedAt: '2026-10-07T04:00:51.909Z' } };
    const tx = vi.fn(async () => [{ task_id: task.taskId }]);
    const db = tx as unknown as OrgSql;
    const stored = new Map<string, CoordEnvelope>();
    // Model the EXISTING append seam's replay serialization, with preparation
    // skipped on a replay and failed preparation leaving no persisted line.
    let tail = Promise.resolve();
    const append = vi.fn<NonNullable<RenewalDeps['append']>>(async (_surface, _writer, envelope, hooks) => {
      const previous = tail;
      let unlock!: () => void;
      tail = new Promise<void>((resolve) => { unlock = resolve; });
      await previous;
      try {
        const existing = stored.get(envelope.msg_id);
        if (existing) return { created: false, sequence: 1, envelope: existing };
        const prepared = hooks?.prepare ? await hooks.prepare(db) : envelope;
        stored.set(envelope.msg_id, prepared);
        return { created: true, sequence: 1, envelope: prepared };
      } finally { unlock(); }
    });
    const send = vi.fn<NonNullable<RenewalDeps['send']>>(async (identity, options) => {
      const envelope = { msg_id: options.msgId!, from: identity.ownerId, to: options.to, kind: 'message',
        ts: '2026-10-07T05:00:00.000Z', summary: options.summary, body: options.body } as CoordEnvelope;
      return options.persistEnvelope!(envelope);
    });
    const wake = vi.fn<NonNullable<RenewalDeps['wake']>>().mockResolvedValue({ targets: ['su-independent'],
      keys: [], woken: 1, queued: 1, pickupConfirmed: false } as unknown as Awaited<ReturnType<NonNullable<RenewalDeps['wake']>>>);
    const confirmReservation = vi.fn<ConfirmReservation>().mockResolvedValue(true);
    const resolveParties = vi.fn<NonNullable<RenewalDeps['resolveParties']>>(async (ids) =>
      new Map(ids.map((id) => [id!, id!])));
    const mutex: NonNullable<RenewalDeps['mutex']> = async (_workspace, _issue, fn) => fn();
    return { input, stored, tx, db, d: { append, send, wake, confirmReservation, resolveParties, mutex } };
  }

  it('delivers the exact renewed lease to the authoritative independent task owner and queues one wake', async () => {
    const f = fixture();
    const result = await notifyRetainedGradingAuditor(f.input, f.d);
    expect(result).toMatchObject({ state: 'delivered', ownerId: 'su-independent', queued: 1, pickupConfirmed: false });
    const [identity, sent] = f.d.send.mock.calls[0]!;
    expect(identity.ownerId).toBe(GRADING_AUDIT_DISPATCH_ACTOR);
    expect(sent.to).toEqual(['su-independent']);
    expect(sent.body).toContain("exact target 'EI-renew' and evidence fingerprint 'exact-fingerprint'");
    expect(sent.body).toContain("reservedAt '2026-10-07T04:00:51.909Z'");
    expect(sent.body).toContain("gradingAudit.state is 'pending'");
    expect(sent.body).toContain("subjectRubricCurrentness");
    expect(f.d.confirmReservation).toHaveBeenCalledWith('EI-renew', 'grading-audit:EI-renew', {
      workspaceId: 'ws-test', reservedAt: f.input.reservation.reservedAt, expectedCard: f.input.card, tx: f.db,
    });
    const [query, ...bindings] = f.tx.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(query.join('?')).toContain("detail->>'coordOwnerId' = ? AND detail->>'label' = ?");
    expect(query.join('?')).toContain("state IN ('pending', 'running')");
    expect(query.join('?')).toContain('FOR SHARE');
    expect(bindings).toEqual(['ws-test', 'task-retained', 'su-independent', 'grading-audit:EI-renew:relay-route', 'EI-renew']);
    expect(f.d.wake).toHaveBeenCalledTimes(1);
    expect(f.stored.size).toBe(1);
  });

  it('deduplicates concurrent renewal notifications and their wake for the same lease', async () => {
    const f = fixture();
    const results = await Promise.all(Array.from({ length: 4 }, () => notifyRetainedGradingAuditor(f.input, f.d)));
    expect(results.map((r) => r.state).sort()).toEqual(['already-delivered', 'already-delivered', 'already-delivered', 'delivered']);
    expect(new Set(results.map((r) => r.msgId)).size).toBe(1);
    expect(f.stored.size).toBe(1);
    expect(f.d.confirmReservation).toHaveBeenCalledTimes(1);
    expect(f.d.wake).toHaveBeenCalledTimes(1);
  });

  it.each(['owner', 'target', 'label-boundary', 'task-state', 'workspace', 'fingerprint', 'lease-key', 'task-class'])
  ('refuses mismatched or missing %s provenance without notifying another actor', async (field) => {
    const f = fixture();
    if (field === 'owner') delete f.input.task.detail.coordOwnerId;
    if (field === 'target') f.input.task.workItemId = 'EI-other';
    if (field === 'label-boundary') f.input.task.detail.label = 'grading-audit:EI-renew-other';
    if (field === 'task-state') f.input.task.state = 'exited';
    if (field === 'workspace') f.input.task.workspaceId = 'other';
    if (field === 'fingerprint') f.input.card.evidenceFingerprint = undefined;
    if (field === 'lease-key') f.input.reservation.key = 'grading-audit:EI-other';
    if (field === 'task-class') f.input.task.class = 'bash-job';
    expect(await notifyRetainedGradingAuditor(f.input, f.d)).toMatchObject({ state: 'skipped' });
    expect(f.d.send).not.toHaveBeenCalled();
    expect(f.d.wake).not.toHaveBeenCalled();
  });

  it('refuses a retired or rebound task discovered at commit time', async () => {
    const f = fixture();
    f.tx.mockResolvedValue([]);
    expect(await notifyRetainedGradingAuditor(f.input, f.d)).toMatchObject({ state: 'failed', reason: expect.stringContaining('changed or retired') });
    expect(f.stored.size).toBe(0);
    expect(f.d.wake).not.toHaveBeenCalled();
  });

  it.each(['same-party', 'unknown-party'])('fails closed on %s independence at the transaction boundary', async (kind) => {
    const f = fixture();
    f.d.resolveParties.mockResolvedValue(kind === 'same-party'
      ? new Map([['su-author', 'same'], ['su-independent', 'same']]) : new Map([['su-author', 'author']]));
    expect(await notifyRetainedGradingAuditor(f.input, f.d)).toMatchObject({ state: 'failed', reason: 'retained auditor independence is not proven' });
    expect(f.stored.size).toBe(0);
    expect(f.d.wake).not.toHaveBeenCalled();
  });

  it('abandons delivery if the target settles, fingerprint changes or another lease wins before append', async () => {
    const f = fixture();
    f.d.confirmReservation.mockResolvedValue(false);
    expect(await notifyRetainedGradingAuditor(f.input, f.d)).toMatchObject({ state: 'failed', reason: expect.stringContaining('target/fingerprint/lease changed') });
    expect(f.stored.size).toBe(0);
    expect(f.tx).not.toHaveBeenCalled();
    expect(f.d.wake).not.toHaveBeenCalled();
  });

  it('preserves a delivered directive on wake failure without duplicating its notification', async () => {
    const f = fixture();
    f.d.wake.mockRejectedValue(new Error('wake unavailable'));
    expect(await notifyRetainedGradingAuditor(f.input, f.d)).toMatchObject({
      state: 'delivered', reason: expect.stringContaining('notification persisted'), pickupConfirmed: false,
    });
    expect(await notifyRetainedGradingAuditor(f.input, f.d)).toMatchObject({ state: 'already-delivered' });
    expect(f.stored.size).toBe(1);
    expect(f.d.wake).toHaveBeenCalledTimes(1);
  });

  it('confirms fingerprint, author, rubric and lease on the same supplied transaction', async () => {
    const tx = vi.fn(async () => []);
    const current = await confirmPendingGradingAuditReservation('EI-renew', 'grading-audit:EI-renew', {
      workspaceId: 'ws-test', reservedAt: 'renewed-at', tx: tx as unknown as OrgSql,
      expectedCard: card('EI-renew', { createdBy: 'su-author', evidenceFingerprint: 'exact-fingerprint' }),
    });
    expect(current).toBe(false);
    const [query, ...bindings] = tx.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    for (const clause of ["'state' = 'pending'", "'reservedAt' = ?", "'evidenceFingerprint' = ?",
      "scorecard.payload->'_ei'->>'created_by' = ?", "'rubricRef' = ?", "'retracted' IS NULL", 'NOT EXISTS', 'FOR UPDATE']) {
      expect(query.join('?')).toContain(clause);
    }
    expect(bindings).toEqual(expect.arrayContaining(['EI-renew', 'grading-audit:EI-renew', 'renewed-at', 'exact-fingerprint', 'su-author', 'standard-rubric']));
  });
});

describe('dispatchPendingGradingAudits', () => {
  it('does not dispatch an audit for a stale or unbound rubric-subject attestation', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([
      card('EI-stale-subject', {
        subject: { kind: 'rubric', ref: 'acceptance-rubric' },
        subjectRubricCurrentness: {
          state: 'stale', reason: 'criteria-hash-mismatch',
          recordedRevision: 4, currentRevision: 5,
          recordedCriteriaHash: 'old', currentCriteriaHash: 'new',
        },
      }),
      card('EI-unbound-subject', { subject: { kind: 'rubric', ref: 'acceptance-rubric' } }),
    ]);

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-stale-subject', 'EI-unbound-subject'], ctx }, d);

    expect(result.receipts).toEqual([
      expect.objectContaining({ issueId: 'EI-stale-subject', state: 'skipped' }),
      expect.objectContaining({ issueId: 'EI-unbound-subject', state: 'skipped' }),
    ]);
    expect(d.reserve).not.toHaveBeenCalled();
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('routes the exact source card before launch, retaining reservation and subject evidence', async () => {
    const d = deps();
    const source = card('EI-routed', {
      subject: { kind: 'plan', ref: 'source-plan' },
      evidenceFingerprint: 'frozen-fingerprint',
    });
    d.listScorecards.mockResolvedValue([source]);
    d.route.mockResolvedValue({ state: 'routed', conversationId: 'audit-consult' });
    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-routed'], ctx }, d);
    expect(d.reserve.mock.invocationCallOrder[0]).toBeLessThan(d.route.mock.invocationCallOrder[0]);
    expect(d.route).toHaveBeenCalledWith(
      expect.objectContaining({
        card: source,
        reservationKey: 'grading-audit:EI-routed',
        reservationReservedAt: '2026-09-08T00:00:00.000Z',
        brief: expect.stringContaining('frozen-fingerprint'),
      }),
      expect.objectContaining({ confirmReservation: expect.any(Function) }),
    );
    expect(result.receipts[0]).toMatchObject({ state: 'routed', conversationId: 'audit-consult' });
    expect(d.launch).not.toHaveBeenCalled();
    expect(d.release).not.toHaveBeenCalled();
  });

  it('reuses an active routed audit and never falls through to launch', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-active')]);
    d.route.mockResolvedValue({ state: 'deduped', conversationId: 'existing-consult' });
    const result = await reconcilePendingGradingAudits({ ctx }, d);
    expect(result.receipts[0]).toMatchObject({ state: 'deduped', conversationId: 'existing-consult' });
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('retires only live one-shot tasks that predate an old settled audit', async () => {
    const d = deps();
    const nowMs = Date.parse('2026-10-06T08:00:00.000Z');
    const passedAt = '2026-10-06T07:30:00.000Z';
    const failedAt = '2026-10-06T07:35:00.000Z';
    const recentAt = '2026-10-06T07:59:30.000Z';
    const settled = (issueId: string, state: 'passed' | 'failed', auditedAt: string) =>
      card(issueId, {
        gradingAudit: {
          state,
          metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
          stampedAt: '2026-10-06T07:00:00.000Z',
          auditedAt,
        },
      });
    d.listScorecards.mockResolvedValue([
      settled('EI-25100000000000001', 'passed', passedAt),
      settled('EI-25100000000000002', 'failed', failedAt),
      settled('EI-25100000000000003', 'passed', recentAt),
      settled('EI-25100000000000004', 'passed', passedAt),
    ]);
    d.listTasks.mockResolvedValue([
      {
        taskId: 'task-settled-passed',
        state: 'running',
        startedAt: '2026-10-06T07:20:00.000Z',
        detail: { label: 'grading-audit:EI-25100000000000001' },
      } as unknown as TaskRow,
      {
        taskId: 'task-settled-failed',
        state: 'running',
        startedAt: '2026-10-06T07:20:00.000Z',
        detail: { label: 'grading-audit:EI-25100000000000002' },
      } as unknown as TaskRow,
      {
        taskId: 'task-recent-settlement',
        state: 'running',
        startedAt: '2026-10-06T07:20:00.000Z',
        detail: { label: 'grading-audit:EI-25100000000000003' },
      } as unknown as TaskRow,
      {
        taskId: 'task-started-after-settlement',
        state: 'running',
        startedAt: '2026-10-06T07:31:00.000Z',
        detail: { label: 'grading-audit:EI-25100000000000004' },
      } as unknown as TaskRow,
    ]);
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));

    const result = await reconcilePendingGradingAudits(
      { ctx, harness: 'papercusp' },
      { ...d, killTask, now: () => nowMs },
    );

    expect(d.listTasks).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      states: ['pending', 'running'],
      launchedBy: GRADING_AUDIT_DISPATCH_ACTOR,
      labelPrefix: 'grading-audit:',
      limit: 2_000,
    });
    expect(killTask).toHaveBeenCalledTimes(2);
    expect(killTask).toHaveBeenCalledWith('task-settled-passed', {
      includeSubtree: true,
      escalateAfterMs: 5_000,
    });
    expect(killTask).toHaveBeenCalledWith('task-settled-failed', {
      includeSubtree: true,
      escalateAfterMs: 5_000,
    });
    expect(result.receipts).toEqual([]);
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('fresh-launches generation-bound cards only from a compatible dispatcher build', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([
      card('EI-generation-bound', {
        gradedGeneration: {
          deployedSha: '1111111',
          hostStartedAt: '2026-09-24T11:38:02.124Z',
          bootHeadSha: null,
          scoutCodeHash: null,
          staleHost: false,
        },
      }),
    ]);
    d.generationAncestry.mockReturnValue(true);

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-generation-bound'], ctx }, d);

    expect(d.generationAncestry).toHaveBeenCalledWith(expect.any(String), '1111111', '2222222');
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).toHaveBeenCalledTimes(1);
    // EI-24339979200649356: the ancestry check measured THIS dispatcher's build, so the
    // judge must be bound to it. The default ('stable') rides the :9071 proxy to green
    // :3070 — a different build — and the judge's emit is then refused as incompatible.
    expect(d.launch).toHaveBeenCalledWith(expect.objectContaining({ mcpTarget: 'spawn-host' }), expect.anything());
    expect(result.receipts[0]).toMatchObject({
      state: 'launched',
      routingFallback: 'generation-bound card requires a fresh judge launched from this compatible dispatcher build',
    });
  });

  it('keeps a judge for a card with no graded generation on the stable MCP proxy', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-unbound-generation')]);

    await dispatchPendingGradingAudits({ targetIds: ['EI-unbound-generation'], ctx }, d);

    expect(d.generationAncestry).not.toHaveBeenCalled();
    expect(d.launch).toHaveBeenCalledTimes(1);
    expect(d.launch.mock.calls[0]?.[0]).not.toHaveProperty('mcpTarget');
  });

  it.each([
    [false, 'auditor-build-older-than-graded-build'],
    [null, 'generation-ancestry-unknown'],
  ] as const)(
    'refuses to route or launch a generation-bound card when host ancestry is %s',
    async (isAncestor, reasonCode) => {
      const d = deps();
      d.listScorecards.mockResolvedValue([
        card('EI-incompatible-generation', {
          gradedGeneration: {
            deployedSha: '1111111',
            hostStartedAt: '2026-09-24T11:38:02.124Z',
            bootHeadSha: null,
            scoutCodeHash: null,
            staleHost: false,
          },
        }),
      ]);
      d.generationAncestry.mockReturnValue(isAncestor);

      const result = await dispatchPendingGradingAudits({ targetIds: ['EI-incompatible-generation'], ctx }, d);

      expect(result.receipts[0]).toMatchObject({ state: 'failed', reason: expect.stringContaining(reasonCode) });
      expect(d.route).not.toHaveBeenCalled();
      expect(d.launch).not.toHaveBeenCalled();
      expect(d.release).toHaveBeenCalledWith(
        'EI-incompatible-generation',
        'grading-audit:EI-incompatible-generation',
        expect.objectContaining({
          backoff: expect.objectContaining({ code: 'generation_incompatible', source: 'retry-window' }),
        }),
      );
    },
  );

  it('does not redispatch a target whose evaluator change requires the source card to be re-emitted', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([
      card('EI-awaiting-reemit', {
        gradingAudit: {
          state: 'awaiting-reemit',
          metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
          stampedAt: '2026-09-24T11:38:02.124Z',
          reemitRequired: {
            code: 'grading_audit_evaluator_changed',
            at: '2026-09-24T11:39:02.124Z',
            reason: 'evaluator revision changed the recorded falsifiability rating',
          },
        },
      }),
    ]);

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-awaiting-reemit'], ctx }, d);

    expect(result.receipts[0]).toMatchObject({
      state: 'skipped',
      reason: 'target is no longer a current pending standard-rubric scorecard',
    });
    expect(d.reserve).not.toHaveBeenCalled();
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('skips a consult route that no longer owns the exact reservation epoch', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-reservation-lost')]);
    d.route.mockResolvedValue({
      state: 'reservation-lost',
      reason: 'grading-audit reservation changed before consult recruitment',
    });

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-reservation-lost'], ctx }, d);

    expect(result.receipts[0]).toMatchObject({
      state: 'skipped',
      reason: 'grading-audit reservation changed before consult recruitment',
    });
    expect(d.launch).not.toHaveBeenCalled();
    expect(d.release).toHaveBeenCalledWith('EI-reservation-lost', 'grading-audit:EI-reservation-lost', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
    });
  });

  it('surfaces and backs off a routing failure, then a healthy retry creates exactly one consult', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-fault')]);
    const now = Date.parse('2026-09-13T05:39:00.000Z');
    const backoff = {
      until: new Date(now + GRADING_AUDIT_FAILURE_BACKOFF_MS).toISOString(),
      source: 'retry-window' as const,
      code: 'dispatch_exception',
      recordedAt: new Date(now).toISOString(),
      reason: 'lineage unavailable',
    };
    d.route
      .mockRejectedValueOnce(new Error('lineage unavailable'))
      .mockResolvedValueOnce({ state: 'routed', conversationId: 'healthy-consult' });
    d.reserve
      .mockResolvedValueOnce({
        status: 'claimed',
        reservation: { key: 'grading-audit:EI-fault', reservedAt: '2026-09-08T00:00:00.000Z' },
      })
      .mockResolvedValueOnce({ status: 'dispatch-backoff', backoff })
      .mockResolvedValueOnce({
        status: 'claimed',
        reservation: { key: 'grading-audit:EI-fault', reservedAt: '2026-09-08T00:00:00.000Z' },
      });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const failed = await dispatchPendingGradingAudits({ targetIds: ['EI-fault'], ctx }, { ...d, now: () => now });
      const suppressed = await dispatchPendingGradingAudits(
        { targetIds: ['EI-fault'], ctx },
        { ...d, now: () => now + 60_000 },
      );
      const recovered = await dispatchPendingGradingAudits(
        { targetIds: ['EI-fault'], ctx },
        { ...d, now: () => now + GRADING_AUDIT_FAILURE_BACKOFF_MS + 1 },
      );

      expect(failed.receipts[0]).toMatchObject({ state: 'failed', reason: 'lineage unavailable' });
      expect(d.release).toHaveBeenCalledWith('EI-fault', 'grading-audit:EI-fault', {
        workspaceId: 'ws-test',
        reservedAt: '2026-09-08T00:00:00.000Z',
        backoff,
      });
      expect(warning).toHaveBeenCalledWith(
        '[grading-integrity] pending audit dispatch failed for EI-fault: lineage unavailable',
      );
      expect(suppressed.receipts[0]).toMatchObject({
        state: 'skipped',
        reason: expect.stringContaining(`re-dispatch suppressed until ${backoff.until}`),
      });
      expect(recovered.receipts[0]).toMatchObject({ state: 'routed', conversationId: 'healthy-consult' });
      expect(d.route).toHaveBeenCalledTimes(2);
      expect(d.launch).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it('serializes concurrent routed dispatches through the existing card reservation', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-race')]);
    d.reserve.mockResolvedValueOnce({
      status: 'claimed',
      reservation: { key: 'grading-audit:EI-race', reservedAt: '2026-09-08T00:00:00.000Z' },
    }).mockResolvedValue({ status: 'already-reserved' });
    d.route.mockResolvedValue({ state: 'routed', conversationId: 'one-consult' });
    const results = await Promise.all(
      [1, 2].map(() => dispatchPendingGradingAudits({ targetIds: ['EI-race'], ctx }, d)),
    );
    expect(results.flatMap((r) => r.receipts.map((receipt) => receipt.state)).sort()).toEqual(['routed', 'skipped']);
    expect(d.route).toHaveBeenCalledOnce();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('abandons a reservation when the target settles before routing', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-settled-after-reservation')]);
    d.confirmReservation.mockResolvedValue(false);

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-settled-after-reservation'], ctx },
      d,
    );

    expect(result.receipts).toEqual([
      {
        issueId: 'EI-settled-after-reservation',
        rubricRef: 'standard-rubric',
        state: 'skipped',
        idempotencyKey: 'grading-audit:EI-settled-after-reservation',
        reason: 'target is no longer pending after reservation; dispatch abandoned',
      },
    ]);
    expect(d.confirmReservation).toHaveBeenCalledWith(
      'EI-settled-after-reservation',
      'grading-audit:EI-settled-after-reservation',
      { workspaceId: 'ws-test', reservedAt: '2026-09-08T00:00:00.000Z' },
    );
    expect(d.release).toHaveBeenCalledWith('EI-settled-after-reservation', 'grading-audit:EI-settled-after-reservation', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
    });
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('re-checks after routing before launching when settlement wins during the route', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-settled-during-route')]);
    d.route.mockResolvedValue({ state: 'fallback', reason: 'no responder' });
    d.confirmReservation.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-settled-during-route'], ctx },
      d,
    );

    expect(result.receipts).toEqual([
      {
        issueId: 'EI-settled-during-route',
        rubricRef: 'standard-rubric',
        state: 'skipped',
        idempotencyKey: 'grading-audit:EI-settled-during-route',
        reason: 'target is no longer pending after reservation; dispatch abandoned',
      },
    ]);
    expect(d.confirmReservation).toHaveBeenCalledTimes(2);
    expect(d.route).toHaveBeenCalledOnce();
    expect(d.release).toHaveBeenCalledWith('EI-settled-during-route', 'grading-audit:EI-settled-during-route', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
    });
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('suppresses a paused scorecard owner during an active workspace-wide loop stand-down', async () => {
    const d = deps();
    d.listWorkspaceWideLoopStanddownOwners.mockResolvedValue(new Set(['su-owner']));
    d.listScorecards.mockResolvedValue([card('EI-paused', { createdBy: 'su-owner' })]);

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-paused'], ctx }, d);

    expect(result.receipts).toMatchObject([{ issueId: 'EI-paused', state: 'skipped' }]);
    expect(result.receipts[0]!.reason).toContain("scorecard owner 'su-owner'");
    expect(d.listScorecards).toHaveBeenCalledOnce();
    expect(d.reserve).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
    expect(d.listWorkspaceWideLoopStanddownOwners).toHaveBeenCalledWith('ws-test', expect.any(Number));
  });

  it('dispatches an unpaused owner’s card while unrelated owners remain stood down', async () => {
    const d = deps();
    d.listWorkspaceWideLoopStanddownOwners.mockResolvedValue(new Set(['su-paused']));
    d.listScorecards.mockResolvedValue([card('EI-unpaused', { createdBy: 'su-resumed' })]);
    d.route.mockResolvedValue({ state: 'routed', conversationId: 'audit-unpaused-owner' });

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-unpaused'], ctx }, d);

    expect(result.receipts).toMatchObject([{ issueId: 'EI-unpaused', state: 'routed' }]);
    expect(d.reserve).toHaveBeenCalledOnce();
    expect(d.route).toHaveBeenCalledOnce();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('dispatches terminal auditor work again after the workspace-wide stand-down is cleared', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-resumed')]);
    d.route.mockResolvedValue({ state: 'routed', conversationId: 'audit-after-resume' });

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-resumed'], ctx }, d);

    expect(result.receipts).toMatchObject([{ issueId: 'EI-resumed', state: 'routed' }]);
    expect(d.listWorkspaceWideLoopStanddownOwners).toHaveBeenCalledWith('ws-test', expect.any(Number));
    expect(d.listScorecards).toHaveBeenCalledOnce();
    expect(d.reserve).toHaveBeenCalledOnce();
    expect(d.route).toHaveBeenCalledOnce();
  });

  it('launches a current standard target and maps a replay to a deduped receipt', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-audit-1')]);
    d.launch
      .mockResolvedValueOnce(launchResult({ deduped: false, launch: { opened: 1, tasks: [{ taskId: 'task-first' }] } }))
      .mockResolvedValueOnce(launchResult({ deduped: true, launch: { opened: 1, tasks: [{ taskId: 'task-first' }] } }));

    const input = { targetIds: [' EI-audit-1 ', 'EI-audit-1'], ctx, harness: 'papercusp' };
    const first = await dispatchPendingGradingAudits(input, d);
    const replay = await dispatchPendingGradingAudits(input, d);

    expect(first).toEqual({
      requestedTargetIds: ['EI-audit-1'],
      receipts: [
        expect.objectContaining({
          issueId: 'EI-audit-1',
          rubricRef: 'standard-rubric',
          state: 'launched',
          idempotencyKey: 'grading-audit:EI-audit-1',
          launch: { opened: 1, tasks: [{ taskId: 'task-first' }] },
        }),
      ],
    });
    expect(replay.receipts).toEqual([
      expect.objectContaining({
        issueId: 'EI-audit-1',
        state: 'deduped',
        idempotencyKey: 'grading-audit:EI-audit-1',
      }),
    ]);
    expect(d.listScorecards).toHaveBeenNthCalledWith(1, {
      includeSuperseded: true,
      includeRetracted: true,
      issueIds: ['EI-audit-1'],
      limit: GRADING_AUDIT_DISPATCH_LIMIT,
    });
    expect(d.launch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        brief: expect.stringContaining('scorecard EI-audit-1'),
        harness: 'papercusp',
        workItem: 'EI-audit-1',
        headless: true,
        independent: true,
        account: 'auto',
        count: 1,
        members: [{ role: 'judge', account: 'auto' }],
        label: 'grading-audit:EI-audit-1',
        idempotencyKey: 'grading-audit:EI-audit-1',
      }),
      auditorCtx,
    );
    expect(d.launch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: 'grading-audit:EI-audit-1' }),
      auditorCtx,
    );
  });

  it("launches a fresh auditor as the system dispatch actor, never inside the calling card author's lineage", async () => {
    // EI-23911815311476758 / EI-23987538343141495: dispatch runs inside the card
    // AUTHOR's own scorecards:emit. Forwarding that caller context stamped the
    // author as the judge's --launched-by, and the emit-side lineage guard then
    // refused the finished audit as self_audit_refused — every time.
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-author-emit', { createdBy: 'su-card-author' })]);
    const authorCtx = { ...ctx, ownerId: 'su-card-author' } as DispatchPendingGradingAuditsInput['ctx'];

    await dispatchPendingGradingAudits({ targetIds: ['EI-author-emit'], ctx: authorCtx }, d);

    expect(d.launch).toHaveBeenCalledTimes(1);
    const launchCtx = d.launch.mock.calls[0]?.[1] as { ownerId?: string; principal?: unknown; workspaceId?: string };
    expect(launchCtx.ownerId).not.toBe('su-card-author');
    expect(launchCtx.ownerId).toBe(GRADING_AUDIT_DISPATCH_ACTOR);
    expect(launchCtx.principal).toEqual({ kind: 'system', slug: GRADING_AUDIT_DISPATCH_ACTOR, workspaceId: 'ws-test' });
    expect(launchCtx.workspaceId).toBe('ws-test');
  });

  it('keeps the caller context when no concrete workspace can scope a system principal', () => {
    const unscoped = { ...ctx, workspaceId: '*', ownerId: 'su-caller' } as DispatchPendingGradingAuditsInput['ctx'];
    // Whitespace-only trims to empty — the same "no concrete workspace" branch as an absent one.
    const missing = { ...ctx, workspaceId: '  ', ownerId: 'su-caller' } as DispatchPendingGradingAuditsInput['ctx'];
    expect(gradingAuditorLaunchCtx(unscoped)).toBe(unscoped);
    expect(gradingAuditorLaunchCtx(missing)).toBe(missing);
  });

  it('dedupes against a live same-label auditor after its reservation epoch expires', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-live-auditor')]);
    d.listTasks.mockResolvedValue([
      {
        taskId: 'task-old-auditor',
        state: 'running',
        detail: { label: 'grading-audit:EI-live-auditor' },
        logPath: '/tmp/old-auditor.log',
      } as unknown as TaskRow,
    ]);

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-live-auditor'], ctx }, d);

    expect(result.receipts).toEqual([
      {
        issueId: 'EI-live-auditor',
        rubricRef: 'standard-rubric',
        state: 'deduped',
        idempotencyKey: 'grading-audit:EI-live-auditor',
        dispatchReservation: {
          key: 'grading-audit:EI-live-auditor',
          reservedAt: '2026-09-08T00:00:00.000Z',
        },
        renewalNotification: { state: 'delivered', ownerId: 'su-independent', msgId: 'renewal-1', queued: 1, pickupConfirmed: false },
        launch: {
          deduped: true,
          opened: 0,
          failed: 0,
          mode: 'live-task-guard',
          tasks: [
            {
              taskId: 'task-old-auditor',
              logPath: '/tmp/old-auditor.log',
              label: 'grading-audit:EI-live-auditor',
            },
          ],
        },
        reason:
          "existing live grading auditor task 'task-old-auditor' owns grading-audit:EI-live-auditor; duplicate launch suppressed",
      },
    ]);
    expect(d.listTasks).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      states: ['pending', 'running'],
      labelPrefix: 'grading-audit:EI-live-auditor',
      limit: 10,
    });
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
    expect(d.notifyRetainedAuditor).toHaveBeenCalledWith(expect.objectContaining({
      card: expect.objectContaining({ issueId: 'EI-live-auditor' }),
      task: expect.objectContaining({ taskId: 'task-old-auditor' }),
      reservation: { key: 'grading-audit:EI-live-auditor', reservedAt: '2026-09-08T00:00:00.000Z' },
    }));
    expect(d.release).toHaveBeenCalledWith('EI-live-auditor', 'grading-audit:EI-live-auditor', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
      restore: {
        key: 'grading-audit:EI-live-auditor',
        reservedAt: '2026-09-08T00:00:00.000Z',
      },
    });
  });

  it('hands the live auditor its own expired lease back instead of deleting it (WI-10005273)', async () => {
    // The reproduced deadlock: a sweep after the 15-minute TTL re-claims the auditor's lease,
    // finds the auditor still live, and used to DELETE the reservation. The auditor's
    // scorecards:emit then had no lease to cite and was refused, so the card stayed pending.
    const d = deps();
    const auditorLease = { key: 'grading-audit:EI-long-audit', reservedAt: '2026-09-07T23:40:00.000Z' };
    d.reserve.mockResolvedValue({
      status: 'claimed',
      reservation: { key: 'grading-audit:EI-long-audit', reservedAt: '2026-09-08T00:00:00.000Z' },
      prior: auditorLease,
    });
    d.listScorecards.mockResolvedValue([card('EI-long-audit')]);
    d.listTasks.mockResolvedValue([
      {
        taskId: 'task-long-auditor',
        state: 'running',
        detail: { label: 'grading-audit:EI-long-audit' },
        logPath: '/tmp/long-auditor.log',
      } as unknown as TaskRow,
    ]);

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-long-audit'], ctx }, d);

    expect(result.receipts[0]).toMatchObject({ state: 'deduped', idempotencyKey: 'grading-audit:EI-long-audit' });
    expect(result.receipts[0]).toHaveProperty('dispatchReservation', auditorLease);
    expect(d.notifyRetainedAuditor).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
    expect(d.release).toHaveBeenCalledTimes(1);
    expect(d.release).toHaveBeenCalledWith('EI-long-audit', 'grading-audit:EI-long-audit', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
      restore: auditorLease,
    });
  });

  it('does not hand off a renewed lease after losing the restore CAS', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-renew')]);
    d.listTasks.mockResolvedValue([{ taskId: 'retained', state: 'running', detail: { label: 'grading-audit:EI-renew' } } as unknown as TaskRow]);
    d.release.mockResolvedValue(false);
    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-renew'], ctx }, d);
    expect(result.receipts[0]).toMatchObject({ state: 'skipped', reason: expect.stringContaining('CAS lost') });
    expect(result.receipts[0]).not.toHaveProperty('dispatchReservation');
    expect(d.notifyRetainedAuditor).not.toHaveBeenCalled();
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('does not guess an auditor when multiple live tasks claim the target', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-renew')]);
    d.listTasks.mockResolvedValue(['first', 'second'].map((taskId) => ({ taskId, state: 'running',
      detail: { label: 'grading-audit:EI-renew' } } as unknown as TaskRow)));
    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-renew'], ctx }, d);
    expect(result.receipts[0]).toMatchObject({ state: 'deduped', renewalNotification: { state: 'skipped', reason: expect.stringContaining('ambiguous') } });
    expect(d.notifyRetainedAuditor).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('clears only the undelivered renewal epoch so a scheduled repair can retry', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-renew')]);
    d.listTasks.mockResolvedValue([{ taskId: 'retained', state: 'running', detail: { label: 'grading-audit:EI-renew' } } as unknown as TaskRow]);
    d.notifyRetainedAuditor.mockResolvedValue({ state: 'failed', reason: 'delivery unavailable' });
    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-renew'], ctx }, d);
    expect(result.receipts[0]).toMatchObject({ renewalNotification: { state: 'failed' } });
    expect(d.release).toHaveBeenCalledTimes(2);
    expect(d.release).toHaveBeenLastCalledWith('EI-renew', 'grading-audit:EI-renew', {
      workspaceId: 'ws-test', reservedAt: '2026-09-08T00:00:00.000Z',
    });
  });

  it('restores nothing on a non-dedupe release, even when the claim replaced an expired lease', async () => {
    // A lease is restored only to a LIVE holder; with no live task the dispatcher owns the row.
    const d = deps();
    d.reserve.mockResolvedValue({
      status: 'claimed',
      reservation: { key: 'grading-audit:EI-gone', reservedAt: '2026-09-08T00:00:00.000Z' },
      prior: { key: 'grading-audit:EI-gone', reservedAt: '2026-09-07T23:40:00.000Z' },
    });
    d.listScorecards.mockResolvedValue([card('EI-gone')]);
    d.confirmReservation.mockResolvedValue(false);

    await dispatchPendingGradingAudits({ targetIds: ['EI-gone'], ctx }, d);

    expect(d.release).toHaveBeenCalledWith('EI-gone', 'grading-audit:EI-gone', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
    });
  });

  it('retires a live auditor only when its task and no-first-turn log both exceed the reservation TTL', async () => {
    const d = deps();
    const nowMs = Date.parse('2026-09-30T12:00:00.000Z');
    const oldTask = {
      taskId: 'task-picker-stalled',
      state: 'running',
      startedAt: new Date(nowMs - GRADING_AUDIT_RESERVATION_TTL_MS - 1).toISOString(),
      detail: { label: 'grading-audit:EI-picker-stalled' },
      logPath: '/tmp/picker-stalled.log',
    } as unknown as TaskRow;
    d.listScorecards.mockResolvedValue([card('EI-picker-stalled')]);
    d.listTasks.mockResolvedValue([oldTask]);
    const readLogTail = vi.fn(async () => 'Claude TUI tool picker still visible');
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));

    const result = await reconcilePendingGradingAudits(
      { ctx, harness: 'papercusp' },
      {
        ...d,
        killTask,
        readLogTail,
        now: () => nowMs,
        readLogMtimeMs: () => nowMs - GRADING_AUDIT_RESERVATION_TTL_MS - 1,
        terminalLogMaxRechecks: 0,
      },
    );

    expect(killTask).toHaveBeenCalledWith('task-picker-stalled', {
      includeSubtree: true,
      escalateAfterMs: 5_000,
    });
    expect(result.receipts[0]).toMatchObject({
      state: 'launched',
      terminalRecovery: {
        retiredTaskIds: ['task-picker-stalled'],
        codes: ['startup_first_turn_stalled'],
      },
    });
  });

  it('keeps stale live auditors with first-turn progress or unreadable log evidence', async () => {
    for (const evidence of [
      { readLogTail: async () => 'Working (18m)\npapercusp.tools:invoke({})', logMtimeMs: null },
      { readLogTail: async () => { throw new Error('log unavailable'); }, logMtimeMs: null },
    ]) {
      const d = deps();
      const nowMs = Date.parse('2026-09-30T12:00:00.000Z');
      d.listScorecards.mockResolvedValue([card('EI-healthy-live-auditor')]);
      d.listTasks.mockResolvedValue([{
        taskId: 'task-healthy-live-auditor',
        state: 'running',
        startedAt: new Date(nowMs - GRADING_AUDIT_RESERVATION_TTL_MS - 1).toISOString(),
        detail: { label: 'grading-audit:EI-healthy-live-auditor' },
        logPath: '/tmp/healthy-live-auditor.log',
      } as unknown as TaskRow]);
      const readLogTail = vi.fn(evidence.readLogTail);
      const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));

      const result = await reconcilePendingGradingAudits(
        { ctx, harness: 'papercusp' },
        {
          ...d,
          killTask,
          readLogTail,
          now: () => nowMs,
          readLogMtimeMs: () => nowMs - GRADING_AUDIT_RESERVATION_TTL_MS - 1,
          terminalLogMaxRechecks: 0,
        },
      );

      expect(killTask).not.toHaveBeenCalled();
      expect(result.receipts[0]).toMatchObject({ state: 'deduped' });
    }
  });

  describe('a live auditor that completed its turn and parked without emitting (WI-10005295)', () => {
    // Tail shape of task 0muqeanqadsbkcjglk2 (Codex auditor, 2026-10-02): it finished a
    // turn, emitted nothing, and every repair deduped to it until a human killed it.
    const parkedLog =
      '• Audit not emitted. Current target state:\n' +
      '  • gradingAudit.state: pending  › Ask Codex to do anything   Working · GPT-5.6-Sol high\n' +
      '  Worked for 20m 18s • 11:40 PMReady ·GPT-5.6-Sol high ·Context 86% left';
    const run = async (logQuietMs: number) => {
      const d = deps();
      const nowMs = Date.parse('2026-10-02T04:01:00.000Z');
      d.listScorecards.mockResolvedValue([card('EI-parked-auditor')]);
      d.listTasks.mockResolvedValue([{
        taskId: 'task-parked-auditor',
        state: 'running',
        startedAt: new Date(nowMs - 41 * 60_000).toISOString(),
        detail: { label: 'grading-audit:EI-parked-auditor' },
        logPath: '/tmp/parked-auditor.log',
      } as unknown as TaskRow]);
      const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
      const result = await reconcilePendingGradingAudits(
        { ctx, harness: 'papercusp' },
        {
          ...d,
          killTask,
          readLogTail: vi.fn(async () => parkedLog),
          now: () => nowMs,
          readLogMtimeMs: () => nowMs - logQuietMs,
          terminalLogMaxRechecks: 0,
        },
      );
      return { killTask, receipt: result.receipts[0] };
    };

    it('retires it once its log has been quiet past the reservation TTL and relaunches', async () => {
      const { killTask, receipt } = await run(GRADING_AUDIT_RESERVATION_TTL_MS + 1);
      expect(killTask).toHaveBeenCalledWith('task-parked-auditor', {
        includeSubtree: true,
        escalateAfterMs: 5_000,
      });
      expect(receipt).toMatchObject({
        state: 'launched',
        terminalRecovery: {
          retiredTaskIds: ['task-parked-auditor'],
          codes: ['parked_without_emit'],
        },
      });
    });

    it('still dedupes to it while its log moved inside the TTL', async () => {
      const { killTask, receipt } = await run(GRADING_AUDIT_RESERVATION_TTL_MS - 60_000);
      expect(killTask).not.toHaveBeenCalled();
      expect(receipt).toMatchObject({ state: 'deduped', launch: { mode: 'live-task-guard' } });
    });
  });

  it('retires a live auditor that explicitly finished without platform tools and launches a bounded fallback', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-tool-refusal')]);
    d.listTasks.mockResolvedValue([{
      taskId: 'task-idle-refusal',
      state: 'running',
      detail: { label: 'grading-audit:EI-tool-refusal' },
      logPath: '/tmp/idle-refusal.log',
    } as unknown as TaskRow]);
    const readLogTail = vi.fn(() =>
      "●I didn't grade scorecard EI-tool-refusal and didn't emit a\n" +
      'grading-integrity audit, because this session has no way to reach the platform.\n' +
      "The platform tools aren't loaded.\n✻Worked for 25s · done 12:33 PM\n❯",
    );
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));

    const result = await reconcilePendingGradingAudits(
      { ctx, harness: 'papercusp', targetIds: ['EI-tool-refusal'] },
      { ...d, readLogTail, killTask, sleep: async () => undefined, terminalLogMaxRechecks: 0 },
    );

    expect(killTask).toHaveBeenCalledWith('task-idle-refusal', {
      includeSubtree: true,
      escalateAfterMs: 5_000,
    });
    expect(d.launch).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', account: 'auto' }),
      auditorCtx,
    );
    expect(result.receipts[0]).toMatchObject({
      state: 'launched',
      terminalRecovery: {
        retiredTaskIds: ['task-idle-refusal'],
        codes: ['tool_surface_unavailable'],
      },
    });
  });

  it('recovers the measured completed-turn refusal wording instead of deduping to the idle Claude judge', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-24234352612789401')]);
    d.listTasks.mockResolvedValue([{
      taskId: 'task-tool-less-judge',
      state: 'running',
      detail: { label: 'grading-audit:EI-24234352612789401' },
      logPath: '/tmp/tool-less-judge.log',
    } as unknown as TaskRow]);
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    const result = await reconcilePendingGradingAudits(
      { ctx, harness: 'papercusp', targetIds: ['EI-24234352612789401'] },
      {
        ...d,
        killTask,
        readLogTail: () =>
          "● I haven't graded or emitted anything for scorecard EI-24234352612789401.\n" +
          '- No platform tools loaded. No mcp__papercusp__* tool appeared.\n' +
          '✻ Cooked for 24s · done 7:57 AM\n❯',
        sleep: async () => undefined,
        terminalLogMaxRechecks: 0,
      },
    );
    expect(killTask).toHaveBeenCalledWith('task-tool-less-judge', {
      includeSubtree: true,
      escalateAfterMs: 5_000,
    });
    expect(d.launch).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', account: 'auto' }),
      auditorCtx,
    );
    expect(result.receipts[0]).toMatchObject({
      state: 'launched',
      terminalRecovery: { codes: ['tool_surface_unavailable'] },
    });
  });

  it('retires a ledger-live auditor with a delayed terminal log and launches the bounded Codex fallback', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-live-terminal-auditor')]);
    d.listTasks.mockResolvedValue([
      {
        taskId: 'task-live-terminal-auditor',
        state: 'running',
        detail: { label: 'grading-audit:EI-live-terminal-auditor' },
        logPath: '/tmp/live-terminal-auditor.log',
      } as unknown as TaskRow,
    ]);
    d.launch.mockResolvedValue(
      launchResult({
        deduped: false,
        launch: { tasks: [{ taskId: 'task-live-terminal-recovery', logPath: '/tmp/recovery.log' }] },
      }),
    );
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    const readLogTail = vi.fn((path: string) =>
      path.includes('live-terminal-auditor')
        ? 'API Error: Request rejected (429) · inference-gateway: all accounts throttled; retry after 60s\n' +
          '✻ Brewed for 10m 2s · done 7:45 AM\n❯'
        : 'healthy fallback boot',
    );

    const result = await reconcilePendingGradingAudits(
      { ctx, harness: 'papercusp' },
      {
        ...d,
        killTask,
        readLogTail,
        sleep: async () => undefined,
        terminalLogMaxRechecks: 0,
      },
    );

    expect(killTask).toHaveBeenCalledWith('task-live-terminal-auditor', {
      includeSubtree: true,
      escalateAfterMs: 5_000,
    });
    expect(d.route).toHaveBeenCalledTimes(1);
    expect(d.launch).toHaveBeenCalledTimes(1);
    expect(d.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        account: 'auto',
        members: [{ role: 'judge', agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', account: 'auto' }],
        idempotencyKey: expect.stringMatching(
          /^grading-audit:EI-live-terminal-auditor:recovery:[a-f0-9]{16}$/,
        ),
      }),
      auditorCtx,
    );
    expect(result.receipts).toEqual([
      expect.objectContaining({
        issueId: 'EI-live-terminal-auditor',
        state: 'launched',
        terminalRecovery: expect.objectContaining({
          retiredTaskIds: ['task-live-terminal-auditor'],
          attempts: 1,
          codes: ['inference_gateway_error'],
        }),
      }),
    ]);
  });

  it('gives concurrent auditors scorecard-scoped scratch isolation for the MCP recovery fallback', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-audit-a'), card('EI-audit-b')]);

    await dispatchPendingGradingAudits({ targetIds: ['EI-audit-a', 'EI-audit-b'], ctx }, d);

    expect(d.launch).toHaveBeenCalledTimes(2);
    const firstBrief = (d.launch.mock.calls[0]?.[0] as { brief: string }).brief;
    const secondBrief = (d.launch.mock.calls[1]?.[0] as { brief: string }).brief;
    expect(firstBrief).toContain('scripts/mcp-call.mjs');
    expect(firstBrief).toContain('--json -');
    expect(firstBrief).toContain('mktemp -d /tmp/grading-integrity-EI-audit-a.XXXXXX');
    expect(firstBrief).toContain('Never read or write shared fixed names such as /tmp/eval-args.json');
    expect(secondBrief).toContain('mktemp -d /tmp/grading-integrity-EI-audit-b.XXXXXX');
    expect(secondBrief).not.toContain('/tmp/grading-integrity-EI-audit-a.XXXXXX');
  });

  it('dispatches independent targets with bounded concurrency while preserving receipt order', async () => {
    const d = deps();
    const targetIds = Array.from({ length: GRADING_AUDIT_DISPATCH_CONCURRENCY + 1 }, (_, i) => `EI-parallel-${i + 1}`);
    d.listScorecards.mockResolvedValue(targetIds.map((issueId) => card(issueId)));

    let active = 0;
    let peak = 0;
    let started = 0;
    let releaseFirstBatch!: () => void;
    const firstBatchReleased = new Promise<void>((resolve) => {
      releaseFirstBatch = resolve;
    });
    d.launch.mockImplementation(async (args) => {
      active += 1;
      peak = Math.max(peak, active);
      started += 1;
      if (started === GRADING_AUDIT_DISPATCH_CONCURRENCY) releaseFirstBatch();
      if (started <= GRADING_AUDIT_DISPATCH_CONCURRENCY) await firstBatchReleased;
      active -= 1;
      return launchResult({
        deduped: false,
        launch: { opened: 1, tasks: [{ taskId: `task-${String((args as { idempotencyKey: string }).idempotencyKey)}` }] },
      });
    });

    const result = await dispatchPendingGradingAudits({ targetIds, ctx }, d);

    expect(peak).toBe(GRADING_AUDIT_DISPATCH_CONCURRENCY);
    expect(result.receipts.map((receipt) => receipt.issueId)).toEqual(targetIds);
    expect(d.launch).toHaveBeenCalledTimes(targetIds.length);
  });

  it('instructs auditors to re-check live grading state before emitting', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-state-recheck')]);

    await dispatchPendingGradingAudits({ targetIds: ['EI-state-recheck'], ctx }, d);

    const brief = (d.launch.mock.calls[0]?.[0] as { brief: string }).brief;
    expect(brief).toContain('Before emitting, re-read the target with scorecards:get');
    expect(brief).toContain('papercusp.output-envelope/v1');
    expect(brief).toContain('Inspect the outer response before reading scorecard.criteria');
    expect(brief).toContain('follow its content reference with capability:read');
    expect(brief).toContain('never pass the wrapper to a scorecard field reader');
    // EI-24583166035391772: the brief must name fields scorecards:get actually returns.
    expect(brief).toContain('scorecard.auditTarget');
    expect(brief).toContain("gradingAudit.state is exactly 'pending'");
    expect(brief).toContain("state is not 'pending' (including 'passed', 'failed', or 'cancelled')");
    expect(brief).toContain('superseded or retracted');
    expect(brief).toContain("Dispatch lease: key 'grading-audit:EI-state-recheck', reservedAt '2026-09-08T00:00:00.000Z'");
    expect(brief).toContain("gradingAuditReservation:{ key:'grading-audit:EI-state-recheck', reservedAt:'2026-09-08T00:00:00.000Z' }");
    expect(brief).toContain('Before reading criterion evidence');
    // WI-10006794: an auditor whose lease lapsed mid-audit must still emit; only a DIFFERENT
    // (newer) reservation is a stop. Without this the emit-side lapsed-lease admission
    // (EI-25246208524832409) is unreachable because the auditor declines before calling it.
    expect(brief).toContain('This strict check applies only at the START of the audit');
    expect(brief).toContain('a dispatchReservation that is ABSENT means only that your lease lapsed');
    expect(brief).toContain('it is NOT a reason to stop');
    expect(brief).toContain('emit with your original gradingAuditReservation unchanged');
    expect(brief).toContain('Stop without emitting only when a dispatchReservation IS present and its key or reservedAt differs');
  });

  it('selects a settled card whose audit identity is stale and forwards currentness for atomic reopening', async () => {
    const d = deps();
    const currentness = {
      state: 'stale' as const,
      reason: 'revision-mismatch' as const,
      recordedRevision: 4,
      currentRevision: 6,
      recordedCriteriaHash: 'hash-old',
      currentCriteriaHash: 'hash-new',
    };
    d.listScorecards.mockResolvedValue([
      card('EI-stale-settled', {
        gradingAudit: {
          state: 'passed',
          metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
          stampedAt: '2026-09-07T00:00:00.000Z',
          rubricRevision: 4,
          criteriaHash: 'hash-old',
          auditIssueId: 'EI-old-audit',
        },
        gradingAuditCurrentness: currentness,
      }),
    ]);

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-stale-settled'], ctx }, d);

    expect(result.receipts).toEqual([expect.objectContaining({ issueId: 'EI-stale-settled', state: 'launched' })]);
    expect(d.reserve).toHaveBeenCalledWith('EI-stale-settled', 'grading-audit:EI-stale-settled', {
      workspaceId: 'ws-test',
      currentness,
    });
  });

  it('never reopens a cancelled audit stamp even when its recorded audit identity is stale', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([
      card('EI-cancelled-audit', {
        retracted: { at: '2026-09-20T04:02:52.814Z', by: 'su-author', reason: 'withdrawn' },
        gradingAudit: {
          state: 'cancelled',
          metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
          stampedAt: '2026-09-20T04:02:01.584Z',
          rubricRevision: 6,
          criteriaHash: 'hash-before-retraction',
        },
        gradingAuditCurrentness: {
          state: 'stale',
          reason: 'revision-mismatch',
          recordedRevision: 6,
          currentRevision: 7,
          recordedCriteriaHash: 'hash-before-retraction',
          currentCriteriaHash: 'hash-current',
        },
      }),
    ]);

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-cancelled-audit'], ctx }, d);

    expect(result.receipts).toEqual([
      expect.objectContaining({ issueId: 'EI-cancelled-audit', state: 'skipped' }),
    ]);
    expect(d.reserve).not.toHaveBeenCalled();
    expect(d.route).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('reopens a settled legacy card whose recorded audit identity is missing', async () => {
    const d = deps();
    const currentness = {
      state: 'unknown' as const,
      reason: 'recorded-identity-missing' as const,
      recordedRevision: null,
      currentRevision: 6,
      recordedCriteriaHash: null,
      currentCriteriaHash: 'hash-current',
    };
    d.listScorecards.mockResolvedValue([
      card('EI-legacy-settled', {
        gradingAudit: {
          state: 'failed',
          metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
          stampedAt: '2026-09-07T00:00:00.000Z',
          auditIssueId: 'EI-retracted-audit',
        },
        gradingAuditCurrentness: currentness,
      }),
    ]);

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-legacy-settled'], ctx }, d);

    expect(result.receipts).toEqual([expect.objectContaining({ issueId: 'EI-legacy-settled', state: 'launched' })]);
    expect(d.reserve).toHaveBeenCalledWith('EI-legacy-settled', 'grading-audit:EI-legacy-settled', {
      workspaceId: 'ws-test',
      currentness,
    });
  });

  it.each(['passed', 'failed'] as const)(
    'skips an explicitly requested %s target after its grading audit settled',
    async (state) => {
      const d = deps();
      d.listScorecards.mockResolvedValue([
        card('EI-settled', {
          gradingAudit: {
            state,
            metaRubricRef: GRADING_INTEGRITY_RUBRIC_REF,
            stampedAt: '2026-08-28T00:00:00.000Z',
            auditIssueId: 'EI-grading-audit',
            auditor: 'independent-auditor',
            auditedAt: '2026-08-28T00:05:00.000Z',
          },
        }),
      ]);

      const result = await dispatchPendingGradingAudits({ targetIds: ['EI-settled'], ctx }, d);

      expect(result).toEqual({
        requestedTargetIds: ['EI-settled'],
        receipts: [
          expect.objectContaining({
            issueId: 'EI-settled',
            state: 'skipped',
            reason: 'target is no longer a current pending standard-rubric scorecard',
          }),
        ],
      });
      expect(d.reserve).not.toHaveBeenCalled();
      expect(d.launch).not.toHaveBeenCalled();
    },
  );

  it('reserves a target before launch so a concurrent dispatcher skips the loser', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-concurrent')]);
    let claimed = false;
    d.reserve.mockImplementation(async () => {
      if (claimed) return { status: 'already-reserved' };
      claimed = true;
      return {
        status: 'claimed',
        reservation: { key: 'grading-audit:EI-concurrent', reservedAt: '2026-09-08T00:00:00.000Z' },
      };
    });

    const [first, second] = await Promise.all([
      dispatchPendingGradingAudits({ targetIds: ['EI-concurrent'], ctx }, d),
      dispatchPendingGradingAudits({ targetIds: ['EI-concurrent'], ctx }, d),
    ]);

    expect(d.reserve).toHaveBeenCalledTimes(2);
    expect(d.launch).toHaveBeenCalledTimes(1);
    expect([first, second].map((result) => result.receipts[0]?.state).sort()).toEqual(['launched', 'skipped']);
    expect([first, second].find((result) => result.receipts[0]?.state === 'skipped')?.receipts[0]?.reason).toBe(
      'another dispatcher already reserved this scorecard',
    );
  });

  it('releases a reservation when the launch fails so repair can retry the target', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-launch-failure')]);
    d.launch.mockResolvedValue({ isError: true, content: [{ text: 'launch refused' }] } as LaunchResult);

    const now = Date.parse('2026-09-13T05:39:00.000Z');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-launch-failure'], ctx },
      { ...d, now: () => now },
    );
    warning.mockRestore();

    expect(result.receipts).toEqual([
      expect.objectContaining({ issueId: 'EI-launch-failure', state: 'failed', reason: 'launch refused' }),
    ]);
    expect(d.release).toHaveBeenCalledWith('EI-launch-failure', 'grading-audit:EI-launch-failure', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
      backoff: {
        until: new Date(now + GRADING_AUDIT_FAILURE_BACKOFF_MS).toISOString(),
        source: 'retry-window',
        code: 'launch_failed',
        recordedAt: new Date(now).toISOString(),
        reason: 'launch refused',
      },
    });
  });

  describe('zero-process account admission refusal (EI-24935954591005579)', () => {
    const refusal = (opened = 0, tasks: unknown[] = []) => ({
      isError: true,
      content: [{ text: 'psu: --account auto could not be honored: no allowed claude account is available in the pool. Refusing to fall back to the default system login.' }],
      data: { launch: { opened, failed: 1, partial: false, tasks } },
    } as LaunchResult);

    it('reuses the independent, one-retry Codex gateway route when no process started', async () => {
      const d = deps();
      d.listScorecards.mockResolvedValue([card('EI-no-primary-account')]);
      d.launch.mockResolvedValueOnce(refusal())
        .mockResolvedValueOnce(launchResult({ launch: { opened: 1, tasks: [{ taskId: 'codex-audit' }] } }));
      const providerCanServe = vi.fn(async () => true);
      const result = await dispatchPendingGradingAudits(
        { targetIds: ['EI-no-primary-account'], ctx, harness: 'papercusp' }, { ...d, providerCanServe },
      );
      expect(d.launch).toHaveBeenCalledTimes(2);
      expect(d.launch.mock.calls[1]).toEqual([
        expect.objectContaining({
          independent: true, agent: 'codex', account: 'auto',
          members: [{ role: 'judge', agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', account: 'auto' }],
          idempotencyKey: expect.stringContaining(':recovery:'),
        }),
        auditorCtx,
      ]);
      expect(providerCanServe).toHaveBeenCalledWith('codex');
      expect(result.receipts[0]?.state).toBe('launched');
      expect(d.release).not.toHaveBeenCalled();
    });

    it.each([
      { opened: 1, tasks: [], serviceable: true },
      { opened: 0, tasks: [{ taskId: 'unknown-task' }], serviceable: true },
      { opened: 0, tasks: [], serviceable: false },
    ])('does not retry an unknown/partially-started or unavailable fallback: %j', async (fixture) => {
      const d = deps();
      d.listScorecards.mockResolvedValue([card('EI-not-safe-to-fallback')]);
      d.launch.mockResolvedValue(refusal(fixture.opened, fixture.tasks));
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await dispatchPendingGradingAudits(
          { targetIds: ['EI-not-safe-to-fallback'], ctx },
          { ...d, providerCanServe: async () => fixture.serviceable },
        );
        expect(d.launch).toHaveBeenCalledTimes(1);
        expect(result.receipts[0]?.state).toBe('failed');
        expect(d.release).toHaveBeenCalledOnce();
      } finally { warning.mockRestore(); }
    });
  });

  it('selects a bounded oldest-first backlog when no explicit targets are supplied', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([
      card('EI-new', { createdAt: '2026-09-05T00:00:00.000Z' }),
      card('EI-old', { createdAt: '2026-09-01T00:00:00.000Z' }),
      card('EI-tie-b', { createdAt: '2026-09-02T00:00:00.000Z' }),
      card('EI-tie-a', { createdAt: '2026-09-02T00:00:00.000Z' }),
      card('EI-superseded', { createdAt: '2026-08-01T00:00:00.000Z', supersededBy: 'EI-replacement' }),
      card('EI-retracted', { createdAt: '2026-08-02T00:00:00.000Z', retracted: {} as ScorecardRow['retracted'] }),
      card('EI-meta', { createdAt: '2026-08-03T00:00:00.000Z', rubricRef: GRADING_INTEGRITY_RUBRIC_REF }),
    ]);

    const result = await dispatchPendingGradingAudits({ ctx, harness: 'papercusp' }, d);

    expect(result.requestedTargetIds).toEqual(['EI-old', 'EI-tie-a', 'EI-tie-b', 'EI-new']);
    expect(d.listScorecards).toHaveBeenCalledWith({
      includeSuperseded: true,
      includeRetracted: true,
      limit: GRADING_AUDIT_BACKLOG_SCAN_LIMIT,
    });
    expect(d.launch.mock.calls.map(([args]) => (args as { idempotencyKey?: string }).idempotencyKey)).toEqual([
      'grading-audit:EI-old',
      'grading-audit:EI-tie-a',
      'grading-audit:EI-tie-b',
      'grading-audit:EI-new',
    ]);
  });

  it('finds an explicit pending target outside the newest scorecard page', async () => {
    const d = deps();
    const oldTarget = card('EI-old-target', { createdAt: '2026-08-01T00:00:00.000Z' });
    d.listScorecards.mockImplementation(async (filter) =>
      filter?.issueIds?.includes(oldTarget.issueId)
        ? [oldTarget]
        : Array.from({ length: GRADING_AUDIT_DISPATCH_LIMIT }, (_, i) => card(`EI-new-${i}`)),
    );

    const result = await dispatchPendingGradingAudits({ targetIds: [oldTarget.issueId], ctx }, d);

    expect(d.listScorecards).toHaveBeenCalledWith({
      includeSuperseded: true,
      includeRetracted: true,
      issueIds: [oldTarget.issueId],
      limit: GRADING_AUDIT_DISPATCH_LIMIT,
    });
    expect(result.receipts).toEqual([
      expect.objectContaining({ issueId: oldTarget.issueId, state: 'launched' }),
    ]);
    expect(d.launch).toHaveBeenCalledOnce();
  });

  it('skips superseded, retracted, meta-rubric, missing-rubric, and nonstandard targets', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([
      card('EI-current'),
      card('EI-superseded', { supersededBy: 'EI-replacement' }),
      card('EI-retracted', { retracted: {} as ScorecardRow['retracted'] }),
      card('EI-meta', { rubricRef: GRADING_INTEGRITY_RUBRIC_REF }),
      card('EI-missing', { rubricRef: 'missing-rubric' }),
      card('EI-acceptance', { rubricRef: 'acceptance-rubric' }),
    ]);
    d.getRubric.mockImplementation(async (ref) => {
      if (ref === 'missing-rubric') return null;
      if (ref === 'acceptance-rubric') return { kind: 'acceptance' } as Rubric;
      return standardRubric();
    });

    const result = await dispatchPendingGradingAudits(
      {
        targetIds: ['EI-current', 'EI-superseded', 'EI-retracted', 'EI-meta', 'EI-missing', 'EI-acceptance'],
        ctx,
        harness: '*',
      },
      d,
    );

    expect(d.launch).toHaveBeenCalledTimes(1);
    expect(d.launch).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'grading-audit:EI-current' }), auditorCtx);
    expect(d.launch.mock.calls[0]?.[0]).not.toHaveProperty('harness');
    // EI-23414612968722239 regression: `role:'judge'` is a HARNESS-SCOPED persona, so it must
    // be gated on the SAME condition as `harness` itself. Sending the role without a harness
    // makes launch-agent refuse the spawn outright ("no harness resolved"), which leaves the
    // card's gradingAudit stamp stuck at 'pending' — and settledGradingAuditIsCurrent() FAILS a
    // pending stamp while PASSING an unstamped card, so a failed dispatch is strictly worse
    // than none: it deadlocks acceptance-rubric vetting for every plan it was meant to audit.
    expect((d.launch.mock.calls[0]?.[0] as { members?: unknown[] }).members?.[0]).not.toHaveProperty('role');
    expect(result.receipts).toEqual([
      expect.objectContaining({ issueId: 'EI-current', state: 'launched', rubricRef: 'standard-rubric' }),
      expect.objectContaining({ issueId: 'EI-superseded', state: 'skipped' }),
      expect.objectContaining({ issueId: 'EI-retracted', state: 'skipped' }),
      expect.objectContaining({ issueId: 'EI-meta', state: 'skipped' }),
      expect.objectContaining({ issueId: 'EI-missing', state: 'skipped', reason: 'target rubric not found' }),
      expect.objectContaining({
        issueId: 'EI-acceptance',
        state: 'skipped',
        reason: "target rubric kind 'acceptance' is not standard",
      }),
    ]);
  });

  it('bounds a duplicate-heavy request before reading or launching more than the dispatch limit', async () => {
    const d = deps();
    const targetIds = Array.from({ length: GRADING_AUDIT_DISPATCH_LIMIT + 5 }, (_, i) => `EI-audit-${i + 1}`);
    d.listScorecards.mockResolvedValue(targetIds.map((issueId) => card(issueId)));

    const result = await dispatchPendingGradingAudits({ targetIds: [...targetIds, ...targetIds.slice(0, 3)], ctx }, d);

    expect(result.requestedTargetIds).toHaveLength(GRADING_AUDIT_DISPATCH_LIMIT);
    expect(result.requestedTargetIds).toEqual(targetIds.slice(0, GRADING_AUDIT_DISPATCH_LIMIT));
    expect(result.receipts).toHaveLength(GRADING_AUDIT_DISPATCH_LIMIT);
    expect(d.listScorecards).toHaveBeenCalledWith({
      includeSuperseded: true,
      includeRetracted: true,
      issueIds: targetIds.slice(0, GRADING_AUDIT_DISPATCH_LIMIT),
      limit: GRADING_AUDIT_DISPATCH_LIMIT,
    });
    expect(d.launch).toHaveBeenCalledTimes(GRADING_AUDIT_DISPATCH_LIMIT);
  });

  it('retires a standalone weekly-limit auditor and launches one deterministic Codex fallback', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-weekly-limit')]);
    d.launch
      .mockResolvedValueOnce(
        launchResult({
          deduped: true,
          launch: { tasks: [{ taskId: 'task-quota', logPath: '/tmp/grading-quota.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { tasks: [{ taskId: 'task-fallback', logPath: '/tmp/grading-fallback.log' }] },
        }),
      );
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    const readLogTail = vi.fn((path: string) =>
      path.includes('quota')
        ? "You've hit your weekly limit · resets Sep 10, 7am (America/New_York)"
        : 'healthy fallback boot',
    );

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-weekly-limit'], ctx, harness: 'papercusp' },
      {
        ...d,
        killTask,
        readLogTail,
        sleep: async () => undefined,
        terminalLogRecheckDelayMs: 0,
        terminalLogMaxRechecks: 0,
      },
    );

    expect(killTask).toHaveBeenCalledWith('task-quota', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(d.launch).toHaveBeenCalledTimes(2);
    expect(d.launch.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        agent: 'codex',
        account: 'auto',
        members: [{ role: 'judge', agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', account: 'auto' }],
        idempotencyKey: expect.stringMatching(/^grading-audit:EI-weekly-limit:recovery:[a-f0-9]{16}$/),
      }),
    );
    expect(result.receipts).toEqual([
      expect.objectContaining({
        issueId: 'EI-weekly-limit',
        state: 'launched',
        terminalRecovery: {
          retiredTaskIds: ['task-quota'],
          attempts: 2,
          codes: ['model_quota_exhausted'],
          fallback: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', account: 'auto' },
          routedTo: 'codex',
        },
      }),
    ]);
  });

  /**
   * WI-10002318. The dispatcher holds exactly ONE terminal retry, and it used to
   * spend it on the Codex fallback unconditionally. Measured 2026-09-22T02:36Z,
   * codex was 0-of-7 serviceable (usage-wall, ~4d out) while claude was 2-of-3,
   * so every retry died at boot on the launcher's walled-pool preflight (exit 78)
   * and the audit landed in backoff without ever being tried on a live provider.
   *
   * These three cases are a MATCHED SET, not variations: the walled case alone is
   * satisfied by simply deleting the flip, so the serviceable case is the control
   * that pins the flip still happening, and the throwing case pins the documented
   * fail-open contract (a ledger outage must not stop us trying at all).
   */
  function quotaTerminalFallbackDeps() {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-walled-fallback')]);
    d.launch
      .mockResolvedValueOnce(
        launchResult({
          deduped: true,
          launch: { tasks: [{ taskId: 'task-quota', logPath: '/tmp/grading-quota.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { tasks: [{ taskId: 'task-retry', logPath: '/tmp/grading-retry.log' }] },
        }),
      );
    return {
      ...d,
      killTask: vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' })),
      readLogTail: vi.fn((path: string) =>
        path.includes('quota')
          ? "You've hit your weekly limit · resets Sep 10, 7am (America/New_York)"
          : 'healthy retry boot',
      ),
      sleep: async () => undefined,
      terminalLogRecheckDelayMs: 0,
      terminalLogMaxRechecks: 0,
    };
  }

  it('does NOT route the bounded terminal retry to a fallback provider that is measurably at capacity', async () => {
    const d = quotaTerminalFallbackDeps();
    const providerCanServe = vi.fn(async () => false);

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-walled-fallback'], ctx, harness: 'papercusp' },
      { ...d, providerCanServe },
    );

    expect(providerCanServe).toHaveBeenCalledWith('codex');
    // The receipt names the route TAKEN, not just the configured fallback —
    // `fallback` still reads codex here, which is exactly what misled a reader
    // of the live 2026-09-27 receipt (WI-10003463).
    expect(result.receipts[0]).toMatchObject({
      terminalRecovery: { fallback: expect.objectContaining({ agent: 'codex' }), routedTo: 'claude' },
    });
    // The retry still happens — it is simply routed at the primary, whose
    // auto-routed gateway pool may still have headroom.
    expect(d.launch).toHaveBeenCalledTimes(2);
    const retry = d.launch.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(retry).not.toHaveProperty('agent');
    expect(retry.members).toEqual([{ role: 'judge', account: 'auto' }]);
    // And the one-retry ceiling still holds: the retry was CONSUMED, not refunded.
    expect(d.launch).not.toHaveBeenCalledTimes(3);
  });

  it('DOES route the bounded terminal retry to the fallback provider when it can serve', async () => {
    const d = quotaTerminalFallbackDeps();
    const providerCanServe = vi.fn(async () => true);

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-walled-fallback'], ctx, harness: 'papercusp' },
      { ...d, providerCanServe },
    );

    expect(result.receipts[0]).toMatchObject({ terminalRecovery: { routedTo: 'codex' } });
    expect(d.launch).toHaveBeenCalledTimes(2);
    expect(d.launch.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        agent: 'codex',
        members: [{ role: 'judge', agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', account: 'auto' }],
      }),
    );
  });

  it('fails OPEN to the fallback provider when the account ledger cannot be read', async () => {
    const d = quotaTerminalFallbackDeps();
    const providerCanServe = vi.fn(async () => {
      throw new Error('account ledger unavailable');
    });

    await dispatchPendingGradingAudits(
      { targetIds: ['EI-walled-fallback'], ctx, harness: 'papercusp' },
      { ...d, providerCanServe },
    );

    expect(d.launch).toHaveBeenCalledTimes(2);
    expect(d.launch.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ agent: 'codex' }));
  });

  it.each([
    {
      screen: 'gateway 5xx',
      gatewayLog:
        '\u001b[38;5;220m●\u001b[3GAPI Error: 500 inference-gateway internal error. This is a server-side\r\n' +
        'issue, usually temporary — try again in a moment. If it persists, check your inference gateway ' +
        '(127.0.0.1:8788).\r\n' +
        '\u001b[38;5;246m✻ Cooked for 12m 56s · done 11:27 AM\u001b[0m\r\n❯',
    },
    {
      screen: 'gateway 429',
      gatewayLog:
        '\u001b[38;5;220m●\u001b[3GAPI Error: Request rejected (429) · inference-gateway: all accounts \r\n' +
        'throttled; retry after 60s\u001b[0m\r\n\r\n✻ Worked for 13m 45s · done 9:09 AM\r\n❯',
    },
    {
      screen: 'gateway 429 without a completed-turn footer',
      gatewayLog:
        '\u001b[38;5;220m●\u001b[3GAPI Error: Request rejected (429) · inference-gateway: all accounts \r\n' +
        'throttled; retry after 60s\u001b[0m',
    },
    {
      screen: 'account-scoped gateway 429',
      gatewayLog:
        '\u001b[38;5;220m●\u001b[3GAPI Error: Request rejected (429)\r\n' +
        "This request would exceed your account's rate limit. Please try again later.\u001b[0m\r\n\r\n" +
        '✻ Cogitated for 6m 49s · done 9:01 AM\r\n❯',
    },
    {
      screen: 'account-paced gateway 429',
      gatewayLog:
        "\u001b[38;5;220m●\u001b[3GAPI Error: Request rejected (429) · inference-gateway: account 'aviynw4' " +
        'paced/paused; retry after 60s\u001b[0m\r\n\r\n✻ Cooked for 13m 41s · done 9:33 AM\r\n❯',
    },
  ])('retires a deduped auditor with a terminal $screen and launches the Codex fallback', async ({ gatewayLog }) => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-gateway-500')]);
    d.launch
      .mockResolvedValueOnce(
        launchResult({
          deduped: true,
          launch: { tasks: [{ taskId: 'task-gateway-500', logPath: '/tmp/grading-gateway-500.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { tasks: [{ taskId: 'task-fallback', logPath: '/tmp/grading-fallback.log' }] },
        }),
      );
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-gateway-500'], ctx, harness: 'papercusp' },
      {
        ...d,
        killTask,
        readLogTail: (path) => (path.includes('gateway-500') ? gatewayLog : 'healthy fallback boot'),
        sleep: async () => undefined,
        terminalLogRecheckDelayMs: 0,
        terminalLogMaxRechecks: 0,
      },
    );

    expect(killTask).toHaveBeenCalledWith('task-gateway-500', {
      includeSubtree: true,
      escalateAfterMs: 5_000,
    });
    expect(d.launch).toHaveBeenCalledTimes(2);
    expect(d.launch.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        agent: 'codex',
        account: 'auto',
        members: [{ role: 'judge', agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', account: 'auto' }],
        idempotencyKey: expect.stringMatching(/^grading-audit:EI-gateway-500:recovery:[a-f0-9]{16}$/),
      }),
    );
    expect(result.receipts).toEqual([
      expect.objectContaining({
        issueId: 'EI-gateway-500',
        state: 'launched',
        terminalRecovery: expect.objectContaining({
          retiredTaskIds: ['task-gateway-500'],
          codes: ['inference_gateway_error'],
        }),
      }),
    ]);
  });

  it('stops after one recovery when the fallback is quota-terminal too', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-double-quota')]);
    d.launch
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { tasks: [{ taskId: 'task-primary', logPath: '/tmp/primary.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { tasks: [{ taskId: 'task-fallback', logPath: '/tmp/fallback.log' }] },
        }),
      );
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-double-quota'], ctx },
      {
        ...d,
        killTask,
        readLogTail: () => "You've hit your weekly limit · resets Sep 10, 7am (America/New_York)",
        sleep: async () => undefined,
        terminalLogRecheckDelayMs: 0,
        terminalLogMaxRechecks: 0,
      },
    );

    expect(d.launch).toHaveBeenCalledTimes(2);
    expect(killTask).toHaveBeenCalledTimes(2);
    expect(result.receipts).toEqual([
      expect.objectContaining({
        issueId: 'EI-double-quota',
        state: 'failed',
        reason: expect.stringContaining('one-retry ceiling'),
        terminalRecovery: expect.objectContaining({
          retiredTaskIds: ['task-primary', 'task-fallback'],
          attempts: 2,
          codes: ['model_quota_exhausted', 'model_quota_exhausted'],
        }),
      }),
    ]);
  });

  it('reconciles a quota failure that appears after the startup probe on a later sweep', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-delayed-quota')]);
    d.launch
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { tasks: [{ taskId: 'task-delayed', logPath: '/tmp/delayed.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: true,
          launch: { tasks: [{ taskId: 'task-delayed', logPath: '/tmp/delayed.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { tasks: [{ taskId: 'task-recovery', logPath: '/tmp/recovery.log' }] },
        }),
      );
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    let delayedLog = 'healthy startup probe';
    const readLogTail = vi.fn((path: string) => (path.includes('delayed') ? delayedLog : 'healthy fallback boot'));

    const initial = await dispatchPendingGradingAudits(
      { targetIds: ['EI-delayed-quota'], ctx, harness: 'papercusp' },
      { ...d, killTask, readLogTail, sleep: async () => undefined, terminalLogMaxRechecks: 0 },
    );
    delayedLog = "You've hit your weekly limit · resets Sep 10, 7am (America/New_York)";

    const recovered = await reconcilePendingGradingAudits(
      { ctx, harness: 'papercusp' },
      { ...d, killTask, readLogTail, sleep: async () => undefined, terminalLogMaxRechecks: 0 },
    );

    expect(initial.receipts).toEqual([expect.objectContaining({ issueId: 'EI-delayed-quota', state: 'launched' })]);
    expect(killTask).toHaveBeenCalledWith('task-delayed', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(recovered.receipts).toEqual([
      expect.objectContaining({
        issueId: 'EI-delayed-quota',
        state: 'launched',
        terminalRecovery: expect.objectContaining({
          retiredTaskIds: ['task-delayed'],
          codes: ['model_quota_exhausted'],
        }),
      }),
    ]);
    expect(d.launch.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^grading-audit:EI-delayed-quota:recovery:[a-f0-9]{16}$/),
        agent: 'codex',
      }),
    );
  });

  it('reconciles a launcher kickoff quota drop on a later sweep', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-launcher-quota-drop')]);
    d.launch
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { tasks: [{ taskId: 'task-dropped-kickoff', logPath: '/tmp/dropped-kickoff.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: true,
          launch: { tasks: [{ taskId: 'task-dropped-kickoff', logPath: '/tmp/dropped-kickoff.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { tasks: [{ taskId: 'task-recovery', logPath: '/tmp/recovery.log' }] },
        }),
      );
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    let droppedLog = 'healthy startup probe';
    const readLogTail = vi.fn((path: string) =>
      path.includes('dropped-kickoff') ? droppedLog : 'healthy fallback boot',
    );

    const initial = await dispatchPendingGradingAudits(
      { targetIds: ['EI-launcher-quota-drop'], ctx, harness: 'papercusp' },
      { ...d, killTask, readLogTail, sleep: async () => undefined, terminalLogMaxRechecks: 0 },
    );
    droppedLog =
      '100% left · staging\u001b[22;3H\u001b[?2026l' +
      'psu-pty-host: launch kickoff DROPPED for role-7a40cbec-960b-4db9-9bca-26020817a009 ' +
      '(submit verification aborted (quota-blocked) within 600000ms over 1 attempt(s))';

    const recovered = await reconcilePendingGradingAudits(
      { ctx, harness: 'papercusp' },
      { ...d, killTask, readLogTail, sleep: async () => undefined, terminalLogMaxRechecks: 0 },
    );

    expect(initial.receipts).toEqual([
      expect.objectContaining({ issueId: 'EI-launcher-quota-drop', state: 'launched' }),
    ]);
    expect(killTask).toHaveBeenCalledWith('task-dropped-kickoff', {
      includeSubtree: true,
      escalateAfterMs: 5_000,
    });
    expect(recovered.receipts).toEqual([
      expect.objectContaining({
        issueId: 'EI-launcher-quota-drop',
        state: 'launched',
        terminalRecovery: expect.objectContaining({
          retiredTaskIds: ['task-dropped-kickoff'],
          codes: ['model_quota_exhausted'],
        }),
      }),
    ]);
    expect(d.launch.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^grading-audit:EI-launcher-quota-drop:recovery:[a-f0-9]{16}$/),
        agent: 'codex',
        account: 'auto',
      }),
    );
  });

  it('recovers a deduped terminal task and gives each reservation epoch a fresh retry key', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-dead-receipt')]);
    d.reserve
      .mockResolvedValueOnce({
        status: 'claimed',
        reservation: { key: 'grading-audit:EI-dead-receipt', reservedAt: '2026-09-09T10:00:00.000Z' },
      })
      .mockResolvedValueOnce({
        status: 'claimed',
        reservation: { key: 'grading-audit:EI-dead-receipt', reservedAt: '2026-09-09T10:15:00.000Z' },
      });
    d.launch
      .mockResolvedValueOnce(
        launchResult({
          deduped: true,
          launch: { tasks: [{ taskId: 'task-dead', logPath: '/tmp/dead.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { agentStarted: true, tasks: [{ taskId: 'task-recovery-a', logPath: '/tmp/recovery-a.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: true,
          launch: { tasks: [{ taskId: 'task-dead', logPath: '/tmp/dead.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { agentStarted: true, tasks: [{ taskId: 'task-recovery-b', logPath: '/tmp/recovery-b.log' }] },
        }),
      );
    d.getTask.mockResolvedValue({ state: 'killed' } as Awaited<ReturnType<GetTask>>);
    const killTask = vi.fn(async (taskId: string) => ({
      ok: false as const,
      taskId,
      action: 'kill',
      error: 'not_live' as const,
    }));
    const run = () =>
      dispatchPendingGradingAudits(
        { targetIds: ['EI-dead-receipt'], ctx, harness: 'papercusp' },
        {
          ...d,
          killTask,
          readLogTail: () => 'no terminal model error was logged',
          sleep: async () => undefined,
          terminalLogMaxRechecks: 0,
        },
      );

    const first = await run();
    const second = await run();

    expect(first.receipts[0]).toMatchObject({
      state: 'launched',
      terminalRecovery: { retiredTaskIds: ['task-dead'], codes: ['task_receipt_not_live'] },
    });
    expect(second.receipts[0]).toMatchObject({
      state: 'launched',
      terminalRecovery: { retiredTaskIds: ['task-dead'], codes: ['task_receipt_not_live'] },
    });
    const firstRetryKey = (d.launch.mock.calls[1]?.[0] as { idempotencyKey: string }).idempotencyKey;
    const secondRetryKey = (d.launch.mock.calls[3]?.[0] as { idempotencyKey: string }).idempotencyKey;
    expect(firstRetryKey).toMatch(/^grading-audit:EI-dead-receipt:recovery:[a-f0-9]{16}$/);
    expect(secondRetryKey).toMatch(/^grading-audit:EI-dead-receipt:recovery:[a-f0-9]{16}$/);
    expect(secondRetryKey).not.toBe(firstRetryKey);
  });

  // WI-10002903: a headless judge whose kickoff was never submitted idles at an
  // empty composer with no terminal log text. The launcher's own receipt is the
  // only signal, so the dispatcher must treat it as a failed launch rather than
  // report 'launched' and hold the reservation for the full TTL.
  it('retires a judge whose launch receipt says the kickoff was never submitted, and relaunches once', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-silent-kickoff')]);
    d.launch
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: {
            agentStarted: null,
            tasks: [
              {
                taskId: 'task-silent',
                logPath: '/tmp/silent.log',
                kickoffProof: {
                  persisted: false,
                  reason: 'kickoff-not-submitted:headless-claude-composer-not-ready',
                },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: {
            agentStarted: true,
            tasks: [{ taskId: 'task-retry', logPath: '/tmp/retry.log', kickoffProof: { persisted: true } }],
          },
        }),
      );
    const killTask = vi.fn(async (taskId: string) => ({
      ok: false as const,
      taskId,
      action: 'kill',
      error: 'not_live' as const,
    }));

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-silent-kickoff'], ctx, harness: 'papercusp' },
      {
        ...d,
        killTask,
        readLogTail: () => 'no terminal model error was logged',
        sleep: async () => undefined,
        terminalLogMaxRechecks: 0,
      },
    );

    expect(killTask).toHaveBeenCalledWith('task-silent', expect.anything());
    expect(d.launch).toHaveBeenCalledTimes(2);
    expect(result.receipts[0]).toMatchObject({
      state: 'launched',
      terminalRecovery: { retiredTaskIds: ['task-silent'], codes: ['launch_kickoff_not_persisted'] },
    });
  });

  it('retries a fresh bootstrap proxy failure when its task exits before kickoff proof returns', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-fresh-task-exited')]);
    d.launch
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: {
            agentStarted: null,
            tasks: [
              {
                taskId: 'task-codex-state-db',
                logPath: '/tmp/codex-state-db.log',
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: {
            agentStarted: true,
            tasks: [{ taskId: 'task-codex-fallback', logPath: '/tmp/codex-fallback.log' }],
          },
        }),
      );
    d.getTask.mockResolvedValueOnce({
      state: 'ended_unobserved',
      exitCode: 1,
      exitReason: 'initial terminal command exited with status 1; headless launch exiting.',
    } as Awaited<ReturnType<GetTask>>);
    const killTask = vi.fn(async (taskId: string) => ({
      ok: false as const,
      taskId,
      action: 'kill',
      error: 'not_live' as const,
    }));

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-fresh-task-exited'], ctx, harness: 'papercusp' },
      {
        ...d,
        killTask,
        readLogTail: () =>
          'psu: mcp_proxy_upstream_error — upstream silent for 8000ms (no response headers)\n' +
          '[papercusp] initial terminal command exited with status 1; headless launch exiting.',
        sleep: async () => undefined,
        terminalLogMaxRechecks: 0,
      },
    );

    expect(d.getTask).toHaveBeenCalledWith('task-codex-state-db');
    expect(killTask).toHaveBeenCalledWith('task-codex-state-db', {
      includeSubtree: true,
      escalateAfterMs: 5_000,
    });
    expect(d.launch).toHaveBeenCalledTimes(2);
    expect(result.receipts[0]).toMatchObject({
      state: 'launched',
      terminalRecovery: { retiredTaskIds: ['task-codex-state-db'], codes: ['task_receipt_not_live'] },
    });
  });

  it('keeps a fresh kickoff timeout unconfirmed while the task-manager row is still running', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-still-starting')]);
    d.launch.mockResolvedValueOnce(
      launchResult({
        deduped: false,
        launch: {
          agentStarted: null,
          tasks: [
            {
              taskId: 'task-still-starting',
              logPath: '/tmp/still-starting.log',
              kickoffProof: { persisted: false, reason: 'kickoff-proof-timeout' },
            },
          ],
        },
      }),
    );
    d.getTask.mockResolvedValueOnce({ state: 'running' } as Awaited<ReturnType<GetTask>>);
    const killTask = vi.fn();

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-still-starting'], ctx, harness: 'papercusp' },
      { ...d, killTask, readLogTail: () => '', terminalLogMaxRechecks: 0 },
    );

    expect(d.getTask).toHaveBeenCalledWith('task-still-starting');
    expect(killTask).not.toHaveBeenCalled();
    expect(d.launch).toHaveBeenCalledTimes(1);
    expect(result.receipts[0]).toMatchObject({ state: 'launched' });
    expect(result.receipts[0]).not.toHaveProperty('terminalRecovery');
  });

  // WI-10002903 (second leg): psu-pty-host dropped the kickoff AFTER the launch
  // receipt returned, so the receipt carried no failure and the PTY stayed
  // ledger-live. The live-task guard must retire it instead of deduping to it
  // for the whole reservation (observed on EI-24118203560334206 at 07:39Z).
  it('retires a ledger-live auditor whose kickoff psu-pty-host dropped after launch, instead of deduping to it', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-dropped-kickoff')]);
    d.listTasks.mockResolvedValue([
      {
        taskId: 'task-dropped-kickoff',
        state: 'running',
        detail: { label: 'grading-audit:EI-dropped-kickoff' },
        logPath: '/tmp/dropped-kickoff.log',
      } as unknown as TaskRow,
    ]);
    d.launch.mockResolvedValue(
      launchResult({
        deduped: false,
        launch: {
          agentStarted: true,
          tasks: [{ taskId: 'task-dropped-recovery', logPath: '/tmp/recovery.log', kickoffProof: { persisted: true } }],
        },
      }),
    );
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    const readLogTail = vi.fn((path: string) =>
      path.includes('dropped-kickoff')
        ? 'psu-pty-host: launch kickoff DROPPED for role-d5284217 ' +
          '(the child never settled to its prompt within 20000ms over 3 attempt(s))\n'
        : 'healthy fallback boot',
    );

    const result = await reconcilePendingGradingAudits(
      { ctx, harness: 'papercusp' },
      { ...d, killTask, readLogTail, sleep: async () => undefined, terminalLogMaxRechecks: 0 },
    );

    expect(killTask).toHaveBeenCalledWith('task-dropped-kickoff', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(d.launch).toHaveBeenCalledTimes(1);
    expect(result.receipts).toEqual([
      expect.objectContaining({
        issueId: 'EI-dropped-kickoff',
        state: 'launched',
        terminalRecovery: expect.objectContaining({
          retiredTaskIds: ['task-dropped-kickoff'],
          codes: ['launch_kickoff_dropped'],
        }),
      }),
    ]);
  });

  it('retires a heartbeat-fresh auditor that finished without emitting, then launches a replacement', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-finished-refusal')]);
    d.listTasks.mockResolvedValue([
      {
        taskId: 'task-finished-refusal',
        state: 'running',
        detail: { label: 'grading-audit:EI-finished-refusal' },
        logPath: '/tmp/finished-refusal.log',
      } as unknown as TaskRow,
    ]);
    d.launch.mockResolvedValue(
      launchResult({
        deduped: false,
        launch: {
          agentStarted: true,
          tasks: [{ taskId: 'task-replacement', logPath: '/tmp/replacement.log', kickoffProof: { persisted: true } }],
        },
      }),
    );
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    const result = await reconcilePendingGradingAudits(
      { ctx, harness: 'papercusp' },
      {
        ...d,
        killTask,
        readLogTail: (path: string) =>
          path.includes('finished-refusal')
            ? "● I didn't emit an audit, so the scorecard is still unsettled. The server refused my audit.\n✻ Worked for 4m 57s · done"
            : 'healthy replacement',
        sleep: async () => undefined,
        terminalLogMaxRechecks: 0,
      },
    );
    expect(killTask).toHaveBeenCalledWith('task-finished-refusal', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(d.launch).toHaveBeenCalledTimes(1);
    expect(result.receipts[0]).toMatchObject({
      state: 'launched',
      terminalRecovery: { retiredTaskIds: ['task-finished-refusal'], codes: ['grading_audit_refused'] },
    });
  });

  it('keeps a judge whose native kickoff marker arrived late but whose turn was observed', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-late-marker')]);
    d.launch.mockResolvedValueOnce(
      launchResult({
        deduped: false,
        launch: {
          agentStarted: true,
          tasks: [
            {
              taskId: 'task-late',
              logPath: '/tmp/late.log',
              kickoffProof: { persisted: false, reason: 'native-turn-marker-timeout' },
            },
          ],
        },
      }),
    );
    const killTask = vi.fn();

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-late-marker'], ctx, harness: 'papercusp' },
      {
        ...d,
        killTask,
        readLogTail: () => 'no terminal model error was logged',
        sleep: async () => undefined,
        terminalLogMaxRechecks: 0,
      },
    );

    expect(killTask).not.toHaveBeenCalled();
    expect(d.launch).toHaveBeenCalledTimes(1);
    expect(result.receipts[0]).toMatchObject({ state: 'launched' });
    expect(result.receipts[0]).not.toHaveProperty('terminalRecovery');
  });
});

// EI-22978598482930667. Measured over the WHOLE grading-audit log population on
// 2026-09-11 (n=6163, deliberately not a recency head): 2228 legs died on the
// pty-host `(quota-blocked)` drop and 2523 launches were refused by the walled-pool
// preflight, every refusal printing a contiguous `earliest known recovery <ISO>`.
// Nothing consumed either signal, so the ~55s sweep tick relaunched the same doomed
// judge forever. These cover the suppression that stops it.
describe('resolveGradingAuditQuotaBackoff', () => {
  const NOW = Date.parse('2026-09-11T16:00:00.000Z');
  const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
  const refusalLog = (horizon: string) =>
    'psu: REFUSING TO LAUNCH — Codex auto-route pool is fully walled: 0 of 7 ChatGPT accounts ' +
    `serviceable; earliest known recovery ${horizon}. Every model call would fail fast with 429.`;

  it('takes the EARLIEST future candidate, whichever source supplies it', async () => {
    const ledgerFirst = await resolveGradingAuditQuotaBackoff({
      code: 'model_quota_exhausted',
      logTail: refusalLog(iso(90 * 60_000)),
      nowMs: NOW,
      readProviderResets: async () => [NOW + 40 * 60_000, NOW + 5 * 60 * 60_000],
    });
    expect(ledgerFirst).toMatchObject({ until: iso(40 * 60_000), source: 'account-ledger' });

    const horizonFirst = await resolveGradingAuditQuotaBackoff({
      code: 'model_quota_exhausted',
      logTail: refusalLog(iso(20 * 60_000)),
      nowMs: NOW,
      readProviderResets: async () => [NOW + 3 * 60 * 60_000],
    });
    expect(horizonFirst).toMatchObject({ until: iso(20 * 60_000), source: 'launcher-horizon' });
  });

  it('clamps a candidate below the floor up, and a far-future one down to the ceiling', async () => {
    // Below MIN: a pool that "recovers" in a minute must not collapse back into
    // the sweep-tick busy loop this suppression exists to stop.
    const tooSoon = await resolveGradingAuditQuotaBackoff({
      code: 'model_quota_exhausted',
      logTail: refusalLog(iso(60_000)),
      nowMs: NOW,
      readProviderResets: async () => [],
    });
    expect(tooSoon).toMatchObject({
      until: iso(GRADING_AUDIT_QUOTA_BACKOFF_MIN_MS),
      source: 'launcher-horizon',
    });

    // Above MAX, using the real horizon codex printed on 2026-09-11 (~3.4 days
    // out): a wrong-but-plausible far reset must degrade to "re-probe in six
    // hours", never strand the audit queue for days.
    const tooFar = await resolveGradingAuditQuotaBackoff({
      code: 'model_quota_exhausted',
      logTail: refusalLog('2026-09-15T01:25:13.000Z'),
      nowMs: NOW,
      readProviderResets: async () => [],
    });
    expect(tooFar).toMatchObject({
      until: iso(GRADING_AUDIT_QUOTA_BACKOFF_MAX_MS),
      source: 'launcher-horizon',
    });
  });

  it('reports source "default" rather than inventing a reset when neither source yields a FUTURE instant', async () => {
    const backoff = await resolveGradingAuditQuotaBackoff({
      code: 'model_quota_exhausted',
      // Both candidates are in the past: an already-elapsed horizon is not a
      // recovery time, and reading it as one would suppress against nothing.
      logTail: refusalLog(iso(-60 * 60_000)),
      nowMs: NOW,
      readProviderResets: async () => [NOW - 10 * 60_000],
    });
    expect(backoff).toMatchObject({
      until: iso(GRADING_AUDIT_QUOTA_BACKOFF_DEFAULT_MS),
      source: 'default',
      code: 'model_quota_exhausted',
      recordedAt: iso(0),
    });
    expect(backoff.reason).toContain('no recoverable reset');
  });

  it('fails OPEN to the default window when the account-ledger read throws', async () => {
    const backoff = await resolveGradingAuditQuotaBackoff({
      code: 'model_quota_exhausted',
      nowMs: NOW,
      readProviderResets: async () => {
        throw new Error('account pool store unavailable');
      },
    });
    expect(backoff).toMatchObject({
      until: iso(GRADING_AUDIT_QUOTA_BACKOFF_DEFAULT_MS),
      source: 'default',
    });
  });
});

describe('terminal grading-audit failures record a reset-aware or generic backoff', () => {
  const NOW = Date.parse('2026-09-11T16:00:00.000Z');
  // Verbatim shape of the launcher refusal, taken from the real fleet logs.
  const WALLED_POOL_REFUSAL =
    'psu: REFUSING TO LAUNCH — Codex auto-route pool is fully walled: 0 of 7 ChatGPT accounts ' +
    'serviceable; earliest known recovery 2026-09-11T17:00:00.000Z. Every model call would fail ' +
    'fast with 429, so this launch can only burn quota.';

  it('records a reset-aware backoff in the SAME release that drops a quota-terminal reservation', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-walled')]);
    d.launch
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { tasks: [{ taskId: 'task-primary', logPath: '/tmp/primary.log' }] },
        }),
      )
      .mockResolvedValueOnce(
        launchResult({
          deduped: false,
          launch: { tasks: [{ taskId: 'task-fallback', logPath: '/tmp/fallback.log' }] },
        }),
      );
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-walled'], ctx },
      {
        ...d,
        killTask,
        readLogTail: () => WALLED_POOL_REFUSAL,
        sleep: async () => undefined,
        terminalLogRecheckDelayMs: 0,
        terminalLogMaxRechecks: 0,
        now: () => NOW,
        readProviderResets: async () => [],
      },
    );

    expect(d.release).toHaveBeenCalledWith('EI-walled', 'grading-audit:EI-walled', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
      backoff: {
        until: '2026-09-11T17:00:00.000Z',
        source: 'launcher-horizon',
        code: 'model_quota_exhausted',
        recordedAt: '2026-09-11T16:00:00.000Z',
        reason: 'terminal model_quota_exhausted; suppressing re-dispatch until the launcher-horizon reset',
      },
    });
    expect(result.receipts[0]).toMatchObject({
      state: 'failed',
      reason: expect.stringContaining('re-dispatch suppressed until 2026-09-11T17:00:00.000Z'),
    });
  });

  it('uses the generic retry window for a non-quota terminal failure despite an unrelated account reset', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-dead-receipt-twice')]);
    d.launch.mockResolvedValue(
      launchResult({
        deduped: true,
        launch: { tasks: [{ taskId: 'task-dead', logPath: '/tmp/dead.log' }] },
      }),
    );
    d.getTask.mockResolvedValue({ state: 'killed' } as Awaited<ReturnType<GetTask>>);
    const killTask = vi.fn(async (taskId: string) => ({
      ok: false as const,
      taskId,
      action: 'kill',
      error: 'not_live' as const,
    }));

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-dead-receipt-twice'], ctx },
      {
        ...d,
        killTask,
        readLogTail: () => 'no terminal model error was logged',
        sleep: async () => undefined,
        terminalLogMaxRechecks: 0,
        now: () => NOW,
        // A live, recoverable reset is available, but this failure is not a
        // quota error; it must use the generic retry window, not that reset.
        readProviderResets: async () => [NOW + 40 * 60_000],
      },
    );

    expect(result.receipts[0]).toMatchObject({
      state: 'failed',
      terminalRecovery: expect.objectContaining({
        codes: ['task_receipt_not_live', 'task_receipt_not_live'],
      }),
    });
    expect(d.release).toHaveBeenCalledWith('EI-dead-receipt-twice', 'grading-audit:EI-dead-receipt-twice', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
      backoff: {
        until: new Date(NOW + GRADING_AUDIT_FAILURE_BACKOFF_MS).toISOString(),
        source: 'retry-window',
        code: 'task_receipt_not_live',
        recordedAt: new Date(NOW).toISOString(),
        reason: 'terminal task_receipt_not_live; suppressing re-dispatch for a bounded retry window',
      },
    });
    expect(result.receipts[0]?.reason).toContain('re-dispatch suppressed until');
  });

  it('records a generic retry window after both auditor legs terminate on gateway errors', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-double-gateway-error')]);
    d.launch
      .mockResolvedValueOnce(launchResult({
        deduped: false,
        launch: { tasks: [{ taskId: 'task-gateway-primary', logPath: '/tmp/gateway-primary.log' }] },
      }))
      .mockResolvedValueOnce(launchResult({
        deduped: false,
        launch: { tasks: [{ taskId: 'task-gateway-fallback', logPath: '/tmp/gateway-fallback.log' }] },
      }));
    const killTask = vi.fn(async (taskId: string) => ({ ok: true as const, taskId, action: 'kill' }));
    const gatewayError =
      'API Error: Request rejected (429) · inference-gateway: all accounts throttled; retry after 60s\n' +
      '✻ Worked for 13m 45s · done 9:09 AM\n❯';

    const result = await dispatchPendingGradingAudits(
      { targetIds: ['EI-double-gateway-error'], ctx },
      {
        ...d,
        killTask,
        readLogTail: () => gatewayError,
        sleep: async () => undefined,
        terminalLogRecheckDelayMs: 0,
        terminalLogMaxRechecks: 0,
        now: () => NOW,
        // The available account reset must not be mistaken for a quota-classified
        // failure; this is an inference_gateway_error and uses retry-window.
        readProviderResets: async () => [NOW + 40 * 60_000],
      },
    );

    expect(result.receipts[0]).toMatchObject({
      state: 'failed',
      terminalRecovery: {
        attempts: 2,
        codes: ['inference_gateway_error', 'inference_gateway_error'],
      },
      reason: expect.stringContaining('re-dispatch suppressed until'),
    });
    expect(d.release).toHaveBeenCalledWith('EI-double-gateway-error', 'grading-audit:EI-double-gateway-error', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
      backoff: {
        until: new Date(NOW + GRADING_AUDIT_FAILURE_BACKOFF_MS).toISOString(),
        source: 'retry-window',
        code: 'inference_gateway_error',
        recordedAt: new Date(NOW).toISOString(),
        reason: 'terminal inference_gateway_error; suppressing re-dispatch for a bounded retry window',
      },
    });
  });
});

// WI-10003463: the bounded retry is routed to the fallback provider only when
// that provider can MEASURABLY serve. These cases drive the real pool rollup, so
// a change to poolVerdictByProvider's unknown/at-capacity semantics is caught here.
describe('gradingAuditFallbackVerdictCanServe', () => {
  const NOW = Date.parse('2026-09-27T12:15:00.000Z');
  const row = (over: Partial<AccountStatusRow> & { id: string; provider: AccountStatusRow['provider'] }) =>
    ({
      credentialRef: `token:${over.id}`,
      boundTo: [],
      available: true,
      usageWalled: false,
      sustainedlyLimited: false,
      edgeThrottleKnown: false,
      edgeThrottled: false,
      edgeThrottleCooledIps: 0,
      edgeThrottleBare429Streak: 0,
      rate: { pausedUntil: 0, penaltyCount: 0, lastPenaltyAt: 0, windowStartedAt: 0 },
      liveBuckets: [],
      readingStatus: 'fresh',
      burn: {
        burnRatePerHr: null,
        headroomFraction: null,
        projectedExhaustionAt: null,
        exhaustsBeforeReset: false,
        action: 'none',
        utilization7d: null,
        disposition: 'no-verdict',
        reason: 'fixture',
      },
      ...over,
    }) as AccountStatusRow;
  const verdictFor = (rows: AccountStatusRow[], provider: AccountStatusRow['provider']) =>
    poolVerdictByProvider(rows, NOW).find((v) => v.provider === provider);

  it('THE INCIDENT: 0 serviceable + stale rows is NOT at capacity, but still cannot serve the fallback', () => {
    // The codex pool shape measured by accounts:status at 2026-09-27T12:15Z.
    const codex = [
      row({ id: 'chatgpt-sub-cli', provider: 'codex', available: false, usageWalled: true }),
      row({
        id: 'aviynw2_codex',
        provider: 'codex',
        available: false,
        usageWalled: true,
        readingStatus: 'stale',
        lastProbeFailedAt: NOW - 60_000,
      }),
      row({ id: 'aviynw_3', provider: 'codex', readingStatus: 'stale' }),
      row({ id: 'aviynw4_codex', provider: 'codex', available: false, usageWalled: true }),
      row({ id: 'aviynw5_codex', provider: 'codex', available: false, usageWalled: true }),
      row({ id: 'aviynw3_codex', provider: 'codex', readingStatus: 'stale' }),
      row({ id: 'aviynw6_codex', provider: 'codex', available: false, usageWalled: true }),
    ];
    const verdict = verdictFor(codex, 'codex');
    // Calibration: the rollup really does call this pool "not at capacity" —
    // exactly the reading the old `!atCapacity` predicate trusted.
    expect(verdict?.atCapacity).toBe(false);
    expect(verdict?.serviceable).toBe(0);
    expect(verdict?.unknown).toBe(3);
    expect(gradingAuditFallbackVerdictCanServe(verdict)).toBe(false);
  });

  it('a provider with one measured serviceable account can serve the fallback', () => {
    const claude = [
      row({ id: 'aviynw10', provider: 'claude' }),
      row({ id: 'aviynw2', provider: 'claude', available: false, usageWalled: true }),
      row({ id: 'aviynw9', provider: 'claude', readingStatus: 'stale' }),
    ];
    const verdict = verdictFor(claude, 'claude');
    expect(verdict?.serviceable).toBe(1);
    expect(gradingAuditFallbackVerdictCanServe(verdict)).toBe(true);
  });

  it('an all-stale pool is unmeasured, so the retry stays on the primary', () => {
    const verdict = verdictFor(
      [row({ id: 'c1', provider: 'codex', readingStatus: 'stale' }), row({ id: 'c2', provider: 'codex', readingStatus: 'never-observed' })],
      'codex',
    );
    expect(verdict?.atCapacity).toBe(false);
    expect(gradingAuditFallbackVerdictCanServe(verdict)).toBe(false);
  });

  it('a provider with no registered accounts cannot serve', () => {
    expect(verdictFor([row({ id: 'a', provider: 'claude' })], 'codex')).toBeUndefined();
    expect(gradingAuditFallbackVerdictCanServe(undefined)).toBe(false);
  });
});
