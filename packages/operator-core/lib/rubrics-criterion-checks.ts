/**
 * rubrics-criterion-checks — the STRUCTURED CRITERION CHECK enforcement
 * (consult-min-max-and-rubric-vetting-2026-08-17 P-011, owner-ratified D-006).
 *
 * A rubric criterion may carry an optional structured `check`:
 *   - kind:'tests' { files } — a DETERMINISTIC must-pass binding. Two enforcement
 *     points, both here:
 *       PROPOSE time — every named file must RESOLVE against the live tree or the
 *       propose is REFUSED (unlike the advisory replicationSqlCheck, whose subject is
 *       external moving-target DB state, a file path is fully in-our-control: a check
 *       that can never run is a booby trap, not advice — the same posture as the
 *       plan-audit citation resolver and the acceptance-kind link guards).
 *       GRADING time — scorecards:emit actually RUNS the files via the testing:run
 *       core (never stale ledger rows), REFUSES a path that no longer resolves rather
 *       than silently passing, and REFUSES a rating the run contradicts (a 'healthy'
 *       rating over a failing must-pass suite is a wrong scorecard, not a note).
 *   - kind:'instrument' — the generalized instrument binding; nothing to enforce
 *     against the tree (the scorecard instrument contract already governs it).
 *   - absent — a fuzzy judgment criterion; this module ignores it entirely.
 *
 * Fuzzy + deterministic criteria coexist in one rubric.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { resolveAgentWorkspaceRoot } from './agent-tools/capability/base-dir';
import { normalizeTestFilePaths, runTestFilesCore, type TestFilesCoreResult } from './agent-tools/testing/run';
import type { RubricCriterionCheck } from './agent-tools/plans/rubric-template';

/** The minimal criterion shape this module reads — key + the optional check. */
export interface CheckedCriterion {
  key: string;
  check?: RubricCriterionCheck;
}

export interface CriterionCheckPathFailure {
  criterionKey: string;
  path: string;
  reason: string;
}

export interface CriterionCheckPathValidation {
  ok: boolean;
  /** The tree the paths were resolved against — echoed so a wrong-tree validation is
   *  visible instead of silent (the WI-7189 lesson, inherited from testing:run). */
  root: string;
  /** tests-check files examined across all criteria (0 ⇒ no criterion carries one). */
  checked: number;
  failures: CriterionCheckPathFailure[];
  /** Criterion key → its files NORMALIZED to repo-root-relative form (workspace-relative
   *  spellings expanded). Present for every tests-check criterion that validated clean —
   *  callers should persist THESE so grading-time resolution is deterministic. */
  normalizedByKey: Record<string, string[]>;
}

/**
 * PROPOSE-time validation: every kind:'tests' check file must resolve against the live
 * tree. Absolute paths are refused outright — a stored absolute path is machine-specific
 * and escapes the tree the check claims to be about; repo-root-relative (or unambiguous
 * workspace-relative, which is normalized) is the portable contract.
 */
export function validateCriterionCheckPaths(
  criteria: ReadonlyArray<CheckedCriterion>,
  opts: { root?: string } = {},
): CriterionCheckPathValidation {
  const root = opts.root ?? resolveAgentWorkspaceRoot({});
  const failures: CriterionCheckPathFailure[] = [];
  const normalizedByKey: Record<string, string[]> = {};
  let checked = 0;
  for (const c of criteria) {
    if (c.check?.kind !== 'tests') continue;
    const absolutes = c.check.files.filter((f) => isAbsolute(f));
    for (const f of absolutes) {
      checked++;
      failures.push({
        criterionKey: c.key,
        path: f,
        reason: 'absolute paths are machine-specific — name the file repo-root-relative',
      });
    }
    const relative = c.check.files.filter((f) => !isAbsolute(f));
    if (relative.length === 0) continue;
    const resolution = normalizeTestFilePaths([...relative], root);
    if (!resolution.ok) {
      checked += relative.length;
      failures.push({
        criterionKey: c.key,
        path: resolution.path,
        reason: `ambiguous workspace-relative path — exists in multiple workspaces (${resolution.matches.join(', ')}); use the repo-root-relative form`,
      });
      continue;
    }
    const normalized: string[] = [];
    for (const f of resolution.files) {
      checked++;
      if (!existsSync(resolve(root, f))) {
        failures.push({ criterionKey: c.key, path: f, reason: 'does not resolve against the live tree' });
        continue;
      }
      normalized.push(f);
    }
    if (normalized.length === relative.length && absolutes.length === 0) {
      normalizedByKey[c.key] = normalized;
    }
  }
  return { ok: failures.length === 0, root, checked, failures, normalizedByKey };
}

