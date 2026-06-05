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

  const tok = await getToken();
  if (tok.kind !== 'ok' || !tok.token) return { kind: 'gh_auth_required' };
  const user = await getUser();
  if (!user) return { kind: 'gh_auth_required' };
  return { kind: 'ok', token: tok.token, githubUserId: user.id, githubLogin: user.login };
}
