/**
 * hive-descriptor-enrich.test.ts — announce-build freshness (hardening P-004 /
 * D-004). Seams injected — no PG, keychain, or fs.
 */
import { describe, it, expect } from 'vitest';
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

  it('no workspaceId → returned unchanged (legacy descriptors)', async () => {
    const d = desc({ workspaceId: undefined });
    expect(await enrichLocalHiveDescriptor(d)).toBe(d);
  });

  it('derivation failures fall back to the registered descriptor fields', async () => {
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
  });
});
