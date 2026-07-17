import { describe, it, expect, vi } from 'vitest';
import {
  buildRecentCommitPatterns,
  commitChurnArea,
  gatherRecentCommitChurn,
  buildRecentCommitLane,
} from './exogenous-commit-lane';

/**
 * NOV-2 (autonomous-loop-prod-audit-2026-07-02 / WI-4635): the recent-commit
 * digest lane — a repo-area churn rollup of recently-touched file paths, the
 * exogenous stimulus distinct from the tracked-completions view. These pin the
 * PURE builder + the fail-soft git edge; no real spawn is exercised (a fake
 * GitLogReader stands in).
 */

describe('commitChurnArea', () => {
  it('takes the top 2 path segments as the area', () => {
    expect(commitChurnArea('packages/operator-core/lib/scout/lenses.ts')).toBe('packages/operator-core');
  });

  it('falls back to the single segment / root for a shallow path', () => {
    expect(commitChurnArea('README.md')).toBe('README.md');
    expect(commitChurnArea('')).toBe('(root)');
  });
});

describe('buildRecentCommitPatterns', () => {
  it('emits nothing below the min-files floor (a lone edit is not a hotspot)', () => {
    const out = buildRecentCommitPatterns(['packages/operator-core/lib/scout/a.ts'], { minFiles: 3 });
    expect(out).toEqual([]);
  });

  it('rolls up churn by area, ranked by distinct-file breadth first', () => {
    const paths = [
      ...Array(5).fill('packages/operator-core/lib/scout/a.ts'), // 1 file, 5 touches
      'packages/operator-core/lib/scout/b.ts',
      'packages/operator-core/lib/scout/c.ts',
      'apps/operator/docs/plans/x.md',
      'apps/operator/docs/plans/y.md',
      'apps/operator/docs/plans/z.md',
      'apps/operator/docs/plans/w.md',
    ];
    const out = buildRecentCommitPatterns(paths, { minFiles: 3 });
    // apps/operator has 4 distinct files > packages/operator-core's 3 distinct files,
    // even though packages/operator-core has more raw touches (7 vs 4) — breadth wins.
    expect(out[0]?.ref).toBe('commit-churn:apps-operator');
    expect(out[0]?.summary).toContain('4 file(s)');
    const scout = out.find((p) => p.ref === 'commit-churn:packages-operator-core');
    expect(scout).toBeTruthy();
    expect(scout!.summary).toContain('3 file(s)');
    expect(scout!.summary).toContain('7 commit-touch(es)');
    expect(scout!.category).toBe('recent-commit');
  });

  it('caps to `limit` areas and normalizes weight to the top area', () => {
    const paths = [
      'a/one/1.ts', 'a/one/2.ts', 'a/one/3.ts', 'a/one/4.ts',
      'b/two/1.ts', 'b/two/2.ts', 'b/two/3.ts',
      'c/three/1.ts', 'c/three/2.ts', 'c/three/3.ts',
    ];
    const out = buildRecentCommitPatterns(paths, { minFiles: 3, limit: 2 });
    expect(out).toHaveLength(2);
    expect(out[0]?.weight).toBe(1);
    expect(out[1]?.weight).toBeLessThan(1);
  });

  it('lists sorted example paths in the detail line, truncated to exampleFiles', () => {
    const paths = ['x/y/b.ts', 'x/y/a.ts', 'x/y/c.ts', 'x/y/d.ts', 'x/y/e.ts'];
    const out = buildRecentCommitPatterns(paths, { minFiles: 3, exampleFiles: 2 });
    expect(out[0]?.detail).toBe('recent examples: x/y/a.ts, x/y/b.ts, …');
  });

  it('ignores blank/whitespace-only path entries', () => {
    const out = buildRecentCommitPatterns(['', '  ', 'a/b/1.ts', 'a/b/2.ts', 'a/b/3.ts'], { minFiles: 3 });
    expect(out).toHaveLength(1);
  });
});

describe('gatherRecentCommitChurn (fail-soft git edge)', () => {
  it('returns the touched paths from a healthy git log', async () => {
    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: '/repo\n', stderr: '' };
      return { code: 0, stdout: 'a/b.ts\nc/d.ts\n\n', stderr: '' };
    });
    const paths = await gatherRecentCommitChurn({ runGit, repoRoot: '/repo' });
    expect(paths).toEqual(['a/b.ts', 'c/d.ts']);
  });

  it('resolves the repo root via rev-parse before reading log', async () => {
    const runGit = vi.fn(async (args: string[], cwd: string) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: '/toplevel\n', stderr: '' };
      expect(cwd).toBe('/toplevel'); // log ran from the resolved toplevel, not the input cwd
      return { code: 0, stdout: 'a.ts\n', stderr: '' };
    });
    const paths = await gatherRecentCommitChurn({ runGit, repoRoot: '/nested/subdir' });
    expect(paths).toEqual(['a.ts']);
  });

  it('returns [] when git log fails (non-git tree, spawn error, …)', async () => {
    const runGit = vi.fn(async () => ({ code: 128, stdout: '', stderr: 'not a git repository' }));
    expect(await gatherRecentCommitChurn({ runGit })).toEqual([]);
  });

  it('returns [] when the runner throws', async () => {
    const runGit = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(await gatherRecentCommitChurn({ runGit })).toEqual([]);
  });
});

describe('buildRecentCommitLane (gather + build)', () => {
  it('produces category-stamped patterns end to end from a fake reader', async () => {
    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: '/repo\n', stderr: '' };
      const files = Array(4).fill('packages/operator-core/lib/scout/x.ts').join('\n');
      return { code: 0, stdout: files, stderr: '' };
    });
    const out = await buildRecentCommitLane({ runGit, minFiles: 1 });
    expect(out).toHaveLength(1);
    expect(out[0]?.category).toBe('recent-commit');
    expect(out[0]?.ref).toBe('commit-churn:packages-operator-core');
  });

  it('is fail-soft end to end', async () => {
    const runGit = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(await buildRecentCommitLane({ runGit })).toEqual([]);
  });
});
