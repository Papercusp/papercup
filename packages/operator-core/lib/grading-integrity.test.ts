import { describe, expect, it, vi } from 'vitest';
import type { Rubric } from './rubrics';
import type { ScorecardRow } from './scorecards';
import type { TaskRow } from './task-manager/types';
import {
  dispatchPendingGradingAudits,
  GRADING_AUDIT_BACKLOG_SCAN_LIMIT,
  GRADING_AUDIT_DISPATCH_CONCURRENCY,
  GRADING_AUDIT_DISPATCH_LIMIT,
  GRADING_AUDIT_FAILURE_BACKOFF_MS,
  GRADING_AUDIT_QUOTA_BACKOFF_DEFAULT_MS,
  GRADING_AUDIT_QUOTA_BACKOFF_MAX_MS,
  GRADING_AUDIT_QUOTA_BACKOFF_MIN_MS,
  GRADING_AUDIT_DISPATCH_ACTOR,
  GRADING_INTEGRITY_RUBRIC_REF,
  gradingAuditorLaunchCtx,
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

// Keep the mock result shape explicit without using `as never` at a mock call;
// the cast is isolated here so the escape guard still typechecks every install site.
function launchResult(data: unknown): LaunchResult {
  return { data } as LaunchResult;
}

const ctx = { workspaceId: 'ws-test', harnessSlug: 'papercusp' } as DispatchPendingGradingAuditsInput['ctx'];

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
    listWorkspaceWideLoopStanddownOwners,
  };
}

describe('dispatchPendingGradingAudits', () => {
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

  it('suppresses terminal auditor dispatch during an active workspace-wide loop stand-down', async () => {
    const d = deps();
    d.listWorkspaceWideLoopStanddownOwners.mockResolvedValue(new Set(['su-owner']));

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-paused'], ctx }, d);

    expect(result).toEqual({
      requestedTargetIds: ['EI-paused'],
      receipts: [
        {
          issueId: 'EI-paused',
          state: 'skipped',
          reason: 'dispatch suppressed by active workspace-wide loop stand-down',
        },
      ],
    });
    expect(d.listScorecards).not.toHaveBeenCalled();
    expect(d.reserve).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
    expect(d.listWorkspaceWideLoopStanddownOwners).toHaveBeenCalledWith('ws-test', expect.any(Number));
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
    expect(d.release).toHaveBeenCalledWith('EI-live-auditor', 'grading-audit:EI-live-auditor', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
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
    expect(brief).toContain("Before emitting, re-read the target scorecard's payload.observation.gradingAudit.state");
    expect(brief).toContain("gradingAudit.state is exactly 'pending'");
    expect(brief).toContain("state is not 'pending' (including 'passed', 'failed', or 'cancelled')");
    expect(brief).toContain('superseded or retracted');
    expect(brief).toContain("Dispatch lease: key 'grading-audit:EI-state-recheck', reservedAt '2026-09-08T00:00:00.000Z'");
    expect(brief).toContain('Before reading criterion evidence');
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

    await dispatchPendingGradingAudits(
      { targetIds: ['EI-walled-fallback'], ctx, harness: 'papercusp' },
      { ...d, providerCanServe },
    );

    expect(providerCanServe).toHaveBeenCalledWith('codex');
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

    await dispatchPendingGradingAudits(
      { targetIds: ['EI-walled-fallback'], ctx, harness: 'papercusp' },
      { ...d, providerCanServe },
    );

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
          launch: { tasks: [{ taskId: 'task-recovery-a', logPath: '/tmp/recovery-a.log' }] },
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
          launch: { tasks: [{ taskId: 'task-recovery-b', logPath: '/tmp/recovery-b.log' }] },
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

describe('terminal grading-audit failures record a backoff only for a quota wall', () => {
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

  it('does NOT suppress a non-quota terminal failure, even with a recoverable reset on the ledger', async () => {
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
        // A live, recoverable reset IS available. If the gate on
        // `model_quota_exhausted` were ever dropped, this arm would start
        // producing a backoff and the assertions below would fail — which is
        // the point of supplying it rather than an empty ledger.
        readProviderResets: async () => [NOW + 40 * 60_000],
      },
    );

    expect(result.receipts[0]).toMatchObject({
      state: 'failed',
      terminalRecovery: expect.objectContaining({
        codes: ['task_receipt_not_live', 'task_receipt_not_live'],
      }),
    });
    // Exact third argument: no `backoff` key at all, so the next sweep retries.
    expect(d.release).toHaveBeenCalledWith('EI-dead-receipt-twice', 'grading-audit:EI-dead-receipt-twice', {
      workspaceId: 'ws-test',
      reservedAt: '2026-09-08T00:00:00.000Z',
    });
    expect(result.receipts[0]?.reason).not.toContain('suppressed');
  });
});
