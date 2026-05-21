/**
 * Git history + diff for plan files. The shared helper behind:
 *   - `GET /api/admin/plans/git/:op` (the UI route handler at
 *     `lib/endpoint-route/routes/admin/plan-git.ts`, which the Plans
 *     admin tab's GitHistoryStrip consumes — P-303).
 *   - `plans:history` / `plans:diff` tools (Q3 of
 *     plans-admin-ui-2026-05-20: promoting the surface so agents get
 *     plan history too).
 *
 * One source of truth for the git argv + validation + parse, so the
 * route and the tools cannot drift.
 *
 * Security: slug is regex-validated (kebab-case alphanum); archived
 * flag picks docs/plans/ vs docs/plans/archive/; nothing else is
 * passed to git's argv. execFile is shell-less.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const PLAN_GIT_SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
export const PLAN_GIT_HASH_RE = /^[0-9a-f]{4,40}$/i;
const PLANS_DIR_REL = 'apps/operator/docs/plans';
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;

export interface GitCommit {
  hash: string;
  author: string;
  /** ISO-8601 author date. */
  date: string;
  subject: string;
}

/**
 * The shared error codes both surfaces report. Routes/tools may
 * translate to their own envelope, but the codes are stable.
 */
export type PlanGitErrorCode =
  | 'invalid_slug'
  | 'invalid_hash'
  | 'git_error';

export type PlanHistoryResult =
  | { ok: true; commits: GitCommit[] }
  | { ok: false; code: PlanGitErrorCode; message?: string };

export type PlanDiffResult =
  | { ok: true; diff: string }
  | { ok: false; code: PlanGitErrorCode; message?: string };

function resolveRepoRoot(): string {
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, PLANS_DIR_REL))) return cwd;
  const up = path.resolve(cwd, '..', '..');
  if (existsSync(path.join(up, PLANS_DIR_REL))) return up;
  return cwd;
}

function planFileRel(slug: string, archived: boolean): string {
  return archived ? `${PLANS_DIR_REL}/archive/${slug}.md` : `${PLANS_DIR_REL}/${slug}.md`;
}

export function parseHistory(stdout: string): GitCommit[] {
  if (!stdout) return [];
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', author = '', date = '', ...subject] = line.split('\x00');
      return { hash, author, date, subject: subject.join('\x00') };
    });
}

export async function readPlanHistory(
  slug: string,
  opts: { archived?: boolean; limit?: number } = {},
): Promise<PlanHistoryResult> {
  if (!PLAN_GIT_SLUG_RE.test(slug)) {
    return { ok: false, code: 'invalid_slug', message: 'slug must be kebab-case alphanumerics' };
  }
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_HISTORY_LIMIT), MAX_HISTORY_LIMIT);
  const repoRoot = resolveRepoRoot();
  const relPath = planFileRel(slug, opts.archived === true);
  // A plan file with no git history (untracked / brand-new) is a
  // normal empty case, not an error.
  if (!existsSync(path.join(repoRoot, relPath))) {
    return { ok: true, commits: [] };
  }
  try {
    const { stdout } = await exec(
      'git',
      [
        'log',
        '--follow',
        `-n${limit}`,
        `--pretty=format:%H%x00%an%x00%aI%x00%s`,
        '--',
        relPath,
      ],
      { cwd: repoRoot, timeout: 5000, maxBuffer: 512 * 1024 },
    );
    return { ok: true, commits: parseHistory(stdout) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, code: 'git_error', message: message.slice(0, 400) };
  }
}

export async function readPlanDiff(
  slug: string,
  hash: string,
  opts: { archived?: boolean } = {},
): Promise<PlanDiffResult> {
  if (!PLAN_GIT_SLUG_RE.test(slug)) {
    return { ok: false, code: 'invalid_slug', message: 'slug must be kebab-case alphanumerics' };
  }
  if (!PLAN_GIT_HASH_RE.test(hash)) {
    return { ok: false, code: 'invalid_hash', message: 'hash must be 4-40 hex chars' };
  }
  const repoRoot = resolveRepoRoot();
  const relPath = planFileRel(slug, opts.archived === true);
  if (!existsSync(path.join(repoRoot, relPath))) {
    return { ok: true, diff: '' };
  }
  try {
    const { stdout } = await exec(
      'git',
      ['diff', `${hash}^!`, '--', relPath],
      { cwd: repoRoot, timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
    );
    return { ok: true, diff: stdout };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, code: 'git_error', message: message.slice(0, 400) };
  }
}
