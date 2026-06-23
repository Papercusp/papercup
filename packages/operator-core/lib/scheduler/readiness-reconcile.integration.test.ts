/**
 * readiness-reconcile.integration.test.ts — the reconciliation SWEEP that catches
 * drift between migration 379's MAINTAINED readiness sidecar
 * (harness_shared.work_item_blocked) and its ORACLE
 * (harness_shared.work_item_is_blocked(harness, feature))
 * (work-item-deps-and-readiness-2026-06-22 P-005, owned by su-0e44e75b).
 *
 * The sidecar is trigger-maintained, so a trigger bug could leave it disagreeing
 * with the oracle — and the scheduler claim reads the sidecar as an indexed
 * anti-join, so a stale sidecar would silently hand out blocked work (MISSING) or
 * starve ready work (EXTRA). `reconcileReadiness` is the detector. This test:
 *
 *   1. Seeds a RANDOM graph of feature items + work_item_deps 'blocks' edges +
 *      varied statuses, lets migration 379's wir_* triggers maintain the sidecar,
 *      and asserts reconcileReadiness ⇒ drift=0 (the triggers keep it EXACT). The
 *      graph is reseeded over several random rounds to exercise many shapes.
 *   2. Deliberately CORRUPTS the sidecar out-of-band of the triggers — INSERT a
 *      bogus row (for a ready feature) + DELETE a legit one (for a blocked feature)
 *      — and asserts the sweep pinpoints exactly those: extra=1, missing=1, drift=2.
 *
 * Real Postgres (testcontainer; Docker required). Mirrors the schema-bootstrap of
 * the sibling claim-respects-blocking.integration.test.ts (the same migration-379
 * materialization), and reuses the canonical _work-items-schema DDL fixtures.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/readiness-reconcile.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
/** Read a migration verbatim, stripping psql meta-commands / GRANTs / bare BEGIN/COMMIT
 *  the bare testcontainer schema can't run (mirrors the sibling integration tests). */
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

// Imported AFTER the mock so the default getOrgPg().sql binding routes at the test DB
// (the test passes the handle explicitly anyway; this keeps the import chain safe).
const { reconcileReadiness } = await import('./readiness-reconcile');

const H = 'papercup';
const WS = 'default'; // work_item_deps + the sidecar live in the 'default' workspace
let db: FreshPgDb;

// ── seed helpers ─────────────────────────────────────────────────────────────
async function seedFeature(id: string, status: string) {
  // INSERT through the auto-updatable hfc view → fires the work_items base triggers
  // (incl. migration 379's wir_insert_sync_own), exactly like production createWorkItem.
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, workspace_id, created_ts, updated_ts)
    VALUES (${H}, ${id}, 'feature', ${status}, ${WS}, 0, 0)`;
}

/** A feature→feature blocks edge (harness-qualified refs, the featureRef convention). */
async function blockByFeature(blockedId: string, blockerId: string) {
  await db.sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${WS}, 'feature', ${`${H}#${blockedId}`}, 'feature', ${`${H}#${blockerId}`}, 'blocks')`;
}

/** PRESENCE of a sidecar row = blocked. Read it directly for cross-checks. */
async function sidecarBlocked(): Promise<Set<string>> {
  const rows = await db.sql<Array<{ feature_id: string }>>`
    SELECT feature_id FROM harness_shared.work_item_blocked
     WHERE workspace_id = ${WS} AND harness_slug = ${H}`;
  return new Set(rows.map((r) => r.feature_id));
}

/** The oracle's blocked set over the seeded features — independent recompute. */
async function oracleBlocked(ids: string[]): Promise<Set<string>> {
  const blocked = new Set<string>();
  for (const id of ids) {
    const [{ b }] = await db.sql<Array<{ b: boolean }>>`
      SELECT harness_shared.work_item_is_blocked(${H}, ${id}) AS b`;
    if (b) blocked.add(id);
  }
  return blocked;
}

const FEATURE_STATUSES = ['todo', 'wip', 'in_progress', 'passed', 'deprecated'] as const;

