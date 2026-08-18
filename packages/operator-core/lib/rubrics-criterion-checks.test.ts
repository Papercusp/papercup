/**
 * rubrics-criterion-checks.test.ts — the P-011 / owner-ratified D-006 structured
 * criterion checks: schema acceptance, propose-time REFUSING path validation, and
 * grading-time evaluation (live-run semantics via an injectable runner).
 *
 * The path-validation tests run against a REAL scratch tree (mkdtemp) so existsSync
 * semantics are the production ones, never a mocked fs. The grading-time tests inject
 * a runner stub; the contradiction pair (failing run × pass rating REFUSES; failing
 * run × honest rating STAMPS) is its own falsifiability control — the verdict provably
 * depends on the rating–run PAIR, not on either alone.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateCriterionCheckPaths,
  assertCriterionCheckPathsResolve,
  evaluateCriterionTestChecks,
  evaluateCriterionCoverageChecks,
  type CriterionCheckRunner,
  type CoverageMeasurement,
  type CoverageReader,
} from './rubrics-criterion-checks';
import { rubricCriterionSchema, rubricTemplateDataSchema, rubricCriterionCheckSchema } from './agent-tools/plans/rubric-template';
import { effectiveCriterionInstrumentKey, planRowToRubric } from './rubrics';

// ── scratch tree ──────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'rubric-checks-test-'));
mkdirSync(join(root, 'packages', 'x'), { recursive: true });
writeFileSync(join(root, 'packages', 'x', 'real.test.ts'), 'export {};\n');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const testsCheck = (files: string[]) => ({ kind: 'tests' as const, files });

// ── schema ────────────────────────────────────────────────────────────────────
describe('rubricCriterionCheckSchema (P-011 schema)', () => {
  it('accepts a tests check and an instrument check; refuses unknown fields and unknown kinds', () => {
    expect(rubricCriterionCheckSchema.safeParse(testsCheck(['a.test.ts'])).success).toBe(true);
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'instrument', instrumentKey: 'gate-verdict' }).success).toBe(true);
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'tests', files: ['a.test.ts'], extra: 1 }).success).toBe(false);
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'vibes' }).success).toBe(false);
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'tests', files: [] }).success).toBe(false);
  });

  it('rides the criterion schema as an optional field (absent = fuzzy, unchanged)', () => {
    const base = { key: 'k', title: 't', model: 'm', method: 'm', driftMarkers: 'd' };
    expect(rubricCriterionSchema.safeParse(base).success).toBe(true);
    expect(rubricCriterionSchema.safeParse({ ...base, check: testsCheck(['a.test.ts']) }).success).toBe(true);
  });

  it('data-level superRefine refuses a criterion binding two DIFFERENT instruments, tolerates equal', () => {
    const data = (check: unknown, instrumentKey?: string) => ({
      characteristic: 'c',
      criteria: [
        { key: 'k', title: 't', model: 'm', method: 'm', driftMarkers: 'd', ...(instrumentKey ? { instrumentKey } : {}), check },
      ],
      ratingScale: ['healthy', 'broken'],
    });
    const conflicting = rubricTemplateDataSchema.safeParse(data({ kind: 'instrument', instrumentKey: 'a' }, 'b'));
    expect(conflicting.success).toBe(false);
    expect(JSON.stringify(conflicting.success ? '' : conflicting.error.issues)).toContain('two different instruments');
    expect(rubricTemplateDataSchema.safeParse(data({ kind: 'instrument', instrumentKey: 'a' }, 'a')).success).toBe(true);
    // tests-check beside an instrumentKey is two DIFFERENT bindings — legal.
    expect(rubricTemplateDataSchema.safeParse(data(testsCheck(['a.test.ts']), 'a')).success).toBe(true);
  });

  it('round-trips through planRowToRubric (the store read maps check 1:1, absent stays absent)', () => {
    const row = {
      plan_slug: 'r-check',
      workspace_id: 'ws',
      harness_slug: null,
      title: 'R',
      status: 'active',
      created: '2026-08-17',
      updated: '2026-08-17',
      updated_at: '2026-08-17T00:00:00.000Z',
      owner: 'su-1',
      archived: false,
      template_data: {
        characteristic: 'c',
        criteria: [
          { key: 'det', title: 't', model: 'm', method: 'm', driftMarkers: 'd', check: testsCheck(['a.test.ts']) },
          { key: 'fuzzy', title: 't', model: 'm', method: 'm', driftMarkers: 'd' },
        ],
        ratingScale: ['healthy', 'broken'],
      },
    };
    const mapped = planRowToRubric(row as never);
    expect(mapped?.criteria.find((c) => c.key === 'det')?.check).toEqual(testsCheck(['a.test.ts']));
    expect(mapped?.criteria.find((c) => c.key === 'fuzzy')?.check).toBeUndefined();
  });

  it('effectiveCriterionInstrumentKey prefers the structured check over the legacy field and model token', () => {
    expect(
      effectiveCriterionInstrumentKey({
        model: 'prose [instrumentKey: legacy-token]',
        instrumentKey: 'legacy-field',
        check: { kind: 'instrument', instrumentKey: 'structured' },
      }),
    ).toBe('structured');
    expect(effectiveCriterionInstrumentKey({ instrumentKey: 'legacy-field' })).toBe('legacy-field');
    // a tests-check is NOT an instrument binding — falls through to the legacy chain.
    expect(
      effectiveCriterionInstrumentKey({ check: testsCheck(['a.test.ts']), instrumentKey: 'legacy-field' }),
    ).toBe('legacy-field');
  });
});

// ── propose-time path validation (REFUSING — D-006) ──────────────────────────
describe('validateCriterionCheckPaths / assertCriterionCheckPathsResolve', () => {
  it('passes a resolving repo-root-relative file and returns it normalized', () => {
    const v = validateCriterionCheckPaths(
      [{ key: 'k', check: testsCheck(['packages/x/real.test.ts']) }],
      { root },
    );
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(1);
    expect(v.normalizedByKey.k).toEqual(['packages/x/real.test.ts']);
  });

  it('fails a file that does not resolve, an absolute path, and reports the criterion key', () => {
    const v = validateCriterionCheckPaths(
      [
        { key: 'missing', check: testsCheck(['packages/x/ghost.test.ts']) },
        { key: 'abs', check: testsCheck([join(root, 'packages/x/real.test.ts')]) },
      ],
      { root },
    );
    expect(v.ok).toBe(false);
    expect(v.failures.map((f) => f.criterionKey).sort()).toEqual(['abs', 'missing']);
    expect(v.failures.find((f) => f.criterionKey === 'missing')?.reason).toContain('does not resolve');
    expect(v.failures.find((f) => f.criterionKey === 'abs')?.reason).toContain('machine-specific');
  });

  it('ignores fuzzy criteria and instrument checks entirely (checked stays 0)', () => {
    const v = validateCriterionCheckPaths(
      [
        { key: 'fuzzy' },
        { key: 'inst', check: { kind: 'instrument', instrumentKey: 'x' } },
      ],
      { root },
    );
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(0);
  });

  it('assert form throws an invalid_args teaching error naming path + criterion', () => {
    expect(() =>
      assertCriterionCheckPathsResolve([{ key: 'k', check: testsCheck(['nope.test.ts']) }], { root }),
    ).toThrowError(/invalid_args:.*'k'.*nope\.test\.ts/s);
    // POSITIVE CONTROL for the guard: the same call with a resolving path returns.
    expect(() =>
      assertCriterionCheckPathsResolve([{ key: 'k', check: testsCheck(['packages/x/real.test.ts']) }], { root }),
    ).not.toThrow();
  });
});

// ── grading-time evaluation (live-run semantics, injectable runner) ───────────
// These stubs stand in for the REAL runner, so they carry the same `byFile` per-file
// grain a real report does (WI-39848) — the batched evaluator attributes verdicts from
// it. Totals are DERIVED from byFile rather than hand-written beside it, so a stub can
// never drift into an internally-inconsistent shape the real distiller could not produce.
const totalsOf = (byFile: Record<string, { passed: number; failed: number; skipped: number; collectionFailed: boolean }>) => ({
  passed: Object.values(byFile).reduce((n, b) => n + b.passed, 0),
  failed: Object.values(byFile).reduce((n, b) => n + b.failed, 0),
  skipped: Object.values(byFile).reduce((n, b) => n + b.skipped, 0),
});
const passRun = (files: string[]) => {
  const byFile = Object.fromEntries(
    files.map((f) => [f, { passed: 3, failed: 0, skipped: 0, collectionFailed: false }]),
  );
  return {
    ok: true,
    runId: 'run-1',
    root,
    ...totalsOf(byFile),
    files: files.length,
    failures: [],
    failuresTruncated: false,
    durationMs: 100,
    byFile,
  };
};
const failRun = (files: string[]) => {
  // Only the FIRST file is red — which is also what makes this a meaningful batched
  // fixture: a criterion naming a later file must NOT inherit this failure.
  const byFile = Object.fromEntries(
    files.map((f, i) => [f, { passed: i === 0 ? 2 : 3, failed: i === 0 ? 1 : 0, skipped: 0, collectionFailed: false }]),
  );
  return {
    ...passRun(files),
    ok: false,
    ...totalsOf(byFile),
    failures: [{ file: files[0], test: 'does the thing', message: 'boom' }],
    byFile,
  };
};

const CRITERIA = [
  { key: 'fuzzy', check: undefined },
  { key: 'det', check: testsCheck(['packages/x/real.test.ts']) },
];

describe('evaluateCriterionTestChecks (grading time)', () => {
  it('runs the check for a rated tests-check criterion and stamps a pass verdict', async () => {
    const calls: string[][] = [];
    const runner: CriterionCheckRunner = async ({ files }) => {
      calls.push(files);
      return passRun(files) as never;
    };
    const res = await evaluateCriterionTestChecks({
      criteria: CRITERIA,
      ratings: { fuzzy: { rating: 'healthy' }, det: { rating: 'healthy' } },
      root,
      runner,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.checkRuns.det).toMatchObject({ kind: 'tests', verdict: 'pass', passed: 3, failed: 0, runId: 'run-1' });
      expect(res.checkRuns.fuzzy).toBeUndefined();
    }
    expect(calls).toEqual([['packages/x/real.test.ts']]);
  });

  it('REFUSES a pass-claiming rating the run contradicts (check_contradicted)', async () => {
    const runner: CriterionCheckRunner = async ({ files }) => failRun(files) as never;
    const res = await evaluateCriterionTestChecks({
      criteria: CRITERIA,
      ratings: { det: { rating: 'healthy' } },
      root,
      runner,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('check_contradicted');
      expect(res.detail).toContain("'det'");
      expect(res.detail).toContain('FAILED');
    }
  });

  it('CONTROL: the SAME failing run with an honest rating is stamped, not refused — the verdict keys on the pair', async () => {
    const runner: CriterionCheckRunner = async ({ files }) => failRun(files) as never;
    const res = await evaluateCriterionTestChecks({
      criteria: CRITERIA,
      ratings: { det: { rating: 'broken' } },
      root,
      runner,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const det = res.checkRuns.det;
      expect(det.verdict).toBe('fail');
      // `failures` rides only the kind:'tests' arm of the ScorecardCheckRun union, so
      // narrow on the discriminant rather than asserting past it.
      if (det.kind !== 'tests') throw new Error(`expected a tests check run, got ${det.kind}`);
      expect(det.failures?.[0]).toContain('does the thing');
    }
  });

  it('REFUSES when the check path no longer resolves at grading time (check_path_unresolved), before any run', async () => {
    let ran = false;
    const runner: CriterionCheckRunner = async ({ files }) => {
      ran = true;
      return passRun(files) as never;
    };
    const res = await evaluateCriterionTestChecks({
      criteria: [{ key: 'det', check: testsCheck(['packages/x/deleted.test.ts']) }],
      ratings: { det: { rating: 'healthy' } },
      root,
      runner,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('check_path_unresolved');
    expect(ran).toBe(false);
  });

  it('REFUSES when the run itself cannot judge (route_error → check_run_failed)', async () => {
    const runner: CriterionCheckRunner = async () =>
      ({ ok: false, runId: 'r', root, error: 'route_error', routerOutput: 'x' }) as never;
    const res = await evaluateCriterionTestChecks({
      criteria: CRITERIA,
      ratings: { det: { rating: 'broken' } },
      root,
      runner,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('check_run_failed');
  });

  it('skips unrated tests-check criteria (emit completeness governs rating coverage separately)', async () => {
    let ran = false;
    const runner: CriterionCheckRunner = async ({ files }) => {
      ran = true;
      return passRun(files) as never;
    };
    const res = await evaluateCriterionTestChecks({
      criteria: CRITERIA,
      ratings: { fuzzy: { rating: 'healthy' } },
      root,
      runner,
    });
    expect(res.ok).toBe(true);
    expect(ran).toBe(false);
  });
});

// ── kind:'coverage' (P-006) ───────────────────────────────────────────────────
const coverageCheck = (
  scope: { surfaceKind?: string; sourceFiles?: string[]; planTouched?: true },
  floor: 'l1' | 'l2' | 'l3' | 'l4' = 'l1',
) => ({ kind: 'coverage' as const, scope, floor });

/** A census reading. Defaults describe a healthy, fully-covered, DECLARED population,
 *  so each test perturbs exactly the one field it is about. */
