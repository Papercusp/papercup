/**
 * patch-artifact-provenance — CLI contract.
 *
 * This is one of the 10 release CLIs WI-41775 declares into npm scripts to clear
 * the module-reachability axis, and it was the ONLY one of the 10 with zero test
 * mentions.
 *
 * It cannot be unit-tested by import: line ~140 is
 * `main().then((c) => process.exit(c))` with no isCliEntry(import.meta.url) guard,
 * so importing this module runs main() at import time, opens Postgres, and
 * process.exit()s the vitest worker. We therefore exercise it the only way its
 * shape allows — spawn it as a CLI.
 *
 * The argument-validation path returns BEFORE postgres(...) is constructed, so
 * this test touches no database and needs no fixtures. Every assertion below was
 * MEASURED against the real CLI on 2026-08-26, not inferred from the source:
 * all four argv shapes give exit 2, empty stdout, and usage on stderr (~0.9s).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = join(__dirname, '../../../..');
const tsx = join(REPO_ROOT, 'node_modules/.bin/tsx');
const script = join(__dirname, 'patch-artifact-provenance.ts');

function runCli(argv: string[]): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(tsx, [script, ...argv], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
}

describe('patch-artifact-provenance CLI contract', () => {
  it('exits 2 with usage on stderr when no flags are supplied', () => {
    const { stdout, stderr, code } = runCli([]);
    expect(code).toBe(2);
    expect(stderr).toContain('usage: patch-artifact-provenance');
    // stdout stays clean: a caller parsing this CLI's stdout must not receive
    // human usage text. (The sibling verify-release-paths CLI broke a deploy
    // exactly this way on 2026-06-05 — see its own output-contract describe
    // block, which exists for that incident.)
    expect(stdout.trim()).toBe('');
  });

  it.each([
    ['only --version', ['--version', '9.9.9']],
    ['only --channel', ['--channel', 'stable']],
    ['--version and --channel but no --artifact', ['--version', '9.9.9', '--channel', 'stable']],
  ])('exits 2 with usage and clean stdout when given %s', (_label, argv) => {
    const { stdout, stderr, code } = runCli(argv as string[]);
    expect(code).toBe(2);
    expect(stderr).toContain('usage: patch-artifact-provenance');
    // Measured: every rejected argv shape keeps stdout empty, not just the
    // no-flag one. Asserting it per-case is what stops a future change from
    // leaking a human line onto stdout on one branch only.
    expect(stdout.trim()).toBe('');
  });

  // CALIBRATION — guards against a vacuous pass. If the tsx binary were missing
  // or the spawn never ran, status would be null and `?? 1` would surface 1, not
  // 2; and a validation path that silently accepted empty input would surface 0.
  // Pinning both ends means the `toBe(2)` assertions above cannot pass by accident.
  it('CALIBRATION: the CLI actually executed (not a dead or vacuous spawn)', () => {
    const { code, stderr } = runCli([]);
    expect(code).not.toBe(0); // validation did not silently accept empty argv
    expect(code).not.toBe(127); // tsx binary resolved
    expect(stderr.length).toBeGreaterThan(0);
  });
});
