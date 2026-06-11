/**
 * unlist-hive-rows.test.ts — the public→private flip's Cupboard withdrawal
 * (P-015). Seams injected.
 */
import { describe, it, expect } from 'vitest';
import { unlistHiveCupboardRows } from './unlist-hive-rows';

const REGISTRY = {
  projects: [
    { slug: 'shop-hive', path: '/h', harness_kind: 'hive' },
    { slug: 'shop', path: '/a', hive_slug: 'shop-hive', github_repository_id: 100 },
    { slug: 'docs', path: '/b', hive_slug: 'shop-hive', github_repository_id: 200 },
    { slug: 'no-id', path: '/c', hive_slug: 'shop-hive' },
    { slug: 'other', path: '/d', github_repository_id: 300 },
  ],
} as never;

describe('unlistHiveCupboardRows (P-015)', () => {
  it('unlists each id-bearing member row; skips non-members and id-less members', async () => {
    const deleted: (number | string)[] = [];
    const out = await unlistHiveCupboardRows(
      { workspaceId: 'ws', hiveSlug: 'shop-hive' },
      {
        loadRegistry: async () => REGISTRY,
        lookupListingId: async (repoId) => `listing-${repoId}`,
        deleteListing: async (id) => {
          deleted.push(id);
          return { ok: true };
        },
      },
    );
    expect(out).toMatchObject({ attempted: 2, unlisted: 2, failed: 0, notFound: 0 });
    expect(deleted.sort()).toEqual(['listing-100', 'listing-200']);
  });

  it('classifies already-unlisted, missing bindings, and failures separately', async () => {
    const out = await unlistHiveCupboardRows(
      { workspaceId: 'ws', hiveSlug: 'shop-hive' },
      {
        loadRegistry: async () => REGISTRY,
        lookupListingId: async (repoId) => (repoId === 100 ? 'l-100' : null),
        deleteListing: async () => ({ ok: true, alreadyUnlisted: true }),
      },
    );
    expect(out).toMatchObject({ attempted: 2, alreadyUnlisted: 1, notFound: 1, failed: 0 });
  });

  it('per-row failures are recorded, never thrown', async () => {
    const out = await unlistHiveCupboardRows(
      { workspaceId: 'ws', hiveSlug: 'shop-hive' },
      {
        loadRegistry: async () => REGISTRY,
        lookupListingId: async () => 'l',
        deleteListing: async () => ({ ok: false, error: 'gh_auth_required' }),
      },
    );
    expect(out).toMatchObject({ attempted: 2, failed: 2 });
    expect(out.errors).toHaveLength(2);
  });
});
