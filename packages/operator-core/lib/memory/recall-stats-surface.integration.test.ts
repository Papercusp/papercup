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

/**
 * context-injection-audit-2026-07-28 P-026 (migration 703) — real-PG guard for
 * the per-pool breakdown, for exactly the reason the P-005 guard above exists.
 *
 * The unit tests for this feature MOCK `sql`, so they prove the writer builds
 * the right values and prove NOTHING about whether the statement executes:
 * a missing column, a jsonb cast that does not round-trip, or a bad LATERAL
 * join all fail INSIDE recordRecallStats' fire-and-forget catch and are
 * swallowed — the identical silent-black-hole shape as P-005. And this feature
 * is a MEASUREMENT INSTRUMENT: every other fix in the plan is judged by what it
 * reports, so a silently-empty instrument would not merely lose telemetry, it
 * would produce confident wrong conclusions about whether those fixes worked.
 */
describe('per-pool recall telemetry round-trips through real PG (P-026 guard)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('persists the pools jsonb and reads each pool back independently', async () => {
    await recordRecallStats(db.adminSql, {
      surface: 'turn-start',
      workspaceId: 'ws-p026',
      potSlug: 'papercusp',
      pools: {
        user: { entries: [entry('u1', 0.9), entry('u2', 0.8)], limit: 6, scopes: ['u:1'] },
        // Queried, budgeted, and returns nothing — the state a flat hit_count erased.
        harness: { entries: [], limit: 3, scopes: ['harness:papercusp'] },
        hive: { entries: [entry('h1', 0.2)], limit: 3, scopes: ['hive:papercusp'] },
      },
    });

    const [row] = (await db.adminSql`
      SELECT hit_count, pools, workspace_id, pot_slug
      FROM harness_shared.memory_recall_stats
      WHERE workspace_id = 'ws-p026'
      ORDER BY created_at DESC
      LIMIT 1
    `) as Array<{
      hit_count: number;
      pools: Record<string, { hits: number; top: number | null; limit: number; scopes: string[] }>;
      workspace_id: string;
      pot_slug: string;
    }>;

    // The insert LANDED (a swallowed failure would leave this undefined).
    expect(row, 'the per-pool insert must land — a swallowed error yields no row').toBeDefined();
    expect(row!.hit_count).toBe(3);
    expect(row!.workspace_id).toBe('ws-p026');
    expect(row!.pot_slug).toBe('papercusp');
    // jsonb round-trips with per-pool detail intact.
    expect(row!.pools.user).toEqual({ hits: 2, top: 0.9, limit: 6, scopes: ['u:1'] });
    expect(row!.pools.harness).toEqual({ hits: 0, top: null, limit: 3, scopes: ['harness:papercusp'] });
    expect(row!.pools.hive!.top).toBe(0.2);
  });

  it('readRecallHealthByPool separates a starved pool from a saturated one', async () => {
    const { readRecallHealthByPool } = await import('./recall-stats');
    // Ten recalls where the user pool saturates its budget every time and the
    // harness pool returns nothing every time. Blended, this looks perfect.
    for (let i = 0; i < 10; i++) {
      await recordRecallStats(db.adminSql, {
        surface: 'p026-probe',
        pools: {
          user: {
            entries: [entry(`a${i}`, 0.5), entry(`b${i}`, 0.4), entry(`c${i}`, 0.3)],
            limit: 3,
            scopes: ['u:probe'],
          },
          harness: { entries: [], limit: 3, scopes: ['harness:orphaned'] },
        },
      });
    }

    const rows = await readRecallHealthByPool(db.adminSql, { surface: 'p026-probe' });
    const byPool = new Map(rows.map((r) => [r.pool, r]));

    const user = byPool.get('user');
    expect(user?.recalls).toBe(10);
    expect(user?.zeroHitRate).toBe(0);
    // hits === the limit STORED ON THE ROW, on every call: selection by budget.
    expect(user?.saturationRate).toBe(1);
    expect(user?.hitsP50).toBe(3);
    expect(user?.topScoreP50).toBeCloseTo(0.5, 6);

    const harness = byPool.get('harness');
    expect(harness?.recalls).toBe(10);
    expect(harness?.zeroHitRate).toBe(1);
    expect(harness?.saturationRate).toBe(0);
    expect(harness?.topScoreP50).toBeNull();
    // The scope it was actually keyed on — the gate-2 detector.
    expect(harness?.scopes).toEqual(['harness:orphaned']);
  });

  it('excludes pull-path rows (pools IS NULL) rather than counting them as zero-hit pools', async () => {
    const { readRecallHealthByPool } = await import('./recall-stats');
    await recordRecallStats(db.adminSql, { surface: 'p026-flat', entries: [entry('x', 0.7)] });
    expect(await readRecallHealthByPool(db.adminSql, { surface: 'p026-flat' })).toEqual([]);
  });
});
