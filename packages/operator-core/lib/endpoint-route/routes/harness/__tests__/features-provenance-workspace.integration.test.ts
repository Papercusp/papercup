/**
 * EI-124 regression — feature provenance must land regardless of workspace.
 *
 * The bug: the `POST /features/import` provenance write filtered the consolidated
 * UPDATE by `workspace_id = activeWorkspaceId()`. Inside the loopback import call
 * `activeWorkspaceId()` falls back to the host's global-current workspace (the
 * request carries no workspace header), so when the harness lives in a DIFFERENT
 * workspace the UPDATE matched 0 rows and silently dropped `source_plan_slug` /
 * `wave` — making promoted features invisible to the wave engine.
 *
 * The fix: `updateFeatureProvenance` keys by the PRIMARY KEY
 * `(harness_slug, feature_id)` — globally unique, no workspace_id — so the row is
 * scoped unambiguously by slug+id and the workspace the request resolves to is
 * irrelevant. This test drives that exact exported statement against a real PG.
 *
 * Integration (real PG via testcontainer). Collision-safe on the shared
 * container: CREATE … IF NOT EXISTS + random unique keys + row-scoped cleanup.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { withTestSchema } from '@papercusp/test-config';
import { updateFeatureProvenance } from '../features';

const SLUG = `ei124-${randomBytes(4).toString('hex')}`;
const FID = `F-EI124-${randomBytes(4).toString('hex').toUpperCase()}`;
// The harness's real workspace — deliberately NOT the workspace any "active
// request" would resolve to, modelling a cross-workspace promote.
const HARNESS_WS = `ws-${randomBytes(3).toString('hex')}`;
const OTHER_WS = `ws-other-${randomBytes(3).toString('hex')}`;

let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  const { connectionUri } = await withTestSchema();
  sql = postgres(connectionUri, { onnotice: () => {} });
  // Minimal consolidated table matching the real PRIMARY KEY (harness_slug,
  // feature_id). IF NOT EXISTS so we co-exist with the full table another
  // integration file may have already created in the shared container.
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_features_consolidated (
      harness_slug text NOT NULL,
      feature_id   text NOT NULL,
      title text, status text,
      workspace_id text NOT NULL,
      source_plan_slug text,
      source_plan_item_ids text[],
      wave text,
      PRIMARY KEY (harness_slug, feature_id)
    )
  `);
  // Seed one feature for our harness, in HARNESS_WS, with NO provenance yet —
  // exactly the post-base-insert state the import route writes.
  await sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, workspace_id, title, status)
    VALUES (${SLUG}, ${FID}, ${HARNESS_WS}, 'seed', 'todo')
  `;
});

afterAll(async () => {
  if (sql) {
    await sql`DELETE FROM harness_shared.harness_features_consolidated WHERE harness_slug = ${SLUG}`.catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
  }
});

describe('EI-124 — updateFeatureProvenance keys by PK, not workspace', () => {
  it('lands provenance even though the row is in a non-active workspace', async () => {
    const n = await updateFeatureProvenance(
      sql,
      { id: FID, source_plan_slug: 'universal-schema-2026-05-30', source_plan_item_ids: ['P-001'], wave: 'tier1' },
      SLUG,
    );
    expect(n).toBe(1);
    const [row] = await sql<{ source_plan_slug: string | null; wave: string | null; source_plan_item_ids: string[] | null }[]>`
      SELECT source_plan_slug, wave, source_plan_item_ids
        FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${SLUG} AND feature_id = ${FID}
    `;
    expect(row.source_plan_slug).toBe('universal-schema-2026-05-30');
    expect(row.wave).toBe('tier1');
    expect(row.source_plan_item_ids).toEqual(['P-001']);
  });

  it('the OLD workspace-filtered UPDATE (wrong workspace) would have matched 0 rows — the bug', async () => {
    // Demonstrates why the removed `WHERE workspace_id = activeWorkspaceId()`
    // predicate was the defect: with the active workspace ≠ the harness's, the
    // legacy statement updates nothing.
    const legacy = await sql`
      UPDATE harness_shared.harness_features_consolidated
         SET wave = 'should-not-apply'
       WHERE workspace_id = ${OTHER_WS}
         AND harness_slug = ${SLUG}
         AND feature_id   = ${FID}
      RETURNING feature_id
    `;
    expect(legacy.length).toBe(0);
    // And the row is untouched by that no-op.
    const [row] = await sql<{ wave: string | null }[]>`
      SELECT wave FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${SLUG} AND feature_id = ${FID}
    `;
    expect(row.wave).toBe('tier1');
  });
});
