/**
 * hive-directory-cache.integration.test.ts — the hive_directory_cache state
 * table (migration 182, p2p-hive-directory P-003) against real migrated PG.
 *
 * Verifies the offline-cache round-trip the directory's loadCache/saveCache
 * seams use (readOperatorState/writeOperatorState over the new table). Follows
 * the org-fixture pattern (test/_org-test-db.ts): mock getOrgPg + the workspace
 * resolver onto the fixture's admin client.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-hive-cache' }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));

const { readOperatorState, writeOperatorState } = await import('./operator-state-pg');
const { createOrgTestDb } = await import('../test/_org-test-db');
import type { DiscoveredHive } from './hive-directory';

function hive(id: string): DiscoveredHive {
  return {
    potId: id,
    title: id,
    description: '',
    ownerGithubLogin: 'alice',
    ownerGithubUserId: 1,
    ownerDevicePubkey: 'pk',
    memberTopics: ['a'.repeat(64)],
    visibility: 'public',
    createdAt: 1000,
    announcedTs: 1000,
    lastSeenMs: 1000,
    attested: true,
  };
}

describe('hive_directory_cache (real PG, migration 182)', () => {
  let db: OrgTestDb;
  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);
  afterAll(async () => {
    await db?.cleanup();
  });

  it('round-trips the discovered set through the cache table', async () => {
    await writeOperatorState('pot_directory_cache', { hives: [hive('ash'), hive('cup')] });
    const row = await readOperatorState<{ hives: DiscoveredHive[] }>('pot_directory_cache');
    expect(row?.hives.map((x) => x.potId)).toEqual(['ash', 'cup']);
    expect(row?.hives[0]).toMatchObject({ title: 'ash', visibility: 'public', attested: true });
  });

  it('overwrites on re-save (single row per workspace)', async () => {
    await writeOperatorState('pot_directory_cache', { hives: [hive('only')] });
    const row = await readOperatorState<{ hives: DiscoveredHive[] }>('pot_directory_cache');
    expect(row?.hives).toHaveLength(1);
    expect(row?.hives[0].potId).toBe('only');
  });

  it('returns null before any write (cold cache)', async () => {
    h.ws = 'ws-hive-cache-empty';
    expect(await readOperatorState('pot_directory_cache')).toBeNull();
    h.ws = 'ws-hive-cache';
  });
});
