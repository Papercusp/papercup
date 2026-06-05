/**
 * Clone a GitHub repository for the create-harness "GitHub URL" flow
 * (papercusp-dogfood-v5 Phase 1b P-008/P-009, Entry 2 of §3).
 *
 * Design — discovered during implementation 2026-05-24:
 *
 * The original plan called for `isomorphic-git` + `@octokit/*` to do
 * OAuth-token-authenticated cloning ourselves. After grounding against
 * the existing setup-wizard (`apps/operator/app/_components/SetupWizard/
 * StepGit.tsx`) the actual established pattern is:
 *
 *   - User runs `gh auth login` (covered in StepGit; will be gated on
 *     during alpha graduation).
 *   - `gh` registers itself as a git credential helper at install
 *     (or via `gh auth setup-git`).
 *   - From then on, plain `git clone https://github.com/owner/repo`
 *     auths transparently via the credential helper — no token in
 *     our process, no OAuth flow in our code.
 *
 * This module shells out to `git clone` and lets the system handle
 * auth. Side benefits:
 *   - No new deps (isomorphic-git + @octokit/* avoided).
 *   - GitHub-CLI is the user's source of truth for "am I signed into
 *     GitHub?" — one credential, no drift.
 *   - We respect whatever credential management the user has set up,
 *     including 2FA / SSH keys / GH Enterprise / corp SSO.
 *   - Public repos clone with no auth at all (degrades gracefully).
 *
 * Security: `git clone <url> <dest>` is invoked via `execFile` (shell-less,
 * argv-quoted). The URL is validated against a strict GitHub-URL allowlist
 * regex; the destination is resolved + bounded to the workspace clones dir.
 * The auth (if any) flows through git's credential helper, never through
 * our env vars or process state.
 */

import { execFile } from 'node:child_process';
import { workspacesRoot } from '../workspace-registry';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

// Lazy: this server module is pulled into the operator-vite SPA bundle, where
// node:util is browser-stubbed (promisify === undefined). Calling promisify at
// module-eval would throw at import → blank page. Defer to first call; never
// invoked in the browser. (Next-removal client/server split is in progress —
// plan finish-next-removal-2026-06-01.)
const execFileP: (...a: unknown[]) => Promise<{ stdout: string; stderr: string }> = (...a) =>
  (promisify(execFile) as (...x: unknown[]) => Promise<{ stdout: string; stderr: string }>)(...a);

/**
 * Accepted GitHub URL shapes:
 *   - https://github.com/<owner>/<repo>
 *   - https://github.com/<owner>/<repo>.git
 *   - git@github.com:<owner>/<repo>
 *   - git@github.com:<owner>/<repo>.git
 *
 * Owner + repo segments are restricted to GitHub's actual rules:
 *   - 1-39 chars
 *   - alphanum, hyphen, underscore, dot
 *   - cannot start/end with separator (we allow it for owner since
 *     GitHub does too in practice; repo regex is strict)
 *
 * Anything else (other hosts, paths with extra segments, query strings,
 * fragments) is rejected to keep this helper exclusively for the
 * GitHub-URL create-harness flow.
 */
const GITHUB_HTTPS_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_.-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99}?)(?:\.git)?\/?$/;
const GITHUB_SSH_RE =
  /^git@github\.com:([A-Za-z0-9][A-Za-z0-9_.-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99}?)(?:\.git)?$/;

export interface ParsedGithubUrl {
  owner: string;
  repo: string;
  /** Normalized HTTPS URL we'll actually invoke `git clone` with. */
  cloneUrl: string;
}

