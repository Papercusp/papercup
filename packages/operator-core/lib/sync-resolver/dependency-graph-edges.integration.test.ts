/**
 * dependency-graph-edges.integration.test.ts — the graph pane's edge seam, against real SQL.
 *
 * Plan: dependency-health-pane-2026-08-02 (P-003).
 *
 * WHY INTEGRATION AND NOT A UNIT TEST. Every property worth asserting here is a property of a
 * JOIN — specifically of endpoint resolution, where the ref FORM depends on the family of the
 * row being pointed at. A mock would encode the author's belief about that convention, which
 * is the belief under test, and it is precisely the belief the D-017 incident proved wrong in
 * production: six edges that were form-valid, mirrored and acyclic, and joined nothing.
 *
 * ⚠ THE FIXTURE MUST NOT RESTATE THE CONVENTION. `canonicalRef` (dependency-fixture.ts) encodes
 * INV-01, so building a row with it and asserting the row matches it proves only that a pure
 * function agrees with itself. The refs below are therefore written LITERALLY — 'papercup#F-1'
 * and a bare 'EI-1' — so a test failure means the RESOLVER disagrees with the stored
 * convention, not that two copies of my own belief disagree.
 *
 * Real Postgres (testcontainer; Docker required).
 *
 * Run:
 *   npm run test:file -- packages/operator-core/lib/sync-resolver/dependency-graph-edges.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';
import { resolveDependencyGraphEdges, DEP_EDGES_MAX_LIMIT } from './dependency-graph-edges';

const WS = 'papercusp-workspace';
const H = 'papercup';
/** The coordination workspace every edge row lives in — NOT the item workspace. */
const COORD = 'default';

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('dependency-graph-edges');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
}, 180_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
});

/** `kind` is a REAL item_kind value — the engine derives family from it, never from a name. */
async function item(
  id: string,
  kind: 'feature' | 'bug' | 'change' | 'task',
  opts: { status?: string; harness?: string; workspace?: string; planSlug?: string } = {},
): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, title, status, item_kind, workspace_id, taken_by, created_ts, updated_ts, payload,
       source_plan_slug)
    VALUES (${opts.harness ?? H}, ${id}, ${`item ${id}`}, ${opts.status ?? 'open'}, ${kind},
            ${opts.workspace ?? WS}, NULL, 0, 0, '{}'::jsonb,
            ${opts.planSlug ?? null})`;
}

/** Refs are written LITERALLY — see the header's note on not restating the convention. */
async function edge(
  blockedKind: 'feature' | 'issue',
  blockedRef: string,
  blockerKind: 'feature' | 'issue',
  blockerRef: string,
  workspace = COORD,
): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${workspace}, ${blockedKind}, ${blockedRef}, ${blockerKind}, ${blockerRef}, 'blocks')`;
}

const edges = () => resolveDependencyGraphEdges(db.sql, { workspaceId: WS, harnessSlug: H });

describe('resolveDependencyGraphEdges — family-aware endpoint resolution', () => {
  it('resolves a FEATURE endpoint by its harness-QUALIFIED ref', async () => {
    await item('F-1', 'feature');
    await item('F-2', 'feature');
    await edge('feature', `${H}#F-1`, 'feature', `${H}#F-2`);

    expect(await edges()).toEqual([
      expect.objectContaining({ blockedId: 'F-1', blockerId: 'F-2', blockedKind: 'feature', blockerKind: 'feature' }),
    ]);
  });

  it('resolves an ISSUE endpoint by its BARE ref', async () => {
    await item('EI-1', 'bug');
    await item('EI-2', 'task');
    await edge('issue', 'EI-1', 'issue', 'EI-2');

    expect(await edges()).toEqual([
      expect.objectContaining({ blockedId: 'EI-1', blockerId: 'EI-2', blockedKind: 'bug', blockerKind: 'task' }),
    ]);
  });

  // THE D-017 CASE. A join matching only one ref form drops every mixed-family edge, and
  // mixed-family is the common shape in real data — a feature blocked by a bug.
  it('resolves MIXED-family edges in BOTH directions — the D-017 shape', async () => {
    await item('F-1', 'feature');
    await item('EI-1', 'bug');
    await edge('feature', `${H}#F-1`, 'issue', 'EI-1'); // feature blocked BY an issue
    await edge('issue', 'EI-1', 'feature', `${H}#F-1`); // …and the reverse

    const got = await edges();
    expect(got).toHaveLength(2);
    expect(got).toContainEqual(expect.objectContaining({ blockedId: 'F-1', blockerId: 'EI-1' }));
    expect(got).toContainEqual(expect.objectContaining({ blockedId: 'EI-1', blockerId: 'F-1' }));
  });

  // NEGATIVE CONTROL for the two above: had the resolver matched refs family-BLIND (e.g. bare
  // on both sides), THIS row would resolve — and it must not. Without it, the passing tests
  // above are also satisfied by a resolver that ignores the convention entirely.
  it('does NOT resolve a feature endpoint written in the BARE (issue) form', async () => {
    await item('F-1', 'feature');
    await item('F-2', 'feature');
    await edge('feature', 'F-1', 'feature', 'F-2'); // both bare — wrong form for features

    expect(await edges()).toEqual([]);
  });
});

