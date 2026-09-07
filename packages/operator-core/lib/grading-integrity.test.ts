import { describe, expect, it, vi } from 'vitest';
import type { Rubric } from './rubrics';
import type { ScorecardRow } from './scorecards';
import {
  dispatchPendingGradingAudits,
  GRADING_AUDIT_BACKLOG_SCAN_LIMIT,
  GRADING_AUDIT_DISPATCH_LIMIT,
  GRADING_INTEGRITY_RUBRIC_REF,
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
  const listScorecards = vi.fn<ListScorecards>().mockResolvedValue([]);
  const getRubric = vi.fn<GetRubric>().mockResolvedValue(standardRubric());
  const launch = vi
    .fn<Launch>()
    .mockResolvedValue(launchResult({ deduped: false, launch: { opened: 1, tasks: [{ taskId: 'task-audit' }] } }));
  return { listScorecards, getRubric, launch };
}

describe('dispatchPendingGradingAudits', () => {
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
});
