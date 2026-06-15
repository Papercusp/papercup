/**
 * hive-publish-from-repo.test.ts — the visibility-gated publish step (P-007).
 * All seams faked. Verifies the D-002/D-003/D-004 gates: public = directory +
 * Cupboard rows per member repo; invite = secret-topic announce only, NO
 * Cupboard; private never reaches this module.
 */
import { describe, it, expect } from 'vitest';
import {
  publishCreatedHive,
  type PublishCreatedHiveDeps,
} from './hive-publish-from-repo';
import { parseHiveInviteLink } from './harness/hive-invite-link';
import type { ProjectEntry } from './harness-registry';

const HIVE_PUBKEY = Buffer.alloc(32, 7).toString('base64');
/** Hardening P-006: a real hex secret so the invite-link artifact round-trips. */
const INVITE_SECRET = 'c0ffee'.repeat(8); // 48 hex chars

function members(): ProjectEntry[] {
  return [
    { slug: 'shop-hive', path: '/hives/shop-hive', harness_kind: 'hive' },
    {
      slug: 'shop',
      path: '/clones/shop',
      hive_slug: 'shop-hive',
      github_remote: 'https://github.com/acme/shop.git',
      github_repository_id: 100,
      github_default_branch: 'main',
    },
    {
      slug: 'docs',
      path: '/clones/docs',
      hive_slug: 'shop-hive',
      github_remote: 'https://github.com/acme/docs.git',
      // no repo id — should be skipped by the Cupboard + local-binding legs
    },
  ];
}

function fakes(over: Partial<PublishCreatedHiveDeps> = {}) {
  const calls = {
    savedMeta: [] as Record<string, unknown>[],
    published: [] as Record<string, unknown>[],
    listings: [] as Record<string, unknown>[],
    localBindings: [] as Record<string, unknown>[],
    rebooted: [] as Array<{ ws: string; slug: string }>,
  };
  const deps: PublishCreatedHiveDeps = {
    saveMeta: async (meta) => {
      calls.savedMeta.push(meta as unknown as Record<string, unknown>);
    },
    ensureWired: async () => null,
    resolveOwner: async () => ({
      githubLogin: 'alice',
      githubUserId: 1,
      devicePubkey: 'dpk',
      attestationGistId: 'gist',
    }),
    loadPubkey: async () => HIVE_PUBKEY,
    loadRegistry: async () => ({ projects: members() }),
    deriveMemberRepos: async () => ['acme/shop#100', 'acme/docs'],
    publishDirectory: async (_dir, meta) => {
      calls.published.push(meta as unknown as Record<string, unknown>);
      return { registered: true, announced: true, visibility: meta.visibility };
    },
    getDirectory: () => ({}) as never,
    publishListing: async (input) => {
      calls.listings.push(input);
      return { ok: true };
    },
    createLocalBinding: async (input) => {
      calls.localBindings.push(input as unknown as Record<string, unknown>);
    },
    rebootHarness: async (ws, slug) => {
      calls.rebooted.push({ ws, slug });
    },
    now: () => 1_700_000_000_000,
    randomSecret: () => INVITE_SECRET,
    ...over,
  };
  return { deps, calls };
}

const BASE = {
  workspaceId: 'ws',
  hiveSlug: 'shop-hive',
  title: 'acme/shop',
  description: 'Hive for acme/shop',
} as const;