describe('resolveDependencyGraphEdges — what it deliberately KEEPS', () => {
  // An INNER join on the blocker would hide exactly the broken edges the integrity mode exists
  // to show. `blockerId: null` is the UI's handle on a dangling ref (INV-13).
  it('RETURNS a dangling edge with blockerId null rather than dropping it', async () => {
    await item('F-1', 'feature');
    await edge('feature', `${H}#F-1`, 'issue', 'EI-does-not-exist');

    expect(await edges()).toEqual([
      expect.objectContaining({ blockedId: 'F-1', blockerId: null, blockerRef: 'EI-does-not-exist' }),
    ]);
  });

  /**
   * WI-36045 — the endpoint fields that make an edge drawable without the list's window.
   *
   * These are not cosmetic: `workItems.byHarness` is a 500-row recency window over ~48k rows,
   * so before these columns existed the pane discarded 78 of 79 real papercusp edges and drew
   * 2 nodes. The graph builds a NODE from these values, so a null here is a blank node.
   */
  it('carries the BLOCKED endpoint fields so a node can be built without the list page', async () => {
    await item('F-1', 'feature', { status: 'open', planSlug: 'my-plan' });
    await item('F-2', 'feature');
    await edge('feature', `${H}#F-1`, 'feature', `${H}#F-2`);

    expect((await edges())[0]).toMatchObject({
      blockedId: 'F-1',
      blockedTitle: 'item F-1',
      blockedStatus: 'open',
      blockedPlanSlug: 'my-plan',
    });
  });

  it('carries the BLOCKER endpoint fields too — the failure was symmetric', async () => {
    await item('F-1', 'feature');
    await item('F-2', 'feature', { status: 'done', planSlug: 'blocker-plan' });
    await edge('feature', `${H}#F-1`, 'feature', `${H}#F-2`);

    expect((await edges())[0]).toMatchObject({
      blockerId: 'F-2',
      blockerTitle: 'item F-2',
      blockerPlanSlug: 'blocker-plan',
    });
  });

  it('leaves the blocker endpoint fields NULL for a dangling edge, without dropping it', async () => {
    // A dangling edge has no blocker row to project from, and that must stay distinguishable
    // from a hydrated one: the UI draws the first as a BREAK and the second as a real item.
    await item('F-1', 'feature');
    await edge('feature', `${H}#F-1`, 'feature', `${H}#GONE`);

    const [row] = await edges();
    expect(row).toMatchObject({ blockerId: null, blockerTitle: null, blockerPlanSlug: null });
    // The BLOCKED side still hydrates — the edge is renderable as a break off a real node.
    expect(row?.blockedTitle).toBe('item F-1');
  });

  it('reports a NULL plan slug as null, not the string "null"', async () => {
    // The graph branches on truthiness to draw the plan marker, so a stringified null would
    // mark every non-plan item as plan-derived.
    await item('F-1', 'feature');
    await item('F-2', 'feature');
    await edge('feature', `${H}#F-1`, 'feature', `${H}#F-2`);

    const [row] = await edges();
    expect(row?.blockedPlanSlug).toBeNull();
    expect(row?.blockerPlanSlug).toBeNull();
  });

  it('carries the blocker STATUS so the UI can grey out an already-satisfied edge', async () => {
    await item('F-1', 'feature');
    await item('F-2', 'feature', { status: 'done' });
    await edge('feature', `${H}#F-1`, 'feature', `${H}#F-2`);

    expect((await edges())[0]).toMatchObject({ blockerId: 'F-2', blockerStatus: 'done' });
  });
});

