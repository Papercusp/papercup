/**
 * check-di-seam-arity-strands-real-tree.test.ts — the WIRING that puts
 * `lint:di-seam-arity-strands` on a blocking path (WI-39420, 2026-08-16).
 *
 * check-lint-guard-reachability flagged this guard as running on NO blocking
 * path: its only test was a unit test of the detector's helpers — "proves the
 * detector works, runs it over nothing". This test EXECUTES the guard over the
 * real tree in `--fail` mode, so it is classified `test` (BLOCKING) by the
 * reachability census (spawns the script over the repo root — the
 * ENFORCING_TEST_RE discriminator).
 *
 * The guard's `--fail` mode blocks on NEW findings only: the three findings
 * that existed when it was wired live in its SHRINK-ONLY `FAIL_BASELINE`
 * (see scripts/check-di-seam-arity-strands.mjs) — wiring it unbaselined would
 * have red-pinned the fleet on defects that accrued while it ran nowhere,
 * exactly the rot mode the reachability meta-guard documents.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

describe('lint:di-seam-arity-strands over the real tree (blocking wiring)', () => {
  it('finds no NEW arity-narrower DI seam beyond the shrink-only baseline', () => {
    let stdout = '';
    let exitCode = 0;
    try {
      stdout = execFileSync('node', ['scripts/check-di-seam-arity-strands.mjs', '--fail'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 120_000,
      });
    } catch (e) {
      const err = e as { status?: number | null; stdout?: string };
      exitCode = err.status ?? 1;
      stdout = err.stdout ?? '';
    }
    // Exit 2 = EXIT_NOT_CHECKED (zero candidate files) — a scan that examined
    // nothing must never read as green (the false-absence class).
    expect(stdout, 'the guard must actually examine the tree').toMatch(/examined \d+ files|found \d+ DI seam/);
    expect(
      exitCode,
      `lint:di-seam-arity-strands --fail found NEW arity-strand(s) beyond its baseline:\n${stdout}\n` +
        'Widen the seam to carry the dropped identifier (the EI-19448665215423873 fix shape), ' +
        'or judge the drop deliberate and record that where the seam is declared — never by appending to FAIL_BASELINE (shrink-only).',
    ).toBe(0);
  });
});
