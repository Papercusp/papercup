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

/**
 * The FAILING TEST FILES named by a `node --test` run's own output.
 *
 * A SECOND runner format, deliberately NOT folded into {@link parseFailedTestFiles}
 * (EI-20095409199430877). Node's built-in runner ends a red run with a `✖ failing tests:`
 * block whose every entry is a `test at <file>:<line>:<col>` line — a shape matching
 * NEITHER vitest matcher. So before this existed, every failure in a `node --test`
 * workspace was reported as `no-file-rows`, the reason whose documented causes are "a
 * worker crash, an OOM, a spawn error". That sends a triager hunting infrastructure while
 * the truth is a named assertion in a named file, printed in plain text a few lines up.
 *
 * Measured on run 3655179-735cdb19: `@papercusp/desktop :: test` was reported
 * `unattributed / no-file-rows` while its own captured output read
 * `test at test/build-desktop-sidecar-lock.test.js:11:1`. `@papercusp/desktop` alone runs
 * ~20 test files this way, so the blind spot covered every one of them.
 *
 * ⚠ WHY SEPARATE, and do not "simplify" this by merging the two: `parseFailedTestFiles`'s
 * result is ALSO fed back as re-run ARGUMENTS (`run(failedFiles)` in affected-tests.mjs),
 * which is a vitest calling convention. `@papercusp/desktop`'s `test` script is a chain of
 * `npm run` sub-steps, so appending file paths to it would not re-run those files — it
 * would silently re-run something else. ATTRIBUTION (what broke) and RE-RUN (how to run it
 * again) are different questions; only the first is answered here.
 *
 * Matched from REAL EMITTED BYTES (node v22), never from a quoted log: a mixed pass/fail
 * run prints `test at` for the failing tests ONLY, so the line is failure-exclusive. The
 * path it carries is workspace-relative — the same shape vitest's rollup rows yield, so
 * callers need no normalisation.
 *
 * ⚠ The path deliberately does NOT reuse {@link VITEST_TEST_FILE_SOURCE}, and that is the
 * load-bearing decision here. That pattern demands a literal `.test.`/`.spec.` SEGMENT, but
 * `@papercusp/cli` names its suites `src/**` + `/*.node-test.ts` — `-test`, not `.test`. The
 * first draft of this function DID pin the vitest convention, and it silently reproduced the
 * exact bug it exists to fix for one of the three workspaces in scope: measured, it returned
 * [] for a real cli-shaped failure while the conventional `.test.js` worked. That is what a
 * naming-convention assumption always looks like — correct on the case you sampled, empty on
 * the one you did not, and an empty result here reads as "nothing failed", never as "my
 * matcher is wrong".
 *
 * `test at ` plus a trailing `:line:col` is already a tight, failure-exclusive anchor, so the
 * path only has to look like a JS/TS-family source file. A file-NAMING convention is not a
 * property of the runner's output; the anchor is. Guard the anchor, not the fashion.
 *
 * @param {string} text
 * @returns {string[]} workspace-relative paths, deduped; [] when none
 */
export function parseNodeTestFailedFiles(text) {
  if (!text) return [];
  const plain = stripVitestAnsi(text);
  const files = new Set();
  // A fresh regex per call: a shared /g literal carries `lastIndex` state, and while
  // `matchAll` happens to clone its argument, relying on that is a footgun for the next
  // editor who reaches for `.exec()` on the same constant.
  const re = /^\s*test at\s+(\S+\.[cm]?[jt]sx?):\d+:\d+\s*$/gm;
  for (const m of plain.matchAll(re)) files.add(m[1]);
  return [...files];
}

/**
 * The esbuild TRANSFORM (parse) failures named in a run's own output.
 *
 * MOVED HERE from scripts/test-files.mjs (WI-37607) so the two runners share ONE detector
 * rather than one runner having it and the other not — the same consolidation this module's
 * header already argues for, and the exact gap that made this move necessary: `test:file`
 * has told callers `cause=transform` since EI-19462803905923939, while `test:affected` — the
 * runner CLAUDE.md's "Tests after editing" actually prescribes — had no detection at all.
 * test-files.mjs re-exports it, so its own callers and tests are unchanged.
 *
 * ⚠ Strip ANSI FIRST (EI-18819483316574031). Every matcher here is line-anchored and vitest
 * emits SGR codes around the payload; a sibling detector in this very file was dead in
 * production for weeks because it matched only on clean text.
 *
 * @param {string} output combined stdout+stderr of a vitest invocation
 * @returns {{ file: string, line: number, col: number, message: string }[]} empty when none
 */
