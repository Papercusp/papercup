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
// full line shape (passed/skipped counts, parenthesized totals, color codes
// all vary by vitest version and TTY-vs-pipe).
export function parseSummaryFailedCounts(text) {
  if (!text) return null;
  const filesMatch = text.match(/^\s*Test Files\s+(\d+)\s+failed\b/m);
  const testsMatch = text.match(/^\s*Tests\s+(\d+)\s+failed\b/m);
  if (!filesMatch && !testsMatch) return null;
  return {
    testFiles: filesMatch ? Number(filesMatch[1]) : 0,
    tests: testsMatch ? Number(testsMatch[1]) : 0,
  };
}
