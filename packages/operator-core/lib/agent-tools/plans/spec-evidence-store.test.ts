import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

import {
  classifySpecEvidenceCurrentness,
  listSpecEvidence,
  measureRepoFilesEvidenceAtRoot,
} from './spec-evidence-store';

let measurementRoot = '';

beforeAll(async () => {
  measurementRoot = await mkdtemp(join(tmpdir(), 'spec-evidence-measurement-'));
  await Promise.all([
    mkdir(join(measurementRoot, 'src'), { recursive: true }),
    mkdir(join(measurementRoot, 'test'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(measurementRoot, 'src', 'feature.ts'), 'export const value = 1;\n'),
    writeFile(join(measurementRoot, 'test', 'feature.test.ts'), 'expect(value).toBe(1);\n'),
  ]);
});

afterAll(async () => {
  await rm(measurementRoot, { recursive: true, force: true });
});

describe('repo-backed server measurement', () => {
  it('hashes normalized source/test file sets deterministically and detects a source change', async () => {
    const recipe = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: ['src/feature.ts'],
      testPaths: ['test/feature.test.ts'],
    };
    const first = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    const replay = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    expect(replay).toEqual(first);
    expect(first.sourceFingerprint).toMatch(/^sha256-file-set-v1:[0-9a-f]{64}$/);
    expect(first.testFingerprint).toMatch(/^sha256-file-set-v1:[0-9a-f]{64}$/);

    await writeFile(join(measurementRoot, 'src', 'feature.ts'), 'export const value = 2;\n');
    const changed = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    expect(changed.sourceFingerprint).not.toBe(first.sourceFingerprint);
    expect(changed.testFingerprint).toBe(first.testFingerprint);
  });

  it('rejects traversal and symlink escapes before reading bytes', async () => {
    await expect(
      measureRepoFilesEvidenceAtRoot(measurementRoot, {
        schemaVersion: 1,
        kind: 'repo-files',
        sourcePaths: ['../outside.ts'],
      }),
    ).rejects.toThrow(/normalized repo-relative POSIX/);
  });
});

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

  it('keeps mixed server and caller comparisons explicit instead of laundering opaque dimensions', () => {
    const currentness = classifySpecEvidenceCurrentness(
      {
        spec_is_current: true,
        source_fingerprint: 'git:one',
        test_fingerprint: 'sha256:test',
        fixture_fingerprint: null,
        rubric_fingerprint: 'sha256:rubric',
        environment_fingerprint: 'node:24',
        coverage_evidence_ref: null,
        coverage_evidence_present: false,
        test_run_id: null,
        test_run_present: false,
      },
      {
        evidenceKind: 'test',
        evidenceRef: 'vitest:mixed',
        sourceFingerprint: 'git:one',
        testFingerprint: 'sha256:test',
        rubricFingerprint: 'sha256:rubric',
        environmentFingerprint: 'node:24',
      },
      { provenance: 'server-measured', attestedDimensions: ['rubric', 'environment'] },
    );

    expect(currentness).toMatchObject({
      overall: 'unknown',
      provenance: 'partially-server-measured',
      dimensions: { source: 'current', test: 'current', rubric: 'current', environment: 'current' },
      staleReasons: [],
      unknownReasons: [
        'current-fingerprints-partially-attested-not-independently-measured:environment,rubric',
      ],
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
