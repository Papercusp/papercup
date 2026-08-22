// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../test/_work-items-schema';
import { PAYLOAD_BUDGET_BYTES } from './sync-read-audit';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  workspaceId: 'p6-learning-improve-real-pg',
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => h.workspaceId }));
vi.mock('../agent-tools/coordination/log', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, coordScopeWorkspace: () => 'default' };
});

const { projectImprovementItemsForBoundedRead } = await import('../harness/improvements/read-items');
const { scoreImprovementCandidates } = await import('../harness/improvements/digest');
const {
  mergeLearningImproveRows,
  normalizeLearningImproveViewArgs,
  projectLearningImproveRows,
  summarizeLearningImproveRows,
} = await import('./learning-improve-view-query');

const ROWS = 620;
const DEEP = 611;
const DEEP_ID = `EI-P6-${DEEP.toString().padStart(4, '0')}`;
const TIER_TOKEN = 'deep-only-tier-token';
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('learning-improve-view-query');
  h.sql = db.sql;
  await db.sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await ensureCoordCapabilityTables(db.sql);
  await db.sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status,
       item_kind, payload, created_ts, updated_ts, origin)
    SELECT ${h.workspaceId},
           'alpha-hive',
           'EI-P6-' || lpad(g::text, 4, '0'),
           'ordinary improvement ' || g,
           'ordinary body ' || g,
           'open',
           'bug',
           CASE WHEN g = ${DEEP}
                THEN jsonb_build_object('paths', jsonb_build_array('packages/operator-core/lib/release/' || ${TIER_TOKEN} || '.ts'))
                ELSE '{}'::jsonb END,
           1900000000000::bigint - g,
           1900000000000::bigint - g,
           'local'
      FROM generate_series(1, ${ROWS}) AS g`;
  await db.sql`
    INSERT INTO harness_shared.coord_links
      (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel)
    SELECT 'default', 'issue', feature_id, 'topic', 'papercusp-improvement', 'tagged'
      FROM harness_shared.work_items
     WHERE workspace_id = ${h.workspaceId}`;
}, 60_000);

afterAll(async () => {
  await db.cleanup();
}, 60_000);

describe('Learning Improve bounded projection — real Postgres', () => {
  it('finds a tierReason+rail-only match beyond row 500 and returns exact facets within budget', async () => {
    const startedAt = performance.now();
    const result = await projectImprovementItemsForBoundedRead(
      {},
      {
        maxRows: 1,
        project: (candidates) => {
          expect(candidates).toHaveLength(ROWS);
          const scored = scoreImprovementCandidates(candidates, {
            nowMs: 1_900_100_000_000,
            ownerFullAutonomy: false,
          });
          const deep = scored.find((row) => row.id === DEEP_ID);
          expect(deep?.title).not.toContain(TIER_TOKEN);
          expect(deep?.tierReason).not.toBe(
            'no protected path/keyword → AUTO-eligible (still gated by blueprint + tests + release-manager)',
          );
          const merged = mergeLearningImproveRows(
            scored,
            [
              {
                ideaId: 'idea-deep',
                lens: 'reframing',
                rail: 'plan',
                routedRef: `wi:${DEEP_ID}`,
                title: 'ordinary routed idea',
                routedAt: '2026-08-22T00:00:00.000Z',
              },
            ],
            1_900_100_000_000,
          );
          const args = normalizeLearningImproveViewArgs({ q: deep!.tierReason, rails: ['plan'] });
          return [
            { rows: projectLearningImproveRows(merged, args), summary: summarizeLearningImproveRows(merged, args) },
          ];
        },
      },
    );
    const elapsedMs = performance.now() - startedAt;
    expect(result).toHaveLength(1);
    expect(result[0]!.rows.map((row) => row.item?.id)).toEqual([DEEP_ID]);
    expect(result[0]!.summary).toMatchObject({ total: ROWS, matched: 1 });
    expect(result[0]!.summary.facets.find((facet) => facet.key === 'rail')?.values).toContainEqual(
      expect.objectContaining({ value: 'plan', count: 1 }),
    );
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(PAYLOAD_BUDGET_BYTES);
    expect(elapsedMs).toBeLessThan(6_000);
  });
});
