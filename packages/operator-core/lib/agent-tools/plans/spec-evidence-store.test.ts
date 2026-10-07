import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  scorecardRows: [] as Array<Record<string, unknown>>,
  queries: [] as Array<{ sql: string; values: unknown[] }>,
  workspaceScopes: [] as string[],
  planScopeOptions: [] as Array<{ harnessSlug?: string; workspaceId?: string }>,
  measurementRoot: '',
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    withWorkspace: async <T>(workspaceId: string, fn: (tx: unknown) => Promise<T>) => {
      h.workspaceScopes.push(workspaceId);
      const tx = ((strings: TemplateStringsArray | string[], ...values: unknown[]) => {
        const sql = Array.from(strings).join(' ');
        h.queries.push({ sql, values });
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
    resolvePlanScope: async (options: { harnessSlug?: string; workspaceId?: string } = {}) => {
      h.planScopeOptions.push(options);
      return { workspaceId: options.workspaceId ?? 'workspace-test', harnessSlug: 'papercusp' };
    },
  };
});

// A replay that MEASURES resolves a real harness checkout. Point that resolution at this
// suite's temp fixture root so the measuring path can be observed end to end; without this
// the measurement can only ever fail with repo_measurement_harness_root_unavailable, which
// would make the guards below pass for the wrong reason.
vi.mock('../../harness-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../harness-registry')>();
  return {
    ...actual,
    loadHarnessRegistry: async () => ({}) as never,
    resolveHarnessContentPath: () => h.measurementRoot,
  };
});

import {
  classifySpecEvidenceCurrentness,
  evidenceMeasurementSchema,
  listSpecEvidence,
  measureAndPinRepoFilesEvidenceAtRoot,
  measureRepoFilesEvidenceDetailedAtRoot,
  measureRepoFilesEvidenceAtRoot,
  measureWorkItemsEvidenceForScope,
} from './spec-evidence-store';

let measurementRoot = '';

