/**
 * revokeContributorViaGithub — OWNER revocation of another contributor.
 *
 * Plan: substrate-revocation-v2 Component B / D-005.
 *
 * Deletes the bad-actor contributor's `user/<github_user_id>` branch on
 * GitHub (their Channel-2 binding artifact). Once deleted, Component A's
 * re-verify loop will detect the missing branch on its next cycle and drop
 * the contributor from live federation across all peers.
 *
 * Authority model:
 *   - Only a GitHub repo ADMIN may invoke this action. The caller's gh
 *     token must have admin permissions on the shared repo.
 *   - `githubUserId` must be a positive integer — validated before
 *     constructing the branch ref. This guarantees we ONLY ever delete
 *     `user/<integer>`, never any other branch.
 *   - Idempotent: branch already gone (404/422) → `{ ok: true, alreadyGone: true }`.
 *
 * Seam design (mirrors revoke-self-device.ts):
 *   - `resolveContext` — async seam that returns `{ repoOwner, repoName, token }`
 *     from `.harness/shared.json` + `resolveLocalGithubIdentity`. Tests inject
 *     a fake that bypasses fs + gh-token.
 *   - `octokit` — injectable Octokit instance so tests inject a fake. Defaults
 *     to `getOctokit()`. The fake must implement only `.rest.repos.get` and
 *     `.rest.git.deleteRef`.
 *
 * This module is SELF-CONTAINED re: GitHub API calls; it does NOT touch the
 * live substrate handle. Component A's re-verify propagates the drop; live
 * handle eviction is out of scope here (per D-005 spec).
 */

import { contributorBranchRef } from '../../identity/contributor-file-types';
import { resolveLocalGithubIdentity } from '../../identity/resolve-local-github-identity';

// ─── public types ─────────────────────────────────────────────────────────────

export type RevokeContributorResult =
  | {
      ok: true;
      /**
       * The branch that was deleted (`user/<githubUserId>`).
       * Also populated when `alreadyGone: true` (reflects the resolved branch name).
       */
      deletedBranch: string;
      /**
       * True when the branch was already absent on GitHub — treated as an
       * idempotent success (no-op but not an error).
       */
      alreadyGone?: true;
    }
  | {
      /**
       * No shared repo context (not a shared harness / gh not authed).
       * The caller cannot proceed without a repo to operate on.
       */
      ok: false;
      code: 'no_context';
    }
  | {
      /**
       * The authenticated gh token is NOT an admin on the shared repo.
       * Only repo admins may revoke another contributor's branch.
       */
      ok: false;
      code: 'not_admin';
    }
  | {
      /** GitHub API call failed for an unexpected reason. */
      ok: false;
      code: 'github_error';
      detail: string;
    };

export interface RevokeContributorInput {
  workspaceId: string;
  harnessSlug: string;
  /** Numeric GitHub user id of the contributor to revoke. Must be a positive integer. */
  githubUserId: number;
}

/**
 * Resolved harness shared-repo context plus the authenticated gh token.
 * Both are needed: the repo tells us WHERE to delete; the token provides auth.
 */
export interface RevokeContributorContext {
  repoOwner: string;
  repoName: string;
  token: string;
}

/**
 * Injectable seams — all have real defaults wired below.
 */
export interface RevokeContributorSeams {
  /**
   * Resolve the shared repo `{ repoOwner, repoName }` and the authenticated
   * gh token from the harness's `.harness/shared.json` + gh-token cache.
   * Returns null when the harness is private or gh is not authed.
   *
   * Default: live fs + resolveLocalGithubIdentity path (same as
   * verify-binding-adapter.ts `defaultResolveContext`).
   */
  resolveContext?: (
    workspaceId: string,
    harnessSlug: string,
  ) => Promise<RevokeContributorContext | null>;

  /**
   * Authenticated Octokit instance.
   * Default: `getOctokit()` — returns null when gh is not authenticated.
   * Tests inject a fake that only needs `.rest.repos.get` + `.rest.git.deleteRef`.
   */
  octokit?: {
    rest: {
      repos: {
        get: (params: {
          owner: string;
          repo: string;
        }) => Promise<{ data: { permissions?: { admin?: boolean } } }>;
      };
      git: {
        deleteRef: (params: {
          owner: string;
          repo: string;
          ref: string;
        }) => Promise<unknown>;
      };
    };
  };
}

