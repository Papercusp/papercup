import { execFileSync } from 'node:child_process';
import * as nodePath from 'node:path';

/** `undefined` means Git could not establish ownership; callers should fail open. */
export type GitTrackednessProbe = (repoRoot: string, repoRelativePath: string) => boolean | null | undefined;

/**
 * Ask Git whether a path is in the index. Status 1 means an ordinary untracked/ignored
 * path; every other failure is uncertainty and must not suppress an advisory.
 */
export function isGitTrackedPath(repoRoot: string, repoRelativePath: string): boolean | undefined {
  try {
    execFileSync('git', ['-C', repoRoot, 'ls-files', '--error-unmatch', '--', repoRelativePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5_000,
      killSignal: 'SIGKILL',
    });
    return true;
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? (error as { status?: unknown }).status
        : undefined;
    return status === 1 ? false : undefined;
  }
}

/** Map a path reference into one checkout, refusing external or ambiguous paths. */
export function repoRelativePathUnderRoot(reference: string, repoRoot: string): string | undefined {
  const value = reference.trim();
  if (!value || value.startsWith('~')) return undefined;
  if (value === '..' || value.startsWith('../') || value.startsWith('..\\')) return undefined;

  const root = nodePath.resolve(repoRoot);
  const absolute = nodePath.isAbsolute(value) ? nodePath.resolve(value) : nodePath.resolve(root, value);
  const relative = nodePath.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith('..' + nodePath.sep) || nodePath.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(nodePath.sep).join('/');
}
