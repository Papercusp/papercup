/**
 * revoke-contributor.test.ts — unit tests for revokeContributorViaGithub.
 *
 * OWNER-revocation in the WRITE-FREE model (non-collaborator-join-fork-pr D-001):
 * admission is gated on the attestation GIST (not a repo branch), so the old
 * branch-delete was a no-op. Correct revocation = the owner adds the target's
 * device pubkeys to the owner's OWN contributor-row `revoked_pubkeys`, which
 * federates and is honored by `read-admission` (it unions revoked_pubkeys across
 * all contributor rows). The repo-admin gate is retained as the authority check.
 *
 * All seams injected — no PG, no substrate, no gh-token, no real Octokit.
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

const TARGET_ID = 12345;
const TARGET_PUBKEYS = ['ed25519:AAAA', 'ed25519:BBBB'];

function makeOctokit(opts: { adminPermission?: boolean; reposGetError?: unknown } = {}) {
  const reposGet = vi.fn(async () => {
    if (opts.reposGetError) throw opts.reposGetError;
    return { data: { permissions: { admin: opts.adminPermission ?? true } } };
  });
  return { rest: { repos: { get: reposGet } } } as RevokeContributorSeams['octokit'];
}

function buildSeams(
  over: Partial<RevokeContributorSeams> & { octokitOpts?: Parameters<typeof makeOctokit>[0] } = {},
): RevokeContributorSeams & {
  octokit: ReturnType<typeof makeOctokit>;
  publishRevocation: ReturnType<typeof vi.fn>;
  loadTargetPubkeys: ReturnType<typeof vi.fn>;
} {
  const { octokitOpts = {}, ...rest } = over;
  const octokit = makeOctokit(octokitOpts);
  const publishRevocation = vi.fn(async () => ({ live: true }));
  const loadTargetPubkeys = vi.fn(async () => TARGET_PUBKEYS);
  return {
    resolveContext: async () => CTX,
    octokit,
    publishRevocation,
    loadTargetPubkeys,
    ...rest,
  } as never;
}

const INPUT = { workspaceId: 'ws1', harnessSlug: 'papercup', githubUserId: TARGET_ID };

// ─── tests ────────────────────────────────────────────────────────────────────

describe('revokeContributorViaGithub (revoked_pubkeys model)', () => {
  it('success: admin + target has pubkeys → publishes them to revoked set, returns revokedPubkeys', async () => {
    const seams = buildSeams();
    const result = await revokeContributorViaGithub(INPUT, seams);
    expect(result).toEqual({ ok: true, revokedPubkeys: TARGET_PUBKEYS, live: true });
    // admin gate checked with the exact repo
    expect(seams.octokit!.rest.repos.get).toHaveBeenCalledWith({
      owner: CTX.repoOwner,
      repo: CTX.repoName,
    });
    // target pubkeys resolved for the right contributor
    expect(seams.loadTargetPubkeys).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      harnessSlug: 'papercup',
      githubUserId: TARGET_ID,
    });
    // published to the revoked set
    expect(seams.publishRevocation).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      harnessSlug: 'papercup',
      pubkeys: TARGET_PUBKEYS,
    });
  });

  it('propagates live:false from publishRevocation (handle not booted)', async () => {
    const seams = buildSeams({ publishRevocation: vi.fn(async () => ({ live: false })) });
    const result = await revokeContributorViaGithub(INPUT, seams);
    expect(result).toEqual({ ok: true, revokedPubkeys: TARGET_PUBKEYS, live: false });
  });

  it('not_admin: permissions.admin false → no publish, {ok:false,code:"not_admin"}', async () => {
    const seams = buildSeams({ octokitOpts: { adminPermission: false } });
    const result = await revokeContributorViaGithub(INPUT, seams);
    expect(result).toEqual({ ok: false, code: 'not_admin' });
    expect(seams.publishRevocation).not.toHaveBeenCalled();
    expect(seams.loadTargetPubkeys).not.toHaveBeenCalled();
  });

  it('not_admin: permissions undefined → {ok:false,code:"not_admin"}', async () => {
    const oc = {
      rest: { repos: { get: vi.fn(async () => ({ data: { permissions: undefined } })) } },
    } as RevokeContributorSeams['octokit'];
    const seams = buildSeams({ octokit: oc });
    const result = await revokeContributorViaGithub(INPUT, seams);
    expect(result).toEqual({ ok: false, code: 'not_admin' });
    expect(seams.publishRevocation).not.toHaveBeenCalled();
  });

  it('no_context: resolveContext null → {ok:false,code:"no_context"}, no admin check', async () => {
    const seams = buildSeams({ resolveContext: async () => null });
    const result = await revokeContributorViaGithub(INPUT, seams);
    expect(result).toEqual({ ok: false, code: 'no_context' });
    expect(seams.octokit!.rest.repos.get).not.toHaveBeenCalled();
    expect(seams.publishRevocation).not.toHaveBeenCalled();
  });

  it('no_target: target has no device pubkeys → {ok:false,code:"no_target"}, no publish', async () => {
    const seams = buildSeams({ loadTargetPubkeys: vi.fn(async () => []) });
    const result = await revokeContributorViaGithub(INPUT, seams);
    expect(result).toEqual({ ok: false, code: 'no_target' });
    expect(seams.publishRevocation).not.toHaveBeenCalled();
  });

  it('bad githubUserId (float) → {ok:false,code:"github_error"}, no admin check', async () => {
    const seams = buildSeams();
    const result = await revokeContributorViaGithub({ ...INPUT, githubUserId: 12345.5 }, seams);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('github_error');
    expect(seams.octokit!.rest.repos.get).not.toHaveBeenCalled();
  });

  it('bad githubUserId (zero) → {ok:false,code:"github_error"}', async () => {
    const seams = buildSeams();
    const result = await revokeContributorViaGithub({ ...INPUT, githubUserId: 0 }, seams);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('github_error');
    expect(seams.publishRevocation).not.toHaveBeenCalled();
  });

  it('bad githubUserId (negative) → {ok:false,code:"github_error"}', async () => {
    const seams = buildSeams();
    const result = await revokeContributorViaGithub({ ...INPUT, githubUserId: -1 }, seams);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('github_error');
    expect(seams.publishRevocation).not.toHaveBeenCalled();
  });

  it('github_error: repos.get throws → {ok:false,code:"github_error",detail}, no target load', async () => {
    const seams = buildSeams({
      octokitOpts: { reposGetError: Object.assign(new Error('Service Unavailable'), { status: 503 }) },
    });
    const result = await revokeContributorViaGithub(INPUT, seams);
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'github_error') {
      expect(result.detail).toContain('Service Unavailable');
    } else {
      expect(result.ok).toBe(false);
    }
    expect(seams.loadTargetPubkeys).not.toHaveBeenCalled();
    expect(seams.publishRevocation).not.toHaveBeenCalled();
  });

  it('revoke_failed: publishRevocation throws → {ok:false,code:"revoke_failed",detail}', async () => {
    const seams = buildSeams({
      publishRevocation: vi.fn(async () => {
        throw new Error('no booted handle');
      }),
    });
    const result = await revokeContributorViaGithub(INPUT, seams);
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'revoke_failed') {
      expect(result.detail).toContain('no booted handle');
    } else {
      expect(result.ok).toBe(false);
    }
  });

  it('passes through all target pubkeys (multi-device contributor)', async () => {
    const many = ['ed25519:k1', 'ed25519:k2', 'ed25519:k3'];
    const seams = buildSeams({ loadTargetPubkeys: vi.fn(async () => many) });
    const result = await revokeContributorViaGithub(INPUT, seams);
    expect(result).toEqual({ ok: true, revokedPubkeys: many, live: true });
    expect(seams.publishRevocation).toHaveBeenCalledWith(
      expect.objectContaining({ pubkeys: many }),
    );
  });
});
