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
import { REPO_ROOT } from './agent-tools/docs/_repo-paths';
import { normalizeTestFilePaths, runTestFilesCore, type TestFilesCoreResult } from './agent-tools/testing/run';
import { selectUnambiguousEvidenceRoot } from './evidence-root-selection';
import type { RubricCriterionCheck } from './agent-tools/plans/rubric-template';
import type {
  ScorecardCheckRun,
  ScorecardCoverageCheckRun,
} from './harness/improvements/observation-types';

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
  /**
   * STRUCTURAL faults in kind:'coverage' scopes, found without touching the database.
   *
   * ⚠ Deliberately NOT the coverage analog of the tests arm's existsSync: "does this
   * scope match any surface" is a census QUERY, and the census legitimately moves
   * between propose and grade (a surface censused today may be retired tomorrow), so a
   * propose-time DB answer would be stale precisely when it mattered and would make
   * this pure function async for every caller. The vacuity refusal that actually
   * protects the gate — a scope resolving to ZERO surfaces — is enforced at GRADING
   * time in {@link evaluateCriterionCoverageChecks}, where it is measured fresh. What
   * IS caught here is the fault no query can fix: a scope that contradicts itself.
   */
  scopeFailures: CriterionCheckPathFailure[];
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
  const scopeFailures: CriterionCheckPathFailure[] = [];
  const normalizedByKey: Record<string, string[]> = {};
  let checked = 0;
  for (const c of criteria) {
    if (c.check?.kind === 'coverage') {
      // A scope naming BOTH an explicit file list and planTouched is contradictory:
      // planTouched RESOLVES to a file list at grading time, so the two would silently
      // race and whichever won would be invisible in the record. Refuse rather than pick.
      if (c.check.scope.planTouched === true && (c.check.scope.sourceFiles?.length ?? 0) > 0) {
        scopeFailures.push({
          criterionKey: c.key,
          path: 'scope',
          reason:
            'scope names both planTouched and an explicit sourceFiles list — planTouched IS the ' +
            'file list, resolved from the subject plan at grading time. Pick one.',
        });
      }
      continue;
    }
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
  return {
    ok: failures.length === 0 && scopeFailures.length === 0,
    root,
    checked,
    failures,
    scopeFailures,
    normalizedByKey,
  };
}

/** Where a selected check-validation root came from — echoed on results so a
 *  canonical-repo validation is visible, never silent (the WI-7189 lesson). */
export type CriterionCheckRootSource = 'requested' | 'canonical-repo';

export interface SelectedCriterionCheckRoot {
  root: string;
  source: CriterionCheckRootSource;
  /** The validation computed against the SELECTED root — callers use this instead of
   *  re-running, so selection and enforcement can never disagree. */
  validation: CriterionCheckPathValidation;
}

/**
 * WI-41394 — the WI-41365 phantom-root class, this validator's own rung. A hive-scoped
 * session resolves its workspace root from a stale registry entry (e.g. /tmp/devboard),
 * a tree that does not exist — so every tests-check path was refused for a reason that
 * had nothing to do with the paths, and a hive-commissioned rubric whose evidence lives
 * in the canonical repo could not carry a structured check at all.
 *
 * Precedence mirrors selectHarnessCitationRepoRoot (plan-audits.ts): the REQUESTED root
 * stays authoritative whenever every tests-check path resolves there; the canonical repo
 * is accepted only when it resolves them ALL; otherwise the requested root is kept, so
 * failures report against the tree the agent claims to edit rather than a tree that
 * happens to be missing different files. Scope faults are root-independent and play no
 * part in selection.
 */
