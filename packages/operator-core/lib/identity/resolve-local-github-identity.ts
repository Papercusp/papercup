/**
 * resolve-local-github-identity — resolve this machine's GitHub identity into
 * { token, githubUserId, githubLogin } for use in federation join/publish paths.
 *
 * Decision D-004 from papercusp-phase1b-bidirectional-federation-2026-06-01:
 *   The joiner's GitHub identity must be resolved SERVER-SIDE (from the local
 *   `gh` token) rather than being passed empty from the UI. This helper is the
 *   single shared resolution path used by:
 *     - The federation join endpoint (Task 2)
 *     - The binding-publish pipeline (Task 3)
 *     - local-announce-identity.ts's defaultResolveGithubUser (DRY refactor here)
 *
 * Inputs are injectable (getToken / getUser) so unit tests run without `gh` or
 * live network. Defaults wire up getGhAuthToken + getOctokit.
 */

import { getGhAuthToken } from './gh-token';
import { getOctokit } from './octokit-client';

export type LocalGithubIdentity =
  | { kind: 'ok'; token: string; githubUserId: number; githubLogin: string }
  | { kind: 'gh_auth_required' };

export interface ResolveLocalGithubIdentityOpts {
  getToken?: () => Promise<{ kind: string; token?: string }>;
  getUser?: () => Promise<{ id: number; login: string } | null>;
  /**
   * Test seam only: force cache participation even with injected fns. In
   * production the cache is used automatically when NO fns are injected (the
   * default path); tests inject fns and must opt in explicitly so a cached
   * value is never served across unrelated injected-mock cases.
   */
  _cache?: boolean;
}

/**
 * Cache the resolved OK identity, keyed by the current gh token
 * (whole-app-sync-payload-audit phase2 P-005). The `oc.users.getAuthenticated()`
 * GET /user round-trip inside getAuthenticatedGithubUser() was measured on the
 * read path of prReviewerSettings.byHarness (0.23s for 342B of data) and is
 * shared by ~27 callers (PR panels, claim-status, viewer, poll-daemon, …), so a
 * per-read network hop was paid all over the app. The {id, login} is machine-
 * stable; keying the cache by the token means a re-auth (which rotates the token,
 * already cached process-lifetime in gh-token with a 401-refresh hook) is a key
 * MISS → automatic invalidation, so we never serve an identity for a token that
 * is no longer current. A short TTL bounds staleness for the rare same-token
 * account edge. getToken() still runs on every call (it is cheap/cached), so
 * token freshness for federation callers is untouched — only the /user hop is
 * cached.
 */
const IDENTITY_CACHE_TTL_MS = 60_000;
let identityCache: { token: string; identity: Extract<LocalGithubIdentity, { kind: 'ok' }>; at: number } | null = null;

/** Drop the cached identity (e.g. on a detected auth change). Also a test seam. */
export function invalidateLocalGithubIdentityCache(): void {
  identityCache = null;
}

/**
 * Shared low-level helper: resolve the authenticated GitHub user via Octokit.
 * Returns null when gh isn't authed or the `/user` response is malformed.
 * Exported so callers that already have an Octokit instance (or a mock) can
 * share the null-vs-bad-shape handling without duplicating the condition.
 */
export async function getAuthenticatedGithubUser(): Promise<{ id: number; login: string } | null> {
  const oc = await getOctokit();
  if (!oc) return null;
  const { data } = await oc.users.getAuthenticated();
  if (typeof data.id !== 'number' || typeof data.login !== 'string' || !data.login) return null;
  return { id: data.id, login: data.login };
}

/**
 * Resolve the local machine's GitHub identity.
 *
 * Returns `{ kind: 'ok', token, githubUserId, githubLogin }` when both the gh
 * token and the `/user` call succeed.
 * Returns `{ kind: 'gh_auth_required' }` when gh isn't authenticated or the
 * user can't be resolved — never throws.
 */
export async function resolveLocalGithubIdentity(
  opts: ResolveLocalGithubIdentityOpts = {},
): Promise<LocalGithubIdentity> {
  const getToken = opts.getToken ?? getGhAuthToken;
  const getUser = opts.getUser ?? getAuthenticatedGithubUser;
  // Cache participates on the default (production) path; injected-mock tests opt
  // in explicitly via `_cache` so no cached value crosses unrelated cases.
  const useCache = opts._cache ?? (!opts.getToken && !opts.getUser);

  const tok = await getToken().catch(() => null);
  if (!tok) return { kind: 'gh_auth_required' };
  if (tok.kind !== 'ok' || !tok.token) return { kind: 'gh_auth_required' };

  // Serve the cached identity for this exact token within the TTL — skips the
  // GET /user network hop. A rotated token (re-auth) is a key miss.
  if (useCache && identityCache && identityCache.token === tok.token && Date.now() - identityCache.at < IDENTITY_CACHE_TTL_MS) {
    return identityCache.identity;
  }

  const user = await getUser().catch(() => null);
  if (!user) return { kind: 'gh_auth_required' };
  const identity = { kind: 'ok' as const, token: tok.token, githubUserId: user.id, githubLogin: user.login };
  if (useCache) identityCache = { token: tok.token, identity, at: Date.now() };
  return identity;
}
