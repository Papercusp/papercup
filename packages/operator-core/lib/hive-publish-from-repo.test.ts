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
import type { ProjectEntry } from './harness-registry';

const HIVE_PUBKEY = Buffer.alloc(32, 7).toString('base64');

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
    now: () => 1_700_000_000_000,
    randomSecret: () => 'secret-hex',
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
    expect(out.inviteSecret).toBe('secret-hex');
    expect(calls.savedMeta[0]).toMatchObject({ visibility: 'invite', inviteSecret: 'secret-hex' });
    expect(out.cupboard).toEqual({ attempted: false, skipped: 'invite' });
    expect(calls.listings).toEqual([]);
    // local rows still land (a LOCAL row leaks nothing off-box)
    expect(calls.localBindings[0]).toMatchObject({ privacy: 'shared-private' });
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

  it('cupboard row failures are reported, never thrown', async () => {
    const { deps } = fakes({ publishListing: async () => ({ ok: false, error: 'gh_auth_required' }) });
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(out.cupboard).toMatchObject({ attempted: true, rowsCreated: 0, rowsFailed: 1 });
    expect(out.cupboard.errors?.[0]).toContain('gh_auth_required');
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
});
