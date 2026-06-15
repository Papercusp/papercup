import { describe, it, expect } from 'vitest';
import {
  contributeUpstream,
  type ContributeUpstreamInput,
  type SelfHiveMember,
} from './contribute-upstream';
import { PAPERCUSP_CANONICAL_REPO_URL } from './enable-platform-mode';

// All external effects (registry read, export, Comb publish, fork push + PR,
// gh token) are injectable seams, so the whole flow is unit-testable with no IO.

const MEMBER_WITH_FORK: SelfHiveMember = {
  memberSlug: 'papercusp-platform',
  hiveSlug: 'papercusp-platform-hive',
  path: '/tmp/self-hive',
  upstreamRemote: 'https://github.com/Papercusp/papercup.git',
  defaultBranch: 'main',
  forkRemote: 'https://github.com/alice/papercup.git',
};

const MEMBER_NO_FORK: SelfHiveMember = {
  memberSlug: 'papercusp-platform',
  hiveSlug: 'papercusp-platform-hive',
  path: '/tmp/self-hive',
  upstreamRemote: 'https://github.com/Papercusp/papercup.git',
  defaultBranch: 'main',
};

function deps(over: Partial<ContributeUpstreamInput> = {}): ContributeUpstreamInput {
  return {
    kind: 'learning-pack',
    workspaceId: 'w',
    resolveSelfHiveMember: async () => MEMBER_WITH_FORK,
    exportPack: async () => ({ ok: true, packDir: '/tmp/self-hive/learning-packs/p', exported: 3, skippedPackRows: 0 }),
    publishPack: async () => ({ ok: true, listingId: 'lst_1', reviewStatus: 'pending' }),
    pushAndOpenPr: async () => ({
      ok: true,
      forkOwner: 'alice',
      forkFullName: 'alice/papercup',
      created: false,
      prNumber: 42,
      prUrl: 'https://github.com/Papercusp/papercup/pull/42',
    }),
    resolveGhToken: async () => ({ ok: true, token: 'tkn' }),
    ...over,
  };
}

describe('contributeUpstream — kind:learning-pack (the Comb path) (P-072)', () => {
  it('PREPARED without confirm: exports locally but does NOT publish to the Comb', async () => {
    let published = false;
    const res = await contributeUpstream(
      deps({
        packId: 'my-pack',
        title: 'My Pack',
        description: 'desc',
        publishPack: async () => {
          published = true;
          return { ok: true, reviewStatus: 'pending' };
        },
      }),
    );
    expect(published).toBe(false);
    expect(res).toMatchObject({ ok: true, kind: 'learning-pack', prepared: true });
    if ('prepared' in res) expect(res.needs).toContain('confirm');
  });

  it('PREPARED reports missing required args as needs (no confirm fired)', async () => {
    const res = await contributeUpstream(deps({ confirm: true, packId: 'p' /* no title/description */ }));
    expect(res).toMatchObject({ ok: true, prepared: true });
    if ('prepared' in res) {
      expect(res.needs).toEqual(expect.arrayContaining(['title', 'description']));
    }
  });

  it('SENT with confirm: lists the pack on the Comb and the listing stays PENDING', async () => {
    let publishedArgs: unknown = null;
    const res = await contributeUpstream(
      deps({
        confirm: true,
        packId: 'my-pack',
        title: 'My Pack',
        description: 'desc',
        publishPack: async (_m, a) => {
          publishedArgs = a;
          return { ok: true, listingId: 'lst_9', reviewStatus: 'pending' };
        },
      }),
    );
    expect(publishedArgs).toMatchObject({ packId: 'my-pack' });
    expect(res).toMatchObject({ ok: true, kind: 'learning-pack', sent: true });
    if ('sent' in res) {
      // The Comb publish stays PENDING (moderation-gated, D-007) — never auto-public.
      expect(res.result.reviewStatus).toBe('pending');
      expect(res.summary).toContain('PENDING');
    }
  });

  it('a failed export (no organic learnings) is a clean error, never a throw', async () => {
    const res = await contributeUpstream(
      deps({
        confirm: true,
        packId: 'p',
        title: 't',
        description: 'd',
        exportPack: async () => ({ ok: false, error: 'nothing_to_export' }),
      }),
    );
    expect(res).toMatchObject({ ok: false, error: 'nothing_to_export' });
  });
});