describe('publishCreatedHive (P-007)', () => {
  it('public: saves meta, announces with pubkey + member repos + links, registers Cupboard rows + local bindings', async () => {
    const { deps, calls } = fakes();
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);

    expect(out.announced).toBe(true);
    expect(calls.savedMeta[0]).toMatchObject({ hiveId: 'shop-hive', visibility: 'public' });

    const announced = calls.published[0];
    expect(announced.hivePubkey).toBe(HIVE_PUBKEY);
    expect(announced.memberRepos).toEqual(['acme/shop#100', 'acme/docs']);
    // one-click link only for the id-bearing member, over the HIVE federation topic
    const links = announced.memberLinks as string[];
    expect(links).toHaveLength(1);
    expect(links[0]).toContain('papercusp://harness?');
    expect(links[0]).toContain('repo_id=100');

    // Cupboard: one row per id-bearing member repo, carrying the hive identity.
    expect(out.cupboard).toMatchObject({ attempted: true, rowsCreated: 1, rowsFailed: 0 });
    expect(calls.listings[0]).toMatchObject({
      listing_kind: 'harness',
      github_repository_id: 100,
      hive_pubkey: HIVE_PUBKEY,
      hive_title: 'acme/shop',
    });

    expect(out.localBindings).toEqual({ created: 1, existed: 0, failed: 0 });
    expect(calls.localBindings[0]).toMatchObject({ harness_slug: 'shop', privacy: 'shared-public' });
  });

  it('invite: announces on the secret topic, returns the secret, NO Cupboard rows (D-003)', async () => {
    const { deps, calls } = fakes();
    const out = await publishCreatedHive({ ...BASE, visibility: 'invite' }, deps);
    expect(out.inviteSecret).toBe(INVITE_SECRET);
    expect(calls.savedMeta[0]).toMatchObject({ visibility: 'invite', inviteSecret: INVITE_SECRET });
    expect(out.cupboard).toEqual({ attempted: false, skipped: 'invite' });
    expect(calls.listings).toEqual([]);
    // local rows still land (a LOCAL row leaks nothing off-box)
    expect(calls.localBindings[0]).toMatchObject({ privacy: 'shared-private' });
  });

  it('invite: formats the FULL invite-link artifact — pubkey + secret + title (hardening P-006/D-006)', async () => {
    const { deps } = fakes();
    const out = await publishCreatedHive({ ...BASE, visibility: 'invite' }, deps);
    expect(out.hivePubkey).toBe(HIVE_PUBKEY);
    expect(out.inviteLink).toBeDefined();
    expect(out.inviteLink!.startsWith('papercusp://hive?')).toBe(true);
    expect(parseHiveInviteLink(out.inviteLink!)).toEqual({
      secret: INVITE_SECRET,
      pubkeyBase64: HIVE_PUBKEY,
      title: 'acme/shop',
    });
  });

  it('invite without a loadable pubkey: the invite link degrades to secret-only and still parses (P-006)', async () => {
    const { deps } = fakes({ loadPubkey: async () => null });
    const out = await publishCreatedHive({ ...BASE, visibility: 'invite' }, deps);
    expect(out.hivePubkey).toBeUndefined();
    expect(parseHiveInviteLink(out.inviteLink!)).toEqual({
      secret: INVITE_SECRET,
      title: 'acme/shop',
    });
  });

  it('public: outcome carries the hive pubkey but mints no invite secret/link (P-006)', async () => {
    const { deps } = fakes();
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(out.hivePubkey).toBe(HIVE_PUBKEY);
    expect(out.inviteSecret).toBeUndefined();
    expect(out.inviteLink).toBeUndefined();
  });

  it('public + private repo: Cupboard skipped (the public registry refuses private repos)', async () => {
    const { deps, calls } = fakes();
    const out = await publishCreatedHive({ ...BASE, visibility: 'public', repoIsPrivate: true }, deps);
    expect(out.cupboard).toEqual({ attempted: false, skipped: 'private_repo' });
    expect(calls.listings).toEqual([]);
    expect(out.announced).toBe(true); // the directory announce still happens
  });

  it('no hive pubkey: no member links, Cupboard skipped, no local rows (no joinable topic)', async () => {
    const { deps, calls } = fakes({ loadPubkey: async () => null });
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(out.cupboard).toMatchObject({ skipped: 'no_hive_pubkey' });
    expect(calls.published[0].memberLinks).toBeUndefined();
    expect(out.localBindings).toEqual({ created: 0, existed: 0, failed: 0 });
  });

  it('BINDING_EXISTS counts as existed, other failures as failed', async () => {
    const { deps } = fakes({
      createLocalBinding: async () => {
        const e = new Error('exists') as Error & { code: string };
        e.code = 'BINDING_EXISTS';
        throw e;
      },
    });
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(out.localBindings).toEqual({ created: 0, existed: 1, failed: 0 });
  });

  it('auto-claims created rows via the worker claim path when permitted (hardening D-002)', async () => {
    const claimed: (string | number)[] = [];
    const { deps } = fakes({
      publishListing: async () => ({ ok: true, data: { id: 'listing-1' } }),
      claimListing: async (id) => {
        claimed.push(id);
        return { ok: true, status: 200 };
      },
    });
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(out.cupboard).toMatchObject({ rowsCreated: 1, rowsClaimed: 1 });
    expect(claimed).toEqual(['listing-1']);
  });

  it('insufficient permission leaves the row provisional — no claim, no error (D-002)', async () => {
    const { deps } = fakes({
      publishListing: async () => ({ ok: true, data: { id: 'listing-2' } }),
      claimListing: async () => ({ ok: false, status: 403, error: 'insufficient_permission' }),
    });
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(out.cupboard).toMatchObject({ rowsCreated: 1, rowsClaimed: 0, rowsFailed: 0 });
    expect(out.cupboard.errors).toBeUndefined();
  });

  it('a create response without an id skips the claim quietly', async () => {
    const { deps } = fakes({
      publishListing: async () => ({ ok: true }),
      claimListing: async () => {
        throw new Error('must not be called');
      },
    });
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(out.cupboard).toMatchObject({ rowsCreated: 1, rowsClaimed: 0 });
  });

  it('cupboard row failures are reported, never thrown', async () => {
    const { deps } = fakes({ publishListing: async () => ({ ok: false, error: 'gh_auth_required' }) });
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(out.cupboard).toMatchObject({ attempted: true, rowsCreated: 0, rowsFailed: 1 });
    expect(out.cupboard.errors?.[0]).toContain('gh_auth_required');
  });

  it('republishHiveAfterMemberAdd: scoped rows for the new member only; existing rows untouched (P-009)', async () => {
    const { deps, calls } = fakes({
      getMeta: async () => ({
        hiveId: 'shop-hive',
        title: 'acme/shop',
        description: '',
        visibility: 'public' as const,
        memberTopics: [],
        createdAt: 1,
      }),
      loadRegistry: async () => ({
        projects: [
          ...members(),
          {
            slug: 'newrepo',
            path: '/clones/newrepo',
            hive_slug: 'shop-hive',
            github_remote: 'https://github.com/acme/newrepo.git',
            github_repository_id: 200,
          },
        ],
      }),
      deriveMemberRepos: async () => ['acme/shop#100', 'acme/newrepo#200'],
    });
    const { republishHiveAfterMemberAdd } = await import('./hive-publish-from-repo');
    const out = await republishHiveAfterMemberAdd(
      { workspaceId: 'ws', hiveSlug: 'shop-hive', onlyRepoIds: [200] },
      deps,
    );
    if ('skipped' in out) throw new Error('expected a publish outcome');
    expect(out.announced).toBe(true);
    // announce carries ALL member repos (content), but new rows are scoped
    expect(calls.published[0].memberRepos).toEqual(['acme/shop#100', 'acme/newrepo#200']);
    expect(calls.listings).toHaveLength(1);
    expect(calls.listings[0]).toMatchObject({ github_repository_id: 200 });
    expect(calls.localBindings).toHaveLength(1);
    expect(calls.localBindings[0]).toMatchObject({ harness_slug: 'newrepo' });
  });

  it('republishHiveAfterMemberAdd: an unpublished/private hive is left untouched', async () => {
    const { deps, calls } = fakes({ getMeta: async () => null });
    const { republishHiveAfterMemberAdd } = await import('./hive-publish-from-repo');
    const out = await republishHiveAfterMemberAdd({ workspaceId: 'ws', hiveSlug: 'x' }, deps);
    expect(out).toEqual({ skipped: 'unpublished_hive' });
    expect(calls.published).toEqual([]);
  });

  it('saveMeta failure aborts with an error (nothing announced)', async () => {
    const { deps, calls } = fakes({
      saveMeta: async () => {
        throw new Error('pg down');
      },
    });
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(out.announced).toBe(false);
    expect(out.error).toContain('save_meta_failed');
    expect(calls.published).toEqual([]);
  });

  it('saveMeta failure on an invite hive still hands back the secret + a secret-only link (P-006)', async () => {
    const { deps } = fakes({
      saveMeta: async () => {
        throw new Error('pg down');
      },
    });
    const out = await publishCreatedHive({ ...BASE, visibility: 'invite' }, deps);
    expect(out.error).toContain('save_meta_failed');
    expect(out.inviteSecret).toBe(INVITE_SECRET);
    expect(parseHiveInviteLink(out.inviteLink!)).toEqual({
      secret: INVITE_SECRET,
      title: 'acme/shop',
    });
  });
});

