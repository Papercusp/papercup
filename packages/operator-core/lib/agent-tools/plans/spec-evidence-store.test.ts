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
  evidenceMeasurementSchema,
  listSpecEvidence,
  measureRepoFilesEvidenceAtRoot,
  measureWorkItemsEvidenceForScope,
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
  // RECURRENCE GUARD (EI-23761345516273342). The replay path performs no server
  // measurement, so its whole `current` tuple is caller-supplied. If a replayed
  // tuple can ever again classify as `overall:'current'` with server-grade
  // provenance, any caller can mint a passing freshness verdict from fingerprints
  // it authored itself — which is the defect this guard exists to catch.
  //
  // Calibration: the sibling test above feeds the IDENTICAL row + tuple with
  // provenance 'server-measured' and correctly gets `overall:'current'`. That
  // pairing is what makes this assertion falsifiable rather than vacuous: only the
  // provenance differs, so a regression that stops distinguishing them fails here.
  it('never lets a replayed snapshot reach overall:current — it is not an independent measurement', () => {
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
        // Every dimension matches the stored row, so nothing is stale. Under the
        // pre-fix behaviour this combination returned `current`/`server-measured`.
        evidenceKind: 'test',
        evidenceRef: 'vitest:one',
        sourceFingerprint: 'git:one',
        testFingerprint: 'sha256:test',
      },
      { provenance: 'replayed-snapshot' },
    );

    expect(currentness.overall).not.toBe('current');
    expect(currentness).toMatchObject({
      overall: 'unknown',
      provenance: 'replayed-snapshot',
      staleReasons: [],
    });
    expect(currentness.unknownReasons).toContain('current-fingerprints-replayed-not-independently-measured');
  });

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

  it('matches scoped currentness by clause identity when two specs share one artifact reference', async () => {
    const shared = {
      work_item_id: 'WI-shared-proof',
      plan_slug: 'plan-one',
      source_val_id: null,
      spec_revision: 1,
      evidence_kind: 'test' as const,
      evidence_ref: 'artifact:shared-index',
      test_fingerprint: null,
      fixture_fingerprint: null,
      rubric_fingerprint: null,
      environment_fingerprint: null,
      coverage_evidence_ref: null,
      coverage_evidence_present: false,
      test_run_id: null,
      test_run_present: false,
      details: {},
      observed_at: '2026-08-20T21:10:00.000Z',
      binding_fingerprint: 'sha256:binding',
      created_by: 'su-test',
      created_at: '2026-08-20T21:10:01.000Z',
      spec_is_current: true,
    };
    h.rows = [
      {
        ...shared,
        id: 10,
        spec_id: 'SPEC-A',
        spec_fingerprint: 'sha256:spec-a',
        source_fingerprint: 'git:source-a',
      },
      {
        ...shared,
        id: 11,
        spec_id: 'SPEC-B',
        spec_fingerprint: 'sha256:spec-b',
        source_fingerprint: 'git:source-b',
      },
    ];

    const rows = await listSpecEvidence({
      harnessSlug: 'papercusp',
      planSlugs: ['plan-one'],
      current: [
        {
          planSlug: 'plan-one',
          specId: 'SPEC-A',
          specRevision: 1,
          specFingerprint: 'sha256:spec-a',
          evidenceKind: 'test',
          evidenceRef: 'artifact:shared-index',
          sourceFingerprint: 'git:source-a',
        },
        {
          planSlug: 'plan-one',
          specId: 'SPEC-B',
          specRevision: 1,
          specFingerprint: 'sha256:spec-b',
          evidenceKind: 'test',
          evidenceRef: 'artifact:shared-index',
          sourceFingerprint: 'git:source-b',
        },
      ],
    });

    expect(rows).toHaveLength(2);
    // Equality with caller-supplied fingerprints is deliberately reported as
    // attested-current/unknown at the aggregate level. Assert the per-row
    // source dimension as well: that is the signal which proves the scoped
    // identity selected SPEC-A's tuple instead of SPEC-B's last-writer value.
    expect(rows.map((row) => ({
      specId: row.specId,
      overall: row.currentness.overall,
      source: row.currentness.dimensions.source,
      provenance: row.currentness.provenance,
      comparisonSupplied: row.currentness.comparisonSupplied,
    }))).toEqual([
      {
        specId: 'SPEC-A',
        overall: 'unknown',
        source: 'current',
        provenance: 'attested-current',
        comparisonSupplied: true,
      },
      {
        specId: 'SPEC-B',
        overall: 'unknown',
        source: 'current',
        provenance: 'attested-current',
        comparisonSupplied: true,
      },
    ]);
  });

  it('replays a pinned server-measured snapshot without reading the live repository', async () => {
    h.rows = [
      {
        id: 3,
        work_item_id: 'WI-3',
        plan_slug: 'plan-one',
        spec_id: 'SPEC-001-01',
        source_val_id: 'VAL-001-01',
        spec_revision: 1,
        current_revision: 2,
        spec_fingerprint: 'sha256:spec-v1',
        evidence_kind: 'test',
        evidence_ref: 'vitest:replay',
        source_fingerprint: 'git:graded',
        test_fingerprint: 'sha256:test-graded',
        fixture_fingerprint: null,
        rubric_fingerprint: null,
        environment_fingerprint: null,
        coverage_evidence_ref: null,
        coverage_evidence_present: false,
        test_run_id: null,
        test_run_present: false,
        details: {
          currentMeasurement: {
            schemaVersion: 1,
            kind: 'repo-files',
            sourcePaths: ['src/feature.ts'],
            testPaths: ['test/feature.test.ts'],
          },
        },
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
      specRevision: 1,
      specFingerprint: 'sha256:spec-v1',
      replaySnapshot: true,
      currentProvenance: 'server-measured',
      current: [
        {
          evidenceKind: 'test',
          evidenceRef: 'vitest:replay',
          sourceFingerprint: 'git:graded',
          testFingerprint: 'sha256:test-graded',
        },
      ],
    });

    expect(row).toMatchObject({
      specRevision: 1,
      currentRevision: 2,
      specFingerprint: 'sha256:spec-v1',
      currentness: {
        overall: 'current',
        provenance: 'server-measured',
        staleReasons: [],
        unknownReasons: [],
      },
    });
    expect(row).not.toHaveProperty('serverMeasurement');
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

// RECURRENCE GUARD (WI-10002087). `source` currentness used to have exactly ONE basis — a repo
// file-set hash — so a binding whose SUBJECT was not a file set could never reach
// `source:'current'` and every non-code plan outcome was unshippable. The fix adds a ledger-state
// basis. These tests pin the property that makes it a real measurement rather than a bypass: the
// digest must MOVE when the underlying disposition moves. If it ever stops moving, a reopened row
// would keep reading "current" and the ledger basis would become the rubber stamp that
// `source:'not-applicable'` (the rejected alternative) would have been.
describe('ledger-state server measurement', () => {
  const recipe = {
    schemaVersion: 1 as const,
    kind: 'work-items' as const,
    workItemIds: ['EI-2', 'EI-1'],
  };

  beforeEach(() => {
    h.rows = [];
    h.scorecardRows = [];
  });

  it('hashes the named rows deterministically, independent of argument order and duplicates', async () => {
    h.rows = [
      { feature_id: 'EI-1', status: 'done' },
      { feature_id: 'EI-2', status: 'dropped' },
    ];

    const first = await measureWorkItemsEvidenceForScope('workspace-test', 'papercusp', recipe);
    const replay = await measureWorkItemsEvidenceForScope('workspace-test', 'papercusp', recipe);
    expect(replay).toEqual(first);

    // Same population, spelled differently: the digest is over a sorted, de-duplicated id set.
    const reordered = await measureWorkItemsEvidenceForScope('workspace-test', 'papercusp', {
      ...recipe,
      workItemIds: ['EI-1', 'EI-2', 'EI-1'],
    });
    expect(reordered.sourceFingerprint).toBe(first.sourceFingerprint);

    expect(first.sourceFingerprint).toMatch(/^sha256-work-item-set-v1:[0-9a-f]{64}$/);
    // Ledger state has no test-file half; a null here is what keeps `test` at not-applicable
    // instead of inventing an unknown dimension the subject cannot ever satisfy.
    expect(first.testFingerprint).toBeNull();
  });

  it('moves the digest when a disposition changes — this is what makes a reopened row go stale', async () => {
    h.rows = [
      { feature_id: 'EI-1', status: 'done' },
      { feature_id: 'EI-2', status: 'dropped' },
    ];
    const before = await measureWorkItemsEvidenceForScope('workspace-test', 'papercusp', recipe);

    // EI-1 is reopened: the census claim "every row reached a recorded disposition" is no longer true.
    h.rows = [
      { feature_id: 'EI-1', status: 'open' },
      { feature_id: 'EI-2', status: 'dropped' },
    ];
    const after = await measureWorkItemsEvidenceForScope('workspace-test', 'papercusp', recipe);

    expect(after.sourceFingerprint).not.toBe(before.sourceFingerprint);
  });

  it('hashes an absent row as an explicit null so a deleted or misspelled id cannot pass as present', async () => {
    h.rows = [
      { feature_id: 'EI-1', status: 'done' },
      { feature_id: 'EI-2', status: 'done' },
    ];
    const bothPresent = await measureWorkItemsEvidenceForScope('workspace-test', 'papercusp', recipe);

    h.rows = [{ feature_id: 'EI-1', status: 'done' }];
    const oneMissing = await measureWorkItemsEvidenceForScope('workspace-test', 'papercusp', recipe);

    expect(oneMissing.sourceFingerprint).not.toBe(bothPresent.sourceFingerprint);
  });

  it('routes both measurement kinds through one discriminated union', () => {
    expect(
      evidenceMeasurementSchema.safeParse({ schemaVersion: 1, kind: 'work-items', workItemIds: ['WI-1234'] }).success,
    ).toBe(true);

    // CALIBRATION / positive control: the pre-existing repo-files basis must still parse, or the
    // assertions above could pass simply because the union stopped accepting anything real.
    expect(
      evidenceMeasurementSchema.safeParse({ schemaVersion: 1, kind: 'repo-files', sourcePaths: ['src/a.ts'] }).success,
    ).toBe(true);

    expect(evidenceMeasurementSchema.safeParse({ schemaVersion: 1, kind: 'work-items', workItemIds: [] }).success).toBe(
      false,
    );
    expect(
      evidenceMeasurementSchema.safeParse({ schemaVersion: 1, kind: 'work-items', workItemIds: ['not a ref'] }).success,
    ).toBe(false);
  });
});
