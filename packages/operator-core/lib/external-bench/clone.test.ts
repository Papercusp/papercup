/**
 * Port 1 (clone + diff) unit tests — fully fake git/fs, no real clone or subprocess.
 */
import { describe, expect, it, vi } from 'vitest';
import { graderTestFiles, isPinnedCommit, makeCloneTaskRepo, makeExtractDiff, resolveRepoSource } from './clone';
import type { BenchTask, TaskCheckout } from './types';

function task(over: Partial<BenchTask> = {}): BenchTask {
  return {
    benchmark: 'swe-bench-pro',
    instanceId: 'inst_x',
    problemStatement: 'fix the bug',
    repo: 'astropy/astropy',
    baseCommit: 'abcdef1234567',
    graderMeta: {},
    ...over,
  };
}

describe('isPinnedCommit', () => {
  it('accepts hex SHAs (7-40), rejects refs', () => {
    expect(isPinnedCommit('abcdef1')).toBe(true);
    expect(isPinnedCommit('a'.repeat(40))).toBe(true);
    expect(isPinnedCommit('main')).toBe(false);
    expect(isPinnedCommit('v2.0')).toBe(false);
    expect(isPinnedCommit('abcdef')).toBe(false); // too short
  });
});

describe('resolveRepoSource', () => {
  it('maps owner/name → GitHub HTTPS', () => {
    expect(resolveRepoSource(task({ repo: 'astropy/astropy' }))).toBe('https://github.com/astropy/astropy.git');
  });
  it('passes a full URL / local path through verbatim', () => {
    expect(resolveRepoSource(task({ repo: 'https://x.example/r.git' }))).toBe('https://x.example/r.git');
    expect(resolveRepoSource(task({ repo: '/local/repo' }))).toBe('/local/repo');
  });
  it('honors graderMeta.repoUrl override', () => {
    expect(resolveRepoSource(task({ repo: 'a/b', graderMeta: { repoUrl: 'file:///mirror/a.git' } }))).toBe('file:///mirror/a.git');
  });
  it('throws when no repo', () => {
    expect(() => resolveRepoSource(task({ repo: undefined }))).toThrow(/no repo/);
  });
});

describe('graderTestFiles', () => {
  it('returns the testFiles array, filtering non-strings; [] when absent', () => {
    expect(graderTestFiles(task({ graderMeta: { testFiles: ['tests/a.py', 'tests/b.py', 3] } }))).toEqual(['tests/a.py', 'tests/b.py']);
    expect(graderTestFiles(task())).toEqual([]);
  });
});

describe('makeCloneTaskRepo', () => {
  it('clones a remote repo then detaches at the base commit', async () => {
    const calls: string[][] = [];
    const git = vi.fn(async (args: string[]) => {
      calls.push(args);
      return '';
    });
    const clone = makeCloneTaskRepo({ git, mkdtemp: async (p) => `${p}XXX`, rm: async () => {} });
    const co = await clone(task(), { workRoot: '/scratch' });

    expect(co.dir).toBe('/scratch/extbench-XXX');
    expect(co.baseCommit).toBe('abcdef1234567');
    expect(calls[0]).toEqual(['clone', '--quiet', 'https://github.com/astropy/astropy.git', '/scratch/extbench-XXX']);
    expect(calls[0]).not.toContain('--local');
    expect(calls.some((a) => a.includes('checkout') && a.includes('--detach') && a.includes('abcdef1234567'))).toBe(true);
  });

  it('uses --local for a local source', async () => {
    const calls: string[][] = [];
    const git = vi.fn(async (args: string[]) => {
      calls.push(args);
      return '';
    });
    const clone = makeCloneTaskRepo({ git, mkdtemp: async (p) => `${p}Y`, rm: async () => {} });
    await clone(task({ repo: '/local/repo' }), { workRoot: '/scratch' });
    expect(calls[0]).toContain('--local');
  });

  it('falls back to fetch+checkout when the base commit is not initially reachable', async () => {
    let checkoutCalls = 0;
    let fetched = false;
    const git = vi.fn(async (args: string[]) => {
      if (args.includes('fetch')) fetched = true;
      if (args.includes('checkout')) {
        checkoutCalls += 1;
        if (checkoutCalls === 1) throw new Error('reference is not a tree');
      }
      return '';
    });
    const clone = makeCloneTaskRepo({ git, mkdtemp: async (p) => `${p}Z`, rm: async () => {} });
    await clone(task(), { workRoot: '/scratch' });
    expect(fetched).toBe(true);
    expect(checkoutCalls).toBe(2);
  });

  it('rejects a non-pinned base commit', async () => {
    const clone = makeCloneTaskRepo({ git: async () => '', mkdtemp: async (p) => p, rm: async () => {} });
    await expect(clone(task({ baseCommit: 'main' }))).rejects.toThrow(/pinned hex SHA/);
  });

  it('cleans up the scratch dir when clone fails', async () => {
    const rm = vi.fn(async () => {});
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'clone') throw new Error('boom');
      return '';
    });
    const clone = makeCloneTaskRepo({ git, mkdtemp: async (p) => `${p}W`, rm });
    await expect(clone(task(), { workRoot: '/scratch' })).rejects.toThrow('boom');
    expect(rm).toHaveBeenCalledWith('/scratch/extbench-W');
  });
});

describe('makeExtractDiff', () => {
  const checkout: TaskCheckout = { dir: '/co', repo: 'r', baseCommit: 'abc1234', cleanup: async () => {} };

  it('stages then diffs against the base commit', async () => {
    const calls: string[][] = [];
    const git = vi.fn(async (args: string[]) => {
      calls.push(args);
      return args.includes('diff') ? 'diff --git a/x b/x\n+changed\n' : '';
    });
    const out = await makeExtractDiff({ git })(checkout, task());
    expect(out).toContain('diff --git');
    expect(calls.some((a) => a.includes('add') && a.includes('-A'))).toBe(true);
    const diffArgs = calls.find((a) => a.includes('diff'))!;
    expect(diffArgs).toContain('--cached');
    expect(diffArgs).toContain('abc1234');
  });

  it('excludes grader test files via pathspec', async () => {
    let diffArgs: string[] = [];
    const git = vi.fn(async (args: string[]) => {
      if (args.includes('diff')) diffArgs = args;
      return args.includes('diff') ? 'diff --git a/x b/x\n' : '';
    });
    await makeExtractDiff({ git })(checkout, task({ graderMeta: { testFiles: ['tests/t.py'] } }));
    expect(diffArgs).toContain('--');
    expect(diffArgs).toContain(':(exclude)tests/t.py');
  });

  it('always excludes the harness .papercusp/ scaffolding from the predictions patch', async () => {
    let diffArgs: string[] = [];
    const git = vi.fn(async (args: string[]) => {
      if (args.includes('diff')) diffArgs = args;
      return args.includes('diff') ? 'diff --git a/x b/x\n' : '';
    });
    // Even with NO grader test files, the harness's own .papercusp/ scratch state must be excluded —
    // it is written by createHarness/the spine (blueprint.yaml, debug, logs, memory) and is never
    // benchmark content; leaking it pollutes the patch the grader applies.
    await makeExtractDiff({ git })(checkout, task());
    expect(diffArgs).toContain('--');
    expect(diffArgs).toContain(':(exclude).papercusp/**');
  });

  it('returns "" when there is no change', async () => {
    const git = vi.fn(async (args: string[]) => (args.includes('diff') ? '   \n' : ''));
    expect(await makeExtractDiff({ git })(checkout, task())).toBe('');
  });
});
