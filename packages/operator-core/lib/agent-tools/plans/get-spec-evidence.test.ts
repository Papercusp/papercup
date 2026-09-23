/**
 * plans:get-spec-evidence — compact by default (review-system-rework-reduction-2026-09-23
 * P-007, clause RSR-P-007-A). Falsifier: the default response carries the full body, or
 * omits the ref to it. Probe: call the read with and without detail:'full' and compare
 * shape and size.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../_harness-scope', async (original) => ({
  ...(await original<typeof import('../_harness-scope')>()),
  harnessScopedCtx: vi.fn((_harness: unknown, ctx: unknown) => ctx),
}));
vi.mock('./_ctx-opts', async (original) => ({
  ...(await original<typeof import('./_ctx-opts')>()),
  resolveEffectiveHarnessSlug: vi.fn(() => 'papercusp'),
}));
vi.mock('./spec-evidence-store', async (original) => ({
  ...(await original<typeof import('./spec-evidence-store')>()),
  listSpecEvidence: vi.fn(),
}));

import tool from './get-spec-evidence';
import { listSpecEvidence } from './spec-evidence-store';
import { mockResolvedTyped } from '../../testing/typed-mock';

const listEvidence = vi.mocked(listSpecEvidence);
type EvidenceRow = Awaited<ReturnType<typeof listSpecEvidence>>[number];

const call = async (args: Record<string, unknown>) =>
  ((await tool.handler(tool.args.parse(args) as never, {} as never)) as { data: Record<string, any> }).data;

const binding = (id: number, specId: string, overall: 'current' | 'stale' | 'unknown'): EvidenceRow => ({
  id,
  workItemId: 'WI-1',
  planSlug: 'plan-a',
  specId,
  sourceValId: null,
  specRevision: 1,
  currentRevision: 1,
  specFingerprint: `sha256:${specId}`,
  evidenceKind: 'test',
  evidenceRef: `testing:run:${id}#packages/x.test.ts`,
  fingerprints: {
    sourceFingerprint: `sha256-file-set-v1:${'a'.repeat(64)}`,
    testFingerprint: `sha256-file-set-v1:${'b'.repeat(64)}`,
    fixtureFingerprint: null,
    rubricFingerprint: null,
    environmentFingerprint: null,
  },
  coverageEvidenceRef: null,
  testRunId: 1000 + id,
  observedAt: '2026-09-23T00:00:00.000Z',
  bindingFingerprint: `sha256:binding-${id}`,
  createdBy: 'su-binder',
  createdAt: '2026-09-23T00:00:01.000Z',
  details: {
    adequacy: { collected: true, skipped: false, executed: true, outcome: 'passed', coverageRungs: { l3: true } },
    observations: 'x'.repeat(600),
    currentMeasurement: { schemaVersion: 1, kind: 'repo-files', sourcePaths: ['src/a.ts'], testPaths: ['test/a.test.ts'] },
  },
  currentness: {
    comparisonSupplied: true,
    provenance: 'server-measured',
    overall,
    dimensions: {
      spec: 'current', source: overall, test: 'current', fixture: 'not-applicable', rubric: 'not-applicable',
      environment: 'not-applicable', coverageEvidence: 'not-applicable', testRun: 'current',
    },
    staleReasons: overall === 'stale' ? ['source_fingerprint_mismatch'] : [],
    unknownReasons: overall === 'unknown' ? ['current-fingerprints-missing'] : [],
  },
  serverMeasurement: {
    status: 'measured',
    measuredDimensions: ['source', 'test'],
    current: {
      planSlug: 'plan-a',
      specId,
      specRevision: 1,
      specFingerprint: `sha256:${specId}`,
      evidenceKind: 'test',
      evidenceRef: `testing:run:${id}#packages/x.test.ts`,
      sourceFingerprint: `sha256-file-set-v1:${'a'.repeat(64)}`,
      testFingerprint: `sha256-file-set-v1:${'b'.repeat(64)}`,
    },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockResolvedTyped(listEvidence, [
    binding(1, 'SPEC-A', 'current'),
    binding(2, 'SPEC-A', 'stale'),
    binding(3, 'SPEC-B', 'unknown'),
  ]);
});

describe('plans:get-spec-evidence detail levels', () => {
  it('returns a per-binding currentness table, a byClause rollup and a fullBody ref by default', async () => {
    const summary = await call({ harness: 'papercusp', slug: 'plan-a' });
    const full = await call({ harness: 'papercusp', slug: 'plan-a', detail: 'full' });

    expect(summary).toMatchObject({
      ok: true,
      detail: 'summary',
      count: 3,
      bounded: { limit: 200, truncatedByLimit: false },
      currentness: { current: 1, stale: 1, unknown: 1 },
      fullBody: {
        tool: 'plans:get-spec-evidence',
        args: { harness: 'papercusp', slug: 'plan-a', detail: 'full' },
        omitted: expect.arrayContaining(['evidence[].fingerprints', 'evidence[].details']),
      },
    });
    expect(summary.byClause).toEqual([
      { specId: 'SPEC-A', specRevision: 1, bindings: 2, current: 1, stale: 1, unknown: 0 },
      { specId: 'SPEC-B', specRevision: 1, bindings: 1, current: 0, stale: 0, unknown: 1 },
    ]);
    expect(summary.evidence[1]).toEqual({
      id: 2,
      workItemId: 'WI-1',
      specId: 'SPEC-A',
      specRevision: 1,
      evidenceKind: 'test',
      evidenceRef: 'testing:run:2#packages/x.test.ts',
      testRunId: 1002,
      currentness: { overall: 'stale', staleReasons: ['source_fingerprint_mismatch'], unknownReasons: [] },
    });

    // Full: every binding as stored, and no ref.
    expect(full).toMatchObject({ ok: true, detail: 'full', count: 3 });
    expect(full).not.toHaveProperty('fullBody');
    expect(full.evidence[0]).toHaveProperty('fingerprints');
    expect(full.evidence[0]).toHaveProperty('details');
    expect(full.evidence[0].currentness).toHaveProperty('dimensions');

    // The selector never reaches the store as a filter.
    expect(listEvidence).toHaveBeenCalledWith(expect.not.objectContaining({ detail: expect.anything() }));
    expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(full).length / 2);
  });

  it('reports when a limited read omits rows from the aggregate population', async () => {
    const population = [
      binding(1, 'SPEC-A', 'current'),
      binding(2, 'SPEC-A', 'stale'),
      binding(3, 'SPEC-A', 'unknown'),
      binding(4, 'SPEC-B', 'current'),
    ];
    listEvidence.mockImplementation(async (options) => population.slice(0, options.limit ?? 200));

    const result = await call({ harness: 'papercusp', slug: 'plan-a', limit: 3 });

    expect(listEvidence).toHaveBeenCalledWith(expect.objectContaining({
      limit: 4,
      planSlugs: ['plan-a'],
    }));
    expect(result).toMatchObject({
      count: 3,
      bounded: { limit: 3, truncatedByLimit: true },
      byClause: [{ specId: 'SPEC-A', specRevision: 1, bindings: 3, current: 1, stale: 1, unknown: 1 }],
    });
    expect(result.evidence).toHaveLength(3);
  });
});
