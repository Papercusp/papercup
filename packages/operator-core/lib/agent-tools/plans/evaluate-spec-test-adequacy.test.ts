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
