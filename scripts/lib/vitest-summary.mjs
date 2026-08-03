// vitest-summary.mjs — parse vitest's own final summary lines for failed
// counts, independent of the child process's exit code.
//
// EI-18653696921091778 (2026-07-25): a single `npm run test:affected` run
// captured
//   Test Files  2 failed | 3274 passed (3276)
//        Tests  4 failed | 38073 passed (38077)
// from a workspace's vitest child, yet that child process exited 0. Any
// caller that gates purely on the exit code (this script's own per-workspace
// loop, or an agent eyeballing `echo $?`) concludes the tree is clean while
// deterministic reds sit in the printed summary — the exact "silence must
// never look like green" footgun this repo's other gates (e.g.
// live-federation-gate.sh's staleness check) already guard against
// elsewhere. `parseSummaryFailedCounts` gives a second, independent signal
// straight from vitest's own reported totals so a mismatch can be caught
// instead of silently trusted.
//
// Deliberately tolerant of vitest reporter formatting drift: matches on the
// stable `Test Files` / `Tests` row labels + a leading failed count, not the
// full line shape (passed/skipped counts, parenthesized totals vary by vitest
// version and TTY-vs-pipe).
//
// ⚠ EI-18819483316574031 (2026-07-27): colour is NOT handled by tolerant matching —
// it must be STRIPPED, and this file's original comment wrongly claimed "color codes
// ... vary" as something the regexes absorbed. They cannot: every matcher here is
// line-anchored (`^\s*`) and vitest emits SGR codes AROUND both the row label and the
// count, so the real gate line
//     \x1b[2m Test Files \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m...
// starts with ESC (not \s) and puts escapes between `Test Files` and `1`. Both anchors
// miss, parseSummaryFailedCounts returned null, and the exit-code/summary cross-check
// that exists *specifically* to stop a red suite reading as green never fired — the
// green pin advanced over a deterministic operator-vite failure and auto-deployed.
// The identical bug had ALREADY been found and fixed in green-checkpoint.ts's
// parseFailingFilesByWorkspace (which strips first, and says so); the fix was simply
// never propagated to these sibling parsers, even though that function's own header
// says it "mirrors parseFailedFiles's file regexes ... so the two stay in sync".
// Strip first, then match. Do not re-introduce a "tolerant regex" that skips this.
/**
 * @param {string} text
 * @returns {string}
 */
