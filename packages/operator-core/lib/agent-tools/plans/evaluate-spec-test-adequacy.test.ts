import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockResolvedTyped } from '../../testing/typed-mock';
import {
  dispatchProjectedTool,
  lookupByMcpName,
  readJsonResult,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';

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

const makeDispatchContext = (): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'default',
  runId: 'spec-test-adequacy-dispatch-test',
  isSuperuser: true,
  uiClientId: 'su-spec-test-adequacy-test',
  role: 'su',
  gateBypass: { role: true, capability: true, quota: true },
  transport: 'mcp',
  requestedFormat: 'json',
  contextTier: 'trimmed',
  tx: {},
});

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
  }) as unknown as Awaited<ReturnType<typeof listSpecClauses>>[number];

beforeEach(() => {
  vi.clearAllMocks();
  listEvidence.mockResolvedValue([{ specId: 'SPEC-001' } as never]);
  listClauses.mockResolvedValue([clause()]);
});

describe('plans:evaluate-spec-test-adequacy handler', () => {
  it('preserves every criterion rating through a trimmed MCP dispatch', async () => {
    listClauses.mockResolvedValue([clause('active')]);
    const args = {
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
    };
    const direct = await call(args);
    const expectedKeys = Object.keys(direct.rows[0].ratings);
    expect(expectedKeys).toHaveLength(9);

    const projected = lookupByMcpName('plans:evaluate-spec-test-adequacy');
    expect(projected?.ignoreSessionPayloadTier).toBe(true);
    const dispatched = await dispatchProjectedTool(
      projected!,
      'plans:evaluate-spec-test-adequacy',
      args,
      makeDispatchContext(),
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const payload = readJsonResult<{ rows: Array<{ ratings: Record<string, unknown> }> }>(dispatched.result!);
    if (!payload) throw new Error('evaluator dispatch should return JSON');
    expect(Object.keys(payload.rows[0].ratings)).toEqual(expectedKeys);
    expect(payload.rows[0].ratings).not.toHaveProperty('_partial');
  });

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

  it('marks draft clauses excluded from successful reads, including an empty exclusion', async () => {
    listClauses.mockResolvedValue([
      clause('active'),
      { ...clause('draft'), specId: 'SPEC-DRAFT', planItemId: 'P-002' } as never,
    ]);

    const base = {
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
    };
    const mixed = await call(base);

    expect(mixed).toMatchObject({
      ok: true,
      count: 1,
      includeDraft: false,
      excludedDraftCount: 1,
      excludedDraftSpecIds: ['SPEC-DRAFT'],
      excludedClauses: [{ specId: 'SPEC-DRAFT', revision: 1, lifecycleStatus: 'draft' }],
    });

    listClauses.mockResolvedValue([clause('active')]);
    const none = await call(base);

    expect(none).toMatchObject({
      ok: true,
      includeDraft: false,
      excludedDraftCount: 0,
      excludedDraftSpecIds: [],
      excludedClauses: [],
    });

    listClauses.mockResolvedValue([
      clause('active'),
      { ...clause('draft'), specId: 'SPEC-DRAFT', planItemId: 'P-002' } as never,
    ]);
    const included = await call({ ...base, includeDraft: true });

    expect(included).toMatchObject({
      ok: true,
      count: 2,
      includeDraft: true,
      excludedDraftCount: 0,
      excludedDraftSpecIds: [],
      excludedClauses: [],
    });
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

  // review-system-rework-reduction-2026-09-23 P-007, clause RSR-P-007-A: a verdict table
  // plus a ref by default; the full body only on request. Falsifier: the default response
  // carries the full body, or omits the ref to it.
  it('returns a per-clause verdict table plus a fullBody ref by default, and the full body only with detail:"full"', async () => {
    listClauses.mockResolvedValue([clause('active')]);
    const base = { harness: 'papercusp', slug: 'plan-a', classRef: 'plan-class-feature-ship', specIds: ['SPEC-001'] };

    const summary = await call(base);
    const full = await call({ ...base, detail: 'full' });

    // Default: the table, and the exact re-call that returns the rest.
    expect(summary).toMatchObject({ ok: true, detail: 'summary' });
    expect(summary.fullBody).toMatchObject({
      tool: 'plans:evaluate-spec-test-adequacy',
      args: { ...base, detail: 'full' },
      omitted: expect.arrayContaining(['rows[].scorecardDraft', 'rows[].ratings[].evidence']),
    });
    const [compact] = summary.rows;
    expect(compact).not.toHaveProperty('scorecardDraft');
    expect(compact).not.toHaveProperty('evidenceRefs');
    for (const entry of Object.values(compact.ratings) as Array<Record<string, unknown>>) {
      expect(entry).not.toHaveProperty('evidence');
    }

    // Full: the drafts and evidence text, and no ref (there is nothing left to fetch).
    expect(full).toMatchObject({ ok: true, detail: 'full' });
    expect(full).not.toHaveProperty('fullBody');
    expect(full.rows[0].scorecardDraft).toBeTruthy();
    expect(Object.values(full.rows[0].ratings).every((r: any) => typeof r.evidence === 'string')).toBe(true);

    // Same verdicts either way — the summary drops prose, never a rating the replay gates read.
    expect(compact).toMatchObject({
      specId: full.rows[0].specId,
      specRevision: full.rows[0].specRevision,
      specFingerprint: full.rows[0].specFingerprint,
      verdict: full.rows[0].verdict,
      wouldBlock: full.rows[0].wouldBlock,
    });
    for (const [criterion, entry] of Object.entries(full.rows[0].ratings) as Array<[string, { rating: string }]>) {
      expect(compact.ratings[criterion].rating).toBe(entry.rating);
    }

    // And it is materially smaller.
    expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(full).length / 2);
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
      detail: 'full',
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

  it('records exact binding ids in the replay recipe, including repeated evidence refs', async () => {
    const evidenceRef = 'packages/operator-core/lib/reconnect.test.ts#reconnect';
    // A repeated reference can name separate active bindings when their evidence kinds differ.
    const evidence: Awaited<ReturnType<typeof listSpecEvidence>> = [
      { id: 18924, evidenceKind: 'test' as const, evidenceRef },
      { id: 18874, evidenceKind: 'fixture' as const, evidenceRef },
      { id: 18875, evidenceKind: 'coverage-census' as const, evidenceRef },
    ].map((row): Awaited<ReturnType<typeof listSpecEvidence>>[number] => ({
      ...row,
      workItemId: 'WI-123',
      planSlug: 'plan-a',
      specId: 'SPEC-001',
      sourceValId: null,
      specRevision: 1,
      currentRevision: 1,
      specFingerprint: 'sha256:spec-001',
      fingerprints: {
        sourceFingerprint: 'git:abc',
        testFingerprint: 'sha256:test',
        fixtureFingerprint: null,
        rubricFingerprint: null,
        environmentFingerprint: null,
      },
      coverageEvidenceRef: null,
      testRunId: null,
      testRunProvenance: null,
      details: {},
      observedAt: '2026-10-01T12:00:00Z',
      bindingFingerprint: 'sha256:binding',
      createdBy: 'su-test',
      createdAt: '2026-10-01T12:00:00Z',
      currentness: {
        comparisonSupplied: true,
        provenance: 'server-measured',
        overall: 'current',
        dimensions: {
          spec: 'current',
          source: 'current',
          test: 'current',
          fixture: 'current',
          rubric: 'current',
          environment: 'current',
          coverageEvidence: 'current',
          testRun: 'current',
        },
        staleReasons: [],
        unknownReasons: [],
      },
    }));
    listClauses.mockResolvedValue([clause('active')]);
    mockResolvedTyped(listEvidence, evidence);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
      detail: 'full',
    });

    expect(result).toMatchObject({ ok: true, count: 1 });
    expect(result.rows[0].scorecardDraft.rerunRecipe).toMatchObject({
      args: { bindingIds: [18874, 18875, 18924] },
      selection: { bindingIds: [18874, 18875, 18924] },
    });
  });

  // acceptance-machinery-seam-fixes-2026-09-16 P-001 (R-1): the number that misled a careful
  // reader on 2026-09-16 was a pinned-cohort "pass 7/0/0" quoted as if it were the ship
  // verdict, while the unscoped gate said 1/7. The label must ride on the result itself.
  it('labels a pinned evidence cohort (evidenceRefs/workItemIds) as NON-governing and an unscoped read as governing', async () => {
    listClauses.mockResolvedValue([clause('active')]);
    listEvidence.mockResolvedValue([{ specId: 'SPEC-001' } as never]);

    const pinnedByRef = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      evidenceRefs: ['test-run:1:spec-001'],
    });
    expect(pinnedByRef).toMatchObject({ ok: true, governing: false });
    expect(String(pinnedByRef.governingNote)).toMatch(/DIAGNOSTIC READ/);
    expect(String(pinnedByRef.governingNote)).toMatch(/shipReadiness/);

    const pinnedByWorkItem = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      workItemIds: ['WI-123'],
    });
    expect(pinnedByWorkItem).toMatchObject({ ok: true, governing: false });

    // specIds / planItemIds narrow WHICH clauses are read, not the evidence cohort of a
    // clause, so they stay governing — the gate grades the same bindings per clause.
    const unscoped = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-001'],
    });
    expect(unscoped).toMatchObject({ ok: true, governing: true });
    expect(unscoped.governingNote).toBeUndefined();
  });

  it('persists non-governing scope and evaluator-build drift on every scorecardDraft criterion', async () => {
    listClauses.mockResolvedValue([clause('active')]);
    listEvidence.mockResolvedValue([{ specId: 'SPEC-001' } as never]);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
      evidenceRefs: ['test-run:1:spec-001'],
      evaluatorBuild: { sha: 'recorded-evaluator-sha', version: '1.2.2' },
      detail: 'full',
    });

    expect(result).toMatchObject({
      ok: true,
      governing: false,
      evaluatorBuildDrift: {
        recorded: { sha: 'recorded-evaluator-sha', version: '1.2.2' },
        live: { sha: 'live-evaluator-sha', version: '1.2.3' },
      },
    });
    const criteria = Object.values(result.rows[0].scorecardDraft.ratings) as Array<{ evidence: string }>;
    expect(criteria).toHaveLength(9);
    for (const criterion of criteria) {
      expect(criterion.evidence).toContain('DIAGNOSTIC READ');
      expect(criterion.evidence).toContain('EVALUATOR BUILD DRIFT');
      expect(criterion.evidence).toContain('recorded-evaluator-sha');
      expect(criterion.evidence).toContain('live-evaluator-sha');
    }
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
      remedy: expect.stringContaining('No current evidence binding matches'),
    });
    expect(result.remedy).toContain('absent, retracted, or superseded');
    expect(result.remedy).toContain('pass specIds without a binding selector');
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

  it('marks a pinned replay snapshot as replayed-snapshot, never server-measured, when forwarding its current tuple', async () => {
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
        // The replay path performs NO server measurement, so the forwarded tuple is
        // caller-supplied. It must be labelled as a replay, never as server proof.
        currentProvenance: 'replayed-snapshot',
      }),
    );
  });

  it('documents and enforces the immutable clause pins required for replay snapshots', () => {
    const baseArgs = {
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
    };
    const result = tool.args.safeParse({ ...baseArgs, replaySnapshot: true });

    if (result.success) throw new Error('Expected replaySnapshot without immutable pins to be rejected');
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      'replaySnapshot requires specRevision and specFingerprint',
    );
    expect(tool.args.shape.replaySnapshot.description).toMatch(
      /requires both specRevision and specFingerprint from the same immutable clause revision/i,
    );
    expect(tool.args.shape.specRevision.description).toMatch(/required when replaySnapshot is true/i);
    expect(tool.args.shape.specFingerprint.description).toMatch(/required when replaySnapshot is true/i);
    expect(tool.description).toContain(
      'When replaySnapshot is true, include both specRevision and specFingerprint',
    );

    expect(tool.args.safeParse(baseArgs).success).toBe(true);
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
      (order === 'newest-first' ? rows : [...rows].reverse()) as unknown as Awaited<ReturnType<typeof listSpecEvidence>>,
    );

    const result = await call({
      harness: 'papercusp', slug: 'plan-a', classRef: 'plan-class-feature-ship',
      workItemIds: ['WI-123'], specIds: ['SPEC-001'], detail: 'full',
    });
    expect(result.rows[0].ratings.freshness.rating).toBe('pass');
    const recipe = result.rows[0].scorecardDraft.rerunRecipe;
    expect(recipe.current.fingerprints).toHaveLength(1);
    expect(recipe.args.current).toEqual(recipe.current.fingerprints);
    expect(recipe.current.fingerprints[0].sourceFingerprint).toBe('sha256:latest-recipe');
  });

  // Renamed from 'no eligible clauses' (EI-23420771213407749): this mocks ZERO clauses, which
  // is a true statement about an empty set. The clauses-exist-but-none-eligible case it was
  // read as covering is the very false green the next test pins, so keep the pair adjacent.
  it('keeps an unfiltered plan with NO CLAUSES AT ALL as a valid empty read', async () => {
    listEvidence.mockResolvedValue([]);
    listClauses.mockResolvedValue([]);

    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
    });

    expect(result).toMatchObject({ ok: true, rows: [], count: 0 });
  });

  it('refuses an UNSELECTED read whose clauses all exist but are filtered out (EI-23420771213407749)', async () => {
    listEvidence.mockResolvedValue([]);
    listClauses.mockResolvedValue([clause('draft')]);

    // No specIds/workItemIds/evidenceRefs/planItemIds and no includeDraft — the exact call the
    // ship gate's remedy text tells an agent to make first. Before the fix this returned
    // { ok:true, rows:[], count:0, wouldBlock:[] }: a zero-work false green whose empty output
    // is indistinguishable from a clean verdict, landing where it is most trusted.
    const result = await call({
      harness: 'papercusp',
      slug: 'plan-a',
      classRef: 'plan-class-feature-ship',
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'selection_empty',
      matchedClauseCount: 1,
      eligibleClauseCount: 0,
      excludedClauses: [{ specId: 'SPEC-001', revision: 1, lifecycleStatus: 'draft' }],
    });
    expect(result.remedy).toContain('includeDraft:true');
    expect(result.remedy).toContain('NOT a clean adequacy result');
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
      remedy: expect.stringContaining('No current evidence edge'),
    });
    expect(result.remedy).toContain('proof may have been retracted or superseded');
    expect(listClauses).not.toHaveBeenCalled();
  });
});
