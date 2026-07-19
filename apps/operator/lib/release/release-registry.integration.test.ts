/**
 * previousCutAt regression — the 0.0.11 changelog-window collapse (2026-07-16).
 *
 * A release row is idempotent on (workspace, channel, version), so re-recording
 * the SAME version to add a late platform (mac landing after linux + windows)
 * UPDATEs the existing row. previousCutAt computes the changelog window's lower
 * bound as "the most recent cut before now, in this channel" — and it MUST exclude
 * the version being (re-)recorded. Without that exclusion, the re-record's window
 * collapses onto the version's OWN earlier cut (the ~56-min gap between the two
 * records held ~no terminal work), and the ON CONFLICT UPDATE overwrote 0.0.11's
 * work-item / plan associations with the empty set (319 terminal items → 0).
 *
 * These assertions pin the fix. Integration because previousCutAt is a SQL query
 * over harness_shared.releases; getTestPg stands up the harness_shared schema.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { getTestPg } from '@papercusp/test-config/pg';
import { previousCutAt } from './release-registry';

let sql: postgres.Sql;
// Unique workspace so these rows never collide with any other test's releases.
const WS = `prevcut-test-${Math.random().toString(36).slice(2, 10)}`;
const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  const dbUrl = await getTestPg();
  sql = postgres(dbUrl, { max: 1 });
  // Self-sufficient: no-op if getTestPg already migrated the table in (it does),
  // and correct (copied from migration 589) if a bare DB is handed over.
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.releases (
      workspace_id  text        NOT NULL,
      version       text        NOT NULL,
      channel       text        NOT NULL DEFAULT 'alpha',
      cut_at        timestamptz NOT NULL DEFAULT now(),
      published_at  timestamptz,
      changelog_md  text,
      work_item_ids text[]      NOT NULL DEFAULT '{}',
      plan_slugs    text[]      NOT NULL DEFAULT '{}',
      artifacts     jsonb       NOT NULL DEFAULT '[]'::jsonb,
      git_sha       text,
      cut_by        text,
      notes         text,
      PRIMARY KEY (workspace_id, channel, version)
    )
  `);
  // 0.0.10 = the real prior release; 0.0.11 = its FIRST record (linux + windows).
  await sql`
    INSERT INTO harness_shared.releases (workspace_id, version, channel, cut_at)
    VALUES
      (${WS}, '0.0.10', 'alpha', ${at('2026-07-14T03:46:43Z')}),
      (${WS}, '0.0.11', 'alpha', ${at('2026-07-15T23:43:49Z')})
  `;
}, 120_000);

afterAll(async () => {
  if (sql) {
    await sql`DELETE FROM harness_shared.releases WHERE workspace_id = ${WS}`.catch(() => {});
    await sql.end();
  }
});

describe('previousCutAt — excludes the version being (re-)recorded', () => {
  it('a 0.0.11 re-record (mac add) sees 0.0.10 as the window start, NOT 0.0.11 itself', async () => {
    // Re-recording 0.0.11 ~56 min after its first cut. The bug returned 0.0.11's
    // own 23:43 cut → window collapses to the 56-min gap → 0 terminal items.
    const prev = await previousCutAt(sql, WS, 'alpha', at('2026-07-16T00:39:39Z'), '0.0.11');
    expect(prev?.toISOString()).toBe('2026-07-14T03:46:43.000Z'); // 0.0.10
  });

  it('a genuinely NEW version (0.0.12) still sees the real predecessor 0.0.11', async () => {
    // The exclusion drops only the SAME version, never all — a new release must
    // still bound its window at the previous one.
    const prev = await previousCutAt(sql, WS, 'alpha', at('2026-07-17T00:00:00Z'), '0.0.12');
    expect(prev?.toISOString()).toBe('2026-07-15T23:43:49.000Z'); // 0.0.11
  });

  it('the first release in a channel returns null (no prior real cut)', async () => {
    const prev = await previousCutAt(sql, WS, 'beta', at('2026-07-18T00:00:00Z'), '0.0.13');
    expect(prev).toBeNull();
  });
});
