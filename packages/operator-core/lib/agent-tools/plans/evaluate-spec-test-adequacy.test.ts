import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../_harness-scope', async (original) => ({
  ...(await original<typeof import('../_harness-scope')>()),
  harnessScopedCtx: vi.fn((_harness: unknown, ctx: unknown) => ctx),
}));
vi.mock('./_ctx-opts', async (original) => ({
  ...(await original<typeof import('./_ctx-opts')>()),
  resolveEffectiveHarnessSlug: vi.fn(() => 'papercusp'),
}));
vi.mock('./spec-clauses-store', async (original) => ({
  ...(await original<typeof import('./spec-clauses-store')>()),
  listSpecClauses: vi.fn(),
}));
vi.mock('./spec-evidence-store', async (original) => ({
  ...(await original<typeof import('./spec-evidence-store')>()),
  listSpecEvidence: vi.fn(),
}));
vi.mock('../../build-info', () => ({
  getBuildInfo: vi.fn(() => ({ sha: 'live-evaluator-sha', version: '1.2.3' })),
}));

import tool from './evaluate-spec-test-adequacy';
import { listSpecClauses } from './spec-clauses-store';
import { listSpecEvidence } from './spec-evidence-store';

const listClauses = vi.mocked(listSpecClauses);
const listEvidence = vi.mocked(listSpecEvidence);

type ToolOutput = { data: Record<string, any> };

const call = async (args: Record<string, unknown>) =>
  ((await tool.handler(args as never, {} as never)) as ToolOutput).data;

const clause = (lifecycleStatus: 'draft' | 'active' | 'accepted' = 'draft') =>
  ({
    planSlug: 'plan-a',
    specId: 'SPEC-001',
    sourceValId: null,
    currentRevision: 1,
    revision: 1,
    planItemId: 'P-001',
    behavior: 'The selected behavior is observable.',
    behaviorClass: 'happy-path',
    requiredEvidence: ['integration'],
    requiredTestLayers: ['integration'],
    mutationRequired: false,
    lifecycleStatus,
    supersedes: null,
    exemption: null,
    falsifier: { observation: 'The selected behavior is absent.' },
    contentHash: 'sha256:spec-001',
    createdBy: 'su-test',
    createdAt: '2026-09-07T00:00:00.000Z',
    acceptedBy: lifecycleStatus === 'draft' ? null : 'reviewer',
    acceptedAt: lifecycleStatus === 'draft' ? null : '2026-09-07T00:01:00.000Z',
    acceptanceRef: lifecycleStatus === 'draft' ? null : 'D-001',
    sourceBar: null,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  listEvidence.mockResolvedValue([{ specId: 'SPEC-001' } as never]);
  listClauses.mockResolvedValue([clause()]);
});

