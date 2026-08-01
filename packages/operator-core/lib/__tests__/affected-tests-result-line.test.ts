/**
 * affected-tests-result-line.test.ts — EI-18796017307093897 regression guard.
 *
 * Observed live 2026-07-27: a `npm run test:affected` background job reported
 * "completed, exit code 0" while the SAME run's own log said "1
 * non-quarantined task(s) failed" — a wrapper/notification layer relaying the
 * exit code disagreed with what `scripts/affected-tests.mjs` itself decided.
 * `scripts/affected-tests.mjs`'s own control flow cannot produce that
 * divergence (the failure message and `process.exit(1)` are inseparable —
 * see the last test below), so the fix is to give every caller a way to
 * verify the TRUE verdict independent of exit-code plumbing elsewhere: one
 * canonical, greppable `AFFECTED_TESTS_RESULT status=... failed=...` line,
 * mirroring `scripts/test-files.mjs`'s `TEST_FILE_RESULT` line, whose
 * `status` is derived from the exact same counters that decide the exit
 * code.
 *
 * These tests exercise the REAL source (a full run needs a real repo tree +
 * real vitest children, which is what `scripts/test-files.mjs` itself is for
 * — this stays a source-shape guard, matching the sibling
 * vitest-summary-exit-code-mismatch.test.ts convention).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');
const source = readFileSync(AFFECTED_TESTS, 'utf8');

describe('affected-tests.mjs emits a self-verifying AFFECTED_TESTS_RESULT line (EI-18796017307093897)', () => {
  it('defines resultLine() from the same failed/quarantinedFailed/tasks counters that decide the exit code', () => {
    expect(source).toMatch(
      /const resultLine = \(status\) =>\s*\n\s*`AFFECTED_TESTS_RESULT status=\$\{status\} tasks=\$\{tasks\.length\} failed=\$\{failed\} quarantinedFailed=\$\{quarantinedFailed\}`;/,
    );
  });

  it('prints status=failed immediately before the process.exit(1) that follows a real failure', () => {
    // Anchor on the whole `if (failed) { ... }` block so a future edit that
    // separates the print from the exit (the exact class of bug this guards
    // against) fails this test even if it doesn't literally reorder lines.
    const failedBlock = source.match(/if \(failed\) \{[\s\S]*?\n\}/)?.[0];
    expect(failedBlock).toBeTruthy();
    expect(failedBlock).toMatch(/errSync\(resultLine\('failed'\)\);/);
    expect(failedBlock).toMatch(/process\.exit\(1\);/);
    // The result line must come BEFORE the exit call, in source order —
    // never printed by a path that a wrapper could observe as already-exited.
    expect(failedBlock!.indexOf("errSync(resultLine('failed'));")).toBeLessThan(failedBlock!.indexOf('process.exit(1);'));
  });

  it('prints status=passed on the clean-run success path', () => {
    expect(source).toMatch(/outSync\('\\nAll affected tests passed\.'\);\s*\n\s*outSync\(resultLine\('passed'\)\);/);
  });

  it('also emits an AFFECTED_TESTS_RESULT line on every early-exit(0) path (no affected / no test script / dry-run)', () => {
    // "no affected workspaces" and "no workspace declares a test script" are
    // both genuine PASS verdicts (nothing to run is not a failure) — a caller
    // grepping for the marker line must still find one, not silence.
    expect(source).toMatch(
      /outSync\('No affected workspaces\.'\);\s*\n\s*outSync\('AFFECTED_TESTS_RESULT status=passed tasks=0 failed=0 quarantinedFailed=0 reason=no-affected-workspaces'\);/,
    );
    // The message TAIL is deliberately loose (`[^`]*`): what this guards is that
    // the marker line is emitted on this early-exit path, not the prose of the
    // human-readable line above it. Pinning the prose exactly is what broke here —
    // a trailing '.' added to "…none declare a 'test' script." reds the fleet's
    // green gate on a copy edit that cannot affect any caller grepping the marker.
    expect(source).toMatch(
      /none declare a 'test' script[^`]*`\);\s*\n\s*outSync\('AFFECTED_TESTS_RESULT status=passed tasks=0 failed=0 quarantinedFailed=0 reason=no-test-script'\);/,
    );
    expect(source).toMatch(
      /if \(dry\) \{\s*\n\s*outSync\(`AFFECTED_TESTS_RESULT status=dry-run tasks=\$\{tasks\.length\} failed=0 quarantinedFailed=0`\);/,
    );
  });

  it('the failure message and process.exit(1) remain inseparable (why the divergence cannot originate here)', () => {
    // Regression guard for the underlying claim in the EI-18796017307093897
    // comment: there is exactly one `if (failed) { ... }` block, and it
    // always ends in process.exit(1) — no code path can print the "N
    // non-quarantined task(s) failed" message and then fall through to a
    // zero exit.
    const failedBlockMatches = source.match(/if \(failed\) \{[\s\S]*?\n\}/g);
    expect(failedBlockMatches).toHaveLength(1);
    expect(failedBlockMatches![0]).toMatch(/non-quarantined task\(s\) failed:/);
    expect(failedBlockMatches![0].trim().endsWith('process.exit(1);\n}'.trim())).toBe(true);
  });
});
