/**
 * P-018 / P-011 (review-system-rework-reduction-2026-09-23): `testing:run { remeasureEvidence }`
 * re-runs ONLY the test proofs whose measured source/test files moved, from the recipes the
 * bindings already persisted, and withdraws a replaced stale row only after its fresh run
 * PASSES. Nothing here weakens a check: a clause whose meaning moved is never re-measured, and
 * a failed re-run keeps its predecessors so the clause stays honestly red.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildTestEvidenceRemeasure,
  planTestEvidenceRemeasure,
  retireRemeasuredPredecessors,
} from './evidence';

type Currentness = {
  overall: 'current' | 'stale' | 'unknown';
  dimensions: Record<string, string>;
  staleReasons: string[];
  unknownReasons: string[];
};

const recipe = (specId: string, testPath: string) => ({
  specId, specRevision: 3, testPath, sourcePaths: ['src/subject.ts'], testLayer: 'unit' as const,
});

function row(id: number, opts: {
  specId?: string; testPath?: string; kind?: string; phase?: string; revision?: number;
  currentness?: Partial<Currentness>; moved?: unknown; outcome?: string; evidenceRef?: string;
  /** Bound by hand (plans:bind-spec-evidence): no stored recipe, only the measured paths. */
  handBound?: boolean;
}) {
  const specId = opts.specId ?? 'S-1';
  const testPath = opts.testPath ?? 'src/subject.test.ts';
  const currentness: Currentness = {
    overall: 'current', dimensions: { spec: 'current', source: 'current', test: 'current' },
    staleReasons: [], unknownReasons: [], ...opts.currentness,
  };
  const handBound = opts.handBound ?? opts.kind === 'mutation';
  return {
    id, specId, specRevision: opts.revision ?? 3, evidenceKind: opts.kind ?? 'test',
    evidenceRef: opts.evidenceRef ?? `test-run-group:old:${id}`,
    details: {
      ...(handBound
        ? { currentMeasurement: { kind: 'repo-files', testPaths: [testPath], sourcePaths: ['src/subject.ts'] } }
        : { testExecution: { phase: opts.phase ?? 'settled', binding: recipe(specId, testPath) } }),
      adequacy: { outcome: opts.outcome ?? 'pass' },
    },
    currentness,
    ...(opts.moved ? { serverMeasurement: { status: 'measured', movedPaths: opts.moved } } : {}),
  } as never;
}

const sourceStale = { overall: 'stale' as const, dimensions: { spec: 'current', source: 'stale' }, staleReasons: ['source-stale'] };

describe('planTestEvidenceRemeasure', () => {
  it('selects only the latest stale-by-drift binding per (clause, test file) and lists every live predecessor', () => {
    const moved = [{ path: 'src/subject.ts', dimension: 'source', change: 'changed' }];
    const plan = planTestEvidenceRemeasure([
      row(10, { currentness: sourceStale, moved }),
      row(9, { phase: 'pending', currentness: sourceStale }),
      row(11, { specId: 'S-2', testPath: 'src/other.test.ts' }),
    ]);
    expect(plan.selected).toHaveLength(1);
    expect(plan.selected[0]).toMatchObject({
      specId: 'S-1', testPath: 'src/subject.test.ts', bindingId: 10, staleReasons: ['source-stale'],
      movedPaths: moved, supersedes: [9, 10], binding: recipe('S-1', 'src/subject.test.ts'),
    });
    expect(plan.skipped).toEqual([{ specId: 'S-2', testPath: 'src/other.test.ts', bindingId: 11, reason: 'current' }]);
  });

  it('never re-measures a clause whose MEANING moved, an in-flight run, or an unmeasurable row', () => {
    const plan = planTestEvidenceRemeasure([
      row(1, { specId: 'S-1', currentness: { overall: 'stale', dimensions: { spec: 'stale' }, staleReasons: ['spec-stale', 'source-stale'] } }),
      row(2, { specId: 'S-2', phase: 'pending', currentness: sourceStale }),
      row(3, { specId: 'S-3', currentness: { overall: 'unknown', dimensions: { spec: 'current' }, unknownReasons: ['server-measurement-unavailable:gone'] } }),
      row(4, { specId: 'S-4', currentness: { overall: 'stale', dimensions: { spec: 'current', coverage: 'stale' }, staleReasons: ['coverage-stale'] } }),
    ]);
    expect(plan.selected).toEqual([]);
    expect(plan.skipped.map((entry) => `${entry.specId}:${entry.reason}`)).toEqual([
      'S-1:clause-moved', 'S-2:run-in-flight', 'S-3:unmeasurable', 'S-4:not-remeasurable',
    ]);
  });

  it('ignores counterexample proofs, which assert a failure against a deliberately broken subject', () => {
    expect(planTestEvidenceRemeasure([row(1, { kind: 'counterexample', currentness: sourceStale })]))
      .toEqual({ selected: [], skipped: [] });
  });

  it('reports a stale proof it cannot re-run instead of dropping it silently', () => {
    // Measured 2026-09-23 on WI-10002643: the pass answered examined 1 / selected 0 /
    // skipped [] while the completion gate failed freshness on exactly these bindings.
    const plan = planTestEvidenceRemeasure([
      row(10363, { specId: 'S-B', handBound: true, currentness: sourceStale }),
      row(10554, { specId: 'S-B', kind: 'mutation', currentness: sourceStale }),
      row(10435, { specId: 'S-B', kind: 'mutation', currentness: sourceStale }),
      row(7, { specId: 'S-C', kind: 'mutation' }),
    ]);
    expect(plan.selected).toEqual([]);
    expect(plan.skipped.map((entry) => `${entry.specId}:${entry.bindingId}:${entry.reason}:${entry.testPath}`)).toEqual([
      'S-B:10554:probe-required:src/subject.test.ts',
      'S-B:10363:no-recipe:src/subject.test.ts',
      'S-C:7:current:src/subject.test.ts',
    ]);
    expect(plan.skipped.find((entry) => entry.bindingId === 10363)!.detail).toMatch(/^source-stale: .*testing:run \{ evidence \}/);
    expect(plan.skipped.find((entry) => entry.bindingId === 10554)!.detail).toMatch(/^source-stale: .*mutation-probe/);
  });

  it('lets a newer recipe-bearing proof supersede a hand-bound one for the same clause and file', () => {
    const plan = planTestEvidenceRemeasure([
      row(1, { handBound: true, currentness: sourceStale }),
      row(2, { currentness: sourceStale }),
    ]);
    expect(plan.selected.map((entry) => entry.bindingId)).toEqual([2]);
    expect(plan.skipped).toEqual([]);
  });

  it('treats a run whose sources moved WHILE it ran as the same drift', () => {
    const plan = planTestEvidenceRemeasure([row(1, { phase: 'source-changed', currentness: sourceStale })]);
    expect(plan.selected.map((entry) => entry.bindingId)).toEqual([1]);
  });

  it('caps one request at 20 bindings and reports the overflow instead of dropping it', () => {
    const rows = Array.from({ length: 23 }, (_, index) =>
      row(index + 1, { specId: `S-${String(index).padStart(2, '0')}`, currentness: sourceStale }));
    const plan = planTestEvidenceRemeasure(rows);
    expect(plan.selected).toHaveLength(20);
    expect(plan.skipped.filter((entry) => entry.reason === 'cap')).toHaveLength(3);
  });
});

