import { describe, expect, it, vi } from 'vitest';
import type { BulkRunRow } from '../attention/bulk-run-store';
import type { CleanupFinding } from './scanner';
import type { CleanupRunFindingRow } from './run-store';
import { runDeterministicPlanCleanup } from './deterministic-runner';

function run(): BulkRunRow {
  return {
    runId: 'run-1',
    workspaceId: 'workspace-1',
    harnessSlug: 'papercusp',
    requestedBy: 'owner',
    resolverOwner: null,
    phase: 'pending',
    runKind: 'plan-cleanup',
    seedRefs: ['plan-a'],
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

function finding(kind: CleanupFinding['kind'], autoApply: boolean): CleanupFinding {
  const itemId = kind === 'finish-plan' || kind === 'stale-now' ? null : 'P-001';
  return {
    findingId: `${kind}:papercusp/plan-a${itemId ? `#${itemId}` : ''}`,
    kind,
    workspaceId: 'workspace-1',
    harnessSlug: 'papercusp',
    planSlug: 'plan-a',
    itemId,
    target: itemId ?? 'plan-a',
    from: 'todo',
    to: kind === 'finish-plan' ? 'shipped' : 'done',
    confidence: autoApply ? 'provable' : 'recommended',
    autoApply,
    autoApplyBlockedBy: autoApply ? null : 'judgment-call',
    evidence: [{ kind: 'plan', ref: 'plan-a', note: 'fixture proof' }],
  };
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
});