describe('contributeUpstream — kind:pr (the fork→canonical PR path) (P-072)', () => {
  function prDeps(over: Partial<ContributeUpstreamInput> = {}): ContributeUpstreamInput {
    return deps({
      kind: 'pr',
      featureBranch: 'platform/fix-1',
      prTitle: 'Fix a thing',
      prBody: 'Body of the PR.',
      ...over,
    });
  }

  it('PREPARED without confirm: does NOT push or open a PR', async () => {
    let fired = false;
    const res = await contributeUpstream(
      prDeps({
        pushAndOpenPr: async () => {
          fired = true;
          return { ok: false, error: 'should-not-run' };
        },
      }),
    );
    expect(fired).toBe(false);
    expect(res).toMatchObject({ ok: true, kind: 'pr', prepared: true });
    if ('prepared' in res) expect(res.needs).toContain('confirm');
  });

  it('NO direct-push to canonical: without a fork_remote it stays PREPARED (needs fork_remote), never sends', async () => {
    let fired = false;
    const res = await contributeUpstream(
      prDeps({
        confirm: true,
        resolveSelfHiveMember: async () => MEMBER_NO_FORK,
        pushAndOpenPr: async () => {
          fired = true;
          return { ok: false, error: 'should-not-run' };
        },
      }),
    );
    // Even WITH confirm, a missing fork is a hard gate — the canonical repo is
    // never direct-pushed (D-007).
    expect(fired).toBe(false);
    expect(res).toMatchObject({ ok: true, kind: 'pr', prepared: true });
    if ('prepared' in res) expect(res.needs).toContain('fork_remote');
  });

  it('PREPARED when gh auth is missing (credential presence gate), never sends', async () => {
    let fired = false;
    const res = await contributeUpstream(
      prDeps({
        confirm: true,
        resolveGhToken: async () => ({ ok: false, reason: 'not_authenticated' }),
        pushAndOpenPr: async () => {
          fired = true;
          return { ok: false, error: 'should-not-run' };
        },
      }),
    );
    expect(fired).toBe(false);
    expect(res).toMatchObject({ ok: true, prepared: true });
    if ('prepared' in res) expect(res.needs).toContain('gh_auth');
  });

  it('SENT with confirm + fork + creds: pushes to the fork and opens a fork→canonical PR', async () => {
    let prArgs: unknown = null;
    const res = await contributeUpstream(
      prDeps({
        confirm: true,
        pushAndOpenPr: async (m, a) => {
          prArgs = { member: m, args: a };
          return {
            ok: true,
            forkOwner: 'alice',
            forkFullName: 'alice/papercup',
            created: true,
            prNumber: 7,
            prUrl: 'https://github.com/Papercusp/papercup/pull/7',
          };
        },
      }),
    );
    expect(res).toMatchObject({ ok: true, kind: 'pr', sent: true });
    if ('sent' in res) {
      expect(res.result).toMatchObject({ prNumber: 7, forkFullName: 'alice/papercup' });
      // The summary makes the fork→canonical, human-reviewed nature explicit.
      expect(res.summary).toContain('canonical Papercusp');
    }
    // The PR seam received the user's fork + the canonical upstream coords — the
    // push target is the fork, the PR base is canonical (never a direct push).
    expect((prArgs as { member: SelfHiveMember }).member.forkRemote).toBe(MEMBER_WITH_FORK.forkRemote);
    expect((prArgs as { member: SelfHiveMember }).member.upstreamRemote).toBe(PAPERCUSP_CANONICAL_REPO_URL);
  });

  it('a fork-PR seam failure is reported, never thrown', async () => {
    const res = await contributeUpstream(
      prDeps({ confirm: true, pushAndOpenPr: async () => ({ ok: false, error: 'push rejected' }) }),
    );
    expect(res).toMatchObject({ ok: false, kind: 'pr', error: 'fork_pr_failed', message: 'push rejected' });
  });
});

describe('contributeUpstream — self-hive resolution', () => {
  it('a missing self-hive is a clean error (platform mode never enabled), never a throw', async () => {
    const res = await contributeUpstream(deps({ resolveSelfHiveMember: async () => null }));
    expect(res).toMatchObject({ ok: false, error: 'self_hive_not_found' });
  });

  it('a throwing resolver is caught and reported, never crashes the flow', async () => {
    const res = await contributeUpstream(
      deps({
        resolveSelfHiveMember: async () => {
          throw new Error('registry down');
        },
      }),
    );
    expect(res).toMatchObject({ ok: false, error: 'self_hive_resolve_failed' });
  });
});