beforeAll(async () => {
  db = await createFreshPgDb('readiness-reconcile');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  // Migration 379: the MAINTAINED sidecar (work_item_blocked) + the wir_* maintenance
  // triggers + the work_item_is_blocked() oracle + the backfill. `.simple()` because it
  // is a multi-statement DDL script.
  await db.sql.unsafe(readMigration('379-maintained-ready-column.sql')).simple();
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps, harness_shared.work_item_blocked`;
});

/**
 * Seed a random feature graph and return the feature ids. Guarantees the result
 * contains BOTH at least one oracle-blocked feature AND at least one ready feature
 * (the corruption test needs one of each to delete-a-legit / insert-a-bogus row).
 */
async function seedRandomGraph(n: number): Promise<string[]> {
  const ids = Array.from({ length: n }, (_, i) => `F-${i}`);
  // Statuses: random, but force F-0 terminal (a satisfied blocker → a guaranteed ready
  // dependent) and F-1 non-terminal (a guaranteed unsatisfied blocker).
  const status = new Map<string, string>();
  for (const id of ids) status.set(id, FEATURE_STATUSES[Math.floor(Math.random() * FEATURE_STATUSES.length)]!);
  status.set('F-0', 'passed'); // terminal blocker
  status.set('F-1', 'wip'); // non-terminal blocker
  for (const id of ids) await seedFeature(id, status.get(id)!);

  // Random blocks-edges over distinct pairs (acyclic-by-direction: only i→j with j<i,
  // matching the writer's acyclicity invariant — a higher-index item blocked by a lower one).
  for (let i = 2; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (Math.random() < 0.35) await blockByFeature(`F-${i}`, `F-${j}`);
    }
  }
  // Guarantee a blocked dependent: F-2 blocked-by the non-terminal F-1.
  await blockByFeature('F-2', 'F-1').catch(() => {}); // edge may already exist (uniq) — fine
  return ids;
}

describe('reconcileReadiness — drift detection over migration 379 sidecar', () => {
  it('reports drift=0: the triggers keep the sidecar EXACT (random graphs)', async () => {
    for (let round = 0; round < 6; round++) {
      await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps, harness_shared.work_item_blocked`;
      const ids = await seedRandomGraph(8);

      // Sanity: the trigger-maintained sidecar must already equal an independent
      // recompute of the oracle (proves the seed actually exercised the triggers).
      const sidecar = await sidecarBlocked();
      const oracle = await oracleBlocked(ids);
      expect([...sidecar].sort()).toEqual([...oracle].sort());

      const res = await reconcileReadiness(db.sql);
      expect(res).toEqual({ drift: 0, missing: [], extra: [] });
    }
  });

  it('detects exactly a corrupted sidecar: extra=1 (bogus) + missing=1 (deleted legit)', async () => {
    const ids = await seedRandomGraph(8);
    const oracle = await oracleBlocked(ids);

    // Pick a feature the oracle says IS blocked (its legit sidecar row exists) and one
    // it says is NOT blocked (no sidecar row). The seed guarantees F-1's dependents are
    // blocked and F-0 (terminal, with no blocker of its own) is ready.
    const blockedId = [...oracle].sort()[0];
    expect(blockedId).toBeDefined(); // graph guarantees ≥1 blocked feature
    const readyId = ids.find((id) => !oracle.has(id));
    expect(readyId).toBeDefined(); // graph guarantees ≥1 ready feature
    expect(blockedId).not.toBe(readyId);

    // Baseline: no drift before corruption.
    expect((await reconcileReadiness(db.sql)).drift).toBe(0);

    // CORRUPT, out-of-band of the triggers:
    //   • DELETE the legit row for a blocked feature → it now falsely looks READY (MISSING).
    await db.sql`
      DELETE FROM harness_shared.work_item_blocked
       WHERE workspace_id = ${WS} AND harness_slug = ${H} AND feature_id = ${blockedId!}`;
    //   • INSERT a bogus row for a ready feature → it now falsely looks BLOCKED (EXTRA).
    await db.sql`
      INSERT INTO harness_shared.work_item_blocked (workspace_id, harness_slug, feature_id)
      VALUES (${WS}, ${H}, ${readyId!})`;

    const res = await reconcileReadiness(db.sql);
    expect(res.drift).toBe(2);
    expect(res.missing).toEqual([{ workspace_id: WS, harness_slug: H, feature_id: blockedId! }]);
    expect(res.extra).toEqual([{ workspace_id: WS, harness_slug: H, feature_id: readyId! }]);
  });

  it('EXTRA also flags a sidecar row for a non-existent / non-feature item', async () => {
    await seedFeature('F-real', 'todo'); // ready, no blockers
    expect((await reconcileReadiness(db.sql)).drift).toBe(0);

    // A sidecar row pointing at an item with no feature row at all — not in the oracle set.
    await db.sql`
      INSERT INTO harness_shared.work_item_blocked (workspace_id, harness_slug, feature_id)
      VALUES (${WS}, ${H}, 'F-ghost')`;

    const res = await reconcileReadiness(db.sql);
    expect(res.drift).toBe(1);
    expect(res.missing).toEqual([]);
    expect(res.extra).toEqual([{ workspace_id: WS, harness_slug: H, feature_id: 'F-ghost' }]);
  });

  it('clean empty graph ⇒ drift=0', async () => {
    expect(await reconcileReadiness(db.sql)).toEqual({ drift: 0, missing: [], extra: [] });
  });
});
