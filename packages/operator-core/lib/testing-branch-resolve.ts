/**
 * testing-branch-resolve.ts — resolve the current git branch and HEAD,
 * with a hard timeout. Used by:
 *   - file-status route (P-009) to scope status chips per D-010
 *   - test reporters (P-010..P-012) to stamp branch/commit_sha on
 *     each test_runs row
 *
 * Fail-soft contract (D-007): every call returns `{branch:null,
 * commit:null}` on failure — never throws, never blocks longer than
 * 200ms. The caller proceeds with null fields; the file-status route
 * falls back to "any source" with a "stale" badge per D-010.
 *
 * Cached for 30 seconds. Resolution is cheap but called per-request,
 * and the branch rarely changes mid-session.
 */

import { exec } from 'node:child_process';
import { inferWorkspaceRoot } from './testing-domain-glob';

export interface GitContext {
  branch: string | null;
  commit: string | null;
}

const CACHE_TTL_MS = 30_000;
let _cached: { value: GitContext; expiresAt: number } | null = null;

function runWithTimeout(cmd: string, cwd: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = exec(cmd, { cwd, timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
    child.on('error', () => resolve(null));
  });
}

export async function resolveGitContext(): Promise<GitContext> {
  const now = Date.now();
  if (_cached && _cached.expiresAt > now) return _cached.value;

  const root = inferWorkspaceRoot();
  const [branchRaw, commitRaw] = await Promise.all([
    runWithTimeout('git rev-parse --abbrev-ref HEAD', root, 200),
    runWithTimeout('git rev-parse HEAD', root, 200),
  ]);

  const value: GitContext = {
    branch: branchRaw && branchRaw !== 'HEAD' ? branchRaw : null,
    commit: commitRaw || null,
  };
  _cached = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/** INTERNAL — test-only. Reset the cache so tests can re-resolve. */
export function _resetGitContextCache(): void {
  _cached = null;
}
