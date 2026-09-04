import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(join(__dirname, '..', '..', '..', '..'));

/**
 * ⚠ KEEP THIS PATH AS ONE CONTIGUOUS STRING LITERAL. Do not "tidy" it into
 * join(REPO_ROOT, 'scripts', 'check-...mjs').
 *
 * scripts/check-lint-guard-reachability.mjs credits a guard as reachable by testing
 * `text.includes(implementationPath)` against this file's source. Split across join()
 * arguments the contiguous substring never appears, the guard scores UNREACHABLE, and the
 * gate reds with a false finding that sends someone to wire a guard already wired. That is
 * the exact false-positive direction that checker's own comments warn about — and it cost
 * a round trip here before the cause was found.
 */
const GUARD_REL = 'scripts/check-systemd-dropins-installed.mjs';
const GUARD = join(REPO_ROOT, GUARD_REL);
const AMBIENT_CURSOR_DROP_IN = join(
  REPO_ROOT,
  'apps/operator/scripts/systemd/papercup-dev-api.service.d/60-ambient-semantic-push.conf',
);

/**
 * Wires scripts/check-systemd-dropins-installed.mjs onto a blocking path.
 *
 * lint:guard-reachability rejects a guard that nothing runs, on the grounds that an
 * unwired guard "rots (false positives + baseline drift accrue invisibly) and its green
 * gets quoted as evidence." That is the same failure the guard itself exists to catch
 * (plan substrate-observability-bug-wave-2026-08-26, D-004), so leaving it unwired would
 * have reproduced the defect one level up.
 *
 * DELIBERATE SPLIT, because the guard asserts a fact that lives in systemd rather than in
 * the repo:
 *   - The FIRST test runs everywhere. It exercises the script and asserts its output is
 *     well-formed, so parsing/reporting regressions cannot rot unnoticed.
 *   - The SECOND test asserts real host state, and SKIPS where no user systemd manager is
 *     reachable (CI). On a host that does run these units — including the box the
 *     green-checkpoint runs on — it has teeth: a tracked drop-in that is not loaded fails
 *     it. That blast radius is intended. If the host running the gate has drifted from the
 *     repo's declared unit configuration, everything built on that assumption is already
 *     wrong, and three components were silently written against exactly that drift.
 */
function runGuard(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [GUARD, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 60_000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      status: typeof err?.status === 'number' ? err.status : 1,
      stdout: `${err?.stdout ?? ''}`,
      stderr: `${err?.stderr ?? ''}`,
    };
  }
}

function userSystemdReachable(): boolean {
  try {
    execFileSync('systemctl', ['--user', 'is-system-running'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 15_000,
    });
    return true;
  } catch (err: any) {
    // is-system-running exits non-zero for healthy-but-degraded states, so only the
    // ABSENCE of output means there was no manager to talk to.
    return `${err?.stdout ?? ''}`.trim().length > 0;
  }
}

describe('systemd drop-in install guard (scripts/check-systemd-dropins-installed.mjs)', () => {
  it('ships the ambient semantic dead-end rail enabled, with an explicit kill switch', () => {
    const dropIn = readFileSync(AMBIENT_CURSOR_DROP_IN, 'utf8');
    expect(dropIn).toMatch(/^Environment=PAPERCUSP_AMBIENT_CURSOR=1$/m);
    expect(dropIn).toContain('Set the value to 0');
  });

  it('--list reports a well-formed population and never fails the build', () => {
    const { status, stdout } = runGuard(['--list']);
    expect(status).toBe(0);
    // The summary line is the contract other readers parse; keep it stable.
    expect(stdout).toMatch(/installed=\d+ missing=\d+ unit-absent=\d+/);
  });

  it('reports every tracked drop-in as loaded on a host that runs these units', () => {
    if (!userSystemdReachable()) {
      // Not silently passing: state plainly that the host fact went unverified here.
      console.log(
        'systemd drop-in host assertion SKIPPED — no user systemd manager reachable (expected in CI).',
      );
      return;
    }

    const { status, stdout, stderr } = runGuard([]);
    expect(
      status,
      `A tracked systemd drop-in is not loaded by its unit on this host. The unit is ` +
        `running WITHOUT configuration this repo believes it has.\n${stdout}${stderr}`,
    ).toBe(0);

    const list = runGuard(['--list']);
    expect(list.stdout).toMatch(/missing=0/);
  });
});
