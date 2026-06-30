/**
 * datatype-registry.integration.test.ts — the datatype registry CRUD + dedup
 * (`harness_shared.datatype_registry`, migration 421;
 * reflexive-platform-extensibility-datatypes-2026-06-24 P-013) against real Postgres.
 *
 * Mirrors code-recipes-store.integration.test.ts: the store is transport-agnostic
 * (every fn TAKES the `sql` handle), so we pass the org-fixture's admin (RLS-bypass)
 * client directly and scope by the explicit workspaceId arg. This ALSO verifies that
 * migration 421 applies cleanly on the real baseline (the generated title_tsv column,
 * the VECTOR(384) column, the JSONB payload/self_improvement columns, the partial
 * unique index on work_item_kind) — the thing a unit test can't cover.
 *
 * Validates: upsert insert→update-in-place by (workspace,id); tier routing fields;
 * hasGenericKind (the P-001 work_items:create gate); findSimilarDatatypes (the D-010
 * soft semantic-dedup, title_tsv lexical leg); list/count; listRegisteredDatatypeNames;
 * and WORKSPACE ISOLATION (a datatype in ws-A is invisible from ws-B).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OrgTestDb } from '../test/_org-test-db';
import {
  upsertDatatype,
  getDatatype,
  listDatatypes,
  countDatatypes,
  findSimilarDatatypes,
  hasGenericKind,
  listRegisteredDatatypeNames,
} from './datatype-registry-store';

const { createOrgTestDb } = await import('../test/_org-test-db');
const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../libs/papercusp/libs/db/sql');

/** A throwaway 384-dim embedding (only presence/cosine is exercised, not a real vector). */
const fakeEmbedding = (seed = 0.1): number[] => Array.from({ length: 384 }, () => seed);