/**
 * The refusing form, called from the proposeRubric LIB write path (like the WI-4287
 * loss-guards, so every caller inherits it). `invalid_args:` prefix per EI-10148 —
 * this is a CALLER error, never a structural tool bug.
 */
export function assertCriterionCheckPathsResolve(
  criteria: ReadonlyArray<CheckedCriterion>,
  opts: { root?: string } = {},
): void {
  const v = validateCriterionCheckPaths(criteria, opts);
  if (v.ok) return;
  throw new Error(
    `invalid_args: proposeRubric: structured tests-check paths must resolve against the live tree ` +
      `(P-011 / D-006 — a check that can never run is a booby trap, not advice). Against root '${v.root}':\n` +
      v.failures.map((f) => `  • criterion '${f.criterionKey}': ${f.path} — ${f.reason}`).join('\n') +
      `\nFix the path(s) (repo-root-relative), or drop the check to leave the criterion fuzzy.`,
  );
}

/** One criterion's grading-time check run — stamped onto the scorecard observation as
 *  `checkRuns[criterionKey]` so a rating the run contradicts is machine-detectable
 *  from the record itself (D-006). */
export interface CriterionCheckRun {
  kind: 'tests';
  files: string[];
  verdict: 'pass' | 'fail';
  /** Test counts from the run (complete, never truncated). */
  passed: number;
  failed: number;
  /** The run correlation id (PAPERCUSP_TEST_RUN_GROUP) — ledger rows are findable by it. */
  runId: string | null;
  /** ISO instant the run finished (emit time — this is a LIVE run, never a ledger read). */
  measuredAt: string;
  /** Bounded failing-test names (file: test), only on a 'fail' verdict. */
  failures?: string[];
}

export type CriterionCheckRefusal =
  | {
      ok: false;
      error: 'check_path_unresolved';
      criterionKey: string;
      paths: string[];
      detail: string;
    }
  | {
      ok: false;
      error: 'check_run_failed';
      criterionKey: string;
      detail: string;
    }
  | {
      ok: false;
      error: 'check_contradicted';
      criterionKey: string;
      rating: string;
      detail: string;
      run: CriterionCheckRun;
    };

export type CriterionCheckEvaluation =
  | { ok: true; checkRuns: Record<string, CriterionCheckRun> }
  | CriterionCheckRefusal;

/** Injectable runner seam (tests stub this; production shells the real router). */
export type CriterionCheckRunner = (opts: {
  files: string[];
  root: string;
  timeoutMs?: number;
}) => Promise<TestFilesCoreResult>;

/** Ratings whose meaning a failing must-pass run CONTRADICTS — the same vocabulary map
 *  the scorecard instrument contract uses for verdict mismatches, applied to the binary
 *  tests-check. A rating outside the map (a bespoke scale word) is stamped but never
 *  refused: the map is deliberately conservative so an unfamiliar vocabulary degrades
 *  to machine-detectable rather than wrongly refused. */
function ratingClaimsPass(rating: string): boolean {
  return ['pass', 'healthy', 'green', 'good', 'yes', 'exemplary', 'exceptional'].includes(
    rating.trim().toLowerCase(),
  );
}

/**
 * GRADING-time evaluation (called by scorecards:emit): for every RATED criterion whose
 * check is kind:'tests', re-resolve the files (refusing a stale path — D-006), RUN them
 * through the testing:run core (one run per criterion, so attribution is exact and a
 * truncated failure list can never mis-assign a verdict), and refuse a rating the run
 * contradicts. Sequential on purpose: checks share one tree and one worker budget.
 */
