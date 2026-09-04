/**
 * rubrics-criterion-checks — the STRUCTURED CRITERION CHECK enforcement
 * (consult-min-max-and-rubric-vetting-2026-08-17 P-011, owner-ratified D-006).
 *
 * A rubric criterion may carry an optional structured `check`:
 *   - kind:'tests' { files } — a DETERMINISTIC must-pass binding. Two enforcement
 *     points, both here:
 *       PROPOSE time — every named file must RESOLVE against the live tree AND be
 *       RUNNABLE by the router grading will use (WI-369566: resolving is not runnable,
 *       and a resolving-but-unroutable path made rubrics permanently ungradeable), or
 *       the propose is REFUSED (unlike the advisory replicationSqlCheck, whose subject is
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

import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import { resolveAgentWorkspaceRoot } from './agent-tools/capability/base-dir';
import { REPO_ROOT } from './agent-tools/docs/_repo-paths';
import { normalizeTestFilePaths, runTestFilesCore, type TestFilesCoreResult } from './agent-tools/testing/run';
import { selectUnambiguousEvidenceRoot } from './evidence-root-selection';
import type { RubricCriterionCheck } from './agent-tools/plans/rubric-template';
import type {
  ScorecardCheckRun,
  ScorecardCoverageCheckRun,
} from './harness/improvements/observation-types';
import { managedSpawn } from './task-manager/managed-spawn';

/** The minimal criterion shape this module reads — key + the optional check. */
export interface CheckedCriterion {
  key: string;
  check?: RubricCriterionCheck;
}

export interface CriterionCheckPathFailure {
  criterionKey: string;
  path: string;
  reason: string;
  /** Present for native checks so the refusal can name the affected runner. */
  checkKind?: 'cargo';
}

export interface NormalizedCargoCheckPaths {
  manifestPath: string;
  sourceFiles: string[];
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
  /** Criterion key → its Cargo manifest and explicit source attribution, normalized to
   *  repo-root-relative form. */
  normalizedCargoByKey: Record<string, NormalizedCargoCheckPaths>;
}

/**
 * WI-369566 — RESOLVING IS NOT RUNNABLE. Path existence was the whole propose-time rule,
 * so a criterion could bind a file that resolves and that the test router will never
 * report on. Grading then refuses it (`check_file_not_run`, below) — and because emit's
 * completeness rule requires EVERY criterion to be rated, no rating value skips the
 * check, so the rubric is PERMANENTLY ungradeable and its plan can never reach
 * status:shipped. Measured instance: a criterion naming `scripts/verify-…-rail.sh`;
 * the router answered TEST_FILE_UNSUPPORTED_INPUT (⚠ NON_TEST … skipped) and then
 * TEST_FILE_ROUTE_ERROR requested=1 matched=0, and only the GRADER discovered it, at
 * ship time. This moves that cost to the author, at authoring time.
 *
 * WHAT IS CHECKED — the FILENAME SHAPE, which is the leg that catches the measured class.
 * MEASURED: `scripts/test-files.mjs` filters a non-test input out before route discovery
 * (`isTestFilePath`, and the NON_TEST refusal above). REASONED, not measured: the external
 * checkout path `runTestFilesCore` falls back to for a managed Hive runs Vitest against the
 * named files, whose include contract is `*.{test,spec}.?(c|m)[jt]s?(x)`, so a differently
 * named file is selected by neither path — if that ever stops holding, the pin below is
 * where the disagreement should surface first.
 *
 * WHAT IS NOT, and why — ROUTE OWNERSHIP ("does a Vitest config own this path"). The
 * router owns that answer (`discoverTestRoute`) and this module must not IMPORT it:
 * `scripts/test-files.mjs` is a test-runner CLI that the operator host deliberately
 * SPAWNS (see `runTestFilesCore`) and never bundles, and `test-executor-runnability.ts`
 * — the one module that does import it — is reached only from the `lint:tests` script,
 * never from the host. Importing it here would drag that CLI and its process/watchdog
 * dependencies into the server bundle to catch a strictly rarer fault that `lint:tests`
 * already owns from both sides (`findOrphanTests` for a test matching no registry glob,
 * `findUnrunnableRegistryTests` for a registry-visible test no runner executes).
 * Grading stays the authority for that last mile.
 *
 * DERIVED-TRUTH RUNG 2 (PIN, not copy): the pattern below is a second statement of the
 * router's `isTestFilePath`, so it is pinned by a divergence test that imports BOTH and
 * asserts they agree over a corpus (rubrics-criterion-checks.test.ts). A test may import
 * the .mjs freely — it costs the host bundle nothing — so the check lives there and this
 * regex cannot silently drift from the router's.
 */