describe('plans:evaluate-spec-test-adequacy handler', () => {
  it('refuses an explicit selection that matches only draft clauses', async () => {
    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'selection_empty',
      count: 0,
      selectedEvidenceCount: 1,
      matchedClauseCount: 1,
      eligibleClauseCount: 0,
      excludedClauses: [{ specId: 'SPEC-001', revision: 1, lifecycleStatus: 'draft' }],
    });
  });

  it('evaluates draft clauses only when the caller explicitly opts in', async () => {
    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
      includeDraft: true,
    });

    expect(result).toMatchObject({ ok: true, count: 1 });
    expect(result.rows).toHaveLength(1);
  });

  it('echoes the live evaluator build and reports drift for a pinned older replay', async () => {
    listClauses.mockResolvedValue([clause('active')]);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
      includeDraft: true,
      evaluatorBuild: { sha: 'repaired-evaluator-sha', version: '1.2.2' },
    });

    expect(result).toMatchObject({
      ok: true,
      evaluatorBuild: { sha: 'live-evaluator-sha', version: '1.2.3' },
      evaluatorBuildDrift: {
        recorded: { sha: 'repaired-evaluator-sha', version: '1.2.2' },
        live: { sha: 'live-evaluator-sha', version: '1.2.3' },
      },
    });
  });

  it('does not report evaluator drift when the replay pin matches the live build', async () => {
    listClauses.mockResolvedValue([clause('active')]);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
      includeDraft: true,
      evaluatorBuild: { sha: 'live-evaluator-sha', version: '1.2.3' },
    });

    expect(result).toMatchObject({
      ok: true,
      evaluatorBuild: { sha: 'live-evaluator-sha', version: '1.2.3' },
    });
    expect(result).not.toHaveProperty('evaluatorBuildDrift');
  });

  it('preserves exact work-item, evidence-ref, and plan-item selectors in the emitted rerun recipe', async () => {
    const evidenceRefs = ['testing:run:current#packages/operator-core/lib/reconnect.test.ts'];
    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      workItemIds: ['WI-123'],
      evidenceRefs,
      planItemIds: ['P-001'],
      includeDraft: true,
    });

    expect(result).toMatchObject({ ok: true, count: 1 });
    expect(result.rows[0].scorecardDraft.rerunRecipe.args).toMatchObject({
      workItemIds: ['WI-123'],
      evidenceRefs,
      planItemIds: ['P-001'],
    });
    expect(listEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ workItemIds: ['WI-123'], evidenceRefs }),
    );
    expect(listClauses).toHaveBeenCalledWith(expect.objectContaining({ planItemIds: ['P-001'] }));
  });

  it('refuses an evidence-ref selector that matches no immutable binding', async () => {
    listEvidence.mockResolvedValue([]);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      evidenceRefs: ['testing:run:superseded'],
      includeDraft: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'selection_empty',
      selectedEvidenceCount: 0,
      selection: { evidenceRefs: ['testing:run:superseded'] },
      remedy: expect.stringContaining('No exact evidence binding matches'),
    });
    expect(listClauses).not.toHaveBeenCalled();
  });

  it('accepts the persisted rerunRecipe.current wrapper and normalizes it to current[]', async () => {
    const current = [
      {
        evidenceKind: 'test',
        evidenceRef: 'packages/operator-core/lib/reconnect.test.ts#reconnect',
        sourceFingerprint: 'git:abc',
        testFingerprint: 'sha256:test',
        fixtureFingerprint: null,
        rubricFingerprint: null,
        environmentFingerprint: null,
      },
    ];
    listEvidence.mockResolvedValue([]);
    listClauses.mockResolvedValue([clause('active')]);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
      includeDraft: true,
      current: { supplied: true, fingerprints: current },
    });

    expect(result).toMatchObject({ ok: true, count: 1 });
    expect(listEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ current }),
    );
  });

  it('marks a pinned replay snapshot as server-measured when forwarding its current tuple', async () => {
    const current = [
      {
        evidenceKind: 'test',
        evidenceRef: 'packages/operator-core/lib/reconnect.test.ts#reconnect',
        sourceFingerprint: 'git:abc',
        testFingerprint: 'sha256:test',
        fixtureFingerprint: null,
        rubricFingerprint: null,
        environmentFingerprint: null,
      },
    ];

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
      specRevision: 1,
      specFingerprint: 'sha256:spec-001',
      replaySnapshot: true,
      includeDraft: true,
      current: { supplied: true, fingerprints: current },
    });

    expect(result).toMatchObject({ ok: true, count: 1 });
    expect(listEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        specRevision: 1,
        specFingerprint: 'sha256:spec-001',
        replaySnapshot: true,
        current,
        currentProvenance: 'server-measured',
      }),
    );
  });

  it.each(['newest-first', 'oldest-first'])('pins the latest logical binding measurement in a replay (%s)', async (order) => {
    listClauses.mockResolvedValue([clause('active')]);
    const binding = (id: number, sourceFingerprint: string) => ({
      id,
      workItemId: 'WI-123',
      planSlug: 'plan-a',
      specId: 'SPEC-001',
      specRevision: 1,
      specFingerprint: 'sha256:spec-001',
      evidenceKind: 'test',
      evidenceRef: 'packages/operator-core/lib/reconnect.test.ts#reconnect',
      fingerprints: {
        sourceFingerprint,
        testFingerprint: 'sha256:test',
        fixtureFingerprint: null,
        rubricFingerprint: null,
        environmentFingerprint: null,
      },
      coverageEvidenceRef: null,
      testRunId: 42,
      details: { adequacy: { falsifiable: true, testLayer: 'integration', outcome: 'pass', executed: true } },
      createdAt: `2026-09-07T00:0${id}:00.000Z`,
      currentness: { overall: 'current', provenance: 'server-measured', staleReasons: [], unknownReasons: [] },
      serverMeasurement: {
        status: 'measured',
        current: {
          evidenceKind: 'test',
          evidenceRef: 'packages/operator-core/lib/reconnect.test.ts#reconnect',
          sourceFingerprint,
          testFingerprint: 'sha256:test',
        },
      },
    });
    const rows = [
      binding(2, 'sha256:latest-recipe'),
      binding(1, 'sha256:obsolete-recipe'),
      { ...binding(3, 'sha256:other-clause'), specId: 'SPEC-OTHER' },
    ];
    listEvidence.mockResolvedValue(
      (order === 'newest-first' ? rows : [...rows].reverse()) as Awaited<ReturnType<typeof listSpecEvidence>>,
    );

    const result = await call({
      harness: 'papercusp', slug: 'plan-a', classRef: 'plan-class-feature-ship',
      workItemIds: ['WI-123'], specIds: ['SPEC-001'],
    });
    expect(result.rows[0].ratings.freshness.rating).toBe('pass');
    const recipe = result.rows[0].scorecardDraft.rerunRecipe;
    expect(recipe.current.fingerprints).toHaveLength(1);
    expect(recipe.args.current).toEqual(recipe.current.fingerprints);
    expect(recipe.current.fingerprints[0].sourceFingerprint).toBe('sha256:latest-recipe');
  });

  it('keeps an unfiltered plan with no eligible clauses as a valid empty read', async () => {
    listEvidence.mockResolvedValue([]);
    listClauses.mockResolvedValue([]);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
    });

    expect(result).toMatchObject({ ok: true, rows: [], count: 0 });
  });

  it('refuses a work-item selection with no exact evidence edge', async () => {
    listEvidence.mockResolvedValue([]);
    listClauses.mockResolvedValue([clause('active')]);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      workItemIds: ['WI-missing'],
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'selection_empty',
      selectedEvidenceCount: 0,
      remedy: expect.stringContaining('No exact evidence edge'),
    });
    expect(listClauses).not.toHaveBeenCalled();
  });
});
