/**
 * git-runner — the shared spawn-based GitRunner + thin helpers for the harness-docs
 * subsystem (drift checks, the freshness sweep, provenance capture, the endpoints).
 * Same shape as run-git-sync's RunGit (never throws; captures code/stdout/stderr).
 */

import { spawn } from 'node:child_process';
import type { GitRunner } from './subject-ref';

export const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

/** Current HEAD sha of a repo, or null if it can't be read. */
export async function repoHeadSha(repoRoot: string): Promise<string | null> {
  const r = await runGit(['rev-parse', 'HEAD'], repoRoot);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Files changed between two refs (repo-relative), or null on git failure. */
export async function repoChangedPaths(repoRoot: string, a: string, b: string): Promise<string[] | null> {
  const r = await runGit(['diff', '--name-only', a, b], repoRoot);
  if (r.code !== 0) return null;
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}