const ROUTER_TEST_FILE_SUFFIX_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;

/** @returns a teaching reason when the path can never be RUN, else null. */
function describeUnroutableTestPath(file: string): string | null {
  if (ROUTER_TEST_FILE_SUFFIX_RE.test(file.replaceAll('\\', '/'))) return null;
  return (
    'resolves, but is not a test file — the router skips a non-test input as NON_TEST ' +
    '(TEST_FILE_UNSUPPORTED_INPUT) and reports on nothing, so scorecards:emit could never ' +
    'grade this criterion and the rubric would be permanently ungradeable. Name the ' +
    'importing *.test.* / *.spec.* file, or drop the check to leave the criterion fuzzy ' +
    '(the right answer when its method is a human-run procedure)'
  );
}

/**
 * PROPOSE-time validation: every kind:'tests' check file and every kind:'cargo' manifest
 * or source attribution must resolve against the live tree. Tests files must also be
 * runnable by the Vitest router grading will use (see {@link describeUnroutableTestPath}).
 * Absolute paths are refused outright — a stored absolute path is machine-specific and
 * escapes the tree the check claims to be about; repo-root-relative (or unambiguous
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
  const normalizedCargoByKey: Record<string, NormalizedCargoCheckPaths> = {};
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
    if (c.check?.kind === 'cargo') {
      const rawPaths = [c.check.manifestPath, ...c.check.sourceFiles];
      const absoluteIndexes = rawPaths.flatMap((path, index) => (isAbsolute(path) ? [index] : []));
      checked += rawPaths.length;
      for (const index of absoluteIndexes) {
        failures.push({
          criterionKey: c.key,
          path: rawPaths[index]!,
          reason: 'absolute paths are machine-specific — name the path repo-root-relative',
          checkKind: 'cargo',
        });
      }
      const relativePaths = rawPaths.filter((path) => !isAbsolute(path));
      if (relativePaths.length === 0) continue;
      const resolution = normalizeTestFilePaths([...relativePaths], root);
      if (!resolution.ok) {
        failures.push({
          criterionKey: c.key,
          path: resolution.path,
          reason: `ambiguous workspace-relative path — exists in multiple workspaces (${resolution.matches.join(', ')}); use the repo-root-relative form`,
          checkKind: 'cargo',
        });
        continue;
      }
      const normalizedRelative = resolution.files;
      let relativeIndex = 0;
      const normalizedPaths = rawPaths.map((path) =>
        isAbsolute(path) ? path : normalizedRelative[relativeIndex++]!,
      );
      let valid = absoluteIndexes.length === 0;
      for (const path of normalizedPaths) {
        if (isAbsolute(path)) continue;
        const candidate = resolve(root, path);
        const isFile = isRegularFileInsideRoot(root, candidate);
        if (!isFile) {
          valid = false;
          failures.push({
            criterionKey: c.key,
            path,
            reason: 'does not resolve to a regular file in the live tree',
            checkKind: 'cargo',
          });
        }
      }
      if (valid) {
        normalizedCargoByKey[c.key] = {
          manifestPath: normalizedPaths[0]!,
          sourceFiles: normalizedPaths.slice(1),
        };
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
      const candidate = resolve(root, f);
      if (!isRegularFileInsideRoot(root, candidate)) {
        failures.push({ criterionKey: c.key, path: f, reason: 'does not resolve against the live tree' });
        continue;
      }
      const unroutable = describeUnroutableTestPath(f);
      if (unroutable) {
        failures.push({ criterionKey: c.key, path: f, reason: unroutable });
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
    normalizedCargoByKey,
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
    const testsFailures = v.failures.filter((f) => f.checkKind !== 'cargo');
    const cargoFailures = v.failures.filter((f) => f.checkKind === 'cargo');
    if (testsFailures.length > 0) {
      parts.push(
        `structured tests-check paths must resolve against the live tree AND be runnable by ` +
          `the test router that grading will use ` +
          `(P-011 / D-006 — a check that can never run is a booby trap, not advice). Against root '${v.root}':\n` +
          testsFailures.map((f) => `  • criterion '${f.criterionKey}': ${f.path} — ${f.reason}`).join('\n') +
          `\nFix the path(s) (repo-root-relative), or drop the check to leave the criterion fuzzy.`,
      );
    }
    if (cargoFailures.length > 0) {
      parts.push(
        `structured cargo-check manifest/source paths must resolve against the live tree ` +
          `(P-011 / D-006 — a check that cannot run is a booby trap, not advice). Against root '${v.root}':\n` +
          cargoFailures.map((f) => `  • criterion '${f.criterionKey}': ${f.path} — ${f.reason}`).join('\n') +
          `\nFix the Cargo paths (repo-root-relative), or drop the check to leave the criterion fuzzy.`,
      );
    }
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

export type CriterionRequirementsRefusal =
  | {
      ok: false;
      error: 'requirements_no_plan_subject';
      criterionKey: string;
      detail: string;
    }
  | {
      ok: false;
      error: 'requirements_scope_empty';
      criterionKey: string;
      detail: string;
    }
  | {
      ok: false;
      error: 'requirements_contradicted';
      criterionKey: string;
      rating: string;
      detail: string;
      run: RequirementsCheckRun;
    };

export type CriterionCheckEvaluation =
  | { ok: true; checkRuns: Record<string, CriterionCheckRun> }
  | CriterionCheckRefusal
  | CriterionCoverageRefusal
  | CriterionRequirementsRefusal;

/** Injectable runner seam (tests stub this; production shells the real router). */
export type CriterionCheckRunner = (opts: {
  files: string[];
  root: string;
  timeoutMs?: number;
}) => Promise<TestFilesCoreResult>;

