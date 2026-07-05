/**
 * build-info — the git sha + version the RUNNING operator process was built from.
 *
 * WI-265 (deploy-skew footgun): the psu-launcher runs from the staging tree
 * (latest code) while :3070 serves the green-release checkout — a launcher change
 * that depends on a not-yet-promoted endpoint silently 404s, with NO visibility
 * into the skew. Exposing the server's sha on /api/health makes the skew
 * DIAGNOSABLE: a launcher (or any agent) compares its own tree's sha to the
 * server's and knows when it's ahead.
 *
 * Resolved ONCE and cached: prefer `PAPERCUSP_BUILD_SHA` (set at deploy), else a
 * one-time `git rev-parse --short HEAD` of the running checkout. Best-effort —
 * any failure yields `sha: null`, so the zero-dependency /api/health contract
 * (must answer even half-init, never throw) holds.
 *
 * WI-2644: the packaged desktop sidecar runs a bundled `serve.mjs` with no
 * `npm_package_version` in its env (that's only set when npm itself invokes a
 * script) — so `version` silently fell back to '0.0.0' on every real desktop
 * build, even though the shipped app has a real version (tauri.conf.json).
 * Mirrors the working PAPERCUSP_BUILD_SHA pattern: prefer an explicit
 * `PAPERCUSP_BUILD_VERSION` (set at build time from tauri.conf.json's version,
 * see papercusp-desktop/bin/release-local.sh), else fall back to
 * npm_package_version, else '0.0.0'.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface BuildInfo {
  /** Short git sha of the running checkout, or null if unresolved. */
  sha: string | null;
  /** package.json version (npm_package_version), or '0.0.0' if unset. */
  version: string;
}

/** Pure resolver (injectable seams for tests). */
export function resolveBuildInfo(opts: {
  env?: NodeJS.ProcessEnv;
  gitSha?: () => string | null;
} = {}): BuildInfo {
  const env = opts.env ?? process.env;
  const envVersion = env.PAPERCUSP_BUILD_VERSION?.trim();
  const version = envVersion || env.npm_package_version || '0.0.0';
  const envSha = env.PAPERCUSP_BUILD_SHA?.trim();
  if (envSha) return { sha: envSha, version };
  const gitSha = opts.gitSha ?? defaultGitSha;
  let sha: string | null = null;
  try {
    sha = gitSha();
  } catch {
    sha = null;
  }
  return { sha: sha || null, version };
}

function defaultGitSha(): string | null {
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

let cached: BuildInfo | null = null;

/** The running operator's build info, resolved once and cached (boot-cheap; the
 *  request path reads the cache, preserving the zero-dep /api/health contract). */
export function getBuildInfo(): BuildInfo {
  if (!cached) cached = resolveBuildInfo();
  return cached;
}

/** Test-only — clear the cache. */
export function _resetBuildInfoForTest(): void {
  cached = null;
}