const measurement = (over: {
  surfaces?: number;
  meets?: number;
  belowUnwaived?: number;
  verdict?: 'measured' | 'not-measured';
  censusUnknown?: string[] | null;
  rows?: string[];
  weakest?: string | null;
} = {}): CoverageMeasurement => {
  const surfaces = over.surfaces ?? 10;
  const meets = over.meets ?? 10;
  return {
    verdict: over.verdict ?? (surfaces > 0 ? 'measured' : 'not-measured'),
    censusUnknown: over.censusUnknown ?? null,
    coverage: {
      surfaces,
      meets,
      belowUnwaived: over.belowUnwaived ?? surfaces - meets,
      pct: surfaces > 0 ? Math.round((meets / surfaces) * 1000) / 10 : null,
      fidelity: { weakest: over.weakest ?? 'declared', declaredPct: surfaces > 0 ? 100 : null },
    },
    rows: (over.rows ?? []).map((surfaceId) => ({ surfaceId, kind: 'mcp-tool', sourceFile: null })),
  };
};

const reader = (m: CoverageMeasurement, spy?: (a: Parameters<CoverageReader>[0]) => void): CoverageReader =>
  async (a) => {
    spy?.(a);
    return m;
  };

describe('rubricCriterionCheckSchema — the coverage arm (P-006)', () => {
  it('accepts a coverage check; refuses unknown fields, a bad floor, and an empty file list', () => {
    expect(rubricCriterionCheckSchema.safeParse(coverageCheck({ surfaceKind: 'mcp-tool' })).success).toBe(true);
    expect(rubricCriterionCheckSchema.safeParse(coverageCheck({ planTouched: true }, 'l3')).success).toBe(true);
    expect(rubricCriterionCheckSchema.safeParse(coverageCheck({})).success).toBe(true);
    expect(
      rubricCriterionCheckSchema.safeParse({ kind: 'coverage', scope: {}, floor: 'l1', extra: 1 }).success,
    ).toBe(false);
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'coverage', scope: {}, floor: 'l9' }).success).toBe(false);
    expect(rubricCriterionCheckSchema.safeParse(coverageCheck({ sourceFiles: [] })).success).toBe(false);
    // scope is strict too — a typo'd key must not silently widen the scope to everything
    expect(
      rubricCriterionCheckSchema.safeParse({ kind: 'coverage', scope: { surfaceKinds: 'mcp-tool' }, floor: 'l1' })
        .success,
    ).toBe(false);
  });
});