export function parseGithubUrl(url: string): ParsedGithubUrl | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  let m = GITHUB_HTTPS_RE.exec(trimmed);
  if (!m) m = GITHUB_SSH_RE.exec(trimmed);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  // Final guard: catch a few owner/repo strings the broad regex would
  // accept but GitHub doesn't allow. Owner can't be all dots; repo
  // can't be just '.' or '..'.
  if (/^\.+$/.test(owner) || /^\.+$/.test(repo)) return null;
  return {
    owner,
    repo,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

/**
 * Default directory where cloned repos land. Workspace-scoped so each
 * workspace has its own set; never touches user's existing repos.
 *
 * The destination subdir is derived from the repo name so the user can
 * `cd` into a predictable path. If the directory already exists the
 * clone fails fast — caller decides whether to overwrite (with the
 * destructive-action gesture) or rename.
 */
export function defaultClonesDir(): string {
  return join(workspacesRoot(), 'clones');
}

export interface CloneResult {
  /** Absolute path the repo was cloned into. */
  path: string;
  /** Parsed URL parts. */
  parsed: ParsedGithubUrl;
}

export interface CloneError {
  /** Stable error code for the create-harness UI to react on. */
  code:
    | 'invalid_url'
    | 'dest_exists'
    | 'auth_required'
    | 'not_found'
    | 'git_missing'
    | 'unknown';
  /** Human-readable message, trimmed to 500 chars. */
  message: string;
}

const GIT_AUTH_HINTS = [
  /Authentication failed/i,
  /could not read Username/i,
  /terminal prompts disabled/i,
  /Permission denied \(publickey\)/i,
  /403/,
];
const GIT_NOT_FOUND_HINTS = [
  /Repository not found/i,
  /does not exist/i,
  /404/,
];

function classifyGitError(stderr: string): CloneError['code'] {
  for (const re of GIT_AUTH_HINTS) if (re.test(stderr)) return 'auth_required';
  for (const re of GIT_NOT_FOUND_HINTS) if (re.test(stderr)) return 'not_found';
  return 'unknown';
}

export interface CloneOpts {
  /** Override the clones dir (tests use this; default is workspace-scoped). */
  clonesDir?: string;
  /** Override the dest subdir name (default = parsed.repo). */
  destName?: string;
  /** Pass `--depth 1` for a shallow clone (faster for large repos). Default false. */
  shallow?: boolean;
  /** Hard timeout (ms) for the whole clone — protects against runaway. Default 5 min. */
  timeoutMs?: number;
}

/**
 * Clone a GitHub repo. Returns the resulting absolute path on success,
 * or a structured error on failure. Never throws for predictable
 * failures (invalid URL, dest exists, auth needed, repo missing) —
 * the create-harness route maps these to HTTP 400/401/404 cleanly.
 */
export async function cloneGithubRepo(
  url: string,
  opts: CloneOpts = {},
): Promise<CloneResult | CloneError> {
  const parsed = parseGithubUrl(url);
  if (!parsed) {
    return {
      code: 'invalid_url',
      message:
        'Not a recognized GitHub URL. Expected one of: ' +
        'https://github.com/<owner>/<repo>, ' +
        'git@github.com:<owner>/<repo>.',
    };
  }

  const clonesDir = opts.clonesDir ?? defaultClonesDir();
  const destName = (opts.destName ?? parsed.repo).replace(/\.git$/, '');
  const dest = resolve(clonesDir, destName);
  // Path-bound assertion: dest MUST live inside clonesDir. resolve()
  // strips traversal, then we string-compare to be sure.
  if (!dest.startsWith(resolve(clonesDir) + '/') && dest !== resolve(clonesDir)) {
    return {
      code: 'invalid_url',
      message: 'Resolved destination escapes the workspace clones dir',
    };
  }
  if (existsSync(dest)) {
    return {
      code: 'dest_exists',
      message: `A directory already exists at ${dest}. Move or rename it before cloning.`,
    };
  }

  await mkdir(dirname(dest), { recursive: true });

  const args = ['clone'];
  if (opts.shallow) args.push('--depth', '1');
  args.push(parsed.cloneUrl, dest);

  try {
    await execFileP('git', args, {
      timeout: opts.timeoutMs ?? 5 * 60 * 1000,
      // Disable interactive prompts — credential helper either has
      // creds or we surface auth_required immediately.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { path: dest, parsed };
  } catch (e: unknown) {
    // execFile error shape: { code: number, stdout, stderr, killed, signal, message }
    const err = e as { code?: unknown; stderr?: string; message?: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr : '';
    const message = stderr.trim() || err.message || 'git clone failed';

    // Clean up half-cloned dest so caller can retry.
    try { await rm(dest, { recursive: true, force: true }); } catch { /* best-effort */ }

    if (err.code === 'ENOENT' || /command not found|ENOENT/.test(message)) {
      return {
        code: 'git_missing',
        message: 'git is not installed or not on PATH',
      };
    }
    return {
      code: classifyGitError(message),
      message: message.slice(0, 500),
    };
  }
}

export function isCloneError(r: CloneResult | CloneError): r is CloneError {
  return 'code' in r;
}