beforeAll(async () => {
  measurementRoot = await mkdtemp(join(tmpdir(), 'spec-evidence-measurement-'));
  h.measurementRoot = measurementRoot;
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

  it('measures fixture calibration files as an independent fingerprint and pin dimension', async () => {
    const fixturePath = 'fixture/server-envelope.ts';
    await mkdir(join(measurementRoot, 'fixture'), { recursive: true });
    await writeFile(join(measurementRoot, fixturePath), 'export const voicePort: number | null = 8080;\n');
    const recipe = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: ['src/feature.ts'],
      testPaths: ['test/feature.test.ts'],
      fixturePaths: [fixturePath],
    };

    const first = await measureAndPinRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    expect(first.fixtureFingerprint).toMatch(/^sha256-file-set-v1:[0-9a-f]{64}$/);
    expect(first.pin.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: fixturePath, dimension: 'fixture' }),
    ]));

    await writeFile(join(measurementRoot, fixturePath), 'export const voicePort: number | null = null;\n');
    const changed = await measureRepoFilesEvidenceDetailedAtRoot(measurementRoot, recipe);
    expect(changed.fixtureFingerprint).not.toBe(first.fixtureFingerprint);
    expect(changed.sourceFingerprint).toBe(first.sourceFingerprint);
    expect(changed.testFingerprint).toBe(first.testFingerprint);
  });

  it('includes globbed source changes, additions, and removals in the source fingerprint', async () => {
    const plugins = join(measurementRoot, 'dynamic', 'plugins');
    await Promise.all([
      mkdir(join(plugins, 'linear-sync'), { recursive: true }),
      mkdir(join(measurementRoot, 'dynamic', 'migrations'), { recursive: true }),
    ]);
    const manifest = join(plugins, 'linear-sync', 'papercusp.json');
    const migration = join(measurementRoot, 'dynamic', 'migrations', '1400-recreate-plugin.sql');
    await Promise.all([
      writeFile(manifest, '{"enabled":false}\n'),
      writeFile(migration, 'CREATE TABLE one();\n'),
    ]);
    const recipe = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: ['src/feature.ts'],
      sourceGlobs: ['dynamic/plugins/*/papercusp.json', 'dynamic/migrations/14*.sql'],
      testPaths: ['test/feature.test.ts'],
    };

    const initialDetailed = await measureRepoFilesEvidenceDetailedAtRoot(measurementRoot, recipe);
    expect(initialDetailed.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'dynamic/plugins/linear-sync/papercusp.json', dimension: 'source' }),
    ]));
    const initial = {
      sourceFingerprint: initialDetailed.sourceFingerprint,
      testFingerprint: initialDetailed.testFingerprint,
    };
    await writeFile(manifest, '{"enabled":true}\n');
    const changed = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    expect(changed.sourceFingerprint).not.toBe(initial.sourceFingerprint);

    const addedManifest = join(plugins, 'calendar-sync', 'papercusp.json');
    await mkdir(join(plugins, 'calendar-sync'), { recursive: true });
    await writeFile(addedManifest, '{"enabled":false}\n');
    const added = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    expect(added.sourceFingerprint).not.toBe(changed.sourceFingerprint);

    await rm(addedManifest);
    const removed = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    expect(removed.sourceFingerprint).not.toBe(added.sourceFingerprint);
    expect(removed.testFingerprint).toBe(initial.testFingerprint);
  });

  it('bounds the number of files expanded from source globs', async () => {
    const bounded = join(measurementRoot, 'bounded-glob');
    await mkdir(bounded, { recursive: true });
    await Promise.all(Array.from({ length: 129 }, (_, index) =>
      writeFile(join(bounded, `file-${index}.ts`), 'export {};\n')));

    await expect(measureRepoFilesEvidenceAtRoot(measurementRoot, {
      schemaVersion: 1,
      kind: 'repo-files',
      sourcePaths: ['src/feature.ts'],
      sourceGlobs: ['bounded-glob/*.ts'],
    })).rejects.toThrow(/repo_measurement_too_many_glob_files/);
  });

  it('rejects traversal and symlink escapes before reading bytes', async () => {
    await expect(
      measureRepoFilesEvidenceAtRoot(measurementRoot, {
        schemaVersion: 1,
        kind: 'repo-files',
        sourcePaths: ['../outside.ts'],
      }),
    ).rejects.toThrow(/normalized repo-relative POSIX/);
    await expect(
      measureRepoFilesEvidenceAtRoot(measurementRoot, {
        schemaVersion: 1,
        kind: 'repo-files',
        sourcePaths: ['src/feature.ts'],
        sourceGlobs: ['../outside/*.ts'],
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

  it.each([
    { label: 'dirty', worktreeDirty: true, expectedOverall: 'unknown' },
    { label: 'clean', worktreeDirty: false, expectedOverall: 'current' },
  ])(
    '$label test-run worktree yields $expectedOverall freshness',
    ({ worktreeDirty, expectedOverall }) => {
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
          test_run_id: 43,
          test_run_present: true,
          test_run_worktree_dirty: worktreeDirty,
        },
        {
          evidenceKind: 'test',
          evidenceRef: 'vitest:one',
          sourceFingerprint: 'git:one',
          testFingerprint: 'sha256:test',
        },
        { provenance: 'server-measured' },
      );

      expect(currentness.overall).toBe(expectedOverall);
      expect(currentness.dimensions.testRun).toBe(expectedOverall);
      if (worktreeDirty) expect(currentness.unknownReasons).toContain('test-run-worktree-not-clean');
    },
  );

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
    h.queries = [];
    h.workspaceScopes = [];
    h.planScopeOptions = [];
  });

  it('pins historical evidence reads to the explicitly supplied workspace', async () => {
    await listSpecEvidence({
      harnessSlug: 'papercusp',
      workspaceId: 'workspace-historical',
      planSlugs: ['plan-one'],
    });

    expect(h.planScopeOptions).toEqual([
      { harnessSlug: 'papercusp', workspaceId: 'workspace-historical' },
    ]);
    expect(h.workspaceScopes).toEqual(['workspace-historical']);
  });

  it('projects structured failed identities even without a human tail, fenced to a failed mutation run (EI-25248905256718690)', async () => {
    h.rows = [{
      id: 1, work_item_id: 'WI-1', plan_slug: 'plan-one', spec_id: 'SPEC-1',
      spec_revision: 1, current_revision: 1, spec_fingerprint: 'spec', spec_is_current: true,
      evidence_kind: 'mutation', evidence_ref: 'mutant', details: {},
      source_fingerprint: null, test_fingerprint: null, fixture_fingerprint: null,
      rubric_fingerprint: null, environment_fingerprint: null, coverage_evidence_ref: null,
      test_run_id: 43, test_run_present: true, test_run_file_path: 'test/a.test.ts',
      test_run_commit_sha: 'abc', test_run_worktree_dirty: false, mutation_failure_tail: null,
      mutation_execution_details: {
        schemaVersion: 1, root: '/repo', filePath: 'test/a.test.ts', runGroupId: null,
        workspaceId: 'ws', harnessSlug: 'papercusp', testNamePattern: null,
        passed: 1, failed: 1, skipped: 0, collectionFailed: false, mutationPhase: 'mutant',
        commitSha: 'abc', worktreeDirty: false, failedCaseTitles: ['suite > failed with a long DOM error'],
      },
      observed_at: '2026-10-06T16:35:00.000Z', created_at: '2026-10-06T16:36:00.000Z',
    }];
    const [row] = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] });
    expect(row.testRunProvenance?.mutationFailureLines).toEqual([
      'suite > failed with a long DOM error: (recorded failed assertion)',
    ]);
    expect(row.testRunProvenance?.mutationFailedCaseTitles).toEqual(['suite > failed with a long DOM error']);
    expect(h.queries.find(query => query.sql.includes('SELECT b.id'))?.sql).toMatch(
      /WHEN b\.evidence_kind = 'mutation'\s+AND tr\.source = 'mutation-probe'\s+AND tr\.status = 'fail'\s+THEN tr\.execution_details/,
    );
  });

  it('projects canonical test-run status, counts, passed titles, and runtime layer to the evaluator', async () => {
    h.rows = [{
      id: 2, work_item_id: 'WI-2', plan_slug: 'plan-one', spec_id: 'SPEC-2',
      spec_revision: 1, current_revision: 1, spec_fingerprint: 'spec', spec_is_current: true,
      evidence_kind: 'test', evidence_ref: 'test-run:44', details: {
        adequacy: {
          testLayer: 'integration',
          testCases: ['suite > exactly passed case'],
          pathReachable: true,
        },
      },
      source_fingerprint: null, test_fingerprint: null, fixture_fingerprint: null,
      rubric_fingerprint: null, environment_fingerprint: null, coverage_evidence_ref: null,
      test_run_id: 44, test_run_present: true, test_run_file_path: 'test/a.test.ts',
      test_run_commit_sha: 'abc123', test_run_worktree_dirty: false, test_run_status: 'pass',
      test_run_execution_details: {
        schemaVersion: 1, root: '/repo', filePath: 'test/a.test.ts', runGroupId: null,
        workspaceId: 'workspace-test', harnessSlug: 'papercusp', testNamePattern: null,
        passed: 2, failed: 0, skipped: 0, collectionFailed: false, mutationPhase: null,
        commitSha: 'abc123', worktreeDirty: false, testLayer: 'integration',
        passedCaseTitles: ['suite > exactly passed case', 'suite > another passed case'],
      },
      mutation_failure_tail: null, mutation_execution_details: null,
      observed_at: '2026-10-06T16:35:00.000Z', created_at: '2026-10-06T16:36:00.000Z',
    }];

    const [row] = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] });
    expect(row.testRunExecution).toMatchObject({
      status: 'pass',
      passed: 2,
      failed: 0,
      skipped: 0,
      collectionFailed: false,
      testLayer: 'integration',
      passedCaseTitles: ['suite > exactly passed case', 'suite > another passed case'],
    });
    const query = h.queries.find(entry => entry.sql.includes('SELECT b.id'))?.sql ?? '';
    expect(query).toContain('tr.status AS test_run_status');
    expect(query).toContain('tr.execution_details AS test_run_execution_details');
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
    expect(row).not.toHaveProperty('withdrawal');
    h.rows[0] = { ...h.rows[0], retracted_at: '2026-08-20 17:12:00-04',
      retracted_by: 'su-reviewer', retraction_reason: 'Withdrawn pending attempt without a result.' };
    const [withdrawn] = await listSpecEvidence({ harnessSlug: 'papercusp',
      planSlugs: ['plan-one'], includeRetracted: true });
    expect(withdrawn).toMatchObject({ withdrawal: {
      at: '2026-08-20T21:12:00.000Z', by: 'su-reviewer',
      reason: 'Withdrawn pending attempt without a result.',
    } });
  });

  it('keeps a kind=fixture binding without a stored fixture baseline unknown', async () => {
    const recipe = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: ['src/feature.ts'],
      testPaths: ['test/feature.test.ts'],
    };
    const measured = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    h.rows = [{
      id: 55,
      work_item_id: 'WI-fixture',
      plan_slug: 'plan-one',
      spec_id: 'SPEC-fixture',
      source_val_id: null,
      spec_revision: 1,
      current_revision: 1,
      spec_fingerprint: 'sha256:spec-fixture',
      evidence_kind: 'fixture',
      evidence_ref: 'fixture:legacy-wiremock',
      source_fingerprint: measured.sourceFingerprint,
      test_fingerprint: measured.testFingerprint,
      fixture_fingerprint: null,
      rubric_fingerprint: null,
      environment_fingerprint: null,
      coverage_evidence_ref: null,
      coverage_evidence_present: false,
      test_run_id: null,
      test_run_present: false,
      details: { currentMeasurement: recipe },
      observed_at: '2026-08-20T21:10:00.000Z',
      binding_fingerprint: 'sha256:fixture-binding',
      created_by: 'su-test',
      created_at: '2026-08-20T21:10:01.000Z',
      spec_is_current: true,
    }];

    const [row] = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] });

    expect(row.currentness).toMatchObject({
      overall: 'unknown',
      dimensions: { source: 'current', test: 'current', fixture: 'unknown' },
      unknownReasons: ['fixture-current-fingerprint-not-supplied'],
    });
  });

  it('marks fixture calibration stale when a measured server fixture source changes', async () => {
    const fixturePath = 'fixture/runtime-envelope.ts';
    await mkdir(join(measurementRoot, 'fixture'), { recursive: true });
    await writeFile(join(measurementRoot, fixturePath), 'export const voicePort: number | null = 8080;\n');
    const recipe = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: ['src/feature.ts'],
      testPaths: ['test/feature.test.ts'],
      fixturePaths: [fixturePath],
    };
    const pinned = await measureAndPinRepoFilesEvidenceAtRoot(measurementRoot, recipe);
    h.rows = [{
      id: 56,
      work_item_id: 'WI-fixture-current',
      plan_slug: 'plan-one',
      spec_id: 'SPEC-fixture-current',
      source_val_id: null,
      spec_revision: 1,
      current_revision: 1,
      spec_fingerprint: 'sha256:spec-fixture-current',
      evidence_kind: 'fixture',
      evidence_ref: 'fixture:wiremock',
      source_fingerprint: pinned.sourceFingerprint,
      test_fingerprint: pinned.testFingerprint,
      fixture_fingerprint: pinned.fixtureFingerprint,
      rubric_fingerprint: null,
      environment_fingerprint: null,
      coverage_evidence_ref: null,
      coverage_evidence_present: false,
      test_run_id: null,
      test_run_present: false,
      details: { currentMeasurement: recipe, measurementPin: pinned.pin },
      observed_at: '2026-08-20T21:10:00.000Z',
      binding_fingerprint: 'sha256:fixture-current-binding',
      created_by: 'su-test',
      created_at: '2026-08-20T21:10:01.000Z',
      spec_is_current: true,
    }];

    const [current] = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] });
    expect(current.currentness).toMatchObject({
      overall: 'current',
      dimensions: { fixture: 'current' },
    });

    await writeFile(join(measurementRoot, fixturePath), 'export const voicePort: number | null = null;\n');
    const [stale] = await listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] });
    expect(stale.currentness).toMatchObject({
      overall: 'stale',
      dimensions: { fixture: 'stale' },
      staleReasons: ['fixture-stale'],
    });
    expect(stale).toHaveProperty('serverMeasurement.movedPaths', expect.arrayContaining([
      expect.objectContaining({ path: fixturePath, dimension: 'fixture', change: 'changed' }),
    ]));
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

  // RECURRENCE GUARD (WI-10002320), MATCHED SET with the test above. `rerunRecipeFor`
  // ALWAYS emits `replaySnapshot: true`, so while that flag alone suppressed the
  // per-binding server measurement, scorecards:emit was structurally unable to certify
  // freshness='pass' on ANY card: the replay could not reproduce the very verdict it
  // replayed, and the classifier — seeing nothing but caller-authored fingerprints —
  // capped the criterion at 'unknown' precisely BECAUSE nothing was stale.
  //
  // Only `replaySnapshot` AND the explicit `currentProvenance: 'server-measured'` opt-out
  // may suppress measurement. The first guard below is the zero-delta control: the row and
  // the caller tuple are byte-identical to the opt-out test above, and ONLY the opt-out is
  // removed — so a regression that reinstates the unconditional suppression drops
  // `serverMeasurement` and fails here, with no second variable to blame it on.
  it('measures a pinned replay that does not opt out — replaySnapshot alone must not suppress measurement', async () => {
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
      // NO currentProvenance opt-out — that single omission is the whole delta.
      current: [
        {
          evidenceKind: 'test',
          evidenceRef: 'vitest:replay',
          sourceFingerprint: 'git:graded',
          testFingerprint: 'sha256:test-graded',
        },
      ],
    });

    expect(row).toHaveProperty('serverMeasurement.status', 'measured');
    // The stored fingerprints are placeholders, so a REAL measurement of the fixture root
    // cannot match them: 'stale' here is positive evidence that the server re-derived the
    // tuple rather than echoing the caller's.
    expect(row).toMatchObject({ currentness: { overall: 'stale' } });
  });

  // The positive half of the same defect: a replay must be able to reach 'current' with
  // server-grade provenance, or no card can ever certify freshness='pass'. Calibration: the
  // row's stored fingerprints are taken FROM a real measurement of the fixture root, so
  // 'current' here means the server re-derived them — not that a caller tuple was laundered
  // (the sibling guard at the top of this file pins that laundering shut independently).
  it('lets a measured replay reach current with server provenance — this is what makes freshness certifiable', async () => {
    const recipe = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: ['src/feature.ts'],
      testPaths: ['test/feature.test.ts'],
    };
    // Derived at run time on purpose: an earlier test in this file rewrites src/feature.ts,
    // so a hardcoded digest would bind this guard to test ordering.
    const measured = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);

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
        source_fingerprint: measured.sourceFingerprint,
        test_fingerprint: measured.testFingerprint,
        fixture_fingerprint: null,
        rubric_fingerprint: null,
        environment_fingerprint: null,
        coverage_evidence_ref: null,
        coverage_evidence_present: false,
        test_run_id: null,
        test_run_present: false,
        details: { currentMeasurement: recipe },
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
      current: [
        {
          evidenceKind: 'test',
          evidenceRef: 'vitest:replay',
          sourceFingerprint: measured.sourceFingerprint,
          testFingerprint: measured.testFingerprint,
        },
      ],
    });

    expect(row).toHaveProperty('serverMeasurement.status', 'measured');
    // source + test are never counted as attested, so a clean re-measurement yields
    // 'server-measured' rather than the capped 'partially-server-measured'.
    expect(row).not.toHaveProperty('serverMeasurement.attestedDimensions');
    expect(row).toMatchObject({
      currentness: {
        overall: 'current',
        provenance: 'server-measured',
        staleReasons: [],
        unknownReasons: [],
      },
    });
  });

  it('pins a multi-clause replay by each row’s full clause identity', async () => {
    const current = [
      {
        planSlug: 'plan-one',
        specId: 'SPEC-001-01',
        specRevision: 1,
        specFingerprint: 'sha256:spec-v1',
        evidenceKind: 'test' as const,
        evidenceRef: 'vitest:one',
        sourceFingerprint: 'git:one',
        testFingerprint: 'sha256:test-one',
      },
      {
        planSlug: 'plan-two',
        specId: 'SPEC-002-01',
        specRevision: 4,
        specFingerprint: 'sha256:spec-v4',
        evidenceKind: 'test' as const,
        evidenceRef: 'vitest:two',
        sourceFingerprint: 'git:two',
        testFingerprint: 'sha256:test-two',
      },
    ];

    await listSpecEvidence({
      harnessSlug: 'papercusp',
      planSlugs: ['plan-one', 'plan-two'],
      specIds: ['SPEC-001-01', 'SPEC-002-01'],
      replaySnapshot: true,
      current,
    });

    const pinQuery = h.queries.find(({ sql }) => sql.includes('unnest('));
    expect(pinQuery?.sql).toContain('requested.plan_slug = b.plan_slug');
    expect(pinQuery?.sql).toContain('requested.spec_id = b.spec_id');
    expect(pinQuery?.sql).toContain('requested.spec_revision = b.spec_revision');
    expect(pinQuery?.sql).toContain('requested.spec_fingerprint = b.spec_fingerprint');
    expect(pinQuery?.values).toEqual([
      ['plan-one', 'plan-two'],
      ['SPEC-001-01', 'SPEC-002-01'],
      [1, 4],
      ['sha256:spec-v1', 'sha256:spec-v4'],
    ]);
  });

  it('restricts a pinned replay to the exact persisted binding ids', async () => {
    await listSpecEvidence({
      harnessSlug: 'papercusp',
      planSlugs: ['plan-one'],
      specIds: ['SPEC-001-01'],
      specRevision: 1,
      specFingerprint: 'sha256:spec-v1',
      replaySnapshot: true,
      evidenceRefs: ['vitest:shared-ref'],
      bindingIds: [18874, 18875, 18924],
    });

    const query = h.queries.find(({ sql }) => sql.includes('b.id = ANY('));
    expect(query?.sql).toContain('b.id = ANY(');
    expect(query?.values).toContainEqual([18874, 18875, 18924]);
  });

  it('keeps an explicitly empty binding-id replay empty', async () => {
    await listSpecEvidence({
      harnessSlug: 'papercusp',
      planSlugs: ['plan-one'],
      specIds: ['SPEC-001-01'],
      specRevision: 1,
      specFingerprint: 'sha256:spec-v1',
      replaySnapshot: true,
      bindingIds: [],
    });

    const query = h.queries.find(({ sql }) => sql.includes('b.id = ANY('));
    expect(query?.sql).toContain('b.id = ANY(');
    expect(query?.values).toContainEqual([]);
  });

  it('limits withdrawn-binding audits to their as-of time while the ordinary read still excludes withdrawals', async () => {
    const auditAsOf = new Date('2026-10-02T00:14:36.135Z');
    const selectors = {
      harnessSlug: 'papercusp',
      planSlugs: ['plan-one'],
      specIds: ['SPEC-001-01'],
      specRevision: 1,
      specFingerprint: 'sha256:spec-v1',
      replaySnapshot: true,
      evidenceRefs: ['vitest:shared-ref'],
    };

    await listSpecEvidence({
      ...selectors,
      includeRetracted: true,
      auditAsOf,
    });
    const auditQuery = h.queries.find(({ sql }) => sql.includes('b.created_at <='));
    expect(auditQuery?.sql).toContain('b.created_at <=');
    expect(auditQuery?.sql).toContain('b.retracted_at IS NULL OR b.retracted_at >');
    expect(auditQuery?.values).toContain(auditAsOf);
    expect(auditQuery?.values).toContain(true);

    await listSpecEvidence(selectors);
    const currentQuery = h.queries.filter(({ sql }) => sql.includes('FROM harness_shared.spec_evidence_bindings')).at(-1);
    expect(currentQuery?.sql).toContain('b.retracted_at IS NULL');
    expect(currentQuery?.values).toContain(false);
  });

  it('replays the exact withdrawn binding with its emission-time fingerprints after live source drift', async () => {
    const auditAsOf = new Date('2026-10-02T00:14:36.135Z');
    const sourcePath = 'src/historical-replay.ts';
    const recipe = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: [sourcePath],
      testPaths: ['test/feature.test.ts'],
    };
    const sourceFile = join(measurementRoot, sourcePath);
    await writeFile(sourceFile, 'export const value = 1;\n');
    try {
      const emission = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
      await writeFile(sourceFile, 'export const value = 2;\n');
      const live = await measureRepoFilesEvidenceAtRoot(measurementRoot, recipe);
      expect(live.sourceFingerprint).not.toBe(emission.sourceFingerprint);

      h.rows = [{
        id: 19999,
        work_item_id: 'WI-3',
        plan_slug: 'plan-one',
        spec_id: 'SPEC-001-01',
        source_val_id: 'VAL-001-01',
        spec_revision: 1,
        current_revision: 2,
        spec_fingerprint: 'sha256:spec-v1',
        evidence_kind: 'test',
        evidence_ref: 'vitest:historical-replay',
        source_fingerprint: emission.sourceFingerprint,
        test_fingerprint: emission.testFingerprint,
        fixture_fingerprint: null,
        rubric_fingerprint: null,
        environment_fingerprint: null,
        coverage_evidence_ref: null,
        coverage_evidence_present: false,
        test_run_id: null,
        test_run_present: false,
        details: { currentMeasurement: recipe },
        observed_at: '2026-10-01T23:00:00.000Z',
        binding_fingerprint: 'sha256:binding-19999',
        created_by: 'su-test',
        created_at: '2026-10-01T23:00:00.000Z',
        retracted_at: '2026-10-02T01:00:00.000Z',
        retracted_by: 'su-reviewer',
        retraction_reason: 'superseded by binding 21019',
        spec_is_current: true,
      }];

      const current = [{
        planSlug: 'plan-one',
        specId: 'SPEC-001-01',
        specRevision: 1,
        specFingerprint: 'sha256:spec-v1',
        evidenceKind: 'test' as const,
        evidenceRef: 'vitest:historical-replay',
        sourceFingerprint: emission.sourceFingerprint,
        testFingerprint: emission.testFingerprint,
      }];
      const [row] = await listSpecEvidence({
        harnessSlug: 'papercusp',
        planSlugs: ['plan-one'],
        specIds: ['SPEC-001-01'],
        specRevision: 1,
        specFingerprint: 'sha256:spec-v1',
        replaySnapshot: true,
        evidenceRefs: ['vitest:historical-replay'],
        bindingIds: [19999],
        currentProvenance: 'historical-snapshot',
        current,
        includeRetracted: true,
        auditAsOf,
      });

      expect(row).toMatchObject({
        id: 19999,
        withdrawal: { reason: 'superseded by binding 21019' },
        fingerprints: { sourceFingerprint: emission.sourceFingerprint },
        currentness: {
          overall: 'current',
          provenance: 'historical-snapshot',
          dimensions: { source: 'current', test: 'current' },
        },
      });
      expect(row).not.toHaveProperty('serverMeasurement');
      const bindingQuery = h.queries.find(({ sql }) => sql.includes('b.id = ANY('));
      const auditQuery = h.queries.find(({ sql }) => sql.includes('b.created_at <='));
      expect(bindingQuery?.values).toContainEqual([19999]);
      expect(auditQuery?.values).toContain(auditAsOf);
    } finally {
      await rm(sourceFile, { force: true });
    }
  });

  it('refuses an audit-as-of cutoff without explicit withdrawn-row visibility', async () => {
    await expect(
      listSpecEvidence({
        harnessSlug: 'papercusp',
        planSlugs: ['plan-one'],
        includeRetracted: false,
        auditAsOf: new Date('2026-10-02T00:14:36.135Z'),
      }),
    ).rejects.toThrow('auditAsOf requires includeRetracted:true');
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
