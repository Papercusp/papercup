/**
 * github-facts — populate the Insights ProjectCard from real GitHub repo
 * metadata (tier-A, per v5 §17).
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24 (P-073a).
 *
 * The ProjectCard has always had slots for description / owner / license /
 * languages / GitHub link, but `loadHarnessInsights` only ever filled them
 * with a slug-derived fallback. This module resolves the harness's GitHub
 * repo (via its git `origin` remote) and fetches the real facts through the
 * operator's authenticated Octokit, mapping them into the card's props. The
 * endpoint passes the result as the `project` override; everything degrades
 * to the existing fallback (no token, no remote, non-GitHub remote, API
 * error) so this never breaks the tab.
 *
 * Layering:
 *   - mapRepoFactsToProjectCard() — PURE: GitHub responses → Partial<ProjectCardProps>.
 *   - fetchGithubRepoFacts()      — one repo via an injected Octokit.
 *   - loadProjectCardFromGithub() — resolve + fetch + 1h read-through cache.
 * All collaborators are injectable, so the logic is unit-tested with no live
 * GitHub / PG / git (see github-facts.test.ts).
 *
 * Follow-up (not here): persist the cache in PG instead of in-process, and
 * surface claim-status / Discord from the binding service + harness config.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Octokit } from '@octokit/rest';
import type {
  ProjectCardProps,
  ProjectCardLanguage,
} from '../../app/harness/insights/ProjectCard';
import { getOctokit } from '../identity/octokit-client';
import { resolveHarnessForWorkspace } from '../harness-core';

const execFileP = promisify(execFile);

/**
 * GitHub Linguist colors for the common languages we'll actually see here.
 * Unknown languages fall back to a neutral gray. (Subset of github/linguist's
 * languages.yml — not exhaustive by design.)
 */
const LANG_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572A5',
  Rust: '#dea584',
  Go: '#00ADD8',
  Java: '#b07219',
  Kotlin: '#A97BFF',
  Swift: '#F05138',
  'C++': '#f34b7d',
  C: '#555555',
  'C#': '#178600',
  Ruby: '#701516',
  PHP: '#4F5D95',
  Shell: '#89e051',
  HTML: '#e34c26',
  CSS: '#563d7c',
  SCSS: '#c6538c',
  Vue: '#41b883',
  Svelte: '#ff3e00',
  Dart: '#00B4AB',
  Scala: '#c22d40',
  Elixir: '#6e4a7e',
  Haskell: '#5e5086',
  Lua: '#000080',
  Nix: '#7e7eff',
  Dockerfile: '#384d54',
  Makefile: '#427819',
  MDX: '#fcb32c',
  Astro: '#ff5a03',
};
const FALLBACK_LANG_COLOR = '#8b949e';

/** Subset of the GitHub `GET /repos/:owner/:repo` response we consume. */
export interface GithubRepoResponse {
  name?: string;
  description?: string | null;
  html_url?: string;
  owner?: { login?: string } | null;
  license?: { spdx_id?: string | null } | null;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  pushed_at?: string | null;
}

function topLanguages(
  bytes: Record<string, number> | null | undefined,
  n = 3,
): ProjectCardLanguage[] {
  const entries = Object.entries(bytes ?? {}).filter(([, b]) => b > 0);
  const total = entries.reduce((sum, [, b]) => sum + b, 0);
  if (total <= 0) return [];
  return entries
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, b]) => ({
      name,
      color: LANG_COLORS[name] ?? FALLBACK_LANG_COLOR,
      percent: Math.round((b / total) * 1000) / 10,
    }));
}

/**
 * PURE map: GitHub repo + languages responses → ProjectCard props.
 * Missing/garbage fields collapse to `undefined` so the per-field merge in
 * `loadHarnessInsights` falls back to the slug-derived defaults.
 */