export function selectCriterionCheckRoot(
  criteria: ReadonlyArray<CheckedCriterion>,
  requested: string,
  canonicalRepoRoot: string = REPO_ROOT,
): SelectedCriterionCheckRoot {
  const validations = new Map<string, CriterionCheckPathValidation>();
  const validationFor = (root: string): CriterionCheckPathValidation => {
    const key = resolve(root);
    const cached = validations.get(key);
    if (cached) return cached;
    const validation = validateCriterionCheckPaths(criteria, { root });
    validations.set(key, validation);
    return validation;
  };
  const selected = selectUnambiguousEvidenceRoot<CriterionCheckRootSource>({
    preferred: { root: requested, source: 'requested' },
    fallback: { root: canonicalRepoRoot, source: 'canonical-repo' },
    // Scope faults are root-independent and deliberately do not choose a tree.
    resolvesEvery: (root) => validationFor(root).failures.length === 0,
  }) ?? { root: requested, source: 'requested' as const };
  return { ...selected, validation: validationFor(selected.root) };
}

/**
 * The refusing form, called from the proposeRubric LIB write path (like the WI-4287
 * loss-guards, so every caller inherits it). `invalid_args:` prefix per EI-10148 —
 * this is a CALLER error, never a structural tool bug. Root selection runs first
 * (WI-41394): a requested root that cannot resolve the paths falls back to the
 * canonical repo when — and only when — every path resolves there.
 */
export function assertCriterionCheckPathsResolve(
  criteria: ReadonlyArray<CheckedCriterion>,
  opts: { root?: string } = {},
): void {
  const requested = opts.root ?? resolveAgentWorkspaceRoot({});
  const v = selectCriterionCheckRoot(criteria, requested).validation;
  if (v.ok) return;
  const parts: string[] = [];
  if (v.failures.length > 0) {
    parts.push(
      `structured tests-check paths must resolve against the live tree ` +
        `(P-011 / D-006 — a check that can never run is a booby trap, not advice). Against root '${v.root}':\n` +
        v.failures.map((f) => `  • criterion '${f.criterionKey}': ${f.path} — ${f.reason}`).join('\n') +
        `\nFix the path(s) (repo-root-relative), or drop the check to leave the criterion fuzzy.`,
    );
  }
  if (v.scopeFailures.length > 0) {
    parts.push(
      `structured coverage-check scopes must be self-consistent:\n` +
        v.scopeFailures.map((f) => `  • criterion '${f.criterionKey}': ${f.reason}`).join('\n'),
    );
  }
  throw new Error(`invalid_args: proposeRubric: ${parts.join('\n\n')}`);
}

/** One criterion's grading-time check run — the persisted shape is the ledger's
 *  {@link ScorecardCheckRun} (observation-types.ts), stamped onto the scorecard as
 *  `checkRuns[criterionKey]` so a rating the run contradicts is machine-detectable
 *  from the record itself (D-006). */
export type CriterionCheckRun = ScorecardCheckRun;

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

export type CriterionCoverageRefusal =
  | {
      ok: false;
      error: 'coverage_scope_empty';
      criterionKey: string;
      detail: string;
    }
  | {
      ok: false;
      error: 'coverage_contradicted';
      criterionKey: string;
      rating: string;
      detail: string;
      run: CoverageCheckRun;
    };

