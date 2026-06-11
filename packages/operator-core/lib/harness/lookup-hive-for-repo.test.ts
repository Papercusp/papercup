/**
 * lookup-hive-for-repo.test.ts — the paste-time repo→Hive resolver (P-005).
 * All three legs injected: GitHub identity, the directory, the Cupboard index.
 */
import { describe, it, expect } from 'vitest';
import { lookupHiveForRepo, type LookupHiveDeps } from './lookup-hive-for-repo';
import type { DiscoveredHive } from '../hive-directory';

const URL_OK = 'https://github.com/acme/shop';

function discovered(over: Partial<DiscoveredHive> = {}): DiscoveredHive {
  return {
    hiveId: 'hive-1',
    title: 'Acme Hive',
    description: '',
    ownerGithubLogin: 'alice',
    ownerGithubUserId: 1,
    ownerDevicePubkey: 'pk',
    memberTopics: [],
    memberRepos: ['acme/shop#100'],
    memberLinks: ['papercusp://harness?topic=' + 'a'.repeat(64) + '&github=acme%2Fshop&repo_id=100'],
    visibility: 'public',
    createdAt: 1,
    announcedTs: 2,
    lastSeenMs: Date.now(),
    attested: true,
    ...over,
  };
}

function deps(over: Partial<LookupHiveDeps> = {}): LookupHiveDeps {
  return {
    resolveIdentity: async () => ({
      github_repository_id: 100,
      github_owner: 'acme',
      github_repo: 'shop',
      private: false,
      existing_binding: null,
    }),
    getDirectory: () => ({
      hydrateFromCache: async () => 0,
      listDiscoveredHives: () => [discovered()],
    }),
    cupboardLookup: async () => ({ ok: true, listing: null }),
    ...over,
  };
}

describe('lookupHiveForRepo (P-005)', () => {
  it('rejects a non-GitHub URL', async () => {
    const r = await lookupHiveForRepo('https://gitlab.com/a/b', deps());
    expect(r.kind).toBe('invalid_url');
  });

  it('directory hit by immutable repo id (content authority wins, no Cupboard needed)', async () => {
    let cupboardAsked = false;
    const r = await lookupHiveForRepo(
      URL_OK,
      deps({
        cupboardLookup: async () => {
          cupboardAsked = true;
          return { ok: true, listing: null };
        },
      }),
    );
    expect(r.kind).toBe('hive');
    if (r.kind !== 'hive') return;
    expect(r.source).toBe('directory');
    expect(r.hive.hiveId).toBe('hive-1');
    expect(r.hive.memberLinks?.length).toBe(1);
    expect(r.bindingUnverified).toBe(false);
    expect(r.coords).toMatchObject({ owner: 'acme', repo: 'shop', githubRepositoryId: 100, identityResolved: true });
    expect(cupboardAsked).toBe(false);
  });

  it('directory hit by owner/repo when GitHub identity is unavailable (degraded)', async () => {
    const r = await lookupHiveForRepo(
      URL_OK,
      deps({
        resolveIdentity: async () => {
          throw new Error('gh down');
        },
        getDirectory: () => ({
          hydrateFromCache: async () => 0,
          listDiscoveredHives: () => [discovered({ memberRepos: ['ACME/Shop'] })],
        }),
      }),
    );
    expect(r.kind).toBe('hive');
    if (r.kind !== 'hive') return;
    expect(r.coords.identityResolved).toBe(false);
  });

  it('cupboard hive hit when the directory has not heard the announce', async () => {
    const r = await lookupHiveForRepo(
      URL_OK,
      deps({
        getDirectory: () => ({ hydrateFromCache: async () => 0, listDiscoveredHives: () => [] }),
        cupboardLookup: async () => ({
          ok: true,
          listing: {
            hive_pubkey: 'HPK',
            hive_title: 'Acme Hive',
            harness_link: 'papercusp://harness?topic=x&github=acme%2Fshop&repo_id=100',
            claim_status: 'unclaimed',
            publisher_github_login: 'alice',
          },
        }),
      }),
    );
    expect(r.kind).toBe('hive');
    if (r.kind !== 'hive') return;
    expect(r.source).toBe('cupboard');
    expect(r.hive.hivePubkey).toBe('HPK');
    expect(r.hive.claimStatus).toBe('unclaimed');
  });

  it('cupboard legacy shared-harness hit (listing without hive identity)', async () => {
    const r = await lookupHiveForRepo(
      URL_OK,
      deps({
        getDirectory: () => ({ hydrateFromCache: async () => 0, listDiscoveredHives: () => [] }),
        cupboardLookup: async () => ({
          ok: true,
          listing: { harness_link: 'papercusp://harness?topic=y&github=acme%2Fshop&repo_id=100' },
        }),
      }),
    );
    expect(r.kind).toBe('legacy_shared_harness');
    if (r.kind !== 'legacy_shared_harness') return;
    expect(r.source).toBe('cupboard');
    expect(r.binding.harnessLink).toContain('papercusp://harness');
  });

  it('verified absence: no hits anywhere + Cupboard reachable → none, binding verified', async () => {
    const r = await lookupHiveForRepo(
      URL_OK,
      deps({ getDirectory: () => ({ hydrateFromCache: async () => 0, listDiscoveredHives: () => [] }) }),
    );
    expect(r).toMatchObject({ kind: 'none', bindingUnverified: false });
  });

  it('cupboard unreachable degrades, never blocks: none + bindingUnverified', async () => {
    const r = await lookupHiveForRepo(
      URL_OK,
      deps({
        getDirectory: () => ({ hydrateFromCache: async () => 0, listDiscoveredHives: () => [] }),
        cupboardLookup: async () => ({ ok: false, error: 'cupboard_http_503' }),
      }),
    );
    expect(r).toMatchObject({ kind: 'none', bindingUnverified: true });
  });

  it('no repo id (identity failed) → Cupboard cannot be asked → bindingUnverified', async () => {
    const r = await lookupHiveForRepo(
      URL_OK,
      deps({
        resolveIdentity: async () => {
          throw new Error('offline');
        },
        getDirectory: () => ({ hydrateFromCache: async () => 0, listDiscoveredHives: () => [] }),
      }),
    );
    expect(r).toMatchObject({ kind: 'none', bindingUnverified: true });
  });

  it('local cached binding surfaces as legacy_shared_harness when nothing else hits', async () => {
    const r = await lookupHiveForRepo(
      URL_OK,
      deps({
        resolveIdentity: async () => ({
          github_repository_id: 100,
          github_owner: 'acme',
          github_repo: 'shop',
          private: false,
          existing_binding: { harness_slug: 'old-share', harness_link: 'papercusp://harness?topic=z&github=acme%2Fshop&repo_id=100', claim_status: 'claimed' },
        }),
        getDirectory: () => ({ hydrateFromCache: async () => 0, listDiscoveredHives: () => [] }),
      }),
    );
    expect(r.kind).toBe('legacy_shared_harness');
    if (r.kind !== 'legacy_shared_harness') return;
    expect(r.source).toBe('local-cache');
    expect(r.binding.harnessSlug).toBe('old-share');
  });

  it('a directory hive WITHOUT memberRepos never matches (no false positives)', async () => {
    const r = await lookupHiveForRepo(
      URL_OK,
      deps({
        getDirectory: () => ({
          hydrateFromCache: async () => 0,
          listDiscoveredHives: () => [discovered({ memberRepos: undefined })],
        }),
      }),
    );
    expect(r.kind).toBe('none');
  });
});
