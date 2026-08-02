/**
 * work-item-deps-integrity.integration.test.ts — the CONTINUOUS detector for D-017's
 * inert-edge class (work-item-dependency-edges-2026-08-02, EI-19325959789634791 step 2).
 *
 * D-017: a `work_item_deps` endpoint can declare a `*_kind` that disagrees with the family
 * of the row it resolves to. Such an edge is FORM-valid, correctly mirrored, acyclic — and
 * gates NOTHING, because the issue floor matches a BARE ref while the writer emitted the
 * harness-qualified feature convention. It passed three green row-shape checks.
 *
 * ⚠ THE TEST BAR HERE IS D-019, AND IT IS THE WHOLE POINT: every test must assert the
 * detector CATCHES a SEEDED bad row. A detector exercised only against clean data proves
 * nothing — and papercusp's live rows were REPAIRED on 2026-08-02, so a clean live run is
 * now guaranteed to return 0 whether the detector works or not. That is exactly the
 * audit-that-rots this module replaces, so the bad rows are seeded here explicitly.
 *
 * Real Postgres (testcontainer; Docker required).
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/work-item-deps-integrity.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { reconcileWorkItemDepEndpoints } = await import('./work-item-deps-integrity');

const WS = 'default';
const H = 'papercup';
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('work-item-deps-integrity');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
}, 90_000);
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps RESTART IDENTITY`;
});

/** A FEATURE-family row. Its endpoint form is harness-QUALIFIED (`<harness>#<id>`). */
const seedFeature = (id: string) => db.sql`
  INSERT INTO harness_shared.work_items
    (harness_slug, feature_id, title, status, item_kind, workspace_id, created_ts, updated_ts)
  VALUES (${H}, ${id}, ${`feature ${id}`}, 'open', 'feature', ${WS}, 0, 0)`;

/** An ISSUE-family row (kind 'task'). Its endpoint form is BARE. */
const seedIssue = (id: string) => db.sql`
  INSERT INTO harness_shared.work_items
    (harness_slug, feature_id, title, status, item_kind, workspace_id, created_ts, updated_ts)
  VALUES (${H}, ${id}, ${`issue ${id}`}, 'open', 'task', ${WS}, 0, 0)`;

/** Write an edge with EXACTLY the given endpoint kinds/refs — including invalid ones. */
const edge = (
  blockedKind: string,
  blockedRef: string,
  blockerKind: string,
  blockerRef: string,
) => db.sql`
  INSERT INTO harness_shared.work_item_deps
    (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
  VALUES (${WS}, ${blockedKind}, ${blockedRef}, ${blockerKind}, ${blockerRef}, 'blocks')`;