describe('validateCriterionCheckPaths — coverage scopes', () => {
  it('REFUSES a scope naming both planTouched and an explicit sourceFiles list', () => {
    const v = validateCriterionCheckPaths(
      [{ key: 'cov', check: coverageCheck({ planTouched: true, sourceFiles: ['a.ts'] }) }],
      { root },
    );
    expect(v.ok).toBe(false);
    expect(v.scopeFailures[0]?.criterionKey).toBe('cov');
    expect(() => assertCriterionCheckPathsResolve([{ key: 'cov', check: coverageCheck({ planTouched: true, sourceFiles: ['a.ts'] }) }], { root })).toThrow(/invalid_args/);
  });

  it('CONTROL: either one alone is accepted, and a coverage check never counts as a tests path', () => {
    for (const scope of [{ planTouched: true as const }, { sourceFiles: ['a.ts'] }, {}]) {
      const v = validateCriterionCheckPaths([{ key: 'cov', check: coverageCheck(scope) }], { root });
      expect(v.ok).toBe(true);
      expect(v.checked).toBe(0);
    }
  });
});

describe('evaluateCriterionCoverageChecks (grading time)', () => {
  const rated = (rating: string) => ({ cov: { rating } });

  it('stamps a pass verdict when nothing in scope is below the floor, and re-reads the census at the asked rung', async () => {
    let seen: Parameters<CoverageReader>[0] | undefined;
    const res = await evaluateCriterionCoverageChecks({
      criteria: [{ key: 'cov', check: coverageCheck({ surfaceKind: 'mcp-tool' }, 'l3') }],
      ratings: rated('healthy'),
      readCoverage: reader(measurement({ surfaces: 10, meets: 10 }), (a) => (seen = a)),
      nowIso: () => '2026-01-01T00:00:00.000Z',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.checkRuns.cov).toMatchObject({
      kind: 'coverage',
      verdict: 'pass',
      floor: 'l3',
      surfaces: 10,
      belowUnwaived: 0,
    });
    // measured NOW, at the criterion's own floor, over the gap list
    expect(seen).toMatchObject({ kind: 'mcp-tool', rung: 'l3', gapsOnly: true });
  });

  // ── FAILURE MODE 1: the vacuous pass ────────────────────────────────────────
  it('REFUSES a scope matching ZERO surfaces rather than passing it (coverage_scope_empty)', async () => {
    const res = await evaluateCriterionCoverageChecks({
      criteria: [{ key: 'cov', check: coverageCheck({ surfaceKind: 'nonesuch' }) }],
      ratings: rated('healthy'),
      readCoverage: reader(measurement({ surfaces: 0, meets: 0, censusUnknown: ['census-has-not-run: …'] })),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('coverage_scope_empty');
    expect(res.detail).toContain('ZERO censused surfaces');
    expect(res.detail).toContain('census-has-not-run');
  });

  it('REFUSES an empty scope even when the rating is HONEST — 0-of-0 is not measurable, whatever the grader says', async () => {
    const res = await evaluateCriterionCoverageChecks({
      criteria: [{ key: 'cov', check: coverageCheck({}) }],
      ratings: rated('broken'),
      readCoverage: reader(measurement({ surfaces: 0, meets: 0 })),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('coverage_scope_empty');
  });

  it('CONTROL: the SAME shape with a real denominator passes — the refusal keys on the empty population, not the scope shape', async () => {
    const res = await evaluateCriterionCoverageChecks({
      criteria: [{ key: 'cov', check: coverageCheck({}) }],
      ratings: rated('healthy'),
      readCoverage: reader(measurement({ surfaces: 1, meets: 1 })),
    });
    expect(res.ok).toBe(true);
  });

  it("REFUSES a not-measured verdict even if a count sneaked through — the words and the number are both honoured", async () => {
    const res = await evaluateCriterionCoverageChecks({
      criteria: [{ key: 'cov', check: coverageCheck({}) }],
      ratings: rated('healthy'),
      readCoverage: reader(measurement({ surfaces: 5, meets: 5, verdict: 'not-measured' })),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('coverage_scope_empty');
  });

  // ── the contradiction pair ──────────────────────────────────────────────────
  it('REFUSES a pass-claiming rating the census contradicts, NAMING the failing surfaces', async () => {
    const res = await evaluateCriterionCoverageChecks({
      criteria: [{ key: 'cov', check: coverageCheck({}, 'l2') }],
      ratings: rated('healthy'),
      readCoverage: reader(measurement({ surfaces: 10, meets: 7, rows: ['tool:a', 'tool:b', 'tool:c'] })),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('coverage_contradicted');
    expect(res.detail).toContain('3 of 10');
    expect(res.detail).toContain('tool:a');
    // `run` rides only the coverage_contradicted arm of CriterionCoverageRefusal; narrow
    // on the discriminant so the assertion below is typed rather than asserted past.
    if (res.error !== 'coverage_contradicted') {
      throw new Error(`expected coverage_contradicted, got ${res.error}`);
    }
    expect(res.run).toMatchObject({ verdict: 'fail', belowUnwaived: 3 });
  });

  it('CONTROL: the SAME failing measurement with an honest rating is STAMPED, not refused — the verdict keys on the pair', async () => {
    const res = await evaluateCriterionCoverageChecks({
      criteria: [{ key: 'cov', check: coverageCheck({}, 'l2') }],
      ratings: rated('degraded'),
      readCoverage: reader(measurement({ surfaces: 10, meets: 7, rows: ['tool:a'] })),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.checkRuns.cov).toMatchObject({ verdict: 'fail', belowUnwaived: 3 });
  });

  // ── FAILURE MODE 2: a bounded sample must not read as the whole ─────────────
  it('says the named surfaces stand for a LARGER population when the gap list is bounded', async () => {
    const res = await evaluateCriterionCoverageChecks({
      criteria: [{ key: 'cov', check: coverageCheck({}) }],
      ratings: rated('healthy'),
      readCoverage: reader(measurement({ surfaces: 100, meets: 60, rows: ['a', 'b'] })),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.detail).toContain('+38 more');
  });

  it('carries the fidelity ceiling into the refusal — a partial census flatters, and the message must say so', async () => {
    const res = await evaluateCriterionCoverageChecks({
      criteria: [{ key: 'cov', check: coverageCheck({}) }],
      ratings: rated('healthy'),
      readCoverage: reader(measurement({ surfaces: 10, meets: 4, rows: ['a'], weakest: 'file-only' })),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.detail).toContain('file-only');
    expect(res.detail).toContain('flatters');
  });

  // ── plan-touched: the reverse map ───────────────────────────────────────────
  it('resolves planTouched to the plan\'s changed files and measures over THEM', async () => {
    let seen: Parameters<CoverageReader>[0] | undefined;
    const res = await evaluateCriterionCoverageChecks({
      criteria: [{ key: 'cov', check: coverageCheck({ planTouched: true }) }],
      ratings: rated('healthy'),
      readCoverage: reader(measurement({ surfaces: 3, meets: 3 }), (a) => (seen = a)),
      resolvePlanTouchedFiles: async () => ['packages/x/a.ts', 'packages/x/b.ts'],
    });
    expect(res.ok).toBe(true);
    expect(seen?.sourceFiles).toEqual(['packages/x/a.ts', 'packages/x/b.ts']);
    if (!res.ok) return;
    // the record stores what was MEASURED, not merely the intent to measure
    expect(res.checkRuns.cov).toMatchObject({
      scope: { planTouched: true, sourceFiles: ['packages/x/a.ts', 'packages/x/b.ts'] },
    });
  });

  it('REFUSES planTouched that resolves to NOTHING instead of silently widening to the whole census', async () => {
    for (const resolver of [async () => null, async () => [] as string[]]) {
      let called = false;
      const res = await evaluateCriterionCoverageChecks({
        criteria: [{ key: 'cov', check: coverageCheck({ planTouched: true }) }],
        ratings: rated('healthy'),
        readCoverage: reader(measurement({ surfaces: 999, meets: 999 }), () => (called = true)),
        resolvePlanTouchedFiles: resolver,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toBe('coverage_scope_empty');
      // and it never got as far as measuring the unscoped census
      expect(called).toBe(false);
    }
  });

  it('skips unrated and non-coverage criteria without reading the census at all', async () => {
    let called = false;
    const res = await evaluateCriterionCoverageChecks({
      criteria: [
        { key: 'cov', check: coverageCheck({}) },
        { key: 'fuzzy' },
        { key: 'det', check: testsCheck(['packages/x/real.test.ts']) },
      ],
      ratings: { det: { rating: 'healthy' } },
      readCoverage: reader(measurement(), () => (called = true)),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Object.keys(res.checkRuns)).toEqual([]);
    expect(called).toBe(false);
  });
});