describe('resolveDependencyGraphEdges — scoping', () => {
  // The single most dangerous thing to get wrong here (migration 719's own warning): the EDGE
  // table is keyed in the coordination workspace, the ITEMS are not. Scoping the edge lookup to
  // the item workspace "would match zero rows and disable blocking entirely".
  it('reads edges from the COORDINATION workspace while scoping items to the caller workspace', async () => {
    await item('F-1', 'feature'); // in WS ('papercusp-workspace')
    await item('F-2', 'feature');
    await edge('feature', `${H}#F-1`, 'feature', `${H}#F-2`, COORD); // edge in 'default'

    expect(await edges()).toHaveLength(1);
  });

  it('ignores an edge row written under the WRONG (item) workspace — the inert class', async () => {
    await item('F-1', 'feature');
    await item('F-2', 'feature');
    await edge('feature', `${H}#F-1`, 'feature', `${H}#F-2`, WS); // edge misfiled in the item ws

    expect(await edges()).toEqual([]);
  });

  it('excludes an edge whose BLOCKED item belongs to another harness', async () => {
    await item('F-1', 'feature', { harness: 'other-pot' });
    await item('F-2', 'feature');
    await edge('feature', 'other-pot#F-1', 'feature', `${H}#F-2`);

    expect(await edges()).toEqual([]);
  });

  it('ignores a non-blocks dep_type', async () => {
    await item('F-1', 'feature');
    await item('F-2', 'feature');
    await db.sql`
      INSERT INTO harness_shared.work_item_deps
        (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
      VALUES (${COORD}, 'feature', ${`${H}#F-1`}, 'feature', ${`${H}#F-2`}, 'relates')`;

    expect(await edges()).toEqual([]);
  });
});

describe('resolveDependencyGraphEdges — the limit CLAMPS rather than rejecting', () => {
  // A hard reject turns a client/server version skew into a panel-breaking error; the pane must
  // degrade instead. Same contract as workItems.byHarness.
  it('clamps an over-large limit to the cap instead of throwing', async () => {
    await item('F-1', 'feature');
    await item('F-2', 'feature');
    await edge('feature', `${H}#F-1`, 'feature', `${H}#F-2`);

    const got = await resolveDependencyGraphEdges(db.sql, {
      workspaceId: WS,
      harnessSlug: H,
      limit: DEP_EDGES_MAX_LIMIT * 100,
    });
    expect(got).toHaveLength(1);
  });

  it('honours a small limit', async () => {
    await item('F-1', 'feature');
    await item('F-2', 'feature');
    await item('F-3', 'feature');
    await edge('feature', `${H}#F-1`, 'feature', `${H}#F-2`);
    await edge('feature', `${H}#F-1`, 'feature', `${H}#F-3`);

    expect(
      await resolveDependencyGraphEdges(db.sql, { workspaceId: WS, harnessSlug: H, limit: 1 }),
    ).toHaveLength(1);
  });
});

describe('resolveDependencyGraphEdges — endpoint lookup stays indexed at production scale', () => {
  it('resolves 1,000 edges inside a 20k-item harness under a 750ms database deadline', async () => {
    // WI-42428: the old blocker LEFT JOIN had no indexed feature_id equality. Postgres
    // therefore materialized the whole harness and evaluated the family-aware OR as a
    // join filter for EVERY edge: ~20m row comparisons for this fixture (and ~123m
    // in the 114k-item / 1,082-edge live shape that hit the resolver's 10s timeout).
    //
    // One set-based insert keeps the fixture cheap. The DB-side deadline is the guard:
    // it measures the SQL statement itself (not a scheduler-dependent JS stopwatch) and
    // leaves ample headroom for the indexed plan, which performs two identity lookups per
    // edge while preserving the exact family-aware ref check.
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, title, status, item_kind, workspace_id, taken_by,
         created_ts, updated_ts, payload)
      SELECT ${H},
             'PERF-' || lpad(g::text, 6, '0'),
             'performance fixture ' || g::text,
             'open',
             'bug',
             ${WS},
             NULL,
             0,
             0,
             '{}'::jsonb
        FROM generate_series(1, 20000) AS g`;

    await db.sql`
      INSERT INTO harness_shared.work_item_deps
        (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
      SELECT ${COORD},
             'issue',
             'PERF-' || lpad(g::text, 6, '0'),
             'issue',
             'PERF-' || lpad((g + 10000)::text, 6, '0'),
             'blocks'
        FROM generate_series(1, 1000) AS g`;

    const got = await db.sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = '750ms'`);
      return resolveDependencyGraphEdges(tx as unknown as typeof db.sql, {
        workspaceId: WS,
        harnessSlug: H,
      });
    });

    expect(got).toHaveLength(1000);
    expect(got[0]).toMatchObject({ blockedId: 'PERF-000001', blockerId: 'PERF-010001' });
  }, 60_000);
});