describe('datatype_registry store (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    // Migration 421 is post-squash → not in the baseline; apply it. A failure here
    // IS the "does the migration apply?" verification.
    await db.adminSql.unsafe(readFileSync(join(SQL_DIR, '421-datatype-registry.sql'), 'utf8'));
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('declares a generic-kind datatype and reads it back (get + list + count)', async () => {
    const ws = 'ws-dt-basic';
    const row = await upsertDatatype(db.adminSql, {
      id: 'bet',
      workspaceId: ws,
      hiveSlug: 'oddsmith-ops',
      title: 'Bet',
      description: 'a thesis: market + p_model + edge + rationale',
      tier: 'generic-kind',
      workItemKind: 'bet',
      payloadSchema: { type: 'object', properties: { market: { type: 'string' }, edge: { type: 'number' } } },
      selfImprovement: { improvements: ['miscalibrated'], scorecard: 'brier', gym: ['no-stale-data'] },
      embedding: fakeEmbedding(),
      tags: ['oddsmith'],
      createdBy: 'owner-1',
    });
    expect(row.id).toBe('bet');
    expect(row.tier).toBe('generic-kind');
    expect(row.workItemKind).toBe('bet');
    expect(row.authoritativeWriter).toBe('papercusp');
    expect(row.hasEmbedding).toBe(true);
    expect(row.payloadSchema).toMatchObject({ type: 'object' });
    expect(row.selfImprovement).toMatchObject({ scorecard: 'brier' });

    const got = await getDatatype(db.adminSql, ws, 'bet');
    expect(got?.title).toBe('Bet');

    const list = await listDatatypes(db.adminSql, ws);
    expect(list.map((d) => d.id)).toContain('bet');
    expect(await countDatatypes(db.adminSql, ws)).toBe(1);
  });

  it('re-declaring the same id UPDATES in place (and COALESCE-preserves the embedding)', async () => {
    const ws = 'ws-dt-update';
    await upsertDatatype(db.adminSql, {
      id: 'wager', workspaceId: ws, title: 'Wager', description: 'first', tier: 'generic-kind',
      embedding: fakeEmbedding(0.2), createdBy: 'a',
    });
    const updated = await upsertDatatype(db.adminSql, {
      id: 'wager', workspaceId: ws, title: 'Wager', description: 'an intent: proposed stake/price/size',
      tier: 'generic-kind', embedding: null, createdBy: 'b', // null embedding must NOT wipe the stored one
    });
    expect(updated.description).toBe('an intent: proposed stake/price/size');
    expect(updated.hasEmbedding).toBe(true); // preserved via COALESCE
    expect(await countDatatypes(db.adminSql, ws)).toBe(1); // updated, not duplicated
  });

  it('hasGenericKind gates registered generic-kinds (the P-001 work_items:create gate)', async () => {
    const ws = 'ws-dt-kind';
    await upsertDatatype(db.adminSql, {
      id: 'forecast', workspaceId: ws, title: 'Forecast', description: 'a probability forecast',
      tier: 'generic-kind', workItemKind: 'forecast', createdBy: 'a',
    });
    // a projection-tier datatype registers NO work_item_kind → not a generic-kind gate hit
    await upsertDatatype(db.adminSql, {
      id: 'position', workspaceId: ws, title: 'Position', description: 'money-truth position',
      tier: 'projection', authoritativeWriter: 'engine:oddsmith', createdBy: 'a',
    });
    expect(await hasGenericKind(db.adminSql, ws, 'forecast')).toBe(true);
    expect(await hasGenericKind(db.adminSql, ws, 'position')).toBe(false); // projection, no kind
    expect(await hasGenericKind(db.adminSql, ws, 'feature')).toBe(false); // built-in, not registered
    expect(await hasGenericKind(db.adminSql, ws, 'nonexistent')).toBe(false);
    expect((await listRegisteredDatatypeNames(db.adminSql, ws)).sort()).toEqual(['forecast', 'position']);
  });

  it('findSimilarDatatypes surfaces a near-duplicate via the title_tsv lexical leg (D-010 dedup)', async () => {
    const ws = 'ws-dt-dedup';
    await upsertDatatype(db.adminSql, {
      id: 'calibration-record', workspaceId: ws, title: 'Calibration record',
      description: 'a record of forecast calibration accuracy over time', tier: 'generic-kind', createdBy: 'a',
    });
    const hits = await findSimilarDatatypes(db.adminSql, ws, {
      title: 'calibration accuracy log',
      description: 'tracks forecast calibration accuracy',
    });
    expect(hits.map((h) => h.id)).toContain('calibration-record');
    expect(hits[0]?.score).toBeGreaterThan(0);
    // an unrelated query returns nothing
    const none = await findSimilarDatatypes(db.adminSql, ws, { title: 'kubernetes ingress controller' });
    expect(none.find((h) => h.id === 'calibration-record')).toBeUndefined();
  });

  it('is WORKSPACE-ISOLATED — a datatype declared in ws-A is invisible from ws-B', async () => {
    await upsertDatatype(db.adminSql, {
      id: 'order', workspaceId: 'ws-A', title: 'Order', description: 'an order', tier: 'projection', createdBy: 'a',
    });
    expect(await getDatatype(db.adminSql, 'ws-A', 'order')).not.toBeNull();
    expect(await getDatatype(db.adminSql, 'ws-B', 'order')).toBeNull();
    expect(await hasGenericKind(db.adminSql, 'ws-B', 'order')).toBe(false);
  });

  // The read-filter broadening (P-001): listWorkItems/countWorkItems/searchWorkItems use
  // featureFamilyKindClause(sql, ws), which admits the 3 built-in feature kinds OR a
  // registered generic-kind. Verify the exact SQL logic against a seeded feature table:
  // a registered generic-kind row IS visible, an UNregistered one is NOT (the dark gate).
  it('feature-family read filter admits a REGISTERED generic-kind but not an unregistered one', async () => {
    const ws = 'ws-vis';
    await upsertDatatype(db.adminSql, {
      id: 'bet', workspaceId: ws, title: 'Bet', description: 'a thesis', tier: 'generic-kind', workItemKind: 'bet', createdBy: 'a',
    });
    // a registered generic-kind item + an UNregistered-kind item, both in the workspace
    await db.adminSql`
      INSERT INTO harness_shared.harness_features_consolidated
        (harness_slug, feature_id, title, summary, status, item_kind, taken_by, workspace_id,
         feature_order, metadata, origin, ts, created_ts, updated_ts)
      VALUES
        ('oddsmith', 'F-BET', 'a bet', '', 'todo', 'bet',   NULL, ${ws}, 1, '{}'::jsonb, 'local', 1000, 1000, 1000),
        ('oddsmith', 'F-WAG', 'a wager', '', 'todo', 'wager', NULL, ${ws}, 2, '{}'::jsonb, 'local', 1000, 1000, 1000)`;
    // the exact predicate featureFamilyKindClause produces
    const rows = await db.adminSql<{ feature_id: string }[]>`
      SELECT feature_id FROM harness_shared.harness_features_consolidated
       WHERE (item_kind IN ('feature', 'research-task', 'chunk')
              OR item_kind IN (
                SELECT work_item_kind FROM harness_shared.datatype_registry
                 WHERE workspace_id = ${ws} AND tier = 'generic-kind' AND status = 'active'
                   AND work_item_kind IS NOT NULL))
         AND workspace_id = ${ws}
       ORDER BY feature_id`;
    const ids = rows.map((r) => r.feature_id);
    expect(ids).toContain('F-BET');   // registered generic-kind → visible
    expect(ids).not.toContain('F-WAG'); // unregistered kind → hidden (the dark gate)
  });
});
