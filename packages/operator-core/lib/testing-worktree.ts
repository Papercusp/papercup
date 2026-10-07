/**
 * Shared worktree provenance helpers for test runners.
 *
 * Keep this module's dependency graph small: Playwright loads its reporters
 * through a CommonJS transform, so reporters must not import the full
 * testing-run-store (which also owns task-manager/systemd spawn code).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveAgentWorkspaceRoot } from './agent-tools/capability/base-dir';
import {
  exemptProbeSubject,
  isMutationProbeRun,
  resolveProbeSubjectExemptionSync,
} from '@papercusp/test-config/admin-test-runs-reporter';
import { verifyVerifierSourceSync } from './verifier-source';

export interface WorktreeGitSnapshot {
  /** `git rev-parse HEAD`, or null if it couldn't be read. */
  commit: string | null;
  /** `git status --porcelain --untracked-files=all` output, or null if unreadable.
   *  Empty string means clean; non-empty means the shared worktree carries
   *  uncommitted changes at this snapshot. */
  porcelain: string | null;
  /** Archive verification failures remain visible in the reporter's diagnostics. */
  provenanceError?: string;
}

/** Playwright's rootDir is the e2e directory. A committed verifier archive has
 * no Git marker; its existing manifest identifies the source root, even when
 * its content is invalid (capture must fail closed rather than use ambient Git).
 */
export function resolveReporterSourceRoot(projectDir?: string): string {
  if (projectDir) {
    let dir = resolve(projectDir);
    while (true) {
      if (existsSync(join(dir, '.verifier-source.json'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return resolveAgentWorkspaceRoot(projectDir ? { projectDir } : {});
}

/** Source stability only, equivalent to Git's ignored dependency/build data.
 * The independent receipt is retained outside the archive by the verifier.
 * Verify the entire archived source population at both boundaries; a supplied
 * SHA alone never attests clean source. Runtime/dependency acceptance is separate.
 */
export function captureTestSourceSnapshot(root: string): WorktreeGitSnapshot {
  if (!existsSync(join(root, '.verifier-source.json')) && !process.env.VERIFY_TAURI_SOURCE_RECEIPT) {
    return captureWorktreeSnapshot(root);
  }
  try {
    const receiptPath = process.env.VERIFY_TAURI_SOURCE_RECEIPT;
    if (!receiptPath) throw new Error('missing independent verifier source receipt');
    const canonicalRoot = realpathSync(root);
    const receiptRel = relative(canonicalRoot, realpathSync(receiptPath));
    if (receiptRel !== '..' && !receiptRel.startsWith(`..${sep}`)) {
      throw new Error('verifier source receipt must be outside the archive');
    }
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    verifyVerifierSourceSync(canonicalRoot, receipt, { runtimeArtifacts: true });
    return { commit: receipt.sourceCommit, porcelain: '' };
  } catch (error) {
    return { commit: null, porcelain: null,
      provenanceError: `verifier source: ${error instanceof Error ? error.message : String(error)}` };
  }
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
  const origin = process.env.PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT?.trim();
  if (isMutationProbeRun() && origin && isAbsolute(origin)) root = origin;
  if (!root) {
    try {
      root = resolveAgentWorkspaceRoot({});
    } catch {
      return { commit: null, porcelain: null };
    }
  }

  const readGit = (args: string[], gitRoot = root, timeoutMs = 2_000): string | null => {
    try {
      const output = execFileSync('git', args, {
        cwd: gitRoot,
        encoding: 'utf8',
        timeout: timeoutMs,
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

  const commit = readGit(['rev-parse', 'HEAD']) || null;
  const porcelain = readGit(['status', '--porcelain', '--untracked-files=all']);
  if (!porcelain || !isMutationProbeRun()) return { commit, porcelain };
  const exemption = resolveProbeSubjectExemptionSync(root, (cmd, gitRoot, budget) => {
    if (cmd === 'git rev-parse --show-toplevel') return readGit(['rev-parse', '--show-toplevel'], gitRoot, budget);
    if (cmd === 'git rev-parse HEAD') return readGit(['rev-parse', 'HEAD'], gitRoot, budget);
    if (cmd === 'git status --porcelain --untracked-files=all') return readGit(['status', '--porcelain', '--untracked-files=all'], gitRoot, budget);
    const pinned = cmd.match(/^git rev-parse '(HEAD:[^']+)'$/);
    return pinned ? readGit(['rev-parse', pinned[1]], gitRoot, budget) : null;
  });
  return { commit, porcelain: exemption ? exemptProbeSubject(porcelain, exemption) : porcelain };
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