export function stripVitestAnsi(text) {
  // eslint-disable-next-line no-control-regex -- SGR codes are the thing being removed.
  return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * The path shape of a vitest test file, as a regex SOURCE FRAGMENT rather than a RegExp.
 *
 * Exported as a string because its two consumers embed it in different line-anchored
 * matchers: this module scans whole outputs with `matchAll` (`gm`), while
 * green-checkpoint.ts's `parseFailingFilesByWorkspace` walks line-by-line with `exec`
 * (no flags) because it must track the enclosing `>>> <workspace>` header. A shared
 * RegExp could not serve both; a shared fragment can.
 */
export const VITEST_TEST_FILE_SOURCE = String.raw`\S+\.(?:test|spec)\.[cm]?[jt]sx?`;

/**
 * ` ❯ lib/x/y.test.ts (22 tests | 1 failed) 85ms` — vitest's per-file ROLLUP row.
 *
 * The load-bearing matcher of the two: vitest prints only the first few `FAIL` rows but
 * emits a rollup for EVERY failing file, so this is what names a large red run in full.
 *
 * A FACTORY rather than a shared `RegExp` const, deliberately: a `g`-flagged RegExp
 * carries mutable `lastIndex`, so a single module-level instance shared across callers
 * silently resumes mid-string on its second use. That failure is state-dependent and
 * order-dependent — exactly the kind that survives a test suite and reappears in the
 * gate. Each caller gets a fresh object.
 *
 * @param {string} [flags] RegExp flags — `'gm'` to scan a whole output, `''` per line.
 * @returns {RegExp}
 */
export function vitestSummaryFailRow(flags = '') {
  return new RegExp(String.raw`^\s*❯\s+(${VITEST_TEST_FILE_SOURCE})\s+\([^)]*\bfailed\b[^)]*\)`, flags);
}

/**
 * `FAIL  lib/x/y.test.ts …` — a failed-SUITE row (transform/setup errors).
 *
 * Distinct from the rollup above and not redundant with it: a file that fails to
 * transform or whose setup throws never reaches the rollup, so this is the only row
 * that names it. See `vitestSummaryFailRow` for why this is a factory.
 *
 * @param {string} [flags] RegExp flags — `'gm'` to scan a whole output, `''` per line.
 * @returns {RegExp}
 */
export function vitestSuiteFailRow(flags = '') {
  return new RegExp(String.raw`^\s*FAIL\s+(${VITEST_TEST_FILE_SOURCE})\b`, flags);
}

export function parseSummaryFailedCounts(text) {
  if (!text) return null;
  const plain = stripVitestAnsi(text);
  const filesMatch = plain.match(/^\s*Test Files\s+(\d+)\s+failed\b/m);
  const testsMatch = plain.match(/^\s*Tests\s+(\d+)\s+failed\b/m);
  if (!filesMatch && !testsMatch) return null;
  return {
    testFiles: filesMatch ? Number(filesMatch[1]) : 0,
    tests: testsMatch ? Number(testsMatch[1]) : 0,
  };
}

/**
 * The FAILING TEST FILES named by a vitest run's own output.
 *
 * Moved here from affected-tests.mjs (EI-18819483316574031) so that the three parsers
 * reading vitest output — this one, {@link parseSummaryFailedCounts}, and
 * green-checkpoint.ts's parseFailingFilesByWorkspace — share ONE ANSI-stripping seam
 * instead of three hand-kept-in-sync copies. Keeping them as independent copies is
 * exactly how green-checkpoint.ts got the strip and these did not.
 *
 * Returns [] (never null) so callers can length-check without a guard.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseFailedTestFiles(text) {
  if (!text) return [];
  const plain = stripVitestAnsi(text);
  const files = new Set();
  for (const m of plain.matchAll(vitestSummaryFailRow('gm'))) files.add(m[1]);
  for (const m of plain.matchAll(vitestSuiteFailRow('gm'))) files.add(m[1]);
  return [...files];
}

/** The greppable token that opens the per-FILE break-set line. Exported so a consumer
 *  greps a shared constant instead of a hand-typed copy that can drift from the emitter. */
export const AFFECTED_TESTS_FAILING_FILES_TOKEN = 'AFFECTED_TESTS_FAILING_FILES';

/** Beyond this many entries the JSON payload is truncated and says so. A break set this
 *  large is a tree-wide event, not a triage list; the counts stay exact either way. */
export const FAILING_FILES_LINE_MAX_ENTRIES = 400;

/**
 * Render the canonical, machine-readable per-FILE break set for a run's final summary.
 *
 * EI-19395701908500754: `AFFECTED_TESTS_RESULT ... failed=N` counts TASKS (workspaces),
 * so the per-FILE set — the thing a triager actually needs — existed nowhere in the
 * verdict log. Agents therefore MINED PROSE for it, and the prose they reached for was
 * the gate's own `[green-checkpoint] isolation: re-running <files>` narration. That
 * narration is emitted by green-checkpoint's self-tests too, so a `grep 'isolation:'`
 * returned FIXTURE paths (`lib/a.test.ts`, candidate `abc123`) with nothing marking them
 * synthetic. Measured on the 01:36:17Z red: the mined set was 2 phantom files; the real
 * one was 11 real files spanning BOTH failing workspaces. The tagging fix (WI-7274) marks
 * the fixture lines; this removes the reason to read them at all.
 *
 * ⚠ COMPLETENESS IS REPORTED SEPARATELY FROM SCOPE, and that is the whole point of the
 * shape. An empty `files=[]` is ambiguous in the direction that costs the most — it reads
 * as "nothing failed" when it can equally mean "we could not attribute what failed" (a
 * TTY run with no captured child output; a crash/OOM that printed no FAIL rows; a
 * non-vitest task like cargo). So a failed task whose files cannot be named is carried
 * EXPLICITLY in `unattributed`, and `coverage` can never read `complete` while any such
 * task exists. `coverage=unattributed` means "tasks failed and NONE of them could be
 * attributed" — the case a bare empty array would have silently mis-reported as clean.
 *
 * @param {{
 *   runToken: string,
 *   entries?: Array<{ workspace: string, file: string }>,
 *   unattributed?: Array<{ task: string, reason: string }>,
 * }} args
 * @returns {string}
 */
export function formatFailingFilesLine({ runToken, entries = [], unattributed = [] }) {
  const files = [...entries];
  const unattr = [...unattributed];
  const coverage =
    files.length === 0 && unattr.length === 0
      ? 'none'
      : unattr.length === 0
        ? 'complete'
        : files.length === 0
          ? 'unattributed'
          : 'partial';
  const truncated = files.length > FAILING_FILES_LINE_MAX_ENTRIES;
  const shown = truncated ? files.slice(0, FAILING_FILES_LINE_MAX_ENTRIES) : files;
  return (
    `${AFFECTED_TESTS_FAILING_FILES_TOKEN} run=${runToken} coverage=${coverage} ` +
    `fileCount=${files.length} unattributedCount=${unattr.length} truncated=${truncated} ` +
    `files=${JSON.stringify(shown)} unattributed=${JSON.stringify(unattr)}`
  );
}

/**
 * Count vitest's own hard-timeout failures — `"Test timed out in Nms."` / `"Hook timed
 * out in Nms."`, the exact message `@vitest/runner` throws when a case or hook exceeds
 * `testTimeout`/`hookTimeout` — in a run's combined stdout+stderr. ANSI-stripped first,
 * like every other parser here (EI-18819483316574031: skipping that step is why a sibling
 * parser went blind on real colourized gate output for weeks).
 *
 * EI-19332556961886184: a test that TIMES OUT reds a suite exactly like a real assertion
 * failure — nothing in a bare "N failed" count says which. Under fleet load this is a
 * load artifact, not evidence the code is broken, and it is worst exactly when the fleet
 * is busiest. This gives a caller a cheap, precise (not the broader `waitFor`/"Exceeded
 * timeout" heuristic green-checkpoint.ts's `outputHasTimingSignature` uses for retry
 * *policy*) way to surface the distinction — it decides nothing about whether the
 * failure is "real"; it only lets a triager see that a timeout signature is present
 * before spending time chasing a defect that may not exist.
 *
 * @param {string} text
 * @returns {number}
 */
export function countTimeoutSignatures(text) {
  if (!text) return 0;
  const plain = stripVitestAnsi(text);
  const matches = plain.match(/\b(?:Test|Hook) timed out in \d+ms\./g);
  return matches ? matches.length : 0;
}
