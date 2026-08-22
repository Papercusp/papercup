/**
 * hive-descriptor-enrich.test.ts — announce-build freshness (hardening P-004 /
 * D-004). Seams injected — no PG, keychain, or fs.
 */
import { describe, it, expect, vi } from 'vitest';
import { enrichLocalHiveDescriptor } from './hive-descriptor-enrich';
import type { LocalHiveDescriptor } from './hive-directory';

const PK = Buffer.alloc(32, 9).toString('base64');

function desc(over: Partial<LocalHiveDescriptor> = {}): LocalHiveDescriptor {
  return {
    potId: 'shop-hive',
    title: 'Shop',
    description: '',
    workspaceId: 'ws',
    memberTopics: [],
    visibility: 'public',
    createdAt: 1,
    ownerGithubLogin: 'alice',
    ownerGithubUserId: 1,
    ownerDevicePubkey: 'dpk',
    attestationGistId: 'gist',
    ...over,
  };
}

describe('enrichLocalHiveDescriptor (P-004)', () => {
  it('re-derives pubkey, member repos, and member links fresh', async () => {
    const out = await enrichLocalHiveDescriptor(desc(), {
      loadPubkey: async () => PK,
      deriveMemberRepos: async () => ['acme/shop#100', 'acme/new-member#200'],
      loadRegistry: async () => ({
        projects: [
          { slug: 'shop-hive', path: '/h', harness_kind: 'hive' },
          { slug: 'shop', path: '/a', hive_slug: 'shop-hive', github_remote: 'https://github.com/acme/shop', github_repository_id: 100 },
          { slug: 'new-member', path: '/b', hive_slug: 'shop-hive', github_remote: 'https://github.com/acme/new-member', github_repository_id: 200 },
        ],
      }),
    });
    expect(out.hivePubkey).toBe(PK);
    expect(out.memberRepos).toEqual(['acme/shop#100', 'acme/new-member#200']);
    expect(out.memberLinks).toHaveLength(2);
    expect(out.memberLinks![1]).toContain('repo_id=200');
  });

  // A3 (EI-18788176839043286): the announce is where the owner PUBLISHES the
  // repoKey its store is really named. Without this stamp a joiner has nothing
  // to adopt and falls back to deriving its own — the divergence A3 exists to end.
  it('stamps each member link with the repoKey that member is PINNED to, not a re-derivation', async () => {
    const out = await enrichLocalHiveDescriptor(desc(), {
      loadPubkey: async () => PK,
      deriveMemberRepos: async () => [],
      loadRegistry: async () => ({
        projects: [
          {
            slug: 'shop',
            path: '/a',
            hive_slug: 'shop-hive',
            github_remote: 'https://github.com/acme/shop',
            github_repository_id: 100,
            // Pinned to the bare slug: this pot was created local-first and
            // published later, so the store on disk is `shop`, NOT `gh-100`.
            pot_repo_key: 'shop',
          },
          {
            slug: 'docs',
            path: '/b',
            hive_slug: 'shop-hive',
            github_remote: 'https://github.com/acme/docs',
            github_repository_id: 200,
          },
        ],
      }),
    });
    // The pinned member announces its PIN — a joiner adopting `gh-100` here
    // would talk to a store that does not exist.
    expect(out.memberLinks![0]).toContain('repo_key=shop');
    // The unpinned member announces today's derivation.
    expect(out.memberLinks![1]).toContain('repo_key=gh-200');
  });

  it('no workspaceId → returned unchanged (legacy descriptors)', async () => {
    const d = desc({ workspaceId: undefined });
    expect(await enrichLocalHiveDescriptor(d)).toBe(d);
  });

  it('derivation failures fall back to the registered descriptor fields — LOUDLY (WI-3496 / D-032 R-3b)', async () => {
    // The fallback itself is deliberate and stays. What changed is that it may no
    // longer be SILENT: a pubkey derivation failure here strips the cross-Hive dial
    // address from every announce this process makes, and swallowing that quietly is
    // the defect D-032 R-3b exists to make observable. This spy is therefore a real
    // assertion, not noise suppression — remove the warn and this test fails.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = desc({ memberRepos: ['stale/ref#1'], memberLinks: ['papercusp://harness?x'] });
    const out = await enrichLocalHiveDescriptor(d, {
      loadPubkey: async () => null,
      deriveMemberRepos: async () => {
        throw new Error('pg down');
      },
      loadRegistry: async () => {
        throw new Error('pg down');
      },
    });
    // no pubkey → links untouched; repo derivation failed → registered set kept
    expect(out.memberRepos).toEqual(['stale/ref#1']);
    expect(out.memberLinks).toEqual(['papercusp://harness?x']);
    // ...and the omission announced itself. Assert on the SUBSTANCE, not the prose:
    // the hive it happened to, and that an outcome was named rather than a bare null.
    const omitted = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('hivePubkey OMITTED'));
    expect(omitted).toHaveLength(1);
    expect(omitted[0]).toContain(d.potId);
    expect(omitted[0]).toMatch(/not_found|error:|threw:|injected_dep_returned_null/);
    warn.mockRestore();
  });
});