export type CriterionCheckEvaluation =
  | { ok: true; checkRuns: Record<string, CriterionCheckRun> }
  | CriterionCheckRefusal
  | CriterionCoverageRefusal;

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
 * through the testing:run core, and refuse a rating the run contradicts.
 *
 * ONE BATCHED RUN for all files, attributed per criterion via the report's `byFile`
 * grain (WI-39848). This replaced one-run-per-criterion, which was chosen so that "a
 * truncated failure list can never mis-assign a verdict" — a real hazard, but it bought
 * that safety with N cold vitest starts against a SINGLE shared deadline, so each run ate
 * the budget the next one needed and the LAST criterion starved deterministically. A
 * 7-check rubric became ungradeable, which blocked its plan's ship gate outright.
 * `byFile` gives exact per-file counts that stay complete even when the failure LIST is
 * capped, so batching now keeps the original safety property AND removes the starvation:
 * the truncation hazard is answered by the data, not by paying for extra processes.
 * A file the report never mentions is refused as unjudged, never treated as a pass.
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
  // WI-41394: select the validation/run root over the rated tests-check subset — the
  // same subset validated below — so a phantom requested root (a stale hive registry
  // entry) falls back to the canonical repo exactly when every checked path resolves
  // there, and propose-time acceptance cannot diverge from grading-time refusal.
  const ratedTestsChecks = input.criteria.filter(
    (c) => c.check?.kind === 'tests' && input.ratings[c.key] !== undefined,
  );
  const root = selectCriterionCheckRoot(ratedTestsChecks, input.root ?? resolveAgentWorkspaceRoot({})).root;
  const runner = input.runner ?? runTestFilesCore;
  const nowIso = input.nowIso ?? (() => new Date().toISOString());
  const deadline = input.timeoutMs !== undefined ? Date.now() + input.timeoutMs : null;
  const checkRuns: Record<string, CriterionCheckRun> = {};

  // ── Pass 1: resolve every rated tests-check's paths BEFORE running anything ──
  // Path resolution is per-criterion and must keep its own refusal (D-006), so a stale
  // path still names the criterion that carries it. Doing all of it up front also means
  // a rubric with one bad path costs zero test runs instead of failing partway through.
  const planned: { key: string; files: string[] }[] = [];
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
    planned.push({ key: c.key, files: validation.normalizedByKey[c.key] ?? [...c.check.files] });
  }
  if (planned.length === 0) return { ok: true, checkRuns };

  // ── Pass 2: ONE batched run for every file, then attribute per criterion ──
  // WI-39848: this used to be one vitest process PER criterion against a SHARED deadline
  // (`Math.max(1000, deadline - Date.now())`), so each run ate budget the next one needed
  // and the LAST criterion was starved deterministically — a 7-check rubric could never be
  // graded, and the refusal blamed the starved criterion's file for being "too slow" when
  // the budget had been spent upstream. The cost driver was N cold starts, not any one
  // suite, so the fix is to pay for ONE. Attribution stays exact because it now reads
  // `byFile` — per-file counts that are complete even when the failure LIST is capped.
  const uniqueFiles = [...new Set(planned.flatMap((p) => p.files))];
  const budget = deadline === null ? undefined : Math.max(1000, deadline - Date.now());
  const run = await runner({ files: uniqueFiles, root, ...(budget !== undefined ? { timeoutMs: budget } : {}) });
  if (run.error !== undefined) {
    return {
      ok: false,
      error: 'check_run_failed',
      criterionKey: planned[0]?.key ?? '(none)',
      detail:
        `the batched tests-check run for ${planned.length} criterion/criteria ` +
        `(${uniqueFiles.length} file(s): ${uniqueFiles.join(', ')}) could not be judged ` +
        `(${run.error}${'hint' in run && run.hint ? ` — ${run.hint}` : ''}). ` +
        `D-006 requires the named files to actually RUN at grading time — an unjudgeable check refuses ` +
        `the emit rather than passing silently. NOTE: this is the whole batch, so it does NOT single out ` +
        `any one criterion's suite as the slow one.`,
    };
  }

  // A runner that reports no per-file grain (a stub, or an older shape) cannot be
  // attributed from a batch. Refuse rather than spread the batch's aggregate across
  // criteria — that would let one criterion's failure condemn another's, or worse, let a
  // green aggregate vouch for a file that never reported.
  const byFile = (run as { byFile?: Record<string, { passed: number; failed: number; skipped: number; collectionFailed: boolean }> }).byFile;
  if (byFile === undefined) {
    return {
      ok: false,
      error: 'check_run_failed',
      criterionKey: planned[0]?.key ?? '(none)',
      detail:
        `the batched tests-check run returned no per-file breakdown (byFile), so its result cannot be ` +
        `attributed to individual criteria. Refusing rather than judging every criterion on the batch ` +
        `aggregate, which would let one criterion's failure condemn another's.`,
    };
  }

  for (const { key, files } of planned) {
    // A file the report never mentions is UNJUDGED, not passed. Without this the batch's
    // green aggregate would vouch for a file that silently failed to run at all.
    const missing = files.filter((f) => byFile[f] === undefined);
    if (missing.length > 0) {
      return {
        ok: false,
        error: 'check_run_failed',
        criterionKey: key,
        detail:
          `criterion '${key}' names test file(s) the batched run never reported on ` +
          `(${missing.join(', ')}), so the check is unjudged. Treating an unreported file as a pass ` +
          `would be exactly the silent pass D-006 forbids.`,
      };
    }
    const passed = files.reduce((n, f) => n + (byFile[f]?.passed ?? 0), 0);
    const failed = files.reduce((n, f) => n + (byFile[f]?.failed ?? 0), 0);
    const record: CriterionCheckRun = {
      kind: 'tests',
      files,
      verdict: failed === 0 ? 'pass' : 'fail',
      passed,
      failed,
      runId: run.runId ?? null,
      measuredAt: nowIso(),
      ...(failed > 0 && Array.isArray(run.failures)
        ? {
            failures: run.failures
              .filter((f) => files.includes((f as { file?: string }).file ?? ''))
              .slice(0, 10)
              .map((f) => `${(f as { file?: string }).file ?? '?'}: ${(f as { test?: string }).test ?? '?'}`),
          }
        : {}),
    };
    const rating = input.ratings[key]?.rating ?? '';
    if (record.verdict === 'fail' && ratingClaimsPass(rating)) {
      return {
        ok: false,
        error: 'check_contradicted',
        criterionKey: key,
        rating,
        run: record,
        detail:
          `criterion '${key}' is rated '${rating}' but its deterministic tests-check FAILED ` +
          `(${record.failed} failing of ${record.passed + record.failed} run${record.failures ? `: ${record.failures.join(' · ')}` : ''}). ` +
          `A must-pass check outranks judgment — fix the code (or the tests), or rate the criterion honestly.`,
      };
    }
    checkRuns[key] = record;
  }
  return { ok: true, checkRuns };
}