/** Distilled result of one native Cargo invocation. Cargo's stable runner reports
 * test names and counts at crate/binary scope, not the source file containing each
 * inline `#[test]`; source attribution is therefore supplied by the criterion and
 * preserved on the resulting scorecard check run. */
export interface CriterionCargoRunResult {
  passed: number;
  failed: number;
  ignored: number;
  runId: string | null;
  durationMs: number | null;
  failures?: string[];
  /** A typed refusal means no trustworthy crate verdict exists. */
  error?: string;
  output?: string;
}

/** Injectable native runner seam. Production invokes Cargo directly; tests can
 * model pass/fail/empty/timeout outcomes without compiling the whole crate. */
export type CriterionCargoCheckRunner = (opts: {
  manifestPath: string;
  sourceFiles: string[];
  root: string;
  test?: string;
  timeoutMs?: number;
}) => Promise<CriterionCargoRunResult>;

const CARGO_RESULT_RE = /^test (\S+) \.\.\. (ok|FAILED|ignored)\s*$/gm;
const CARGO_ANSI_RE = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B\[[0-?]*[ -/]*[@-~]|\u001B[ -/]*[@-~]/g;
const CARGO_RUN_OUTPUT_LIMIT = 16 * 1024 * 1024;
const CARGO_DEFAULT_TIMEOUT_MS = 15 * 60_000;

function isInsideRoot(root: string, candidate: string): boolean {
  const rootAbs = resolve(root);
  const candidateAbs = resolve(candidate);
  if (!(candidateAbs === rootAbs || candidateAbs.startsWith(`${rootAbs}${sep}`))) return false;
  try {
    const rootReal = realpathSync(rootAbs);
    const candidateReal = realpathSync(candidateAbs);
    return candidateReal === rootReal || candidateReal.startsWith(`${rootReal}${sep}`);
  } catch {
    return false;
  }
}

function isRegularFileInsideRoot(root: string, candidate: string): boolean {
  try {
    return isInsideRoot(root, candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function cargoBinary(): string {
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const candidates = [
    ...pathDirs.map((dir) => join(dir, 'cargo')),
    process.env.CARGO_HOME ? join(process.env.CARGO_HOME, 'bin', 'cargo') : null,
    join(homedir(), '.cargo', 'bin', 'cargo'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'cargo';
}

function cargoResultNames(output: string): { name: string; outcome: 'ok' | 'FAILED' | 'ignored' }[] {
  const normalized = output.replace(CARGO_ANSI_RE, '');
  const results: { name: string; outcome: 'ok' | 'FAILED' | 'ignored' }[] = [];
  const resultRe = new RegExp(CARGO_RESULT_RE.source, 'gm');
  let match: RegExpExecArray | null;
  while ((match = resultRe.exec(normalized)) !== null) {
    results.push({ name: match[1]!, outcome: match[2] as 'ok' | 'FAILED' | 'ignored' });
  }
  return results;
}

function killCargoTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    try {
      child.kill(signal);
    } catch {
      /* the process already exited */
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* the process already exited */
    }
  }
}

/**
 * Run one Cargo crate at manifest scope and distil its stable stdout into counts.
 *
 * This is intentionally separate from `runTestFilesCore`: that core is a Vitest
 * router and correctly refuses `.rs` inputs. Cargo's own manifest/test boundary
 * is the native equivalent, while the caller retains explicit sourceFiles
 * attribution because stable Cargo output has no source-location grain.
 */
export function runCargoCriterionCheck(opts: {
  manifestPath: string;
  sourceFiles: string[];
  root: string;
  test?: string;
  timeoutMs?: number;
  managedSpawnFn?: typeof managedSpawn;
}): Promise<CriterionCargoRunResult> {
  const runId = randomUUID();
  const startedAt = Date.now();
  const manifestAbs = resolve(opts.root, opts.manifestPath);
  const args = [
    'test',
    '--manifest-path',
    manifestAbs,
    '--no-fail-fast',
    ...(opts.test ? [opts.test] : []),
  ];
  const timeoutMs = opts.timeoutMs ?? CARGO_DEFAULT_TIMEOUT_MS;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CARGO_TERM_COLOR: 'never',
    PAPERCUSP_TEST_RUN_GROUP: runId,
  };

  return new Promise((resolveResult) => {
    let output = '';
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    let closeObserved = false;
    let child: ChildProcess | null = null;
    let timer: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;

    const append = (chunk: string): void => {
      const next = output + chunk;
      if (next.length <= CARGO_RUN_OUTPUT_LIMIT) {
        output = next;
        return;
      }
      outputTruncated = true;
      output = next.slice(-CARGO_RUN_OUTPUT_LIMIT);
    };
    const finish = (result: CriterionCargoRunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      resolveResult(result);
    };

    const kill = (signal: NodeJS.Signals): void => {
      if (child) killCargoTree(child, signal);
    };
    const scheduleEscalation = (): void => {
      // A timeout can settle the caller's promise before managedSpawn finishes
      // its admission/ledger handshake. A late child still needs the same
      // SIGKILL backstop even though the result is already settled.
      if (escalation || !child) return;
      escalation = setTimeout(() => kill('SIGKILL'), 15_000);
      escalation.unref();
    };
    const requestTermination = (): void => {
      timedOut = true;
      if (!child) {
        finishFromClose(null, null);
        return;
      }
      kill('SIGTERM');
      scheduleEscalation();
    };
    const finishFromClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        closeObserved = true;
        if (escalation) clearTimeout(escalation);
        return;
      }
      closeObserved = true;
      const results = cargoResultNames(output);
      const passed = results.filter((r) => r.outcome === 'ok').length;
      const failed = results.filter((r) => r.outcome === 'FAILED').length;
      const ignored = results.filter((r) => r.outcome === 'ignored').length;
      const failures = results
        .filter((r) => r.outcome === 'FAILED')
        .slice(0, 10)
        .map((r) => r.name);
      const common = {
        passed,
        failed,
        ignored,
        runId,
        durationMs: Date.now() - startedAt,
        ...(failures.length > 0 ? { failures } : {}),
        ...(outputTruncated ? { output: 'Cargo output exceeded the bounded parser buffer.' } : {}),
      };
      if (timedOut) {
        finish({ ...common, error: `timeout after ${timeoutMs}ms` });
      } else if (outputTruncated) {
        finish({ ...common, error: 'output_truncated: Cargo test result lines were not fully measurable' });
      } else if (results.length === 0) {
        finish({
          ...common,
          output: output.slice(-4000),
          error: code === 0 ? 'no_tests: Cargo reported no test result lines' : `cargo_failed: exit code ${code ?? 'null'}`,
        });
      } else if (code !== 0 && failed === 0) {
        finish({ ...common, output: output.slice(-4000), error: `cargo_failed: exit code ${code ?? 'null'}` });
      } else {
        finish(common);
      }
    };
    const handleStartError = (error: unknown): void => {
      finish({
        passed: 0,
        failed: 0,
        ignored: 0,
        runId,
        durationMs: Date.now() - startedAt,
        error: `spawn_error: ${error instanceof Error ? error.message : String(error)}`,
      });
    };

    timer = setTimeout(() => {
      // managedSpawn may still be settling its admission/ledger work when this
      // deadline expires. Remember the timeout and kill the payload immediately
      // once the child handle arrives; never leave a late child running because
      // the timeout callback raced the async spawn handshake.
      requestTermination();
    }, timeoutMs);

    const spawnTask = opts.managedSpawnFn ?? managedSpawn;
    let start: Promise<Awaited<ReturnType<typeof managedSpawn>>>;
    try {
      start = spawnTask(
        cargoBinary(),
        args,
        {
          class: 'build',
          title: `scorecards cargo check (${opts.manifestPath})`,
          argv: [cargoBinary(), ...args],
          cwd: opts.root,
          launchedBy: 'scorecards:emit',
          runtimeMaxSec: Math.max(1, Math.ceil(timeoutMs / 1000)),
          detail: { rubricCheck: 'cargo', manifestPath: opts.manifestPath, sourceFiles: opts.sourceFiles },
        },
        {
          spawnOptions: {
            cwd: opts.root,
            env,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        },
      );
    } catch (error) {
      handleStartError(error);
      return;
    }

    void start.then((managed) => {
      child = managed.child;
      child.stdout?.on('data', (chunk: Buffer | string) => {
        append(chunk.toString());
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        append(chunk.toString());
      });
      child.once('error', (error) => {
        finish({
          passed: 0,
          failed: 0,
          ignored: 0,
          runId,
          durationMs: Date.now() - startedAt,
          error: `spawn_error: ${error.message}`,
        });
      });
      child.once('close', finishFromClose);
      if (timedOut) requestTermination();

      // A very short-lived child may have emitted both `exit` and `close` before
      // managedSpawn finished its async ledger work. ChildProcess retains its
      // exitCode/signalCode, so schedule one fallback check rather than hanging
      // until the rubric timeout after the close event was legitimately missed.
      if (child.exitCode != null || child.signalCode != null) {
        setImmediate(() => {
          if (!settled && !closeObserved) {
            finishFromClose(child?.exitCode ?? null, child?.signalCode ?? null);
          }
        });
      }
    }, handleStartError);
  });
}

/**
 * GRADING-time evaluation for kind:'cargo' checks. Each unique manifest/filter
 * pair is run once, then its crate-level verdict is copied to each criterion
 * with that criterion's explicit sourceFiles attribution. This keeps native
 * checks cheap without claiming Cargo can identify which Rust file owned a test.
 */
export async function evaluateCriterionCargoChecks(input: {
  criteria: ReadonlyArray<CheckedCriterion>;
  ratings: Record<string, { rating: string } | undefined>;
  root?: string;
  timeoutMs?: number;
  runner?: CriterionCargoCheckRunner;
  nowIso?: () => string;
}): Promise<CriterionCheckEvaluation> {
  const ratedCargoChecks = input.criteria.filter(
    (c) => c.check?.kind === 'cargo' && input.ratings[c.key] !== undefined,
  );
  const root = selectCriterionCheckRoot(ratedCargoChecks, input.root ?? resolveAgentWorkspaceRoot({})).root;
  const runner = input.runner ?? runCargoCriterionCheck;
  const nowIso = input.nowIso ?? (() => new Date().toISOString());
  const deadline = input.timeoutMs !== undefined ? Date.now() + input.timeoutMs : null;
  const planned: {
    key: string;
    manifestPath: string;
    sourceFiles: string[];
    test?: string;
  }[] = [];

  for (const c of ratedCargoChecks) {
    const validation = validateCriterionCheckPaths([c], { root });
    const normalized = validation.normalizedCargoByKey[c.key];
    if (!validation.ok || !normalized) {
      return {
        ok: false,
        error: 'check_path_unresolved',
        criterionKey: c.key,
        paths: validation.failures.map((f) => f.path),
        detail:
          `criterion '${c.key}' carries a cargo-check whose manifest/source path(s) cannot be used against '${root}': ` +
          validation.failures.map((f) => `${f.path} (${f.reason})`).join('; ') +
          ` — grading a native deterministic criterion whose check cannot run would be a silent pass. ` +
          `Fix the rubric's check (rubrics:propose) or restore the path(s), then re-emit.`,
      };
    }
    planned.push({
      key: c.key,
      manifestPath: normalized.manifestPath,
      sourceFiles: normalized.sourceFiles,
      ...(c.check?.kind === 'cargo' && c.check.test ? { test: c.check.test } : {}),
    });
  }
  if (planned.length === 0) return { ok: true, checkRuns: {} };

  const groups = new Map<
    string,
    { manifestPath: string; sourceFiles: string[]; test?: string; keys: string[] }
  >();
  for (const item of planned) {
    const groupKey = `${item.manifestPath}\u0000${item.test ?? ''}`;
    const group = groups.get(groupKey) ?? {
      manifestPath: item.manifestPath,
      sourceFiles: [],
      ...(item.test ? { test: item.test } : {}),
      keys: [],
    };
    for (const sourceFile of item.sourceFiles) {
      if (!group.sourceFiles.includes(sourceFile)) group.sourceFiles.push(sourceFile);
    }
    group.keys.push(item.key);
    groups.set(groupKey, group);
  }

  const checkRuns: Record<string, CriterionCheckRun> = {};
  for (const group of groups.values()) {
    const budget = deadline === null ? undefined : Math.max(1000, deadline - Date.now());
    const run = await runner({
      manifestPath: group.manifestPath,
      sourceFiles: group.sourceFiles,
      root,
      ...(group.test ? { test: group.test } : {}),
      ...(budget !== undefined ? { timeoutMs: budget } : {}),
    });
    if (run.error) {
      return {
        ok: false,
        error: 'check_run_failed',
        criterionKey: group.keys[0] ?? '(none)',
        detail:
          `the cargo tests-check run for ${group.keys.length} criterion/criteria ` +
          `(manifest ${group.manifestPath}${group.test ? `, filter ${JSON.stringify(group.test)}` : ''}) ` +
          `could not be judged (${run.error}). D-006 requires the named native tests to actually ` +
          `RUN at grading time — an unjudgeable check refuses the emit rather than passing silently.`,
      };
    }
    if (run.passed + run.failed === 0) {
      return {
        ok: false,
        error: 'check_run_failed',
        criterionKey: group.keys[0] ?? '(none)',
        detail:
          `the cargo tests-check run for manifest '${group.manifestPath}' executed ZERO non-ignored ` +
          `tests${group.test ? ` for filter ${JSON.stringify(group.test)}` : ''}; ` +
          `an ignored/empty native suite is unjudged, not a deterministic pass.`,
      };
    }
    for (const item of planned.filter((candidate) => group.keys.includes(candidate.key))) {
      const record: CriterionCheckRun = {
        kind: 'cargo',
        manifestPath: group.manifestPath,
        sourceFiles: item.sourceFiles,
        ...(group.test ? { test: group.test } : {}),
        verdict: run.failed === 0 ? 'pass' : 'fail',
        passed: run.passed,
        failed: run.failed,
        ignored: run.ignored,
        runId: run.runId,
        measuredAt: nowIso(),
        ...(run.failed > 0 && run.failures?.length ? { failures: run.failures } : {}),
      };
      const rating = input.ratings[item.key]?.rating ?? '';
      if (record.verdict === 'fail' && ratingClaimsPass(rating)) {
        return {
          ok: false,
          error: 'check_contradicted',
          criterionKey: item.key,
          rating,
          run: record,
          detail:
            `criterion '${item.key}' is rated '${rating}' but its deterministic cargo-check FAILED ` +
            `(${record.failed} failing of ${record.passed + record.failed} run): ` +
            `${record.failures?.join(' · ') ?? 'Cargo reported a failing test'}. ` +
            `A must-pass check outranks judgment — fix the code (or the tests), or rate the criterion honestly.`,
        };
      }
      checkRuns[item.key] = record;
    }
  }
  return { ok: true, checkRuns };
}

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
    // A reported file can still be UNJUDGED: Vitest exits zero when every test in a
    // collected file is skipped (for example, a portable suite guarded by
    // `describe.skipIf(!config)`). Checking only the batch aggregate is insufficient —
    // one genuinely-running sibling file would hide the vacuous file. Every named file
    // must execute at least one test before it may support a deterministic criterion.
    const unexecuted = files.filter((f) => {
      const counts = byFile[f]!;
      return counts.passed + counts.failed === 0;
    });
    if (unexecuted.length > 0) {
      return {
        ok: false,
        error: 'check_run_failed',
        criterionKey: key,
        detail:
          `criterion '${key}' names test file(s) that were reported but executed ZERO tests: ` +
          unexecuted
            .map((f) => {
              const counts = byFile[f]!;
              return `${f} (${counts.skipped} skipped${counts.collectionFailed ? ', collection failed' : ''})`;
            })
            .join(', ') +
          `. An exit-zero skip-only suite is unjudged, not a deterministic pass. Supply the ` +
          `required test configuration or bind the criterion to a non-skipping authority test, then re-emit.`,
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