// EI-681: the "go shared" reboot — publishing a hive must boot + swarm-join +
// start the outbox drain for the just-bound local member harnesses, or an
// owner's feature writes sit in substrate_outbox undrained and never federate.
describe('hive publish — go-shared reboot of local member harnesses (EI-681)', () => {
  it('reboots exactly the id-bearing local members (not the hive home, not id-less members)', async () => {
    const { deps, calls } = fakes();
    await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    // members(): shop (id=100) reboots; docs (no repo id) is skipped (step 6
    // bound no row for it); shop-hive (the home, no github_remote) is not a member.
    expect(calls.rebooted).toEqual([{ ws: 'ws', slug: 'shop' }]);
  });

  it('republishHiveAfterMemberAdd: reboots ONLY the new member (onlyRepoIds scope)', async () => {
    const { deps, calls } = fakes({
      getMeta: async () => ({
        hiveId: 'shop-hive',
        title: 'acme/shop',
        description: '',
        visibility: 'public' as const,
        memberTopics: [],
        createdAt: 1,
      }),
      loadRegistry: async () => ({
        projects: [
          ...members(),
          {
            slug: 'newrepo',
            path: '/clones/newrepo',
            hive_slug: 'shop-hive',
            github_remote: 'https://github.com/acme/newrepo.git',
            github_repository_id: 200,
          },
        ],
      }),
    });
    const { republishHiveAfterMemberAdd } = await import('./hive-publish-from-repo');
    await republishHiveAfterMemberAdd(
      { workspaceId: 'ws', hiveSlug: 'shop-hive', onlyRepoIds: [200] },
      deps,
    );
    expect(calls.rebooted).toEqual([{ ws: 'ws', slug: 'newrepo' }]);
  });

  it('a reboot failure (sync throw or async reject) NEVER fails the publish, and never skips a later member', async () => {
    const rebooted: string[] = [];
    const { deps } = fakes({
      loadRegistry: async () => ({
        projects: [
          ...members(),
          {
            slug: 'extra',
            path: '/clones/extra',
            hive_slug: 'shop-hive',
            github_remote: 'https://github.com/acme/extra.git',
            github_repository_id: 300,
          },
        ],
      }),
      deriveMemberRepos: async () => ['acme/shop#100', 'acme/extra#300'],
      // 'shop' throws SYNCHRONOUSLY (the harder case — a plain .catch can't
      // swallow it); 'extra' must still be rebooted and the publish must succeed.
      rebootHarness: (_ws: string, slug: string) => {
        if (slug === 'shop') throw new Error('boom (sync)');
        rebooted.push(slug);
        return Promise.resolve();
      },
    });
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(out.announced).toBe(true); // publish unaffected by the reboot throw
    expect(rebooted).toEqual(['extra']); // the throw on 'shop' did not skip 'extra'
  });

  it('async-rejecting reboot does not fail the publish', async () => {
    const { deps } = fakes({ rebootHarness: async () => Promise.reject(new Error('reject')) });
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(out.announced).toBe(true);
  });

  it('no joinable topic (no hive pubkey) → no reboots', async () => {
    const { deps, calls } = fakes({ loadPubkey: async () => null });
    await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(calls.rebooted).toEqual([]);
  });
});