/** The coverage run record — {@link ScorecardCoverageCheckRun}, re-exported for callers. */
export type CoverageCheckRun = ScorecardCoverageCheckRun;

/**
 * The slice of `readCoverage`'s response this module judges on. Declared STRUCTURALLY
 * rather than importing the inferred return type so the seam is stubbable in tests —
 * and, more importantly, so what the gate actually depends on is written down: if
 * `readCoverage` ever stops returning one of these, this breaks HERE, loudly, instead
 * of the gate quietly judging on an `undefined` that coerces to a passing 0.
 */
export interface CoverageMeasurement {
  verdict: 'measured' | 'not-measured';
  censusUnknown: string[] | null;
  coverage: {
    surfaces: number;
    meets: number;
    belowUnwaived: number;
    pct: number | null;
    fidelity: { weakest: string | null; declaredPct: number | null };
  };
  rows: { surfaceId: string; kind: string; sourceFile: string | null }[];
}

/** Injectable census-read seam (tests stub this; production passes `readCoverage`). */
export type CoverageReader = (args: {
  kind?: string;
  sourceFiles?: string[];
  rung: 'l1' | 'l2' | 'l3' | 'l4';
  gapsOnly: boolean;
  limit: number;
}) => Promise<CoverageMeasurement>;

/**
 * Resolves `scope.planTouched` to the file list it stands for: the implementing files
 * the subject plan's completed work actually changed. Returns null when the caller has
 * no plan subject to resolve against — which REFUSES the check rather than silently
 * widening it to the whole census.
 */
export type PlanTouchedFilesResolver = () => Promise<string[] | null>;

/** How many failing surfaces to name in a refusal before summarising the rest. */
const MAX_NAMED_SURFACES = 12;