describe('buildTestEvidenceRemeasure', () => {
  it('starts nothing when no proof is stale by drift', async () => {
    const list = vi.fn().mockResolvedValue([row(1, {})]);
    const built = await buildTestEvidenceRemeasure({ workItemId: 'WI-1', planSlug: 'p' }, { harnessSlug: 'h' }, { list });
    expect(built.request).toBeNull();
    expect(built.files).toEqual([]);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ planSlugs: ['p'], workItemIds: ['WI-1'], evidenceKinds: ['test', 'mutation'] }));
  });

  it('turns stale bindings into an ordinary evidence request over the exact test files', async () => {
    const list = vi.fn().mockResolvedValue([row(1, { currentness: sourceStale })]);
    const built = await buildTestEvidenceRemeasure({ workItemId: 'WI-1', planSlug: 'p' }, { harnessSlug: 'h' }, { list });
    expect(built.request).toEqual({ workItemId: 'WI-1', planSlug: 'p', bindings: [recipe('S-1', 'src/subject.test.ts')] });
    expect(built.files).toEqual(['src/subject.test.ts']);
  });
});

describe('retireRemeasuredPredecessors', () => {
  const scope = { workspaceId: 'ws', harnessSlug: 'h', actorId: 'su-x', root: '/r' };
  const prepared = [{ input: { planSlug: 'p', workItemId: 'WI-1', evidenceRef: 'test-run-group:new:0' } }] as never;
  const selected = planTestEvidenceRemeasure([row(10, { currentness: sourceStale }), row(9, { currentness: sourceStale })]).selected;

  it('retracts exactly the replaced predecessors once the fresh run is a current pass', async () => {
    const list = vi.fn().mockResolvedValue([row(20, { evidenceRef: 'test-run-group:new:0' })]);
    const retract = vi.fn().mockResolvedValue({ status: 'retracted' });
    const outcome = await retireRemeasuredPredecessors(selected, prepared, 'new', scope, { list, retract });
    expect(retract.mock.calls.map(([call]) => call.bindingId)).toEqual([9, 10]);
    expect(retract.mock.calls[0]![0].reason).toContain('superseded by re-measured binding 20');
    expect(outcome).toEqual([{ specId: 'S-1', testPath: 'src/subject.test.ts', replacementId: 20, retired: [9, 10] }]);
  });

  it('keeps every predecessor when the fresh run failed, so the clause stays honestly red', async () => {
    const list = vi.fn().mockResolvedValue([row(20, { evidenceRef: 'test-run-group:new:0', outcome: 'fail' })]);
    const retract = vi.fn();
    const outcome = await retireRemeasuredPredecessors(selected, prepared, 'new', scope, { list, retract });
    expect(retract).not.toHaveBeenCalled();
    expect(outcome[0]).toMatchObject({ retired: [], kept: [9, 10] });
  });

  it('keeps every predecessor when the fresh proof is itself already stale', async () => {
    const list = vi.fn().mockResolvedValue([row(20, { evidenceRef: 'test-run-group:new:0', currentness: sourceStale })]);
    const retract = vi.fn();
    await retireRemeasuredPredecessors(selected, prepared, 'new', scope, { list, retract });
    expect(retract).not.toHaveBeenCalled();
  });
});
