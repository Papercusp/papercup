import { describe, expect, it, vi } from 'vitest';
import type { BulkRunRow } from '../attention/bulk-run-store';
import { DEFAULT_ENLIST_PLAN_LIMIT, type CleanupFinding } from './scanner';
import type { CleanupRunFindingRow } from './run-store';
import { runDeterministicPlanCleanup } from './deterministic-runner';

function run(seedRefs: string[] = ['plan-a']): BulkRunRow {
  return {
    runId: 'run-1',
    workspaceId: 'workspace-1',
    harnessSlug: 'papercusp',
    requestedBy: 'owner',
    resolverOwner: null,
    phase: 'pending',
    runKind: 'plan-cleanup',
    seedRefs,
    filterSnapshot: {},
    launchSnapshot: {},
    totalItems: 1,
    autoResolved: 0,
    recommended: 0,
    skipped: 0,
    failed: 0,
    error: null,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    heartbeatAt: null,
  };
}

function finding(
  kind: CleanupFinding['kind'],
  autoApply: boolean,
  planSlug = 'plan-a',
): CleanupFinding {
  const itemId = kind === 'finish-plan' || kind === 'stale-now' || kind === 'enlist-plan'
    ? null
    : 'P-001';
  const value: CleanupFinding = {
    findingId: `${kind}:papercusp/${planSlug}${itemId ? `#${itemId}` : ''}`,
    kind,
    workspaceId: 'workspace-1',
    harnessSlug: 'papercusp',
    planSlug,
    itemId,
    target: itemId ?? 'plan-a',
    from: 'todo',
    to: kind === 'finish-plan' ? 'shipped' : 'done',
    confidence: autoApply ? 'provable' : 'recommended',
    autoApply,
    autoApplyBlockedBy: autoApply ? null : 'judgment-call',
    evidence: [{ kind: 'plan', ref: planSlug, note: 'fixture proof' }],
  };
  if (kind === 'enlist-plan') {
    value.action = {
      kind: 'enlist-plan',
      goalId: 'goal-everything',
      planRef: `plan:papercusp/${planSlug}`,
      worklist: [],
      expectedVersion: 0,
    };
  }
  return value;
}

function rowOf(value: CleanupFinding): CleanupRunFindingRow {
  return {
    workspaceId: 'workspace-1',
    runId: 'run-1',
    findingId: value.findingId,
    kind: value.kind,
    planSlug: value.planSlug,
    harnessSlug: value.harnessSlug,
    itemId: value.itemId,
    target: value.target,
    from: value.from,
    to: value.to,
    confidence: value.confidence,
    evidence: value.evidence,
    position: 0,
    outcome: 'pending',
    error: null,
    decidedAt: null,
  };
}

function storeHarness(rows: CleanupRunFindingRow[]) {
  return {
    seed: vi.fn(async ({ findings }: { findings: readonly CleanupFinding[] }) => {
      for (const value of findings) {
        if (!rows.some((row) => row.findingId === value.findingId)) rows.push(rowOf(value));
      }
      return { findings: rows, refused: null };
    }),
    read: vi.fn(async () => rows),
    execute: vi.fn(async (input: { findingId: string; execute: (row: CleanupRunFindingRow) => Promise<unknown> }) => {
      const row = rows.find((candidate) => candidate.findingId === input.findingId)!;
      const actionResult = await input.execute(row);
      row.outcome = 'auto_applied';
      return { actionResult, finding: row, run: run(), refused: null };
    }),
    report: vi.fn(async ({ reports }: { reports: Array<{ findingId: string; outcome: CleanupRunFindingRow['outcome']; error?: string }> }) => {
      for (const report of reports) {
        const row = rows.find((candidate) => candidate.findingId === report.findingId)!;
        row.outcome = report.outcome;
        row.error = report.error ?? null;
      }
      return { updated: rows, missing: [], run: run(), refused: null };
    }),
  };
}