/**
 * GRADING-time evaluation for kind:'coverage' checks — the census counterpart of
 * {@link evaluateCriterionTestChecks}, holding the identical three-part contract:
 * measure NOW (never a stale row), refuse what cannot be judged, and refuse a
 * pass-claiming rating the measurement contradicts.
 *
 * The three failure modes it is built to NOT have — each of them this plan's own
 * subject matter, so shipping one here would be self-refuting:
 *
 *  1. **0-of-0 rendering as pass.** A scope matching ZERO censused surfaces REFUSES.
 *     An empty scope is the cheapest possible way to make a coverage gate vacuously
 *     green ("0 gaps! everything is covered"), and `readCoverage` already refuses to
 *     express it as a ratio — `pct` is null and `verdict` says `not-measured` in words.
 *     A gate that passed there would contradict the very surface it reads.
 *  2. **A truncated population flattering the ratio.** The census can be a real number
 *     about a partial world (WI-39812: 675 defineTool files censused as 49, because the
 *     catalog is module-split). Truncation ALWAYS flatters, since surfaces that were
 *     never enumerated cannot appear as gaps — so every verdict message carries the
 *     fidelity marker, and the record stores it.
 *  3. **Stale evidence.** The census is re-read here, at grading time.
 */
export async function evaluateCriterionCoverageChecks(input: {
  criteria: ReadonlyArray<CheckedCriterion>;
  ratings: Record<string, { rating: string } | undefined>;
  readCoverage: CoverageReader;
  resolvePlanTouchedFiles?: PlanTouchedFilesResolver;
  nowIso?: () => string;
}): Promise<CriterionCheckEvaluation> {
  const nowIso = input.nowIso ?? (() => new Date().toISOString());
  const checkRuns: Record<string, CriterionCheckRun> = {};
  let planTouchedFiles: string[] | null | undefined;

  for (const c of input.criteria) {
    if (c.check?.kind !== 'coverage') continue;
    if (input.ratings[c.key] === undefined) continue;
    const { scope, floor } = c.check;

    // ── Resolve the scope. planTouched expands to a real file list HERE, so the record
    //    stores what was measured rather than the intention to measure something.
    let sourceFiles = scope.sourceFiles;
    if (scope.planTouched === true) {
      if (planTouchedFiles === undefined) {
        planTouchedFiles = input.resolvePlanTouchedFiles ? await input.resolvePlanTouchedFiles() : null;
      }
      if (planTouchedFiles === null || planTouchedFiles.length === 0) {
        return {
          ok: false,
          error: 'coverage_scope_empty',
          criterionKey: c.key,
          detail:
            `criterion '${c.key}' carries a coverage-check scoped to planTouched, but no changed files ` +
            `could be resolved for the subject plan${planTouchedFiles === null ? ' (no plan subject on this emit)' : ' (its completed work-items record no filesChanged)'}. ` +
            `An unresolved scope would measure the WHOLE census instead of this plan's surfaces — ` +
            `silently widening a gate is worse than refusing it. Give the criterion an explicit ` +
            `scope.sourceFiles, or grade a card whose subject plan has completion evidence.`,
        };
      }
      sourceFiles = planTouchedFiles;
    }

    // ── Measure. ONE read: the aggregates are computed over the whole in-scope
    //    population regardless of gapsOnly (which bounds only the returned rows), so
    //    this yields both an unbounded verdict and a bounded list of names for it.
    const measurement = await input.readCoverage({
      ...(scope.surfaceKind ? { kind: scope.surfaceKind } : {}),
      ...(sourceFiles && sourceFiles.length > 0 ? { sourceFiles } : {}),
      rung: floor,
      gapsOnly: true,
      limit: MAX_NAMED_SURFACES,
    });

    // ── FAILURE MODE 1. Zero denominator ⇒ refuse. Never a pass, never a 0%, never 100%.
    if (measurement.verdict === 'not-measured' || measurement.coverage.surfaces === 0) {
      return {
        ok: false,
        error: 'coverage_scope_empty',
        criterionKey: c.key,
        detail:
          `criterion '${c.key}' carries a coverage-check whose scope matches ZERO censused surfaces, ` +
          `so there is nothing to be covered and no denominator to form a ratio from ` +
          `(${describeScope(scope, sourceFiles)}, floor ${floor}). ` +
          (measurement.censusUnknown?.length
            ? `The census says why: ${measurement.censusUnknown.join(' | ')}. `
            : '') +
          `Passing here would be a vacuous truth — "0 gaps" because nothing was ever looked at. ` +
          `Fix the scope so it names real surfaces, or drop the check to leave the criterion fuzzy.`,
      };
    }

    const { surfaces, meets, belowUnwaived, pct, fidelity } = measurement.coverage;
    const belowSurfaces = measurement.rows.map((r) => r.surfaceId);
    const record: CoverageCheckRun = {
      kind: 'coverage',
      scope: {
        ...(scope.surfaceKind ? { surfaceKind: scope.surfaceKind } : {}),
        ...(sourceFiles && sourceFiles.length > 0 ? { sourceFiles } : {}),
        ...(scope.planTouched === true ? { planTouched: true as const } : {}),
      },
      floor,
      verdict: belowUnwaived === 0 ? 'pass' : 'fail',
      surfaces,
      meets,
      belowUnwaived,
      pct,
      fidelity,
      ...(belowSurfaces.length > 0 ? { belowSurfaces } : {}),
      measuredAt: nowIso(),
    };

    const rating = input.ratings[c.key]?.rating ?? '';
    if (record.verdict === 'fail' && ratingClaimsPass(rating)) {
      return {
        ok: false,
        error: 'coverage_contradicted',
        criterionKey: c.key,
        rating,
        run: record,
        detail:
          `criterion '${c.key}' is rated '${rating}' but ${belowUnwaived} of ${surfaces} censused ` +
          `surfaces in scope do NOT meet ${floor} (${describeScope(scope, sourceFiles)}): ` +
          `${namedSurfaces(belowSurfaces, belowUnwaived)}. ` +
          `${fidelityCaveat(fidelity)} ` +
          `A measured gap outranks judgment — prove the surfaces to ${floor}, waive them ` +
          `deliberately, or rate the criterion honestly.`,
      };
    }
    checkRuns[c.key] = record;
  }
  return { ok: true, checkRuns };
}

