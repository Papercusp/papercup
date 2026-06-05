/**
 * plugin-grants-fork-backfill.integration.test.ts — operator-core-side coverage
 * for the two grant-population seams of revive-plugin-system-2026-06-04:
 *
 *   - copyGrantsToNewHarness  (snapshot-fork inheritance — `copied` count,
 *     ON CONFLICT no-dup on re-fork, source===target no-op)
 *   - backfillGrantsFromEnabledPluginsAndLegacyFile (`inserted` count)
 *
 * The apps/operator copy of this test exercises the same functions against a
 * hand-built table; this one lives next to the source in @papercusp/operator-core
 * and drives them through the `{ sql }` override against a throwaway testcontainer
 * DB (createFreshPgDb), so a column/constraint drift in plugin-grants.ts is caught
 * in the package that owns it. Mirrors the existing grants test's itPg pattern.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  copyGrantsToNewHarness,
  backfillGrantsFromEnabledPluginsAndLegacyFile,
} from './plugin-grants';

let db: FreshPgDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshPgDb('grants_fork');
  sql = db.sql;
  // `harness_shared.plugin_capability_grants` is defined in 000-baseline.sql
  // (originally migration 051). createFreshPgDb only makes the schema, so build
  // the table here exactly as baseline declares it (PK on the full tuple).
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
}, 120_000);

afterAll(async () => {
  if (db) await db.cleanup();
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
    ORDER BY plugin_name, plugin_version, capability
  `;
}

describe('copyGrantsToNewHarness (snapshot-fork inheritance)', () => {
  it('copies every grant from source to target and reports the count', async () => {
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
    // Forked rows are re-attributed to system + a fork-from reason.
    expect(target.every((row) => row.granted_by === 'system')).toBe(true);
    expect(target.every((row) => row.reason === 'fork from sheets')).toBe(true);
  });

  it('a re-fork into the same target does NOT duplicate (ON CONFLICT DO NOTHING → copied=0)', async () => {
    await insertGrant('@papercupai/cf-pages', '0.1.0', 'sheets', 'http:fetch:api.cloudflare.com');

    const first = await copyGrantsToNewHarness('sheets', 'sheets-fork', { sql });
    expect(first.copied).toBe(1);

    const second = await copyGrantsToNewHarness('sheets', 'sheets-fork', { sql });
    expect(second.copied).toBe(0);

    expect(await listGrantsFor('sheets-fork')).toHaveLength(1);
  });

  it('source === target is a no-op (copied=0, table unchanged — no PK violation)', async () => {
    await insertGrant('@papercupai/cf-pages', '0.1.0', 'sheets', 'tasks:read');
    const r = await copyGrantsToNewHarness('sheets', 'sheets', { sql });
    expect(r.copied).toBe(0);
    expect(await listGrantsFor('sheets')).toHaveLength(1); // unchanged
  });

  it('empty source forks cleanly (copied=0)', async () => {
    const r = await copyGrantsToNewHarness('nothing-here', 'fork-of-nothing', { sql });
    expect(r.copied).toBe(0);
    expect(await listGrantsFor('fork-of-nothing')).toHaveLength(0);
  });

  it('does not leak a sibling harness\'s grants into the fork (scope is exact-match)', async () => {
    await insertGrant('@papercupai/cf-pages', '0.1.0', 'sheets', 'http:fetch:api.cloudflare.com');
    await insertGrant('@papercupai/cf-pages', '0.1.0', 'other-harness', 'http:fetch:api.cloudflare.com');

    const r = await copyGrantsToNewHarness('sheets', 'sheets-fork', { sql });
    expect(r.copied).toBe(1);
    const target = await listGrantsFor('sheets-fork');
    expect(target).toHaveLength(1);
    expect(target[0].plugin_name).toBe('@papercupai/cf-pages');
  });
});

describe('backfillGrantsFromEnabledPluginsAndLegacyFile (`inserted` count)', () => {
  it('inserts one grant per (harness, plugin, cap) tuple and counts them', async () => {
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

    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.plugin_capability_grants`;
    expect(rows[0].n).toBe(4);

    const sheetsRows = await listGrantsFor('sheets');
    expect(sheetsRows.every((row) => row.granted_by === 'system')).toBe(true);
    expect(sheetsRows.every((row) => row.reason === 'enabled-plugins.json backfill')).toBe(true);
  });

  it('counts inserted by declared caps even if a re-run is ON CONFLICT no-op at the DB level', async () => {
    const input = [{ harnessSlug: 'sheets', plugins: [{ name: 'p', version: '0.1.0', manifestCapabilities: ['x', 'y'] }] }];
    const first = await backfillGrantsFromEnabledPluginsAndLegacyFile(input, { sql, skipLegacy: true });
    expect(first.inserted).toBe(2);

    // Second run still reports inserted=2 (the count is over declared caps), but
    // the table stays at 2 rows because grantCapabilities is ON CONFLICT DO NOTHING.
    const second = await backfillGrantsFromEnabledPluginsAndLegacyFile(input, { sql, skipLegacy: true });
    expect(second.inserted).toBe(2);
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.plugin_capability_grants`;
    expect(rows[0].n).toBe(2);
  });

  it('empty input is a no-op (inserted=0)', async () => {
    const r = await backfillGrantsFromEnabledPluginsAndLegacyFile([], { sql, skipLegacy: true });
    expect(r.inserted).toBe(0);
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.plugin_capability_grants`;
    expect(rows[0].n).toBe(0);
  });

  it('a plugin with empty manifestCapabilities[] contributes zero grants', async () => {
    const r = await backfillGrantsFromEnabledPluginsAndLegacyFile(
      [{ harnessSlug: 'sheets', plugins: [{ name: 'p', version: '0.1.0', manifestCapabilities: [] }] }],
      { sql, skipLegacy: true },
    );
    expect(r.inserted).toBe(0);
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.plugin_capability_grants`;
    expect(rows[0].n).toBe(0);
  });

  it('keeps per-version grants distinct within one harness', async () => {
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
