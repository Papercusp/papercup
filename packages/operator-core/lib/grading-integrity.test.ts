import { describe, expect, it, vi } from 'vitest';
import type { Rubric } from './rubrics';
import type { ScorecardRow } from './scorecards';
import {
  dispatchPendingGradingAudits,
  GRADING_AUDIT_BACKLOG_SCAN_LIMIT,
  GRADING_AUDIT_DISPATCH_LIMIT,
  GRADING_INTEGRITY_RUBRIC_REF,
  reconcilePendingGradingAudits,
  type GradingAuditReservationResult,
  type DispatchPendingGradingAuditsDeps,
  type DispatchPendingGradingAuditsInput,
} from './grading-integrity';

type ListScorecards = NonNullable<DispatchPendingGradingAuditsDeps['listScorecards']>;
type GetRubric = NonNullable<DispatchPendingGradingAuditsDeps['getRubric']>;
type Launch = NonNullable<DispatchPendingGradingAuditsDeps['launch']>;
type LaunchResult = Awaited<ReturnType<Launch>>;

// Keep the mock result shape explicit without using `as never` at a mock call;
// the cast is isolated here so the escape guard still typechecks every install site.
function launchResult(data: unknown): LaunchResult {
  return { data } as LaunchResult;
}

const ctx = { workspaceId: 'ws-test', harnessSlug: 'papercusp' } as DispatchPendingGradingAuditsInput['ctx'];

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
    state: 'fallback', reason: 'existing router: no_qualified_responder',
  });
  const listScorecards = vi.fn<ListScorecards>().mockResolvedValue([]);
  const getRubric = vi.fn<GetRubric>().mockResolvedValue(standardRubric());
  const launch = vi
    .fn<Launch>()
    .mockResolvedValue(launchResult({ deduped: false, launch: { opened: 1, tasks: [{ taskId: 'task-audit' }] } }));
  const reserve = vi.fn(async (): Promise<GradingAuditReservationResult> => ({
    status: 'claimed',
    reservation: { key: 'grading-audit:test', reservedAt: '2026-09-08T00:00:00.000Z' },
  }));
  const release = vi.fn(async () => true);
  const listWorkspaceWideLoopStanddownOwners = vi.fn(async (_workspaceId: string, _nowMs: number) => new Set<string>());
  return { listScorecards, getRubric, launch, route, reserve, release, listWorkspaceWideLoopStanddownOwners };
}

describe('dispatchPendingGradingAudits', () => {
  it('routes the exact source card before launch, retaining reservation and subject evidence', async () => {
    const d = deps();
    const source = card('EI-routed', { subject: { kind: 'plan', ref: 'source-plan' }, evidenceFingerprint: 'frozen-fingerprint' });
    d.listScorecards.mockResolvedValue([source]);
    d.route.mockResolvedValue({ state: 'routed', conversationId: 'audit-consult' });
    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-routed'], ctx }, d);
    expect(d.reserve.mock.invocationCallOrder[0]).toBeLessThan(d.route.mock.invocationCallOrder[0]);
    expect(d.route).toHaveBeenCalledWith(expect.objectContaining({
      card: source, reservationKey: 'grading-audit:EI-routed',
      brief: expect.stringContaining('frozen-fingerprint'),
    }));
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

  it('reports routing failure without launching past an uncertain persisted dispatch', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-fault')]);
    d.route.mockRejectedValue(new Error('lineage unavailable'));
    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-fault'], ctx }, d);
    expect(result.receipts[0]).toMatchObject({ state: 'failed', reason: 'lineage unavailable' });
    expect(d.launch).not.toHaveBeenCalled();
    expect(d.release).toHaveBeenCalledOnce();
  });

  it('serializes concurrent routed dispatches through the existing card reservation', async () => {
    const d = deps();
    d.listScorecards.mockResolvedValue([card('EI-race')]);
    d.reserve.mockResolvedValueOnce({ status: 'claimed' }).mockResolvedValue({ status: 'already-reserved' });
    d.route.mockResolvedValue({ state: 'routed', conversationId: 'one-consult' });
    const results = await Promise.all([1, 2].map(() => dispatchPendingGradingAudits({ targetIds: ['EI-race'], ctx }, d)));
    expect(results.flatMap((r) => r.receipts.map((receipt) => receipt.state)).sort()).toEqual(['routed', 'skipped']);
    expect(d.route).toHaveBeenCalledOnce();
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
        headless: true,
        account: 'auto',
        count: 1,
        members: [{ role: 'judge', account: 'auto' }],
        label: 'grading-audit:EI-audit-1',
        idempotencyKey: 'grading-audit:EI-audit-1',
      }),
      ctx,
    );
    expect(d.launch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: 'grading-audit:EI-audit-1' }),
      ctx,
    );
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

    const result = await dispatchPendingGradingAudits({ targetIds: ['EI-launch-failure'], ctx }, d);

    expect(result.receipts).toEqual([
      expect.objectContaining({ issueId: 'EI-launch-failure', state: 'failed', reason: 'launch refused' }),
    ]);
    expect(d.release).toHaveBeenCalledWith('EI-launch-failure', 'grading-audit:EI-launch-failure', {
      workspaceId: 'ws-test',
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
    expect(d.launch).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'grading-audit:EI-current' }), ctx);
    expect(d.launch.mock.calls[0]?.[0]).not.toHaveProperty('harness');
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
        account: 'default',
        members: [{ role: 'judge', agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', account: 'default' }],
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
          fallback: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', account: 'default' },
        },
      }),
    ]);
  });

  it('retires a deduped auditor whose gateway-5xx turn completed and launches the Codex fallback', async () => {
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
    const gatewayLog =
      '\u001b[38;5;220m●\u001b[3GAPI Error: 500 inference-gateway internal error. This is a server-side\r\n' +
      'issue, usually temporary — try again in a moment. If it persists, check your inference gateway ' +
      '(127.0.0.1:8788).\r\n' +
      '\u001b[38;5;246m✻ Cooked for 12m 56s · done 11:27 AM\u001b[0m\r\n❯';

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
        account: 'default',
        members: [{ role: 'judge', agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', account: 'default' }],
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
});