// ─── core ─────────────────────────────────────────────────────────────────────

export async function revokeContributorViaGithub(
  input: RevokeContributorInput,
  seams: RevokeContributorSeams = {},
): Promise<RevokeContributorResult> {
  // Validate githubUserId before we construct any branch ref.
  // This is a hard safety guard — non-integer or non-positive ids must never
  // reach the deleteRef call.
  if (!Number.isInteger(input.githubUserId) || input.githubUserId <= 0) {
    return { ok: false, code: 'github_error', detail: 'githubUserId must be a positive integer' };
  }

  const {
    resolveContext = realResolveContext,
    octokit: octokitSeam,
  } = seams;

  // 1. Resolve shared-repo context (repo + token).
  const ctx = await resolveContext(input.workspaceId, input.harnessSlug);
  if (!ctx) {
    return { ok: false, code: 'no_context' };
  }

  // 2. Get an Octokit instance.
  let oc: RevokeContributorSeams['octokit'];
  if (octokitSeam) {
    oc = octokitSeam;
  } else {
    const realOc = await (await import('../../identity/octokit-client')).getOctokit();
    if (!realOc) {
      return { ok: false, code: 'no_context' };
    }
    oc = realOc as unknown as typeof oc;
  }

  // 3. Admin check: the authenticated user must be a repo admin.
  //    Only admins may delete another contributor's user branch.
  let repoData: { permissions?: { admin?: boolean } };
  try {
    const resp = await oc!.rest.repos.get({ owner: ctx.repoOwner, repo: ctx.repoName });
    repoData = resp.data;
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 'github_error', detail };
  }

  if (!repoData.permissions?.admin) {
    return { ok: false, code: 'not_admin' };
  }

  // 4. Resolve the exact branch name — ONLY ever `user/<positive-integer>`.
  //    `contributorBranchRef` also throws on non-positive-integer, so this is
  //    doubly guarded. The ref passed to deleteRef is `heads/<branch>`.
  const branch = contributorBranchRef(input.githubUserId);
  const ref = 'heads/' + branch;

  // 5. Delete the branch. Treat 422 and 404 as idempotent success.
  try {
    await oc!.rest.git.deleteRef({ owner: ctx.repoOwner, repo: ctx.repoName, ref });
  } catch (err: unknown) {
    // Octokit throws a RequestError with `.status` on HTTP errors.
    const status = (err as { status?: number }).status;
    if (status === 404 || status === 422) {
      // Branch already gone — idempotent success.
      return { ok: true, deletedBranch: branch, alreadyGone: true };
    }
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 'github_error', detail };
  }

  return { ok: true, deletedBranch: branch };
}

// ─── real default seams ───────────────────────────────────────────────────────

async function realResolveContext(
  workspaceId: string,
  harnessSlug: string,
): Promise<RevokeContributorContext | null> {
  // Resolve the harness's on-disk project dir → shared.json → github_remote.
  let projectDir: string;
  try {
    const { resolveHarnessPaths } = await import('@/lib/resolve-harness-paths');
    const resolved = await resolveHarnessPaths(harnessSlug, workspaceId);
    projectDir = resolved.projectDir;
  } catch {
    return null;
  }
  if (!projectDir || projectDir.startsWith('/tmp/papercusp-unresolved/')) return null;

  const { loadSharedConfigFromProjectDir } = await import('@/lib/harness/load-shared-config');
  const cfg = loadSharedConfigFromProjectDir(projectDir);
  if (!cfg) return null;

  const { parseGithubUrl } = await import('@/lib/harness/clone-github');
  const parsed = parseGithubUrl(cfg.github_remote);
  if (!parsed) return null;

  const identity = await resolveLocalGithubIdentity();
  if (identity.kind !== 'ok') return null;

  return {
    repoOwner: parsed.owner,
    repoName: parsed.repo,
    token: identity.token,
  };
}
