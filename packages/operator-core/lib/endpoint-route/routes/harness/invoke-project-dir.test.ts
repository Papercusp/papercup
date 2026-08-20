import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveInvokeProjectDir } from './invoke-project-dir';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { project: string; repair: string; linkedGitdir: string } {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-invoke-project-dir-'));
  cleanup.push(root);
  const project = join(root, 'repo');
  const repair = join(project, '.papercusp', 'worktrees', 'repair-1');
  const linkedGitdir = join(project, '.git', 'worktrees', 'repair-1');
  mkdirSync(repair, { recursive: true });
  mkdirSync(linkedGitdir, { recursive: true });
  writeFileSync(join(repair, '.git'), `gitdir: ${linkedGitdir}\n`, 'utf8');
  return { project, repair, linkedGitdir };
}

describe('resolveInvokeProjectDir', () => {
  it('keeps ordinary invokes on the registered harness root without probing the filesystem', () => {
    expect(
      resolveInvokeProjectDir({ projectPath: '/does/not/need/to/exist', role: 'worker', body: {} }),
    ).toEqual({ ok: true, projectDir: '/does/not/need/to/exist', source: 'harness-root' });
  });

  it('accepts a release-fixer linked worktree owned by this harness', () => {
    const { project, repair } = fixture();
    expect(
      resolveInvokeProjectDir({
        projectPath: project,
        role: 'release-fixer',
        body: { releaseFixerContext: { repairWorktree: repair } },
      }),
    ).toEqual({ ok: true, projectDir: repair, source: 'frozen-repair-worktree' });
  });

  it('rejects the cwd override for every non-release-fixer role', () => {
    const { project, repair } = fixture();
    expect(
      resolveInvokeProjectDir({
        projectPath: project,
        role: 'worker',
        body: { releaseFixerContext: { repairWorktree: repair } },
      }),
    ).toMatchObject({ ok: false, code: 'repair_worktree_role_mismatch' });
  });

  it('rejects a symlink that appears nested but resolves outside the gate-owned root', () => {
    const { project, repair } = fixture();
    const outside = join(project, 'outside-repair');
    mkdirSync(outside, { recursive: true });
    const escaped = join(project, '.papercusp', 'worktrees', 'escaped');
    symlinkSync(outside, escaped, 'dir');

    expect(
      resolveInvokeProjectDir({
        projectPath: project,
        role: 'release-fixer',
        body: { releaseFixerContext: { repairWorktree: escaped } },
      }),
    ).toMatchObject({ ok: false, code: 'repair_worktree_outside_harness' });
    expect(repair).not.toBe(outside);
  });

  it('rejects a nested linked worktree whose gitdir belongs to another repository', () => {
    const { project, repair } = fixture();
    const foreignGitdir = join(project, 'foreign', '.git', 'worktrees', 'repair-1');
    mkdirSync(foreignGitdir, { recursive: true });
    writeFileSync(join(repair, '.git'), `gitdir: ${foreignGitdir}\n`, 'utf8');

    expect(
      resolveInvokeProjectDir({
        projectPath: project,
        role: 'release-fixer',
        body: { releaseFixerContext: { repairWorktree: repair } },
      }),
    ).toMatchObject({ ok: false, code: 'repair_worktree_wrong_repo' });
  });
});
