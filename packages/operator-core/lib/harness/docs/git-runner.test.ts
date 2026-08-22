import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * The harness-docs `runGit` routes git through the spawner sidecar so the big
 * operator process never pays fork()'s page-table-copy cost — ~40ms per GB of
 * the PARENT's RSS, i.e. ~165ms of BLOCKED EVENT LOOP per git call on the ~4GB
 * bg-host, for commands git itself finishes in ~4ms (EI-18808838427010743).
 *
 * As with pot-git's seam, the property that matters is NOT "it used the
 * sidecar" — it is that routing is INVISIBLE to callers: same exit code, same
 * stdout/stderr, and a sidecar fault degrades PERFORMANCE, never CORRECTNESS.
 * This subsystem decides DOC DRIFT (`git log <range> --name-only`), so a git
 * result that silently changes shape here marks docs fresh when they are stale.
 */

// Mocked so the fallback can be driven deterministically without a real sidecar.
vi.mock('../../fleet/git-via-sidecar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../fleet/git-via-sidecar')>();
  return {
    ...actual,
    gitSidecarEnabled: (...a: unknown[]) => sidecarEnabledMock(...(a as [])),
    runGitViaSpawnerSidecar: (...a: unknown[]) => sidecarRunMock(...(a as [])),
  };
});

let sidecarEnabledMock: (...a: unknown[]) => boolean = () => false;
let sidecarRunMock: (...a: unknown[]) => Promise<{ code: number; stdout: string; stderr: string }> =
  () => Promise.reject(new Error('not configured'));

const { runGit, runGitLocal, repoChangedPathPairs } = await import('./git-runner');

let repo: string;

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'harnessdocs-rungit-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  await writeFile(join(repo, 'f.txt'), 'hello\n');
  git('add', 'f.txt');
  git('commit', '-q', '-m', 'seed');
});

afterAll(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

describe('harness-docs runGit', () => {
  it('with the sidecar OFF, returns real git output via the local spawn', async () => {
    sidecarEnabledMock = () => false;
    const r = await runGit(['rev-parse', 'HEAD'], repo);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reports a NON-ZERO exit instead of throwing (callers branch on code)', async () => {
    sidecarEnabledMock = () => false;
    const r = await runGit(['rev-parse', '--verify', '-q', 'refs/nope/nothing^{object}'], repo);
    expect(r.code).not.toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('uses the sidecar result verbatim when the sidecar answers', async () => {
    sidecarEnabledMock = () => true;
    sidecarRunMock = () => Promise.resolve({ code: 0, stdout: 'from-sidecar\n', stderr: '' });
    const r = await runGit(['rev-parse', 'HEAD'], repo);
    expect(r.stdout).toBe('from-sidecar\n');
  });

  it('FALLS BACK to the local spawn when the sidecar fails, with an identical result', async () => {
    // The safety property. If this regresses, a sidecar outage would make every
    // drift `git log` look empty — which the checker reads as "no drift", i.e.
    // silently marking stale docs fresh rather than failing loudly.
    const local = await runGitLocal(['rev-parse', 'HEAD'], repo);

    sidecarEnabledMock = () => true;
    sidecarRunMock = () => Promise.reject(new Error('ECONNREFUSED /run/nope.sock'));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const viaFallback = await runGit(['rev-parse', 'HEAD'], repo);
      expect(viaFallback.code).toBe(local.code);
      expect(viaFallback.stdout).toBe(local.stdout);

      // Warned once per distinct REASON, not once per call: this is the
      // hottest git path in the host, so per-call logging is itself a cost.
      const again = await runGit(['rev-parse', 'HEAD'], repo);
      expect(again.stdout).toBe(local.stdout);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('ECONNREFUSED');
    } finally {
      warn.mockRestore();
    }
  });

  it("passes THIS process's env to the sidecar, not the sidecar's own", async () => {
    // The sidecar merges the passed env over ITS OWN process.env. Omitting it
    // would silently run git under the sidecar's environment — a different
    // HOME/GIT_* config than the caller's, which changes what git resolves.
    sidecarEnabledMock = () => true;
    let seenEnv: NodeJS.ProcessEnv | undefined;
    sidecarRunMock = (...a: unknown[]) => {
      seenEnv = a[3] as NodeJS.ProcessEnv;
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    };
    await runGit(['status'], repo);
    expect(seenEnv).toBeDefined();
    expect(seenEnv?.PATH).toBe(process.env.PATH);
  });

  it('passes the caller cwd through unchanged (the repo git must run against)', async () => {
    sidecarEnabledMock = () => true;
    let seenCwd: string | undefined;
    sidecarRunMock = (...a: unknown[]) => {
      seenCwd = a[1] as string;
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    };
    await runGit(['rev-parse', 'HEAD'], repo);
    expect(seenCwd).toBe(repo);
  });

  it('bounds the sidecar run so a wedged child cannot pin a slot forever', async () => {
    // The local path is deliberately unbounded, but an unbounded sidecar call
    // would let one hung git hold a sidecar slot indefinitely.
    sidecarEnabledMock = () => true;
    let seenTimeout: number | undefined;
    sidecarRunMock = (...a: unknown[]) => {
      seenTimeout = a[2] as number;
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    };
    await runGit(['rev-parse', 'HEAD'], repo);
    expect(seenTimeout).toBeGreaterThan(0);
  });

  it('preserves old and new paths for a detected rename', async () => {
    sidecarEnabledMock = () => false;
    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    await rename(join(repo, 'f.txt'), join(repo, 'moved.md'));
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'rename doc'], { cwd: repo, stdio: 'ignore' });
    const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

    const changes = await repoChangedPathPairs(repo, before, after);
    expect(changes).toEqual([{ status: 'R100', previousPath: 'f.txt', path: 'moved.md' }]);
  });
});
