/**
 * Regression coverage for setup-release-checkout.sh's INTEGRATION_ROOT repo check
 * (WI-10001774).
 *
 * ## The bug this locks out
 * The check used to be `[ -d "$INTEGRATION_ROOT/.git" ]` — a test for a DIRECTORY.
 * A git WORKTREE's `.git` is a FILE (`gitdir: <path>`), so every worktree was
 * rejected as "not a git repo".
 *
 * That is the default case, not an edge case. `integrationRoot` falls back to
 * `scriptRepoRoot()` (release-config.ts), i.e. whichever tree the calling process
 * runs from — and the operator processes that launch deploys run from worktrees:
 * papercusp-staging (:3170) and papercup-release (:3070). So every deploy fired
 * through the release:deploy TOOL aborted here, as did its rollback leg (both call
 * this script). Measured 2026-09-17: the pipeline sat 260 commits behind the green
 * pin, and fleet outage EI-23538941588991674 stayed unfixable for 7.5h behind it.
 *
 * ## Why the failure was invisible
 * The check runs BEFORE anything touches the release root, so the release tree stays
 * consistent and :3070 keeps serving the old build happily. A deploy that cannot run
 * and a deploy that has not run yet look identical from the outside — which is why
 * this needs a test rather than "we'd notice".
 *
 * ## What is locked here
 *   (a) a WORKTREE is accepted — the actual regression;
 *   (b) a normal main repo is still accepted — no loosening in the useful direction;
 *   (c) a non-repo is still REJECTED, with the original message. This matters because
 *       the tempting minimal fix is `-e`, which a stray `.git` file satisfies. We use
 *       `git rev-parse --git-dir`, which tests the capability every later line in the
 *       script actually depends on (they are all `git -C "$INTEGRATION_ROOT" ...`).
 *
 * Same extraction pattern as setup-release-checkout-submodule-repos.test.ts: the check
 * is sourced OUT OF the live script, so this tracks shipped logic rather than a copy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT_PATH = join(__dirname, '../../bin/release/setup-release-checkout.sh');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'setup-release-test',
  GIT_AUTHOR_EMAIL: 'setup-release-test@example.invalid',
  GIT_COMMITTER_NAME: 'setup-release-test',
  GIT_COMMITTER_EMAIL: 'setup-release-test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout ?? '').trim();
}

/**
 * Pull the shipped guard line out of the live script.
 *
 * Anchored on the user-facing message rather than on any particular shell builtin, so
 * the extraction keeps working if the implementation changes again — and fails loudly
 * (rather than silently matching nothing and vacuously passing) if the line is gone.
 */
function extractRepoCheck(): string {
  const src = readFileSync(SCRIPT_PATH, 'utf8');
  const line = src
    .split('\n')
    .find((l) => l.includes('integration root is not a git repo') && !l.trimStart().startsWith('#'));
  if (!line) {
    throw new Error(
      'could not find the INTEGRATION_ROOT repo-check line in setup-release-checkout.sh — ' +
        'if it was intentionally renamed, update this test; do NOT delete the check.',
    );
  }
  return line;
}

/** Run the extracted check with INTEGRATION_ROOT bound to `root`. */
function runCheck(root: string): { code: number; stderr: string } {
  const program = `set -u\nINTEGRATION_ROOT=${JSON.stringify(root)}\n${extractRepoCheck()}\nexit 0\n`;
  const r = spawnSync('bash', ['-c', program], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  });
  return { code: r.status ?? -1, stderr: r.stderr ?? '' };
}

describe('setup-release-checkout.sh — INTEGRATION_ROOT repo check', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'setup-release-repo-check-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A main repo with one commit, so a worktree can be added from it. */
  function makeMainRepo(): string {
    const main = join(tmp, 'main');
    mkdirSync(main, { recursive: true });
    git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, 'f.txt'), 'hello\n');
    git(main, 'add', 'f.txt');
    git(main, 'commit', '-q', '-m', 'init');
    return main;
  }

  it('accepts a normal main repo (.git is a directory)', () => {
    const main = makeMainRepo();
    expect(runCheck(main).code).toBe(0);
  });

  it('accepts a git WORKTREE, whose .git is a FILE — the WI-10001774 regression', () => {
    const main = makeMainRepo();
    const wt = join(tmp, 'wt');
    git(main, 'worktree', 'add', '--detach', wt, 'HEAD');

    // Guard the premise: if .git here were a directory, this test would pass even
    // against the old `-d` check and would therefore prove nothing.
    const dotGit = join(wt, '.git');
    const stat = spawnSync('bash', ['-c', `[ -f ${JSON.stringify(dotGit)} ] && echo file || echo notfile`], {
      encoding: 'utf8',
    });
    expect(stat.stdout.trim()).toBe('file');

    expect(runCheck(wt).code).toBe(0);
  });

  it('still REJECTS a non-repo directory, with the original message', () => {
    const plain = join(tmp, 'plain');
    mkdirSync(plain, { recursive: true });
    const r = runCheck(plain);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('integration root is not a git repo');
  });

  it('still REJECTS a directory holding a stray .git FILE that is not a real repo', () => {
    // The tempting minimal fix for the worktree bug is `-e`, which this case satisfies.
    // Asserting it here is what keeps the fix from being "simplified" back into a hole.
    const fake = join(tmp, 'fake');
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, '.git'), 'gitdir: /nonexistent/path/that/is/not/a/repo\n');
    const r = runCheck(fake);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('integration root is not a git repo');
  });
});