describe('runDeterministicPlanCleanup', () => {
  it('enforces one run-wide enlistment cap across locked rescans and later passes', async () => {
    const rows: CleanupRunFindingRow[] = [];
    const store = storeHarness(rows);
    const all = Array.from(
      { length: DEFAULT_ENLIST_PLAN_LIMIT + 1 },
      (_, index) => finding('enlist-plan', true, `plan-${String(index + 1).padStart(2, '0')}`),
    );
    const cleanupRun = run(all.map((candidate) => candidate.planSlug));
    const scanRun = vi.fn(async (
      _run: BulkRunRow,
      planSlugs: readonly string[] = _run.seedRefs,
      options: { enlistPlanLimit?: number } = {},
    ) => all
      .filter((candidate) => planSlugs.includes(candidate.planSlug))
      .slice(0, Math.max(0, options.enlistPlanLimit ?? DEFAULT_ENLIST_PLAN_LIMIT)));
    const dispatch = vi.fn(async () => ({ ok: true }));
    const settle = vi.fn(async () => ({ ...cleanupRun, phase: 'complete' as const }));

    const result = await runDeterministicPlanCleanup({
      run: cleanupRun,
      call: vi.fn(),
      deps: {
        scanRun,
        ...store,
        dispatch,
        settle,
        notify: vi.fn(async () => undefined),
      } as never,
    });

    expect(result).toMatchObject({
      needsResolver: false,
      phase: 'complete',
      applied: DEFAULT_ENLIST_PLAN_LIMIT,
      failed: 0,
    });
    expect(dispatch).toHaveBeenCalledTimes(DEFAULT_ENLIST_PLAN_LIMIT);
    expect(result.appliedFindingIds).toEqual(
      all.slice(0, DEFAULT_ENLIST_PLAN_LIMIT).map((candidate) => candidate.findingId),
    );
    expect(result.appliedFindingIds).not.toContain(all.at(-1)?.findingId);
    expect(scanRun.mock.calls.map((call) => call[2]?.enlistPlanLimit)).toContain(0);
  });

  it('re-scans to a fixed point and finishes without an LLM when every finding is provable', async () => {
    const rows: CleanupRunFindingRow[] = [];
    const store = storeHarness(rows);
    let state = 0;
    const flip = finding('flip-to-done', true);
    const finish = finding('finish-plan', true);
    const scanRun = vi.fn(async () => state === 0 ? [flip] : state === 1 ? [finish] : []);
    const dispatch = vi.fn(async ({ finding: current }: { finding: CleanupFinding }) => {
      expect(current.autoApply).toBe(true);
      state += 1;
      return { ok: true };
    });
    const settle = vi.fn(async () => ({ ...run(), phase: 'complete' as const }));

    const result = await runDeterministicPlanCleanup({
      run: run(),
      call: vi.fn(),
      deps: {
        scanRun,
        ...store,
        dispatch,
        settle,
        notify: vi.fn(async () => undefined),
      } as never,
    });

    expect(result).toMatchObject({ needsResolver: false, phase: 'complete', applied: 2, failed: 0 });
    expect(result.appliedFindingIds).toEqual([flip.findingId, finish.findingId]);
    expect(dispatch.mock.calls.map((call) => call[0].finding.kind)).toEqual(['flip-to-done', 'finish-plan']);
    expect(settle).toHaveBeenCalledWith({ runId: 'run-1' });
  });

  it('leaves only judgment findings pending and requests the resolver', async () => {
    const rows: CleanupRunFindingRow[] = [];
    const store = storeHarness(rows);
    const recommendation = finding('stale-now', false);
    const settle = vi.fn();

    const result = await runDeterministicPlanCleanup({
      run: run(),
      call: vi.fn(),
      deps: {
        scanRun: vi.fn(async () => [recommendation]),
        ...store,
        dispatch: vi.fn(),
        settle,
        notify: vi.fn(async () => undefined),
      } as never,
    });

    expect(result.needsResolver).toBe(true);
    expect(result.recommendationFindingIds).toEqual([recommendation.findingId]);
    expect(rows[0]?.outcome).toBe('pending');
    expect(settle).not.toHaveBeenCalled();
  });

  it('preserves the live run phase when deterministic write authority is revoked', async () => {
    const settle = vi.fn();
    const result = await runDeterministicPlanCleanup({
      run: run(),
      call: vi.fn(),
      deps: {
        scanRun: vi.fn(async () => [finding('flip-to-done', true)]),
        seed: vi.fn(async () => ({
          findings: [],
          refused: { reason: 'run_authority_revoked', phase: 'review' },
        })),
        settle,
        notify: vi.fn(async () => undefined),
      } as never,
    });

    expect(result).toMatchObject({
      needsResolver: false,
      phase: 'review',
      applied: 0,
      authorityRevoked: true,
      authorityRefusal: { reason: 'run_authority_revoked', phase: 'review' },
    });
    expect(settle).not.toHaveBeenCalled();
  });
});
