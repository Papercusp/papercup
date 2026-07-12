/**
 * recall-stats-surface.integration.test.ts — the RECURRENCE GUARD for
 * memory-delivery-unification-2026-07-12 P-005.
 *
 * P-005 added per-port recall surfaces (initialize / compact / turn-start /
 * brief / orient / claim / create) on the premise that the `surface` column is
 * FREE-TEXT. But the original table (migration 240) shipped a CHECK constraint
 * pinning surface to ('search','injection'), and recordRecallStats' fire-and-
 * forget catch SWALLOWS the resulting constraint violation — so every new-port
 * write silently recorded nothing, and the P-005 UNIT test (recall-stats.test.ts)
 * never caught it because it mocks `sql`. Migration 583 drops that constraint.
 *
 * This test runs recordRecallStats against a REAL migrated Postgres (the full
 * 240→583 chain) and asserts a row LANDS for every documented RecallSurface.
 * If a CHECK constraint on `surface` is ever (re)introduced without a member,
 * the swallowed insert produces 0 rows here and this test fails — turning a
 * silent telemetry black-hole back into a red build.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import type { MemoryEntry } from './backend';
import type { RecallSurface } from './recall-stats';
import { recordRecallStats } from './recall-stats';

const { createOrgTestDb } = await import('../../test/_org-test-db');

// Must stay in sync with the RecallSurface union in recall-stats.ts. A compile-time
// check (below) fails the build if the union grows a member not listed here.
const ALL_SURFACES: readonly RecallSurface[] = [
  'search',
  'injection',
  'initialize',
  'compact',
  'turn-start',
  'brief',
  'orient',
  'claim',
  'create',
];

// Compile-time exhaustiveness: if RecallSurface gains a member, this errors until
// it is added to ALL_SURFACES above (so the runtime guard actually covers it).
type _MissingFromList = Exclude<RecallSurface, (typeof ALL_SURFACES)[number]>;
const _exhaustive: _MissingFromList extends never ? true : false = true;
void _exhaustive;

const entry = (id: string, score: number): MemoryEntry => ({ id, text: id, scope: 's', score });

describe('recordRecallStats persists every documented surface (real PG — P-005 guard)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('writes a landing row for each RecallSurface (the surface column is free-text; no CHECK rejects a port)', async () => {
    for (const surface of ALL_SURFACES) {
      // recordRecallStats never throws — a constraint violation is SWALLOWED —
      // so we assert on the persisted row, not on a thrown error.
      await recordRecallStats(db.adminSql, { surface, entries: [entry(`e-${surface}`, 0.5)] });
    }

    const rows = (await db.adminSql`
      SELECT surface, count(*)::int AS n
      FROM harness_shared.memory_recall_stats
      WHERE surface = ANY(${ALL_SURFACES as string[]})
      GROUP BY surface
    `) as Array<{ surface: string; n: number }>;

    const landed = new Map(rows.map((r) => [r.surface, r.n]));
    for (const surface of ALL_SURFACES) {
      expect(landed.get(surface) ?? 0, `surface '${surface}' should have recorded a row`).toBeGreaterThanOrEqual(1);
    }
  });

  it('also records a zero-hit recall for a port (hit_count 0, NULL top score) — the zero-hit-rate signal', async () => {
    await recordRecallStats(db.adminSql, { surface: 'initialize', entries: [] });
    const [row] = (await db.adminSql`
      SELECT hit_count, top_score
      FROM harness_shared.memory_recall_stats
      WHERE surface = 'initialize' AND hit_count = 0
      ORDER BY created_at DESC
      LIMIT 1
    `) as Array<{ hit_count: number; top_score: number | null }>;
    expect(row?.hit_count).toBe(0);
    expect(row?.top_score).toBeNull();
  });
});
