/**
 * pre-push hook gating — catch-test-lags-migration-at-the-author (#4), Part A.
 *
 * The hook at `bin/git-hooks/pre-push` is the LOCAL enforcement point for two guards:
 *   1. "main is automation-only" — a hard block (pre-existing).
 *   2. An OVERRIDABLE soft-block that runs `npm run test:affected` for an interactive
 *      staging push, so an author sees their own test fallout before the fleet's green
 *      gate does.
 *
 * The single most important property is that the SCHEDULED git-sync push must NOT run
 * the affected suite (it would wedge git-sync, which pushes on a ≤10-min cron). git-sync
 * marks every git invocation with PAPERCUSP_GIT_SYNC_PUSH=1 (run-git-sync.ts
 * defaultRunGit); this test pins the contract that the hook skips on that marker, plus
 * the other fast-exit gates. It deliberately exercises ONLY the early-exit paths so the
 * test never triggers a real (slow) `test:affected` run.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../../..');
const HOOK = resolve(REPO_ROOT, 'bin/git-hooks/pre-push');

function runHook(refLine: string, env: Record<string, string> = {}) {
  // Pipe the ref line on stdin (mirrors git's pre-push contract) and inherit a clean
  // env plus the overrides. spawnSync with no tty → stdout/stderr are pipes, so the
  // hook's `[ -t 1 ] || [ -t 2 ]` non-interactive guard also short-circuits any
  // staging path that slipped past the env gates — exactly the background-push safety
  // net we want to assert is non-blocking.
  return spawnSync('bash', [HOOK], {
    input: `${refLine}\n`,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

describe('pre-push hook', () => {
  it('the hook script exists and is the installed source', () => {
    expect(existsSync(HOOK)).toBe(true);
  });

  it('HARD-BLOCKS a push to main without the green-checkpoint marker', () => {
    const r = runHook('refs/heads/main aaa refs/heads/main bbb', { PAPERCUSP_MAIN_PUSH_OK: '' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/push to main BLOCKED/);
  });

  it('ALLOWS green-checkpoint to push main (PAPERCUSP_MAIN_PUSH_OK=1)', () => {
    const r = runHook('refs/heads/main aaa refs/heads/main bbb', { PAPERCUSP_MAIN_PUSH_OK: '1' });
    expect(r.status).toBe(0);
  });

  it('SKIPS the affected gate for the scheduled git-sync push (PAPERCUSP_GIT_SYNC_PUSH=1) — never wedges git-sync', () => {
    const r = runHook('refs/heads/staging aaa refs/heads/staging bbb', { PAPERCUSP_GIT_SYNC_PUSH: '1' });
    expect(r.status).toBe(0);
    // The affected-run banner must NOT appear — proving the suite never started.
    expect(r.stderr).not.toMatch(/running affected unit tests/);
  });

  it('SKIPS the affected gate on the explicit author opt-out (SKIP_AFFECTED=1)', () => {
    const r = runHook('refs/heads/staging aaa refs/heads/staging bbb', { SKIP_AFFECTED: '1' });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/running affected unit tests/);
  });

  it('SKIPS the affected gate under CI', () => {
    const r = runHook('refs/heads/staging aaa refs/heads/staging bbb', { CI: 'true' });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/running affected unit tests/);
  });

  it('SKIPS the affected gate for a non-staging branch push', () => {
    const r = runHook('refs/heads/some-branch aaa refs/heads/some-branch bbb');
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/running affected unit tests/);
  });

  it('is NON-BLOCKING for an unattended staging push (no TTY) — the affected gate is interactive-only', () => {
    // No skip env, staging push, but spawned with piped stdio (no TTY) → the hook's
    // interactive guard exits 0 without running the suite. This is the safety net that
    // keeps any automated/background pusher we do not know about from being wedged.
    const r = runHook('refs/heads/staging aaa refs/heads/staging bbb');
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/running affected unit tests/);
  });
});
