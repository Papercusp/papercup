import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * `defaultRunGit` routes git through the spawner sidecar so the big operator
 * process never pays fork()'s page-table-copy cost (~40ms per GB of its own
 * RSS, ~165ms per git call on the 4.2GB bg-host — EI-18808838427010743).
 *
 * The property that actually matters is NOT "it uses the sidecar" — it is that
 * routing is INVISIBLE to callers: same exit code, same stdout, same stderr,
 * and a sidecar fault degrades PERFORMANCE, never CORRECTNESS. pot-git's ref
 * reads decide what gets integrated and published to peers, so a git result
 * that silently changes shape here is a correctness bug in the sync protocol,
 * not a perf bug.
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

const { defaultRunGit, runGitLocal } = await import('./storage');

let repo: string;

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'potgit-rungit-'));
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

describe('pot-git defaultRunGit', () => {
  it('with the sidecar OFF, returns real git output via the local spawn', async () => {
    sidecarEnabledMock = () => false;
    const r = await defaultRunGit(['rev-parse', '--verify', '-q', 'HEAD^{object}'], repo);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reports a NON-ZERO exit for a bad ref instead of throwing', async () => {
    // readNamespaceRef depends on this: "ref absent" is a code!==0, not a throw.
    sidecarEnabledMock = () => false;
    const r = await defaultRunGit(['rev-parse', '--verify', '-q', 'refs/nope/nothing^{object}'], repo);
    expect(r.code).not.toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('FALLS BACK to the local spawn when the sidecar fails, with an identical result', async () => {
    // The safety property: a sidecar fault must not break git. If this ever
    // regresses, a sidecar outage would silently make every pot-git ref read
    // look like "ref absent" — which the integrator reads as "this member has
    // published nothing", i.e. silent data loss rather than a loud failure.
    const local = await runGitLocal(['rev-parse', '--verify', '-q', 'HEAD^{object}'], repo);

    sidecarEnabledMock = () => true;
    sidecarRunMock = () => Promise.reject(new Error('ECONNREFUSED /run/nope.sock'));

    // The fallback is expected to announce itself exactly once per distinct
    // reason — loudly enough to diagnose, not once per git call (this is the
    // hot ref-read path; per-call logging would itself become a cost).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const viaFallback = await defaultRunGit(['rev-parse', '--verify', '-q', 'HEAD^{object}'], repo);
      expect(viaFallback.code).toBe(local.code);
      expect(viaFallback.stdout).toBe(local.stdout);

      const again = await defaultRunGit(['rev-parse', '--verify', '-q', 'HEAD^{object}'], repo);
      expect(again.stdout).toBe(local.stdout);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('ECONNREFUSED');
    } finally {
      warn.mockRestore();
    }
  });

  it('uses the sidecar result verbatim when the sidecar answers', async () => {
    sidecarEnabledMock = () => true;
    sidecarRunMock = () => Promise.resolve({ code: 0, stdout: 'from-sidecar\n', stderr: '' });
    const r = await defaultRunGit(['rev-parse', 'HEAD'], repo);
    expect(r.stdout).toBe('from-sidecar\n');
  });

  it('passes the C locale through to the sidecar so output stays parse-stable', async () => {
    // Every caller parses git's human-readable output; a host LANG leaking
    // through would change that text and break the parsing at the root.
    sidecarEnabledMock = () => true;
    let seenEnv: Record<string, string> | undefined;
    sidecarRunMock = (...a: unknown[]) => {
      seenEnv = a[3] as Record<string, string>;
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    };
    await defaultRunGit(['status'], repo);
    expect(seenEnv?.LC_ALL).toBe('C');
    expect(seenEnv?.LANG).toBe('C');
  });

  it('forwards the caller timeout override to the sidecar (network ops need a generous one)', async () => {
    sidecarEnabledMock = () => true;
    let seenTimeout: number | undefined;
    sidecarRunMock = (...a: unknown[]) => {
      seenTimeout = a[2] as number;
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    };
    await defaultRunGit(['fetch'], repo, { timeoutMs: 240_000 });
    expect(seenTimeout).toBe(240_000);
  });
});
