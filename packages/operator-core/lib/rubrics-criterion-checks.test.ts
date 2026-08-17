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
  type CriterionCheckRunner,
} from './rubrics-criterion-checks';
import { rubricCriterionSchema, rubricTemplateDataSchema, rubricCriterionCheckSchema } from './agent-tools/plans/rubric-template';
import { effectiveCriterionInstrumentKey } from './rubrics';

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
const passRun = (files: string[]) => ({
  ok: true,
  runId: 'run-1',
  root,
  passed: 3,
  failed: 0,
  skipped: 0,
  files: files.length,
  failures: [],
  failuresTruncated: false,
  durationMs: 100,
});
const failRun = (files: string[]) => ({
  ...passRun(files),
  ok: false,
  passed: 2,
  failed: 1,
  failures: [{ file: files[0], test: 'does the thing', message: 'boom' }],
});

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
      expect(res.checkRuns.det.verdict).toBe('fail');
      expect(res.checkRuns.det.failures?.[0]).toContain('does the thing');
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
