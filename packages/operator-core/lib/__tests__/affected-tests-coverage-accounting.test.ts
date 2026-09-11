/**
 * affected-tests-coverage-accounting.test.ts — P-006 / R-8 sub-requirement 5:
 * "retain full final coverage where the release promise needs it".
 *
 * THE ASYMMETRY THIS CLOSES, and it runs in the wrong direction.
 *
 * `scripts/test-files.mjs` — the CHEAP, targeted, diagnostic path — already treats a
 * collected-but-not-executed test as an absent measurement rather than a pass. It carries
 * `testsExecutedFrom` / `testsSkippedFrom`, stamps `skippedTests=N` on every
 * `TEST_FILE_RESULT`, and outright REFUSES a zero-executed run with
 * `TEST_FILE_ALL_SKIPPED ... status=not-measured`. That machinery was bought with a real
 * incident (EI-19380376466745152: an agent's fix was never once exercised by the run cited
 * as proof of it, because a peer had landed `it.skip` on the exact assertion six minutes
 * earlier; every signal in that run read as success).
 *
 * `scripts/affected-tests.mjs` — the path the RELEASE PROMISE runs on, the one whose verdict
 * fast-forwards `main` and triggers the deploy — has none of it. Measured on this box
 * 2026-09-11, a genuinely executing run:
 *
 *     $ node scripts/affected-tests.mjs --changed-paths .gitignore
 *     AFFECTED_TESTS_RESULT status=passed tasks=4 failed=0 quarantinedFailed=0 \
 *         timedOutTasks=0 undeterminedTasks=0
 *
 * Nothing on that line distinguishes four tasks of real green from four tasks that
 * collected their tests and executed none of them. The count is not merely unreported —
 * vitest prints it in every task's own output (`Tests  8 passed | 1 skipped (9)`) and the
 * gate's only numeric parser, `parseSummaryFailedCounts`, reads `N failed` and discards the
 * rest. So the information is present at the seam and thrown away.
 *
 * WHY THE DISCLOSURE IS NON-GATING. This file deliberately does NOT port the focused path's
 * refusal to the gate. `affected-tests.mjs` already owns the precedent for the correct shape
 * in `notCheckedNonGating` — a guard that declared up front that "I could not look" is its
 * expected answer is "counted and reported LOUDLY below — missing coverage must stay visible
 * — but NOT gating". Folding a non-verdict into a gating counter red-pinned candidate
 * 57483d0491 for the whole fleet. Coverage that was not obtained is the same class of fact:
 * it must be VISIBLE on the verdict line, and it must not silently freeze `main`.
 *
 * THREE-STATE, NOT TWO. Most gate tasks are not vitest at all (lint legs, repo-wide invariant
 * guards), so their test counts are genuinely unreadable. An aggregate that reported those as
 * a measured zero would be the same defect one level up — a bounded measurement rendered as a
 * confident number. Unreadable tasks are counted separately and never folded into `0`.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AFFECTED_TESTS_NOT_EXECUTED_TOKEN,
  emptyCoverage,
  foldTaskCoverage,
  formatCoverageFields,
  formatNotExecutedSummary,
  testsExecutedFrom,
  testsSkippedFrom,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — untyped .mjs parser seam, imported by path like its sibling suites
} from '../../../../scripts/lib/vitest-summary.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

/** A vitest task that ran everything it collected. */
const ALL_EXECUTED = '      Test Files  1 passed (1)\n      Tests  8 passed (8)';
/** A vitest task that collected tests and executed NONE — the case the gate cannot see today. */
const ALL_SKIPPED = '      Test Files  1 skipped (1)\n      Tests  9 skipped (9)';
/** A partially skipped task — real evidence, but not full coverage. */
const PARTIAL = '      Test Files  1 passed (1)\n      Tests  4 passed | 1 skipped (5)';
/** A lint leg / repo-wide guard: not vitest, so its test counts are genuinely unreadable. */
const NON_VITEST = 'lint:no-raw-setinterval: 0 offenders\n';

