/**
 * Shared worktree provenance helpers for test runners.
 *
 * Keep this module's dependency graph small: Playwright loads its reporters
 * through a CommonJS transform, so reporters must not import the full
 * testing-run-store (which also owns task-manager/systemd spawn code).
 */

import { execFileSync } from 'node:child_process';
import { resolveAgentWorkspaceRoot } from './agent-tools/capability/base-dir';

export interface WorktreeGitSnapshot {
  /** `git rev-parse HEAD`, or null if it couldn't be read. */
  commit: string | null;
  /** `git status --porcelain --untracked-files=all` output, or null if unreadable.
   *  Empty string means clean; non-empty means the shared worktree carries
   *  uncommitted changes at this snapshot. */
  porcelain: string | null;
}

export function computeWorktreeDirty(before: WorktreeGitSnapshot, after: WorktreeGitSnapshot): boolean {
  if (!before.commit || !after.commit) return true;
  if (before.commit !== after.commit) return true;
  if (before.porcelain === null || after.porcelain === null) return true;
  if (before.porcelain.trim().length > 0) return true;
  if (after.porcelain.trim().length > 0) return true;
  return false;
}

/**
 * Capture the shared worktree's commit and full porcelain status fail-soft.
 *
 * This is intentionally synchronous for the pre-run call: callers must finish
 * the before snapshot before spawning a child, otherwise a fast child could
 * complete before its "before" probe does. A missing/failed probe is returned
 * as null and therefore marks the run dirty via computeWorktreeDirty.
 */
export function captureWorktreeSnapshot(cwd?: string): WorktreeGitSnapshot {
  let root = cwd;
  if (!root) {
    try {
      root = resolveAgentWorkspaceRoot({});
    } catch {
      return { commit: null, porcelain: null };
    }
  }

  const readGit = (args: string[]): string | null => {
    try {
      const output = execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        timeout: 2_000,
        // These snapshots only observe the shared tree. Prevent Git's optional
        // index refresh from competing with git-sync's index writer.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (output == null) return null;
      return output.trim();
    } catch {
      return null;
    }
  };

  return {
    commit: readGit(['rev-parse', 'HEAD']) || null,
    porcelain: readGit(['status', '--porcelain', '--untracked-files=all']),
  };
}

/** Native async producers can await the shared sidecar Git runner rather than
 * block their host on the synchronous reporter's two-second deadline. Keep
 * unknown reads fail-closed and bracket status to detect source movement.
 * The lazy import keeps synchronous reporter imports small.
 */
export async function captureWorktreeSnapshotAsync(root: string): Promise<WorktreeGitSnapshot> {
  const { runGit } = await import('./harness/docs/git-runner');
  try {
    const head = await runGit(['--no-optional-locks', 'rev-parse', 'HEAD'], root);
    const status = await runGit(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'], root);
    const after = await runGit(['--no-optional-locks', 'rev-parse', 'HEAD'], root);
    return {
      commit: head.code === 0 && after.code === 0 && head.stdout.trim() === after.stdout.trim()
        ? head.stdout.trim() || null : null,
      porcelain: status.code === 0 ? status.stdout.trim() : null,
    };
  } catch {
    return { commit: null, porcelain: null };
  }
}
