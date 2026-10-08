import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHiveDirectoryRows } from './discovery-hive-rows';
const fixture = vi.hoisted(() => ({ discovered: [] as unknown[], projects: [] as unknown[], hives: new Map<string, unknown>() }));
vi.mock('./hive-directory-deps', () => ({ getHiveDirectory: () => ({ listDiscoveredHives: () => fixture.discovered }) }));
vi.mock('./harness-registry', () => ({ loadHarnessRegistry: async () => ({ projects: fixture.projects }) }));
vi.mock('./hive-store', () => ({ getHiveBySlug: async (_workspace: string, slug: string) => fixture.hives.get(slug) ?? null }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'workspace' }));
beforeEach(() => {
  fixture.discovered = []; fixture.projects = [{ slug: 'owned', harness_kind: 'hive' }, { slug: 'joined', harness_kind: 'hive', remote_hive: true }, { slug: 'project', hive_slug: 'owned' }];
  fixture.hives = new Map([['owned', { pubkeyBase64: 'owned-key', title: 'Private owned DAO', createdAt: 1, updatedAt: 1 }],
    ['joined', { pubkeyBase64: 'joined-key', title: 'Joined DAO', createdAt: 1, updatedAt: 1 }]]);
});
describe('explicit local DAO directory view', () => {
  it('keeps owned and private organizations out of the default public discovery view', async () => {
    expect((await buildHiveDirectoryRows()).map(row => row.potId)).toEqual(['joined']);
  });
  it('includes workspace-owned identities only on explicit local opt-in', async () => {
    const rows = await buildHiveDirectoryRows({ includeLocalViews: true });
    expect(rows.map(row => row.potId)).toEqual(['owned', 'joined']);
    expect(rows[0]).toMatchObject({ source: 'local', title: 'Private owned DAO', memberCount: 1, memberLinks: [] });
  });
  it('deduplicates published and locally renamed views by verified identity', async () => {
    fixture.discovered = [{ potId: 'published-owner', title: 'Published DAO', description: '', ownerGithubLogin: 'owner', visibility: 'public',
      hivePubkey: 'joined-key', memberTopics: [], memberLinks: [], createdAt: 1, lastSeenMs: 1 }];
    const rows = await buildHiveDirectoryRows({ includeLocalViews: true });
    expect(rows.map(row => row.potId)).toEqual(['published-owner', 'owned']);
  });
  it('refuses to invent an owned identity from the registry name', async () => {
    fixture.hives.delete('owned');
    expect((await buildHiveDirectoryRows({ includeLocalViews: true })).map(row => row.potId)).toEqual(['joined']);
  });
});
