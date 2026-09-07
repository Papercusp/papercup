import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  scorecardRows: [] as Array<Record<string, unknown>>,
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: unknown) => Promise<T>) => {
      const tx = ((strings: TemplateStringsArray | string[]) => {
        const sql = Array.from(strings).join(' ');
        return Promise.resolve(sql.includes('provisional') ? h.scorecardRows : h.rows);
      }) as unknown;
      return fn(tx);
    },
  };
});

vi.mock('./source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./source')>();
  return {
    ...actual,
    resolvePlanScope: async () => ({ workspaceId: 'workspace-test', harnessSlug: 'papercusp' }),
  };
});

import { classifySpecEvidenceCurrentness, listSpecEvidence } from './spec-evidence-store';

describe('classifySpecEvidenceCurrentness exact current comparisons', () => {
  it('treats a complete byte-identical server-measured fingerprint set as current', () => {
    const currentness = classifySpecEvidenceCurrentness(
      {
        spec_is_current: true,
        source_fingerprint: 'git:one',
        test_fingerprint: 'sha256:test',
        fixture_fingerprint: null,
        rubric_fingerprint: null,
        environment_fingerprint: null,
        coverage_evidence_ref: null,
        coverage_evidence_present: false,
        test_run_id: null,
        test_run_present: false,
      },
      {
        evidenceKind: 'test',
        evidenceRef: 'vitest:one',
        sourceFingerprint: 'git:one',
        testFingerprint: 'sha256:test',
      },
      { provenance: 'server-measured' },
    );

    expect(currentness).toMatchObject({
      overall: 'current',
      dimensions: {
        spec: 'current',
        source: 'current',
        test: 'current',
        fixture: 'not-applicable',
      },
      staleReasons: [],
      unknownReasons: [],
      comparisonSupplied: true,
      provenance: 'server-measured',
    });
  });

  it('labels an echoed caller fingerprint set attested-current and caps aggregate freshness at unknown', () => {
    const currentness = classifySpecEvidenceCurrentness(
      {
        spec_is_current: true,
        source_fingerprint: 'git:one',
        test_fingerprint: 'sha256:test',
        fixture_fingerprint: null,
        rubric_fingerprint: null,
        environment_fingerprint: null,
        coverage_evidence_ref: null,
        coverage_evidence_present: false,
        test_run_id: null,
        test_run_present: false,
      },
      {
        evidenceKind: 'test',
        evidenceRef: 'vitest:one',
        sourceFingerprint: 'git:one',
        testFingerprint: 'sha256:test',
      },
    );

    expect(currentness).toMatchObject({
      overall: 'unknown',
      provenance: 'attested-current',
      dimensions: { source: 'current', test: 'current' },
      unknownReasons: ['current-fingerprints-attested-not-independently-measured'],
      comparisonSupplied: true,
    });
  });
});

describe('listSpecEvidence timestamp normalization', () => {
  beforeEach(() => {
    h.rows = [];
    h.scorecardRows = [];
  });

  it('accepts PostgreSQL timestamp strings instead of assuming Date instances', async () => {
    h.rows = [
      {
        id: 1,
        work_item_id: 'WI-1',
        plan_slug: 'plan-one',
        spec_id: 'SPEC-001-01',
        source_val_id: 'VAL-001-01',
        spec_revision: 1,
        current_revision: 1,
        spec_fingerprint: 'sha256:spec',
        evidence_kind: 'test',
        evidence_ref: 'vitest:one',
        source_fingerprint: 'git:one',
        test_fingerprint: 'sha256:test',
        fixture_fingerprint: null,
        rubric_fingerprint: null,
        environment_fingerprint: null,
        coverage_evidence_ref: null,
        coverage_evidence_present: false,
        test_run_id: null,
        test_run_present: false,
        details: {},
        observed_at: '2026-08-20 17:10:00-04',
        binding_fingerprint: 'sha256:binding',
        created_by: 'su-test',
        created_at: '2026-08-20T21:10:01.000Z',
        spec_is_current: true,
      },
    ];

    const [row] = await listSpecEvidence({
      harnessSlug: 'papercusp',
      planSlugs: ['plan-one'],
      current: [
        {
          evidenceKind: 'test',
          evidenceRef: 'vitest:one',
          sourceFingerprint: 'git:one',
          testFingerprint: 'sha256:test',
        },
      ],
    });

    expect(row).toMatchObject({
      observedAt: '2026-08-20T21:10:00.000Z',
      createdAt: '2026-08-20T21:10:01.000Z',
      currentness: {
        overall: 'unknown',
        provenance: 'attested-current',
        unknownReasons: ['current-fingerprints-attested-not-independently-measured'],
      },
    });
  });

  it('surfaces provisional scorecard proof bases on the returned binding row', async () => {
    h.rows = [
      {
        id: 2,
        work_item_id: 'WI-2',
        plan_slug: 'plan-one',
        spec_id: 'SPEC-001-01',
        source_val_id: 'VAL-001-01',
        spec_revision: 1,
        current_revision: 1,
        spec_fingerprint: 'sha256:spec',
        evidence_kind: 'manual',
        evidence_ref: 'scorecard:EI-123#matched-window',
        source_fingerprint: 'git:one',
        test_fingerprint: null,
        fixture_fingerprint: null,
        rubric_fingerprint: null,
        environment_fingerprint: null,
        coverage_evidence_ref: null,
        coverage_evidence_present: false,
        test_run_id: null,
        test_run_present: false,
        details: { adequacy: { collected: true } },
        observed_at: '2026-08-20 17:10:00-04',
        binding_fingerprint: 'sha256:binding',
        created_by: 'su-test',
        created_at: '2026-08-20T21:10:01.000Z',
        spec_is_current: true,
      },
    ];
    h.scorecardRows = [
      {
        feature_id: 'EI-123',
        provisional: {
          stampedAt: '2026-08-20T17:09:00.000Z',
          violatableKeys: ['criterion-a'],
        },
      },
    ];

    const [row] = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] });

    expect(row).toMatchObject({
      provisionalProofBase: true,
      provisionalScorecard: {
        issueId: 'EI-123',
        stampedAt: '2026-08-20T17:09:00.000Z',
        violatableKeys: ['criterion-a'],
      },
      details: {
        provisionalProofBase: true,
        provisionalScorecard: { issueId: 'EI-123' },
      },
    });
  });
});