export function mapRepoFactsToProjectCard(
  repo: GithubRepoResponse,
  languageBytes: Record<string, number> | null | undefined,
): Partial<ProjectCardProps> {
  const spdx = repo.license?.spdx_id;
  const license = spdx && spdx !== 'NOASSERTION' ? spdx : null;
  return {
    // Leave name/githubUrl/owner undefined when GitHub didn't give them, so
    // the loader's slug-based fallback wins instead of blanking the card.
    name: repo.name || undefined,
    description: repo.description ?? '',
    ownerDisplayName: repo.owner?.login || undefined,
    license,
    languages: topLanguages(languageBytes),
    githubUrl: repo.html_url || undefined,
    stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : null,
    forks: typeof repo.forks_count === 'number' ? repo.forks_count : null,
    openIssues: typeof repo.open_issues_count === 'number' ? repo.open_issues_count : null,
    lastActivityIso: repo.pushed_at ?? null,
  };
}

/**
 * Parse a git remote URL into {owner, name}. Handles the three shapes git
 * emits: https://github.com/o/r(.git), git@github.com:o/r.git, and ssh://.
 * Non-GitHub remotes return null.
 */
export function parseGithubRemote(raw: string): { owner: string; name: string } | null {
  const s = raw.trim();
  if (!/github\.com/i.test(s)) return null;
  const m = s.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return { owner: m[1], name: m[2] };
}

/** Fetch one repo's facts through an injected Octokit. null on any error. */
export async function fetchGithubRepoFacts(
  owner: string,
  name: string,
  octokit: Octokit,
): Promise<Partial<ProjectCardProps> | null> {
  try {
    const [repoRes, langRes] = await Promise.all([
      octokit.rest.repos.get({ owner, repo: name }),
      octokit.rest.repos
        .listLanguages({ owner, repo: name })
        .catch(() => ({ data: {} as Record<string, number> })),
    ]);
    return mapRepoFactsToProjectCard(
      repoRes.data as GithubRepoResponse,
      langRes.data as Record<string, number>,
    );
  } catch {
    return null;
  }
}

async function defaultResolveRepoPath(
  workspaceId: string,
  slug: string,
): Promise<string | null> {
  const resolved = await resolveHarnessForWorkspace(workspaceId, slug);
  return resolved?.repoPath ?? null;
}

async function defaultOwnerName(
  repoPath: string,
): Promise<{ owner: string; name: string } | null> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', repoPath, 'remote', 'get-url', 'origin'],
      { timeout: 5000 },
    );
    return parseGithubRemote(stdout);
  } catch {
    return null;
  }
}

interface CacheEntry {
  value: Partial<ProjectCardProps> | null;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60 * 60 * 1000; // 1h — mirrors the Cupboard indexer cadence.

export interface LoadProjectCardOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test seams — runtime callers omit these. */
  octokit?: Octokit | null;
  resolveRepoPath?: (workspaceId: string, slug: string) => Promise<string | null>;
  ownerName?: (repoPath: string) => Promise<{ owner: string; name: string } | null>;
  now?: () => number;
}

/**
 * Resolve the harness's GitHub repo and return real ProjectCard facts, or
 * `undefined` to let the slug-derived fallback render. Read-through cached
 * per owner/name for 1h. Never throws.
 */
export async function loadProjectCardFromGithub(
  opts: LoadProjectCardOpts,
): Promise<Partial<ProjectCardProps> | undefined> {
  try {
    const now = (opts.now ?? Date.now)();
    const resolveRepoPath = opts.resolveRepoPath ?? defaultResolveRepoPath;
    const ownerName = opts.ownerName ?? defaultOwnerName;

    const repoPath = await resolveRepoPath(opts.workspaceId, opts.harnessSlug);
    if (!repoPath) return undefined;
    const on = await ownerName(repoPath);
    if (!on) return undefined;

    const key = `${on.owner}/${on.name}`.toLowerCase();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) return hit.value ?? undefined;

    const octokit =
      opts.octokit !== undefined ? opts.octokit : await getOctokit();
    if (!octokit) return undefined; // no token — don't cache; degrade to fallback

    const facts = await fetchGithubRepoFacts(on.owner, on.name, octokit);
    cache.set(key, { value: facts, expiresAt: now + TTL_MS });
    return facts ?? undefined;
  } catch {
    return undefined;
  }
}

/** Test-only: clear the module cache between cases. */
export function _clearGithubFactsCacheForTests(): void {
  cache.clear();
}
