/**
 * Migration 734 — re-point harness-qualified refs when a work item is RE-HOMED
 * (EI-19374236094682800).
 *
 * @covers INV-03
 *
 * ⚠ SCOPE — this suite proves the REF-LEVEL half of INV-03 ("no edge still names the old
 * slug") and deliberately stops there. It cannot prove the edge still GATES: the fixture
 * below stands up its own 5-column `work_items` table, so no claim floor exists in it, and
 * the case named "keeping a blocks edge live" asserts string equality on blocked_ref /
 * blocker_ref — row shape, not effectiveness. The behavioural half lives in
 * scheduler/rename-drift-effectiveness.integration.test.ts (P-012), which drives the real
 * claim door. Neither file substitutes for the other; a rename can leave refs perfect and
 * still strand readiness, and can leave a ref stale that nothing was gating on.
 *
 * A feature-family endpoint is stored as '<harness_slug>#<feature_id>' and matched by its
 * FULL qualified ref, so any change to work_items.harness_slug silently strands every ref
 * naming the old slug: the edge stays form-valid and becomes INERT. Re-home is continuous
 * (the 651/652 pot-membership BEFORE trigger rewrites harness_slug on ordinary writes), so
 * the fix is a seam — an AFTER UPDATE OF harness_slug trigger — not a repair script.
 *
 * This suite is the recurrence guard for the CLASS. It applies the real migration file, so
 * what is under test is the shipping SQL rather than a re-statement of it.
 *
 * The two cases most worth protecting are the ones a naive implementation gets wrong:
 *   • the unscoped match — coord rows live in workspace 'default' while the work item lives
 *     in 'papercusp-workspace'; a workspace-scoped repair silently fixes NOTHING; and
 *   • the collision asymmetry — an edge duplicate is deleted, but a colliding coord_thread
 *     is PRESERVED, because a thread owns posts and deleting it destroys work-item comments.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, applyMigrationForTest, type FreshPgDb } from '../test/_pg-helpers';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../libs/papercusp/libs/db/sql');
/** The work item's own tenant. */
const WS = 'papercusp-workspace';
/** DEFAULT_COORD_WORKSPACE — where the coordination plane actually writes its rows. */
const COORD_WS = 'default';

let db: FreshPgDb;

function reHome(featureId: string, from: string, to: string) {
  return db.sql`UPDATE harness_shared.work_items SET harness_slug = ${to}
                 WHERE feature_id = ${featureId} AND harness_slug = ${from}`;
}

async function srcRefs(): Promise<string[]> {
  const rows = await db.sql<{ src_ref: string }[]>`
    SELECT src_ref FROM harness_shared.coord_links ORDER BY src_ref`;
  return rows.map((r) => r.src_ref);
}

beforeAll(async () => {
  db = await createFreshPgDb('repointrefs');
  const { sql } = db;
  // Only the columns + UNIQUE indexes the migration touches. The unique indexes are not
  // decoration: without them the collision tests cannot fail, and a collision is exactly
  // what would otherwise abort the re-home UPDATE itself.
  await sql.unsafe(`
    CREATE TABLE harness_shared.work_items (
      -- WI-38326: FEATURE_COLS projects these five claim-spec filter columns; a fixture
      -- missing them fails that projection with "column does not exist" (D-014 debt).
      tags jsonb,
      source_plan_slug text,
      source_plan_item_ids text[],
      redundancy integer,
      expected_cost_cents bigint,
      workspace_id text NOT NULL, harness_slug text NOT NULL, feature_id text NOT NULL,
      item_kind text NOT NULL DEFAULT 'bug', status text NOT NULL DEFAULT 'open',
      admission text, admitted_at timestamptz, admitted_by text,
      PRIMARY KEY (harness_slug, feature_id));
    CREATE TABLE harness_shared.coord_links (
      id bigserial PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'default',
      src_kind text NOT NULL, src_ref text NOT NULL,
      dst_kind text NOT NULL, dst_ref text NOT NULL, rel text NOT NULL);
    CREATE UNIQUE INDEX coord_links_edge_uq ON harness_shared.coord_links
      (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel);
    CREATE TABLE harness_shared.work_item_deps (
      id bigserial PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'default',
      blocked_kind text NOT NULL, blocked_ref text NOT NULL,
      blocker_kind text NOT NULL, blocker_ref text NOT NULL, dep_type text NOT NULL);
    CREATE UNIQUE INDEX work_item_deps_edge_uniq ON harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type);
    CREATE TABLE harness_shared.coord_threads (
      workspace_id text NOT NULL DEFAULT 'default', thread_id text NOT NULL,
      parent_kind text NOT NULL, parent_ref text NOT NULL, post_count int NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace_id, thread_id));
    CREATE UNIQUE INDEX coord_threads_parent_uq ON harness_shared.coord_threads
      (workspace_id, parent_kind, parent_ref);`);

  // ── Residue seeded BEFORE the migration: what the one-time backfill must repair ──
  // The item already lives at its NEW slug while the refs still name the OLD one — the
  // exact state migration 649's re-home left behind.
  await sql`INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id) VALUES
    (${WS}, 'oddsmith-hive', 'WI-BACKFILL-1'),
    (${WS}, 'hiveloop-hive', 'WI-AMBIG-1'),
    (${WS}, 'sheets',        'WI-AMBIG-1')`;
  await sql`INSERT INTO harness_shared.coord_links (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel) VALUES
    (${COORD_WS}, 'feature', 'oddsmith#WI-BACKFILL-1', 'plan_item', 'p#P-001', 'implements'),
    (${COORD_WS}, 'feature', 'hiveloop#WI-AMBIG-1',   'plan_item', 'p#P-002', 'implements'),
    (${COORD_WS}, 'feature', 'research-desk#WI-GONE-1','plan_item', 'p#P-003', 'implements')`;
  await sql`INSERT INTO harness_shared.coord_threads (workspace_id, thread_id, parent_kind, parent_ref) VALUES
    (${COORD_WS}, 'T-BACKFILL', 'feature', 'oddsmith#WI-BACKFILL-1')`;

  await applyMigrationForTest(sql, join(SQL_DIR, '734-repoint-qualified-refs-on-rehome.sql'));
});