export async function evaluateCriterionTestChecks(input: {
  criteria: ReadonlyArray<CheckedCriterion>;
  /** Criterion key → the rating string being emitted (only RATED criteria are checked —
   *  emit's completeness validation separately guarantees every criterion is rated). */
  ratings: Record<string, { rating: string } | undefined>;
  root?: string;
  /** Total run budget across ALL checks (ms); each run gets what remains. */
  timeoutMs?: number;
  runner?: CriterionCheckRunner;
  nowIso?: () => string;
}): Promise<CriterionCheckEvaluation> {
  const root = input.root ?? resolveAgentWorkspaceRoot({});
  const runner = input.runner ?? runTestFilesCore;
  const nowIso = input.nowIso ?? (() => new Date().toISOString());
  const deadline = input.timeoutMs !== undefined ? Date.now() + input.timeoutMs : null;
  const checkRuns: Record<string, CriterionCheckRun> = {};
  for (const c of input.criteria) {
    if (c.check?.kind !== 'tests') continue;
    if (input.ratings[c.key] === undefined) continue;
    // Re-resolve at grading time — the tree has moved since propose. A path that no
    // longer resolves REFUSES the emit rather than silently passing (D-006 verbatim).
    const validation = validateCriterionCheckPaths([c], { root });
    if (!validation.ok) {
      return {
        ok: false,
        error: 'check_path_unresolved',
        criterionKey: c.key,
        paths: validation.failures.map((f) => f.path),
        detail:
          `criterion '${c.key}' carries a tests-check whose file(s) no longer resolve against '${root}': ` +
          validation.failures.map((f) => `${f.path} (${f.reason})`).join('; ') +
          ` — grading a deterministic criterion whose check cannot run would be a silent pass. ` +
          `Fix the rubric's check (rubrics:propose) or restore the file(s), then re-emit.`,
      };
    }
    const files = validation.normalizedByKey[c.key] ?? [...c.check.files];
    const remaining = deadline === null ? undefined : Math.max(1000, deadline - Date.now());
    const run = await runner({ files, root, ...(remaining !== undefined ? { timeoutMs: remaining } : {}) });
    if (run.error !== undefined) {
      return {
        ok: false,
        error: 'check_run_failed',
        criterionKey: c.key,
        detail:
          `criterion '${c.key}' tests-check could not be judged (${run.error}${'hint' in run && run.hint ? ` — ${run.hint}` : ''}). ` +
          `D-006 requires the named files to actually RUN at grading time — an unjudgeable check refuses ` +
          `the emit rather than passing silently.`,
      };
    }
    const record: CriterionCheckRun = {
      kind: 'tests',
      files,
      verdict: run.failed === 0 && run.ok === true ? 'pass' : 'fail',
      passed: run.passed,
      failed: run.failed,
      runId: run.runId ?? null,
      measuredAt: nowIso(),
      ...(run.failed > 0 && Array.isArray(run.failures)
        ? {
            failures: run.failures
              .slice(0, 10)
              .map((f) => `${(f as { file?: string }).file ?? '?'}: ${(f as { test?: string }).test ?? '?'}`),
          }
        : {}),
    };
    const rating = input.ratings[c.key]?.rating ?? '';
    if (record.verdict === 'fail' && ratingClaimsPass(rating)) {
      return {
        ok: false,
        error: 'check_contradicted',
        criterionKey: c.key,
        rating,
        run: record,
        detail:
          `criterion '${c.key}' is rated '${rating}' but its deterministic tests-check FAILED ` +
          `(${record.failed} failing of ${record.passed + record.failed} run${record.failures ? `: ${record.failures.join(' · ')}` : ''}). ` +
          `A must-pass check outranks judgment — fix the code (or the tests), or rate the criterion honestly.`,
      };
    }
    checkRuns[c.key] = record;
  }
  return { ok: true, checkRuns };
}