describe('the parsers live at the SHARED seam, so the gate and the focused path cannot drift', () => {
  // scripts/test-files.mjs owns these today and is their only consumer. affected-tests.mjs
  // already imports every other vitest parser from lib/vitest-summary.mjs precisely so they
  // are not "three hand-kept-in-sync copies" (the file says so itself). A second copy for the
  // gate would reintroduce exactly that.
  it('exports testsExecutedFrom and testsSkippedFrom from lib/vitest-summary.mjs', () => {
    expect(typeof testsExecutedFrom).toBe('function');
    expect(typeof testsSkippedFrom).toBe('function');
  });

  it('keeps scripts/test-files.mjs re-exporting them, so the focused suite cannot break', async () => {
    const router: Record<string, unknown> = await import(
      /* @vite-ignore */ resolve(REPO_ROOT, 'scripts/test-files.mjs')
    );
    expect(typeof router.testsExecutedFrom).toBe('function');
    expect(typeof router.testsSkippedFrom).toBe('function');
  });

  it('reads a skip count out of a real vitest summary row', () => {
    expect(testsSkippedFrom(PARTIAL)).toBe(1);
    expect(testsSkippedFrom(ALL_SKIPPED)).toBe(9);
  });

  it('returns null — UNREADABLE — for output that is not a vitest run', () => {
    expect(testsSkippedFrom(NON_VITEST)).toBeNull();
    expect(testsExecutedFrom(NON_VITEST)).toBeNull();
  });
});

describe('coverage accounting folds per-task output into a three-state tally', () => {
  it('starts at a measured zero with nothing unreadable', () => {
    const c = emptyCoverage();
    expect(c).toMatchObject({ executed: 0, skipped: 0, unreadableTasks: 0 });
    expect(c.notExecuted).toEqual([]);
  });

  it('sums executed and skipped across vitest tasks', () => {
    let c = emptyCoverage();
    c = foldTaskCoverage(c, { task: 'a :: test', output: ALL_EXECUTED });
    c = foldTaskCoverage(c, { task: 'b :: test', output: PARTIAL });
    expect(c.executed).toBe(12);
    expect(c.skipped).toBe(1);
    expect(c.unreadableTasks).toBe(0);
  });

  it('counts a non-vitest task as UNREADABLE, never as a measured zero', () => {
    const c = foldTaskCoverage(emptyCoverage(), { task: 'guard :: lint', output: NON_VITEST });
    expect(c.unreadableTasks).toBe(1);
    expect(c.executed).toBe(0);
    expect(c.skipped).toBe(0);
    // The distinction is the whole point: a reader must be able to tell "this task ran no
    // tests" from "this task's test count could not be read".
    expect(c.notExecuted).toEqual([]);
  });

  it('NAMES a vitest task that collected tests and executed none of them', () => {
    // A count alone would not be enough — the same lesson the focused path learned:
    // what is missing is WHICH task went unmeasured.
    const c = foldTaskCoverage(emptyCoverage(), { task: 'ws :: test', output: ALL_SKIPPED });
    expect(c.notExecuted).toEqual([{ task: 'ws :: test', skipped: 9 }]);
    expect(c.executed).toBe(0);
    expect(c.skipped).toBe(9);
    expect(c.unreadableTasks).toBe(0);
  });

  it('does not name a task that executed something, even if partially skipped', () => {
    const c = foldTaskCoverage(emptyCoverage(), { task: 'ws :: test', output: PARTIAL });
    expect(c.notExecuted).toEqual([]);
  });
});

describe('the tally renders onto the verdict line callers actually grep', () => {
  it('renders measured counts as fields', () => {
    let c = emptyCoverage();
    c = foldTaskCoverage(c, { task: 'a :: test', output: PARTIAL });
    expect(formatCoverageFields(c)).toBe('testsExecuted=4 testsSkipped=1 coverageUnreadableTasks=0');
  });

  it('keeps unreadable tasks visible beside the counts', () => {
    let c = emptyCoverage();
    c = foldTaskCoverage(c, { task: 'a :: test', output: ALL_EXECUTED });
    c = foldTaskCoverage(c, { task: 'g :: lint', output: NON_VITEST });
    expect(formatCoverageFields(c)).toBe('testsExecuted=8 testsSkipped=0 coverageUnreadableTasks=1');
  });

  it('emits a greppable NOT_EXECUTED disclosure naming each unmeasured task', () => {
    let c = emptyCoverage();
    c = foldTaskCoverage(c, { task: 'ws-one :: test', output: ALL_SKIPPED });
    c = foldTaskCoverage(c, { task: 'ws-two :: test', output: ALL_SKIPPED });
    const summary = formatNotExecutedSummary(c);
    expect(summary).toContain(AFFECTED_TESTS_NOT_EXECUTED_TOKEN);
    expect(summary).toContain('tasks=2');
    expect(summary).toContain('ws-one :: test');
    expect(summary).toContain('ws-two :: test');
    // Non-gating, and it must SAY so — the notCheckedNonGating precedent.
    expect(summary).toMatch(/not gating/i);
  });

  it('emits nothing when every task executed something', () => {
    const c = foldTaskCoverage(emptyCoverage(), { task: 'a :: test', output: ALL_EXECUTED });
    expect(formatNotExecutedSummary(c)).toBe('');
  });
});

