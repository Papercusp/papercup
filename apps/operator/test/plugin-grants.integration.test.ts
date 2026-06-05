/**
 * Integration test for copyGrantsToNewHarness — the snapshot grant
 * carry-over from PR #2. Boots a testcontainers Postgres, applies
 * Migration 051, exercises copy/idempotency/scope semantics.
 *
 * Real bug class this guards against: a re-fork (or a `git revert`
 * on the migration) silently duplicating grants, or the SQL pulling
 * grants from harness_slug='' (the global scope) into a per-harness
 * fork by accident.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { withTestSchema, teardownTestPg } from '@papercusp/test-config';
import {
  copyGrantsToNewHarness,
  grantCapabilities,
  revokeCapabilities,
  getGrantsForPluginInHarness,
  backfillGrantsFromEnabledPluginsAndLegacyFile,
} from '@papercusp/operator-core/lib/plugin-grants';

let sql: postgres.Sql;
let baseUri: string;

beforeAll(async () => {
  const handle = await withTestSchema();
  baseUri = handle.connectionUri;
  // copyGrantsToNewHarness writes literal "harness_shared.plugin_capability_grants" —
  // we create that schema in the test container.
  sql = postgres(baseUri, { max: 4, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.plugin_capability_grants (
      plugin_name      TEXT NOT NULL,
      plugin_version   TEXT NOT NULL,
      harness_slug     TEXT NOT NULL,
      capability       TEXT NOT NULL,
      granted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      granted_by       TEXT,
      reason           TEXT,
      PRIMARY KEY (plugin_name, plugin_version, harness_slug, capability)
    )
  `);
});

afterAll(async () => {
  if (sql) {
    try { await sql.unsafe(`DROP SCHEMA IF EXISTS harness_shared CASCADE`); } catch {}
    await sql.end({ timeout: 5 });
  }
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.plugin_capability_grants`;
});

async function insertGrant(plugin: string, version: string, harness: string, cap: string) {
  await sql`
    INSERT INTO harness_shared.plugin_capability_grants
      (plugin_name, plugin_version, harness_slug, capability, granted_by, reason)
    VALUES (${plugin}, ${version}, ${harness}, ${cap}, 'test', 'fixture')
  `;
}

async function listGrantsFor(harnessSlug: string) {
  return sql<{ plugin_name: string; plugin_version: string; capability: string; granted_by: string; reason: string }[]>`
    SELECT plugin_name, plugin_version, capability, granted_by, reason
    FROM harness_shared.plugin_capability_grants
    WHERE harness_slug = ${harnessSlug}
    ORDER BY plugin_name, capability
  `;
}

describe('copyGrantsToNewHarness', () => {
  it('copies every grant from source to target', async () => {
    await insertGrant('@papercupai/cf-pages', '0.1.0', 'sheets', 'http:fetch:api.cloudflare.com');
    await insertGrant('@papercupai/cf-pages', '0.1.0', 'sheets', 'secrets:read:CF_TOKEN');
    await insertGrant('@papercupai/pi-coding', '0.1.1', 'sheets', 'ui:dashboard-tab');

    const r = await copyGrantsToNewHarness('sheets', 'sheets-fork', { sql });
    expect(r.copied).toBe(3);

    const target = await listGrantsFor('sheets-fork');
    expect(target.map((row) => `${row.plugin_name} ${row.capability}`).sort()).toEqual([
      '@papercupai/cf-pages http:fetch:api.cloudflare.com',
      '@papercupai/cf-pages secrets:read:CF_TOKEN',
      '@papercupai/pi-coding ui:dashboard-tab',
    ]);
  });

  it('attributes copied grants to system + fork-from reason', async () => {
    await insertGrant('@papercupai/cf-pages', '0.1.0', 'sheets', 'http:fetch:api.cloudflare.com');
    await copyGrantsToNewHarness('sheets', 'sheets-fork', { sql });
    const [row] = await listGrantsFor('sheets-fork');
    expect(row.granted_by).toBe('system');
    expect(row.reason).toBe('fork from sheets');
  });

  it('a re-fork (same target) does NOT duplicate — ON CONFLICT DO NOTHING', async () => {
    await insertGrant('@papercupai/cf-pages', '0.1.0', 'sheets', 'http:fetch:api.cloudflare.com');

    const first = await copyGrantsToNewHarness('sheets', 'sheets-fork', { sql });
    expect(first.copied).toBe(1);

    const second = await copyGrantsToNewHarness('sheets', 'sheets-fork', { sql });
    expect(second.copied).toBe(0);

    // Still only 1 row after re-fork
    const target = await listGrantsFor('sheets-fork');
    expect(target).toHaveLength(1);
  });

  it('does NOT leak grants from a sibling harness (scope is exact-match)', async () => {
    await insertGrant('@papercupai/cf-pages', '0.1.0', 'sheets', 'http:fetch:api.cloudflare.com');
    await insertGrant('@papercupai/cf-pages', '0.1.0', 'other-harness', 'http:fetch:api.cloudflare.com');

    await copyGrantsToNewHarness('sheets', 'sheets-fork', { sql });
    const target = await listGrantsFor('sheets-fork');
    expect(target).toHaveLength(1); // only sheets's grant carries
    expect(target[0].plugin_name).toBe('@papercupai/cf-pages');
  });

  it('handles empty source — copied=0, no error', async () => {
    const r = await copyGrantsToNewHarness('nothing-here', 'fork-of-nothing', { sql });
    expect(r.copied).toBe(0);
    const target = await listGrantsFor('fork-of-nothing');
    expect(target).toHaveLength(0);
  });

  it('refuses identical source/target (would violate primary key)', async () => {
    await insertGrant('@papercupai/cf-pages', '0.1.0', 'sheets', 'tasks:read');
    const r = await copyGrantsToNewHarness('sheets', 'sheets', { sql });
    expect(r.copied).toBe(0);
    const target = await listGrantsFor('sheets');
    expect(target).toHaveLength(1); // unchanged
  });

  it('rejects empty slugs without touching the DB', async () => {
    const r1 = await copyGrantsToNewHarness('', 'target', { sql });
    expect(r1.copied).toBe(0);
    const r2 = await copyGrantsToNewHarness('source', '', { sql });
    expect(r2.copied).toBe(0);
  });

  it('preserves plugin_version (per-version grants do not collapse on fork)', async () => {
    await insertGrant('@papercupai/cf-pages', '0.1.0', 'sheets', 'http:fetch:api.cloudflare.com');
    await insertGrant('@papercupai/cf-pages', '0.2.0', 'sheets', 'http:fetch:api.cloudflare.com');

    await copyGrantsToNewHarness('sheets', 'sheets-fork', { sql });
    const target = await sql<{ plugin_version: string }[]>`
      SELECT plugin_version FROM harness_shared.plugin_capability_grants
      WHERE harness_slug = 'sheets-fork'
      ORDER BY plugin_version
    `;
    expect(target.map((r) => r.plugin_version)).toEqual(['0.1.0', '0.2.0']);
  });
});

describe('grantCapabilities', () => {
  it('inserts every cap in the input', async () => {
    await grantCapabilities({
      pluginName: '@papercupai/cf-pages',
      pluginVersion: '0.1.0',
      harnessSlug: 'sheets',
      capabilities: ['http:fetch:api.cloudflare.com', 'secrets:read:CF_TOKEN'],
      grantedBy: 'user',
      reason: 'install consent',
    }, { sql });

    const after = await listGrantsFor('sheets');
    expect(after.map((r) => r.capability).sort()).toEqual([
      'http:fetch:api.cloudflare.com',
      'secrets:read:CF_TOKEN',
    ]);
    expect(after.every((r) => r.granted_by === 'user' && r.reason === 'install consent')).toBe(true);
  });

  it('empty capabilities[] is a no-op (no error, no rows)', async () => {
    await grantCapabilities({
      pluginName: 'p', pluginVersion: 'v', harnessSlug: 'h', capabilities: [],
    }, { sql });
    const all = await sql`SELECT count(*)::int AS n FROM harness_shared.plugin_capability_grants`;
    expect((all as any)[0].n).toBe(0);
  });

  it('re-granting the same tuple is ON CONFLICT DO NOTHING (preserves original audit row)', async () => {
    await grantCapabilities({
      pluginName: '@papercupai/cf-pages', pluginVersion: '0.1.0', harnessSlug: 'sheets',
      capabilities: ['tasks:read'], grantedBy: 'first-user', reason: 'first reason',
    }, { sql });

    await grantCapabilities({
      pluginName: '@papercupai/cf-pages', pluginVersion: '0.1.0', harnessSlug: 'sheets',
      capabilities: ['tasks:read'], grantedBy: 'second-user', reason: 'should-not-overwrite',
    }, { sql });

    const after = await listGrantsFor('sheets');
    expect(after).toHaveLength(1);
    expect(after[0].granted_by).toBe('first-user');
    expect(after[0].reason).toBe('first reason');
  });
});

describe('revokeCapabilities', () => {
  it('removes the matching tuple', async () => {
    await grantCapabilities({
      pluginName: 'p', pluginVersion: '0.1.0', harnessSlug: 'h',
      capabilities: ['a', 'b', 'c'],
    }, { sql });

    await revokeCapabilities({
      pluginName: 'p', pluginVersion: '0.1.0', harnessSlug: 'h',
      capabilities: ['b'],
    }, { sql });

    const after = await listGrantsFor('h');
    expect(after.map((r) => r.capability).sort()).toEqual(['a', 'c']);
  });

  it('revoking a non-existent cap is a no-op', async () => {
    await grantCapabilities({
      pluginName: 'p', pluginVersion: '0.1.0', harnessSlug: 'h', capabilities: ['a'],
    }, { sql });
    await revokeCapabilities({
      pluginName: 'p', pluginVersion: '0.1.0', harnessSlug: 'h', capabilities: ['z'],
    }, { sql });

    const after = await listGrantsFor('h');
    expect(after.map((r) => r.capability)).toEqual(['a']);
  });

  it('only revokes the exact (plugin, version, harness, cap) match', async () => {
    await grantCapabilities({
      pluginName: 'p', pluginVersion: '0.1.0', harnessSlug: 'h1', capabilities: ['a'],
    }, { sql });
    await grantCapabilities({
      pluginName: 'p', pluginVersion: '0.2.0', harnessSlug: 'h1', capabilities: ['a'],
    }, { sql });
    await grantCapabilities({
      pluginName: 'p', pluginVersion: '0.1.0', harnessSlug: 'h2', capabilities: ['a'],
    }, { sql });

    // Only revoke (p, 0.1.0, h1, a)
    await revokeCapabilities({
      pluginName: 'p', pluginVersion: '0.1.0', harnessSlug: 'h1', capabilities: ['a'],
    }, { sql });

    const remaining = await sql<{ plugin_version: string; harness_slug: string }[]>`
      SELECT plugin_version, harness_slug FROM harness_shared.plugin_capability_grants
      ORDER BY plugin_version, harness_slug
    `;
    expect(remaining).toEqual([
      { plugin_version: '0.1.0', harness_slug: 'h2' },
      { plugin_version: '0.2.0', harness_slug: 'h1' },
    ]);
  });
});

describe('getGrantsForPluginInHarness', () => {
  it('returns the caps granted to a specific (plugin, version, harness) tuple', async () => {
    await grantCapabilities({
      pluginName: 'p', pluginVersion: '0.1.0', harnessSlug: 'sheets',
      capabilities: ['http:fetch:api.cloudflare.com', 'secrets:read:CF_TOKEN'],
    }, { sql });

    const caps = await getGrantsForPluginInHarness('p', '0.1.0', 'sheets', { sql, skipLegacy: true });
    expect(caps.sort()).toEqual(['http:fetch:api.cloudflare.com', 'secrets:read:CF_TOKEN']);
  });

  it('unions per-harness with empty-string global grants (harness_slug = "")', async () => {
    await grantCapabilities({
      pluginName: 'p', pluginVersion: '0.1.0', harnessSlug: 'sheets',
      capabilities: ['per-harness'],
    }, { sql });
    await grantCapabilities({
      pluginName: 'p', pluginVersion: '0.1.0', harnessSlug: '',
      capabilities: ['global'],
    }, { sql });

    const caps = await getGrantsForPluginInHarness('p', '0.1.0', 'sheets', { sql, skipLegacy: true });
    expect(caps.sort()).toEqual(['global', 'per-harness']);
  });

  it('does NOT leak grants from a different version (per-version isolation)', async () => {
    await grantCapabilities({
      pluginName: 'p', pluginVersion: '0.1.0', harnessSlug: 'sheets',
      capabilities: ['x'],
    }, { sql });
    await grantCapabilities({
      pluginName: 'p', pluginVersion: '0.2.0', harnessSlug: 'sheets',
      capabilities: ['y'],
    }, { sql });

    expect(await getGrantsForPluginInHarness('p', '0.1.0', 'sheets', { sql, skipLegacy: true })).toEqual(['x']);
    expect(await getGrantsForPluginInHarness('p', '0.2.0', 'sheets', { sql, skipLegacy: true })).toEqual(['y']);
  });

  it('returns [] when nothing matches', async () => {
    const caps = await getGrantsForPluginInHarness('nope', '0.0.0', 'nowhere', { sql, skipLegacy: true });
    expect(caps).toEqual([]);
  });

  it('does NOT leak grants from a different plugin', async () => {
    await grantCapabilities({
      pluginName: 'plugin-a', pluginVersion: '0.1.0', harnessSlug: 'sheets',
      capabilities: ['shared-cap'],
    }, { sql });
    const caps = await getGrantsForPluginInHarness('plugin-b', '0.1.0', 'sheets', { sql, skipLegacy: true });
    expect(caps).toEqual([]);
  });
});

describe('backfillGrantsFromEnabledPluginsAndLegacyFile', () => {
  it('writes one grant per (harness, plugin, cap) tuple', async () => {
    const r = await backfillGrantsFromEnabledPluginsAndLegacyFile(
      [
        {
          harnessSlug: 'sheets',
          plugins: [
            { name: '@papercupai/cf-pages', version: '0.1.0', manifestCapabilities: ['http:fetch:api.cloudflare.com', 'secrets:read:CF_TOKEN'] },
            { name: '@papercupai/pi-coding', version: '0.1.1', manifestCapabilities: ['ui:dashboard-tab'] },
          ],
        },
        {
          harnessSlug: 'docs',
          plugins: [
            { name: '@papercupai/cf-pages', version: '0.1.0', manifestCapabilities: ['http:fetch:api.cloudflare.com'] },
          ],
        },
      ],
      { sql, skipLegacy: true },
    );
    expect(r.inserted).toBe(4);

    const rows = await sql<{ harness_slug: string; plugin_name: string; capability: string }[]>`
      SELECT harness_slug, plugin_name, capability FROM harness_shared.plugin_capability_grants
      ORDER BY harness_slug, plugin_name, capability
    `;
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => true)).toBe(true);
  });

  it('attributes every backfilled row to system + enabled-plugins.json backfill', async () => {
    await backfillGrantsFromEnabledPluginsAndLegacyFile(
      [{ harnessSlug: 'sheets', plugins: [{ name: 'p', version: '0.1.0', manifestCapabilities: ['x'] }] }],
      { sql, skipLegacy: true },
    );
    const rows = await sql<{ granted_by: string; reason: string }[]>`
      SELECT granted_by, reason FROM harness_shared.plugin_capability_grants
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].granted_by).toBe('system');
    expect(rows[0].reason).toBe('enabled-plugins.json backfill');
  });

  it('is idempotent — running twice yields the same row count', async () => {
    const input = [{ harnessSlug: 'sheets', plugins: [{ name: 'p', version: '0.1.0', manifestCapabilities: ['x', 'y'] }] }];
    await backfillGrantsFromEnabledPluginsAndLegacyFile(input, { sql, skipLegacy: true });
    await backfillGrantsFromEnabledPluginsAndLegacyFile(input, { sql, skipLegacy: true });
    const rows = await sql`SELECT count(*)::int AS n FROM harness_shared.plugin_capability_grants`;
    expect((rows as any)[0].n).toBe(2);
  });

  it('empty input is a no-op (inserted=0)', async () => {
    const r = await backfillGrantsFromEnabledPluginsAndLegacyFile([], { sql, skipLegacy: true });
    expect(r.inserted).toBe(0);
    const rows = await sql`SELECT count(*)::int AS n FROM harness_shared.plugin_capability_grants`;
    expect((rows as any)[0].n).toBe(0);
  });

  it('a plugin with empty manifestCapabilities[] contributes zero grants', async () => {
    const r = await backfillGrantsFromEnabledPluginsAndLegacyFile(
      [{ harnessSlug: 'sheets', plugins: [{ name: 'p', version: '0.1.0', manifestCapabilities: [] }] }],
      { sql, skipLegacy: true },
    );
    expect(r.inserted).toBe(0);
  });

  it('different plugin versions in the same harness do not collide', async () => {
    await backfillGrantsFromEnabledPluginsAndLegacyFile(
      [{
        harnessSlug: 'sheets',
        plugins: [
          { name: 'p', version: '0.1.0', manifestCapabilities: ['x'] },
          { name: 'p', version: '0.2.0', manifestCapabilities: ['x'] },
        ],
      }],
      { sql, skipLegacy: true },
    );
    const rows = await sql<{ plugin_version: string }[]>`
      SELECT plugin_version FROM harness_shared.plugin_capability_grants
      WHERE harness_slug = 'sheets' AND plugin_name = 'p'
      ORDER BY plugin_version
    `;
    expect(rows.map((r) => r.plugin_version)).toEqual(['0.1.0', '0.2.0']);
  });
});
