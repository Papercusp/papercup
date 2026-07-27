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
export function stripVitestAnsi(text) {
  // eslint-disable-next-line no-control-regex -- SGR codes are the thing being removed.
  return String(text).replace(/\x1b\[[0-9;]*m/g, '');
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
 */
export function parseFailedTestFiles(text) {
  if (!text) return [];
  const plain = stripVitestAnsi(text);
  const files = new Set();
  // ` ❯ lib/x/y.test.ts (22 tests | 1 failed) 85ms` — failed-file summary rows.
  for (const m of plain.matchAll(/^\s*❯\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s+\([^)]*\bfailed\b[^)]*\)/gm)) {
    files.add(m[1]);
  }
  // `FAIL  lib/x/y.test.ts …` — failed-suite rows (transform/setup errors).
  for (const m of plain.matchAll(/^\s*FAIL\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\b/gm)) {
    files.add(m[1]);
  }
  return [...files];
}