function describeScope(
  scope: { surfaceKind?: string; sourceFiles?: string[]; planTouched?: true },
  resolvedFiles: string[] | undefined,
): string {
  const parts: string[] = [];
  if (scope.surfaceKind) parts.push(`kind=${scope.surfaceKind}`);
  if (scope.planTouched === true) {
    parts.push(`planTouched=${resolvedFiles ? `${resolvedFiles.length} file(s)` : 'unresolved'}`);
  } else if (resolvedFiles && resolvedFiles.length > 0) {
    parts.push(`files=${resolvedFiles.length}`);
  }
  return parts.length > 0 ? `scope ${parts.join(' ')}` : 'scope = the whole harness census';
}

/** Names the surfaces, and says so when the named list stands for a larger population —
 *  a bounded sample presented as if it were the whole is the same lie as a bounded
 *  aggregate presented as a total. */
function namedSurfaces(named: string[], total: number): string {
  if (named.length === 0) return `${total} surface(s), none listed`;
  const shown = named.join(', ');
  return named.length < total ? `${shown} (+${total - named.length} more)` : shown;
}

function fidelityCaveat(fidelity: { weakest: string | null; declaredPct: number | null }): string {
  if (!fidelity.weakest) return '';
  return (
    `Population fidelity: weakest '${fidelity.weakest}'` +
    (fidelity.declaredPct !== null ? `, ${fidelity.declaredPct}% declared` : '') +
    ` — a partial census flatters, since surfaces it never enumerated cannot appear as gaps.`
  );
}
