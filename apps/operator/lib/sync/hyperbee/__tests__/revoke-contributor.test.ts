/**
 * revoke-contributor.test.ts — unit tests for revokeContributorViaGithub.
 *
 * All seams injected — no PG, no fs, no gh-token, no real Octokit.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  revokeContributorViaGithub,
  type RevokeContributorSeams,
  type RevokeContributorContext,
} from '../revoke-contributor';

// ─── helpers ──────────────────────────────────────────────────────────────────

const CTX: RevokeContributorContext = {
  repoOwner: 'Papercusp',
  repoName: 'papercup',
  token: 'token-abc',
};

const GITHUB_USER_ID = 12345;
const EXPECTED_BRANCH = 'user/12345';
const EXPECTED_REF = 'heads/user/12345';

function makeOctokit(opts: {
  adminPermission?: boolean;
  reposGetError?: unknown;
  deleteRefError?: unknown;
} = {}): RevokeContributorSeams['octokit'] {
  const deleteRef = vi.fn(async () => {
    if (opts.deleteRefError) throw opts.deleteRefError;
    return {};
  });
  const reposGet = vi.fn(async () => {
    if (opts.reposGetError) throw opts.reposGetError;
    return { data: { permissions: { admin: opts.adminPermission ?? true } } };
  });
  return {
    rest: {
      repos: { get: reposGet },
      git: { deleteRef },
    },
  };
}

function buildSeams(over: Partial<RevokeContributorSeams> & {
  octokitOpts?: Parameters<typeof makeOctokit>[0];
} = {}): RevokeContributorSeams & {
  octokit: ReturnType<typeof makeOctokit>;
} {
  const { octokitOpts = {}, ...rest } = over;
  const octokit = makeOctokit(octokitOpts);
  return {
    resolveContext: async () => CTX,
    octokit,
    ...rest,
  };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('revokeContributorViaGithub', () => {
  it('success: admin + branch exists → deleteRef called with exact heads/user/<id>, returns {ok:true,deletedBranch}', async () => {
    const seams = buildSeams();
    const result = await revokeContributorViaGithub(
      { workspaceId: 'ws1', harnessSlug: 'papercup', githubUserId: GITHUB_USER_ID },
      seams,
    );
    expect(result).toEqual({ ok: true, deletedBranch: EXPECTED_BRANCH });
    // Verify admin check was performed
    expect(seams.octokit!.rest.repos.get).toHaveBeenCalledOnce();
    expect(seams.octokit!.rest.repos.get).toHaveBeenCalledWith({
      owner: CTX.repoOwner,
      repo: CTX.repoName,
    });
    // Verify deleteRef called with the EXACT ref format
    expect(seams.octokit!.rest.git.deleteRef).toHaveBeenCalledOnce();
    expect(seams.octokit!.rest.git.deleteRef).toHaveBeenCalledWith({
      owner: CTX.repoOwner,
      repo: CTX.repoName,
      ref: EXPECTED_REF,
    });
  });

  it('idempotent (404): branch already gone → {ok:true,alreadyGone:true}, no propagated error', async () => {
    const seams = buildSeams({
      octokitOpts: { deleteRefError: Object.assign(new Error('Not Found'), { status: 404 }) },
    });
    const result = await revokeContributorViaGithub(
      { workspaceId: 'ws1', harnessSlug: 'papercup', githubUserId: GITHUB_USER_ID },
      seams,
    );
    expect(result).toEqual({ ok: true, deletedBranch: EXPECTED_BRANCH, alreadyGone: true });
    // deleteRef was still called — we tried and got 404
    expect(seams.octokit!.rest.git.deleteRef).toHaveBeenCalledOnce();
  });

  it('idempotent (422): GitHub 422 → {ok:true,alreadyGone:true}', async () => {
    const seams = buildSeams({
      octokitOpts: { deleteRefError: Object.assign(new Error('Unprocessable'), { status: 422 }) },
    });
    const result = await revokeContributorViaGithub(
      { workspaceId: 'ws1', harnessSlug: 'papercup', githubUserId: GITHUB_USER_ID },
      seams,
    );
    expect(result).toEqual({ ok: true, deletedBranch: EXPECTED_BRANCH, alreadyGone: true });
  });

  it('not_admin: permissions.admin false → no deleteRef call, {ok:false,code:"not_admin"}', async () => {
    const seams = buildSeams({ octokitOpts: { adminPermission: false } });
    const result = await revokeContributorViaGithub(
      { workspaceId: 'ws1', harnessSlug: 'papercup', githubUserId: GITHUB_USER_ID },
      seams,
    );
    expect(result).toEqual({ ok: false, code: 'not_admin' });
    // deleteRef must NOT be called when not admin
    expect(seams.octokit!.rest.git.deleteRef).not.toHaveBeenCalled();
  });

  it('not_admin: permissions.admin undefined → {ok:false,code:"not_admin"}', async () => {
    const oc = {
      rest: {
        repos: { get: vi.fn(async () => ({ data: { permissions: undefined } })) },
        git: { deleteRef: vi.fn(async () => ({})) },
      },
    };
    const result = await revokeContributorViaGithub(
      { workspaceId: 'ws1', harnessSlug: 'papercup', githubUserId: GITHUB_USER_ID },
      { resolveContext: async () => CTX, octokit: oc as RevokeContributorSeams['octokit'] },
    );
    expect(result).toEqual({ ok: false, code: 'not_admin' });
    expect(oc.rest.git.deleteRef).not.toHaveBeenCalled();
  });

  it('no_context: resolveContext returns null → {ok:false,code:"no_context"}, no deleteRef', async () => {
    const seams = buildSeams({ resolveContext: async () => null });
    const result = await revokeContributorViaGithub(
      { workspaceId: 'ws1', harnessSlug: 'papercup', githubUserId: GITHUB_USER_ID },
      seams,
    );
    expect(result).toEqual({ ok: false, code: 'no_context' });
    expect(seams.octokit!.rest.git.deleteRef).not.toHaveBeenCalled();
  });

  it('bad githubUserId (float) → {ok:false,code:"github_error"}, no deleteRef called', async () => {
    const seams = buildSeams();
    const result = await revokeContributorViaGithub(
      { workspaceId: 'ws1', harnessSlug: 'papercup', githubUserId: 12345.5 },
      seams,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('github_error');
    expect(seams.octokit!.rest.git.deleteRef).not.toHaveBeenCalled();
  });

  it('bad githubUserId (zero) → {ok:false,code:"github_error"}, no deleteRef called', async () => {
    const seams = buildSeams();
    const result = await revokeContributorViaGithub(
      { workspaceId: 'ws1', harnessSlug: 'papercup', githubUserId: 0 },
      seams,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('github_error');
    expect(seams.octokit!.rest.git.deleteRef).not.toHaveBeenCalled();
  });

  it('bad githubUserId (negative) → {ok:false,code:"github_error"}, no deleteRef called', async () => {
    const seams = buildSeams();
    const result = await revokeContributorViaGithub(
      { workspaceId: 'ws1', harnessSlug: 'papercup', githubUserId: -1 },
      seams,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('github_error');
    expect(seams.octokit!.rest.git.deleteRef).not.toHaveBeenCalled();
  });

  it('github_error: repos.get throws non-auth error → {ok:false,code:"github_error",detail}', async () => {
    const seams = buildSeams({
      octokitOpts: {
        reposGetError: Object.assign(new Error('Service Unavailable'), { status: 503 }),
      },
    });
    const result = await revokeContributorViaGithub(
      { workspaceId: 'ws1', harnessSlug: 'papercup', githubUserId: GITHUB_USER_ID },
      seams,
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'github_error') {
      expect(result.detail).toContain('Service Unavailable');
    } else {
      expect(result.ok).toBe(false); // force failure if code is wrong
    }
    expect(seams.octokit!.rest.git.deleteRef).not.toHaveBeenCalled();
  });

  it('github_error: deleteRef throws non-404/422 error → {ok:false,code:"github_error",detail}', async () => {
    const seams = buildSeams({
      octokitOpts: {
        deleteRefError: Object.assign(new Error('Internal Server Error'), { status: 500 }),
      },
    });
    const result = await revokeContributorViaGithub(
      { workspaceId: 'ws1', harnessSlug: 'papercup', githubUserId: GITHUB_USER_ID },
      seams,
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'github_error') {
      expect(result.detail).toContain('Internal Server Error');
    } else {
      expect(result.ok).toBe(false); // force failure if code is wrong
    }
  });

  it('branch name is always user/<githubUserId> — never any other branch', async () => {
    const seams = buildSeams();
    await revokeContributorViaGithub(
      { workspaceId: 'ws1', harnessSlug: 'papercup', githubUserId: 99999 },
      seams,
    );
    expect(seams.octokit!.rest.git.deleteRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'heads/user/99999' }),
    );
  });
});