describe('reconcileWorkItemDepEndpoints — the D-017 endpoint-integrity detector', () => {
  it('reports ZERO defects for correctly-written edges of BOTH families', async () => {
    // The baseline. Asserted first so a later CATCH result is attributable to the seeded
    // defect rather than to the detector simply flagging everything it sees.
    await seedFeature('F-1');
    await seedFeature('F-2');
    await seedIssue('WI-1');
    await seedIssue('WI-2');
    await edge('feature', `${H}#F-1`, 'feature', `${H}#F-2`); // qualified, as features must be
    await edge('issue', 'WI-1', 'issue', 'WI-2'); //             bare, as issues must be

    expect(await reconcileWorkItemDepEndpoints(db.sql)).toMatchObject({
      defects: 0,
      mismatched: [],
      dangling: [],
    });
  });

  it('CATCHES the exact live D-017 shape: an issue-family item written with the FEATURE convention', async () => {
    // This is the row that shipped 6 times past count-matching, mirror-symmetry and
    // acyclicity checks. Both endpoints resolve to ISSUE-family rows, but the edge declares
    // feature + harness-qualified refs, so the issue floor (which matches BARE) cannot see
    // it and the item is served while blocked.
    await seedIssue('WI-blocked');
    await seedIssue('WI-blocker');
    await edge('feature', `${H}#WI-blocked`, 'feature', `${H}#WI-blocker`);

    const res = await reconcileWorkItemDepEndpoints(db.sql);
    expect(res.dangling).toEqual([]);
    expect(res.defects).toBe(2); // both endpoints are wrong, and both are reported
    expect(res.mismatched).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          side: 'blocked',
          declared_kind: 'feature',
          ref: `${H}#WI-blocked`,
          expected_kind: 'issue',
        }),
        expect.objectContaining({
          side: 'blocker',
          declared_kind: 'feature',
          ref: `${H}#WI-blocker`,
          expected_kind: 'issue',
        }),
      ]),
    );
  });

  it('CATCHES the RIGHT kind in the WRONG ref FORM — form is half the invariant', async () => {
    // kind='issue' is correct here, so a detector that only compared kinds would pass this.
    // But the ref is harness-qualified, and the floor matches `d.blocked_ref = wi.feature_id`
    // BARE — so this edge is just as inert as the one above.
    await seedIssue('WI-1');
    await seedIssue('WI-2');
    await edge('issue', `${H}#WI-1`, 'issue', 'WI-2');

    const res = await reconcileWorkItemDepEndpoints(db.sql);
    expect(res.defects).toBe(1);
    expect(res.mismatched[0]).toMatchObject({
      side: 'blocked',
      declared_kind: 'issue',
      ref: `${H}#WI-1`,
      expected_kind: 'issue', // kind already correct — the FORM is what is wrong
    });
  });

  it('CATCHES the mirror case: a FEATURE-family item written with the issue convention', async () => {
    await seedFeature('F-1');
    await seedFeature('F-2');
    await edge('issue', 'F-1', 'feature', `${H}#F-2`);

    const res = await reconcileWorkItemDepEndpoints(db.sql);
    expect(res.defects).toBe(1);
    expect(res.mismatched[0]).toMatchObject({
      side: 'blocked',
      declared_kind: 'issue',
      ref: 'F-1',
      expected_kind: 'feature',
    });
  });

  it('reports a DANGLING endpoint separately from a mismatch, with expected_kind null', async () => {
    // Kept out of `mismatched` on purpose: the writer deliberately tolerates an absent
    // blocker (resolveDepEndpoint falls back to the feature form so an edge naming a
    // not-yet-created item stays writable). So this is a data-hygiene finding, repaired by
    // DELETING the edge — never by rewriting its kind, which is what conflating the two
    // lists would invite.
    await seedIssue('WI-1');
    await edge('issue', 'WI-1', 'feature', `${H}#F-does-not-exist`);

    const res = await reconcileWorkItemDepEndpoints(db.sql);
    expect(res.mismatched).toEqual([]);
    expect(res.defects).toBe(1);
    expect(res.dangling[0]).toMatchObject({
      side: 'blocker',
      ref: `${H}#F-does-not-exist`,
      expected_kind: null,
      bare_id_found_in: null, // exists nowhere ⇒ genuinely stale ⇒ delete the edge
    });
  });

  it('distinguishes a WRONG HARNESS QUALIFIER from a genuinely stale ref — the repair depends on it', async () => {
    // The live 2026-08-02 shape: 8 edges referenced `papercusp-public-site#WI-54xx` while
    // every one of those items existed under `papercusp-public-site-pot`. Both cases surface
    // as "does not resolve", but the repairs are OPPOSITE — delete the edge vs. re-point it —
    // so reporting them identically invites silently discarding a live dependency.
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, title, status, item_kind, workspace_id, created_ts, updated_ts)
      VALUES ('other-pot', 'F-elsewhere', 'lives in another harness', 'open', 'feature', ${WS}, 0, 0)`;
    await seedFeature('F-1');
    await edge('feature', `${H}#F-1`, 'feature', `${H}#F-elsewhere`);

    const res = await reconcileWorkItemDepEndpoints(db.sql);
    expect(res.defects).toBe(1);
    expect(res.dangling[0]).toMatchObject({
      side: 'blocker',
      ref: `${H}#F-elsewhere`,
      expected_kind: null,
      bare_id_found_in: 'other-pot', // ⇒ the qualifier is wrong; re-point, do not delete
    });
  });

  it('names the edge_id so a finding is repairable, not merely countable', async () => {
    // The audit that found the live rows had to re-derive which rows to fix. A detector that
    // reports only counts recreates that work every time it fires.
    await seedIssue('WI-1');
    await seedIssue('WI-2');
    await edge('feature', `${H}#WI-1`, 'issue', 'WI-2');

    const [{ id }] = await db.sql<{ id: string }[]>`
      SELECT id::text AS id FROM harness_shared.work_item_deps LIMIT 1`;
    const res = await reconcileWorkItemDepEndpoints(db.sql);
    expect(res.mismatched.map((d) => d.edge_id)).toEqual([id]);
  });

  it('is not confused by a harness slug containing a "#" — the id is split on the LAST one', async () => {
    // Guards the ref-splitting itself. A slug with '#' would otherwise truncate the id and
    // make a perfectly good feature endpoint look dangling.
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, title, status, item_kind, workspace_id, created_ts, updated_ts)
      VALUES ('od#d', 'F-9', 'odd harness', 'open', 'feature', ${WS}, 0, 0)`;
    await seedFeature('F-2');
    await edge('feature', 'od#d#F-9', 'feature', `${H}#F-2`);

    expect((await reconcileWorkItemDepEndpoints(db.sql)).defects).toBe(0);
  });
});