afterAll(async () => {
  await db?.cleanup();
});

describe('migration 734 — re-point qualified refs on re-home', () => {
  describe('the one-time backfill', () => {
    it('re-points residue whose bare id resolves to exactly one harness', async () => {
      expect(await srcRefs()).toContain('oddsmith-hive#WI-BACKFILL-1');
      expect(await srcRefs()).not.toContain('oddsmith#WI-BACKFILL-1');
    });

    it('repairs coord_threads residue too — not only the edge tables', async () => {
      const [row] = await db.sql<{ parent_ref: string }[]>`
        SELECT parent_ref FROM harness_shared.coord_threads WHERE thread_id = 'T-BACKFILL'`;
      expect(row?.parent_ref).toBe('oddsmith-hive#WI-BACKFILL-1');
    });

    it('LEAVES an ambiguous ref alone (bare id under >1 harness) rather than guessing', async () => {
      // Picking one of several candidate harnesses would invent a dependency that was
      // never declared. Staying stale is reportable; a fabricated edge is not.
      expect(await srcRefs()).toContain('hiveloop#WI-AMBIG-1');
    });

    it('LEAVES a ref that resolves nowhere alone (delete is a different repair)', async () => {
      // id-exists-nowhere ⇒ genuinely stale ⇒ DELETE the edge; id-under-another-slug ⇒
      // wrong qualifier ⇒ RE-POINT. The two look identical and must not be conflated.
      expect(await srcRefs()).toContain('research-desk#WI-GONE-1');
    });
  });

  describe('the trigger (the durable seam)', () => {
    it('re-points src_ref and dst_ref when harness_slug changes', async () => {
      await db.sql`INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id)
                   VALUES (${WS}, 'old-pot', 'WI-T1')`;
      await db.sql`INSERT INTO harness_shared.coord_links (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel) VALUES
        (${COORD_WS}, 'feature', 'old-pot#WI-T1', 'plan_item', 'p#P-010', 'implements'),
        (${COORD_WS}, 'plan_item', 'p#P-011', 'feature', 'old-pot#WI-T1', 'relates')`;

      await reHome('WI-T1', 'old-pot', 'new-pot');

      expect(await srcRefs()).toContain('new-pot#WI-T1');
      const [dst] = await db.sql<{ dst_ref: string }[]>`
        SELECT dst_ref FROM harness_shared.coord_links WHERE rel = 'relates' AND src_ref = 'p#P-011'`;
      expect(dst?.dst_ref).toBe('new-pot#WI-T1');
    });

    it('re-points BOTH work_item_deps sides, keeping a blocks edge live', async () => {
      // This is the case with teeth: an inert blocks edge is a real dependency the claim
      // floor cannot see, so the item advertises as claimable while blocked.
      await db.sql`INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id)
                   VALUES (${WS}, 'old-pot', 'WI-T2')`;
      await db.sql`INSERT INTO harness_shared.work_item_deps
        (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type) VALUES
        (${COORD_WS}, 'feature', 'old-pot#WI-T2', 'feature', 'other#WI-X', 'blocks'),
        (${COORD_WS}, 'feature', 'other#WI-Y', 'feature', 'old-pot#WI-T2', 'blocks')`;

      await reHome('WI-T2', 'old-pot', 'new-pot');

      const rows = await db.sql<{ blocked_ref: string; blocker_ref: string }[]>`
        SELECT blocked_ref, blocker_ref FROM harness_shared.work_item_deps ORDER BY blocked_ref`;
      expect(rows).toEqual([
        { blocked_ref: 'new-pot#WI-T2', blocker_ref: 'other#WI-X' },
        { blocked_ref: 'other#WI-Y', blocker_ref: 'new-pot#WI-T2' },
      ]);
    });

    it('repairs across workspaces — the coord row is in `default`, the item is not', async () => {
      // The regression this pins: scoping the repair by workspace_id looks correct and
      // repairs NOTHING, because the coordination plane writes under DEFAULT_COORD_WORKSPACE
      // while the work item lives in its own tenant. Measured live: 73 of 75 stale refs.
      await db.sql`INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id)
                   VALUES (${WS}, 'old-pot', 'WI-XWS')`;
      await db.sql`INSERT INTO harness_shared.coord_links (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel)
                   VALUES (${COORD_WS}, 'feature', 'old-pot#WI-XWS', 'plan_item', 'p#P-020', 'implements')`;

      await reHome('WI-XWS', 'old-pot', 'new-pot');

      expect(await srcRefs()).toContain('new-pot#WI-XWS');
    });

    it('leaves BARE issue refs and plan_item refs untouched', async () => {
      // Only feature-family endpoints are harness-qualified (D-009 rule 1). Rewriting a
      // bare issue ref would break the issue floor, which matches on the bare id.
      await db.sql`INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id)
                   VALUES (${WS}, 'old-pot', 'WI-BARE')`;
      await db.sql`INSERT INTO harness_shared.coord_links (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel)
                   VALUES (${COORD_WS}, 'issue', 'WI-BARE', 'plan_item', 'p#P-030', 'implements')`;

      await reHome('WI-BARE', 'old-pot', 'new-pot');

      const [row] = await db.sql<{ src_ref: string }[]>`
        SELECT src_ref FROM harness_shared.coord_links WHERE src_kind = 'issue' AND dst_ref = 'p#P-030'`;
      expect(row?.src_ref).toBe('WI-BARE');
    });

    it('resolves an edge collision by dropping the redundant duplicate, not by raising', async () => {
      // A raise here would abort the RE-HOME itself — i.e. one stale ref could start
      // rejecting ordinary work-item writes. An edge carries no payload, so the duplicate
      // is redundant by definition and safe to drop.
      await db.sql`INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id)
                   VALUES (${WS}, 'old-pot', 'WI-DUP')`;
      await db.sql`INSERT INTO harness_shared.coord_links (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel) VALUES
        (${COORD_WS}, 'feature', 'old-pot#WI-DUP', 'plan_item', 'p#P-040', 'implements'),
        (${COORD_WS}, 'feature', 'new-pot#WI-DUP', 'plan_item', 'p#P-040', 'implements')`;

      await expect(reHome('WI-DUP', 'old-pot', 'new-pot')).resolves.toBeDefined();

      const rows = await db.sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM harness_shared.coord_links WHERE dst_ref = 'p#P-040'`;
      expect(rows[0]?.n).toBe('1');
      expect(await srcRefs()).not.toContain('old-pot#WI-DUP');
    });

    it('PRESERVES a colliding coord_thread — never trades comment loss for a tidy ref', async () => {
      // The asymmetry that matters: a thread owns posts. If a thread already sits at the
      // new ref, the stale one is left in place with its posts rather than deleted.
      await db.sql`INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id)
                   VALUES (${WS}, 'old-pot', 'WI-THREAD')`;
      await db.sql`INSERT INTO harness_shared.coord_threads (workspace_id, thread_id, parent_kind, parent_ref, post_count) VALUES
        (${COORD_WS}, 'T-STALE',  'feature', 'old-pot#WI-THREAD', 7),
        (${COORD_WS}, 'T-TARGET', 'feature', 'new-pot#WI-THREAD', 2)`;

      await expect(reHome('WI-THREAD', 'old-pot', 'new-pot')).resolves.toBeDefined();

      const [stale] = await db.sql<{ parent_ref: string; post_count: number }[]>`
        SELECT parent_ref, post_count FROM harness_shared.coord_threads WHERE thread_id = 'T-STALE'`;
      expect(stale).toBeDefined();
      expect(stale?.post_count).toBe(7);
      expect(stale?.parent_ref).toBe('old-pot#WI-THREAD');
    });

    it('is a no-op for an UPDATE that does not change harness_slug', async () => {
      await db.sql`INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id)
                   VALUES (${WS}, 'stay-pot', 'WI-NOOP')`;
      await db.sql`INSERT INTO harness_shared.coord_links (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel)
                   VALUES (${COORD_WS}, 'feature', 'stay-pot#WI-NOOP', 'plan_item', 'p#P-050', 'implements')`;

      await db.sql`UPDATE harness_shared.work_items SET status = 'done' WHERE feature_id = 'WI-NOOP'`;

      expect(await srcRefs()).toContain('stay-pot#WI-NOOP');
    });
  });
});
