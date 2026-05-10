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
import { copyGrantsToNewHarness } from '../lib/plugin-grants';

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