describe('behaviour: the real gate script emits the coverage fields on a run that EXECUTED', () => {
  // Driven for real rather than pinned against source text. A source-text regex cannot see
  // REACHABILITY — it passes just as happily when the code it pins has become unreachable,
  // which is the blind spot that let an early `process.exit(0)` sit above the repo-wide guard
  // loop, green the whole time (EI-19454727576364875). This is the sibling assertion to
  // affected-tests-result-line.test.ts and uses the same cheap real-execution path.
  it('stamps testsExecuted / testsSkipped / coverageUnreadableTasks on AFFECTED_TESTS_RESULT', () => {
    const r = spawnSync(process.execPath, [AFFECTED_TESTS, '--changed-paths', '.gitignore'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, AFFECTED_RETRY_FAILED: '' },
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const line = out.split('\n').find((l) => l.startsWith('AFFECTED_TESTS_RESULT '));
    expect(line, 'the run emitted no AFFECTED_TESTS_RESULT marker at all').toBeTruthy();

    const fields: Record<string, string> = {};
    for (const tok of (line as string).slice('AFFECTED_TESTS_RESULT '.length).trim().split(/\s+/)) {
      const eq = tok.indexOf('=');
      if (eq > 0) fields[tok.slice(0, eq)] = tok.slice(eq + 1);
    }
    // The pre-existing fields must survive: appending is the whole compatibility contract,
    // since green-checkpoint.ts matches the line whole and tokenises `status=`.
    expect(fields.status).toBeDefined();
    expect(fields.tasks).toBeDefined();
    expect(fields.failed).toBeDefined();

    // The coverage fields are a property of a TERMINAL VERDICT, and scoping this assertion to
    // one is the point rather than a concession. `status=refused` / `aborted` / `dry-run` are
    // emitted from hardcoded lines on paths that never entered the run loop — several of them
    // ABOVE the point where the tally can even be declared without a TDZ throw — and each
    // already self-declares as a non-verdict, so no reader can mistake one for a green. The
    // dangerous reading this whole tally exists to remove is "status=passed with nothing
    // executed", which lives only on the line below.
    //
    // Asserting the fields on ANY marker line made this test red whenever the box was busy
    // enough to starve admission: a real, load-correlated false red on the gate's own suite.
    const terminal = fields.status === 'passed' || fields.status === 'failed';
    if (terminal) {
      expect(fields.testsExecuted, `no testsExecuted on a terminal verdict: ${line}`).toBeDefined();
      expect(fields.testsSkipped, `no testsSkipped on a terminal verdict: ${line}`).toBeDefined();
      expect(
        fields.coverageUnreadableTasks,
        `no coverageUnreadableTasks on a terminal verdict: ${line}`,
      ).toBeDefined();
    } else {
      // Never a silent pass: a non-terminal run must be one of the statuses that SAYS it
      // decided nothing. Anything else means the run reached a verdict by a path this test
      // does not know about, which is exactly what it should fail on.
      expect(
        ['refused', 'aborted', 'dry-run'],
        `unrecognised non-terminal status — is this a verdict without coverage fields? ${line}`,
      ).toContain(fields.status);
    }
  });
});

describe('the contract is stated where its readers look', () => {
  it('affected-tests.mjs consumes the shared coverage seam rather than a private copy', () => {
    const src = readFileSync(AFFECTED_TESTS, 'utf8');
    expect(src).toContain('foldTaskCoverage');
    expect(src).toContain('formatCoverageFields');
    expect(src).toContain('AFFECTED_TESTS_NOT_EXECUTED');
  });
});