export function parseTransformFailure(output) {
  const plain = stripVitestAnsi(output ?? '');
  if (!/Transform failed with \d+ error/.test(plain)) return [];
  const locations = [];
  const seen = new Set();
  // esbuild prints `<path>:<line>:<col>: ERROR: <message>`. Its sibling `File: <path>:<line>:<col>`
  // line carries no `ERROR:` and is deliberately NOT matched — it would double-count every entry.
  const re = /^\s*(\S[^\n]*?):(\d+):(\d+):\s*ERROR:\s*(.+?)\s*$/gm;
  let match;
  while ((match = re.exec(plain)) !== null) {
    const key = `${match[1]}:${match[2]}:${match[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    locations.push({ file: match[1], line: Number(match[2]), col: Number(match[3]), message: match[4] });
  }
  return locations;
}

/**
 * The distinct CULPRIT MODULES of a run's parse failures — deduped, one entry per file
 * regardless of how many times esbuild reprinted it (it reprints per importing worker, so a
 * single broken module yields dozens of identical locations in a real log).
 *
 * @param {string} output combined stdout+stderr of a vitest invocation
 * @returns {string[]} `path:line:col` strings, deduped, in first-seen order
 */
export function transformCulpritsFrom(output) {
  const seen = new Set();
  for (const loc of parseTransformFailure(output)) seen.add(`${loc.file}:${loc.line}:${loc.col}`);
  return [...seen];
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
 * ⚠⚠ `transformCulprits` is a THIRD, ORTHOGONAL axis — deliberately not folded into `coverage`
 * (WI-37607). `coverage` answers "were the failed tasks attributed to files"; it does NOT answer
 * "are the listed files actually broken", and on a parse failure those two come apart completely:
 * measured 2026-08-09, a single unparseable module produced `coverage=complete fileCount=21
 * unattributedCount=0` where all 21 were casualties of a peer's mid-write. Adding a 5th `coverage`
 * value was rejected because green-checkpoint and CLAUDE.md both consume the documented four, and
 * silently changing what `complete` means is the same class of error as the one being fixed.
 *
 * There is deliberately NO `cause=` field here. A parse failure being PRESENT is provable from the
 * output; its being the SOLE cause of every listed file is not — and inventing a confident cause
 * taxonomy is precisely how a well-formed line came to overstate what it knew.
 *
 * @param {{
 *   runToken: string,
 *   entries?: Array<{ workspace: string, file: string }>,
 *   unattributed?: Array<{ task: string, reason: string }>,
 *   transformCulprits?: string[],
 * }} args
 * @returns {string}
 */
export function formatFailingFilesLine({ runToken, entries = [], unattributed = [], transformCulprits = [] }) {
  const files = [...entries];
  const unattr = [...unattributed];
  const culprits = [...new Set(transformCulprits)];
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
    `transformCulpritCount=${culprits.length} ` +
    `files=${JSON.stringify(shown)} unattributed=${JSON.stringify(unattr)} ` +
    `transformCulprits=${JSON.stringify(culprits)}`
  );
}

/**
 * Attribute ONE failed task to the test files that broke it.
 *
 * Returns either files or a REASON it has none — never a bare empty list, because the
 * caller accumulates these and an empty contribution is indistinguishable from "this task
 * passed". Three ways a genuinely-red task yields no file:
 *   - `no-captured-output` — an interactive TTY run inherited stdio, so there is no text
 *     to parse. The failure is real; attribution was never possible.
 *   - `no-file-rows`      — captured output in which NO known runner format named a file:
 *     a worker crash, an OOM, a spawn error.
 *     ⚠ Read this as "no PARSER spoke for it", not "the output named nothing" — those came
 *     apart for `node --test` workspaces until EI-20095409199430877, where output naming the
 *     failing file in plain text still reported this reason and read as an infra crash.
 *   - `transform`         — no FAIL/rollup rows AND a parse failure is present, i.e. the
 *     collapse happened before the reporter ran. Split out of `no-file-rows` (WI-37607):
 *     this docstring used to name a transform failure as one of that reason's causes, which
 *     made a peer's mid-edit read identically to an OOM.
 *   - `non-vitest`        — cargo and friends; this parser cannot speak for them.
 *
 * ⚠ `transformCulprits` is returned INDEPENDENTLY of whether files were attributed, and that
 * independence is the point (WI-37607). Measured on the real logs: a module that fails to
 * parse still produces FAIL/rollup rows for every test file that transitively imports it, so
 * the common case is `entries.length === 21, unattributed.length === 0` — fully attributed,
 * `coverage=complete`, and every one of those 21 a CASUALTY of one broken module. Reading the
 * culprit set off the `unattributed` reason alone would therefore miss exactly the case this
 * was built for.
 *
 * @param {{ workspace: string, task: string, captured: boolean, output?: string }} args
 * @returns {{ entries: Array<{ workspace: string, file: string }>,
 *             unattributed: Array<{ task: string, reason: string }>,
 *             transformCulprits: string[] }}
 */
export function attributeFailedTask({ workspace, task, captured, output = '' }) {
  if (!captured) {
    return { entries: [], unattributed: [{ task, reason: 'no-captured-output' }], transformCulprits: [] };
  }
  const transformCulprits = transformCulpritsFrom(output);
  // Both known runner formats (EI-20095409199430877). A task may legitimately emit both —
  // `@papercusp/desktop`'s `test` chains several `npm run` sub-steps — so this is a union,
  // not a fallback: taking the first non-empty set would drop the other runner's files.
  const files = [...new Set([...parseFailedTestFiles(output), ...parseNodeTestFailedFiles(output)])];
  if (files.length === 0) {
    return {
      entries: [],
      unattributed: [{ task, reason: transformCulprits.length > 0 ? 'transform' : 'no-file-rows' }],
      transformCulprits,
    };
  }
  return { entries: files.map((file) => ({ workspace, file })), unattributed: [], transformCulprits };
}

/**
 * The whole failure-summary block a run prints for its break set: the human list a triager
 * reads, then the canonical machine line. Returned as lines rather than printed so the
 * thing that actually ships is unit-testable.
 *
 * Extracted deliberately (EI-19395701908500754): left inline in affected-tests.mjs, the only
 * available guard is a source-text assertion, which cannot catch a runtime fault on a path
 * that runs solely when the gate is already red — i.e. it would report green while being
 * broken exactly when needed. This module's own history has that shape twice over
 * (EI-18819483316574031: a parser dead in production while its tests passed).
 *
 * The transform-casualty block leads DELIBERATELY (WI-37607). CLAUDE.md instructs triagers to
 * "read `coverage` before `files`", so on a parse failure the most authoritative-looking token in
 * the whole summary — `coverage=complete` — is the one most likely to be trusted about a question
 * it does not answer. A warning printed AFTER the list would be read after the damage.
 *
 * @param {{
 *   runToken: string,
 *   failedTaskCount: number,
 *   entries?: Array<{ workspace: string, file: string }>,
 *   unattributed?: Array<{ task: string, reason: string }>,
 *   transformCulprits?: string[],
 * }} args
 * @returns {string[]}
 */
export function renderFailingFilesSummary({
  runToken,
  failedTaskCount,
  entries = [],
  unattributed = [],
  transformCulprits = [],
}) {
  const culprits = [...new Set(transformCulprits)];
  const lines = [];
  if (culprits.length > 0) {
    lines.push(
      `\n⚠⚠ PARSE (transform) FAILURE DETECTED — cause=transform. Culprit module(s):`,
      ...culprits.map((c) => `     ${c}`),
      `  A module in the import graph failed to PARSE, so EVERY test file that transitively imports`,
      `  it fails too. Treat the ${entries.length} file(s) below as CASUALTIES of the module(s) above`,
      `  until proven otherwise — not as ${entries.length} independent breaks.`,
      `  ⚠ \`coverage\` below can still read \`complete\`: it reports whether each failed TASK was`,
      `    attributed to files, NOT whether those files are themselves broken. On a parse failure`,
      `    those two questions come apart, and coverage answers only the first.`,
      `  On this shared tree this is usually a PEER MID-EDIT: re-run in a minute and check the`,
      `  culprit's \`git status\` BEFORE investigating anything in the list below.`,
    );
  }
  lines.push(
    `\n${entries.length} failing test file(s) — the per-FILE break set ` +
      `(the failed=${failedTaskCount} above counts TASKS, not files):`,
  );
  for (const e of entries) lines.push(`  - ${e.workspace} :: ${e.file}`);
  if (unattributed.length) {
    lines.push(
      `${unattributed.length} failed task(s) could NOT be attributed to files — their ` +
        `failures are REAL but unnamed here; do not read the list above as complete:`,
    );
    for (const u of unattributed) lines.push(`  - ${u.task} (${u.reason})`);
  }
  lines.push(formatFailingFilesLine({ runToken, entries, unattributed, transformCulprits: culprits }));
  return lines;
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
