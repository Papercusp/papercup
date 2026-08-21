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
import {
  COORD_REF_HOLDERS_DDL,
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
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
  await db.sql.unsafe(COORD_REF_HOLDERS_DDL).simple();
}, 90_000);
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps,
                        harness_shared.coord_links, harness_shared.coord_threads RESTART IDENTITY`;
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

/** A coord_links row — the AUTHORITATIVE store that work_item_deps mirrors. */
const link = (srcKind: string, srcRef: string, dstKind: string, dstRef: string, rel = 'implements') =>
  db.sql`
  INSERT INTO harness_shared.coord_links (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel)
  VALUES (${WS}, ${srcKind}, ${srcRef}, ${dstKind}, ${dstRef}, ${rel})`;

/** A coord_threads row — a work item's comment thread, parented by a qualified/bare ref. */
const thread = (threadId: string, parentKind: string, parentRef: string) => db.sql`
  INSERT INTO harness_shared.coord_threads (workspace_id, thread_id, parent_kind, parent_ref)
  VALUES (${WS}, ${threadId}, ${parentKind}, ${parentRef})`;

// @covers INV-01 INV-02 INV-12 INV-13
// INV-12 needs BOTH halves and gets them: 'reports ZERO defects for correctly-written edges'
// is the silent-on-clean control without which every FIRES case below proves nothing.
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

  it('names the relation + row_id so a finding is repairable, not merely countable', async () => {
    // The audit that found the live rows had to re-derive which rows to fix. A detector that
    // reports only counts recreates that work every time it fires.
    // The RELATION is half the answer now that three are swept: it decides the repair.
    // A work_item_deps row is the MIRROR (re-run the writer); a coord_links row is the
    // AUTHORITATIVE source (re-running the writer just reproduces the bad ref).
    await seedIssue('WI-1');
    await seedIssue('WI-2');
    await edge('feature', `${H}#WI-1`, 'issue', 'WI-2');

    const [{ id }] = await db.sql<{ id: string }[]>`
      SELECT id::text AS id FROM harness_shared.work_item_deps LIMIT 1`;
    const res = await reconcileWorkItemDepEndpoints(db.sql);
    expect(res.mismatched.map((d) => [d.relation, d.row_id])).toEqual([['work_item_deps', id]]);
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

/**
 * EI-19376392851673381 — the sweep used to read `work_item_deps` ALONE, which is the mirror.
 * Every test below leaves work_item_deps EMPTY on purpose: under the old detector each one
 * scored a clean defects=0, which is exactly how 32 stale refs stayed live under a green
 * verdict. If a future change narrows the sweep back to one relation, these fail.
 */
// @covers INV-03 INV-13
describe('reconcileWorkItemDepEndpoints — coverage of the AUTHORITATIVE ref-holders', () => {
  it('CATCHES a stale harness qualifier in coord_links, which the mirror never shows', async () => {
    // The live shape: the item was re-homed to another pot and the ref kept the old slug.
    // work_item_deps is empty, so this is precisely the defect the old sweep could not see.
    await seedFeature('F-1');
    await link('feature', `old-pot#F-1`, 'plan_item', 'p#P-001');

    const res = await reconcileWorkItemDepEndpoints(db.sql);
    expect(res.dangling).toHaveLength(1);
    expect(res.dangling[0]).toMatchObject({
      relation: 'coord_links',
      side: 'src',
      ref: 'old-pot#F-1',
      // The repair-deciding field: the id EXISTS elsewhere ⇒ RE-POINT, never delete.
      bare_id_found_in: H,
    });
  });

  it('CATCHES a stale ref in coord_threads — an orphaned comment thread', async () => {
    // Since work-item mail was retired (WI-6097), durable work-item direction IS thread
    // posts, so this silently detaches an item's comments from the item.
    await seedFeature('F-1');
    await thread('T-1', 'feature', 'old-pot#F-1');

    const res = await reconcileWorkItemDepEndpoints(db.sql);
    expect(res.dangling).toHaveLength(1);
    expect(res.dangling[0]).toMatchObject({
      relation: 'coord_threads',
      side: 'parent',
      // coord_threads has no surrogate id — the row is addressed by thread_id.
      row_id: 'T-1',
    });
  });

  it('distinguishes a stale ref from a wrong qualifier, the two OPPOSITE repairs', async () => {
    // Same symptom ("resolves to nothing"), different repair: delete vs re-point. Reporting
    // them identically invites exactly the wrong one.
    await seedFeature('F-1');
    await link('feature', 'old-pot#F-1', 'plan_item', 'p#P-001'); // wrong qualifier ⇒ re-point
    await link('feature', `${H}#F-GONE`, 'plan_item', 'p#P-002'); // exists nowhere  ⇒ delete

    const res = await reconcileWorkItemDepEndpoints(db.sql);
    const byRef = Object.fromEntries(res.dangling.map((d) => [d.ref, d.bare_id_found_in]));
    expect(byRef['old-pot#F-1']).toBe(H);
    expect(byRef[`${H}#F-GONE`]).toBeNull();
  });

  it('IGNORES plan_item endpoints — they use a different ref grammar', async () => {
    // coord_links also stores '<planSlug>#P-NNN'. Feeding those to a work-item oracle would
    // report every plan link in the system as dangling — a detector that cries wolf on its
    // own healthy rows is worse than no detector.
    await seedFeature('F-1');
    await link('plan_item', 'some-plan#P-001', 'plan_item', 'some-plan#P-002', 'relates');
    await link('topic', 'coord-dx', 'plan_item', 'some-plan#P-003', 'relates');

    expect((await reconcileWorkItemDepEndpoints(db.sql)).defects).toBe(0);
  });

  it('reports ZERO across all three relations when every ref is correct', async () => {
    // The control. Without it, the CATCHes above are consistent with a detector that simply
    // flags everything in the two newly-swept tables.
    await seedFeature('F-1');
    await seedIssue('WI-1');
    await link('feature', `${H}#F-1`, 'plan_item', 'p#P-001');
    await link('issue', 'WI-1', 'plan_item', 'p#P-002');
    await thread('T-1', 'feature', `${H}#F-1`);
    await thread('T-2', 'issue', 'WI-1');
    await edge('feature', `${H}#F-1`, 'issue', 'WI-1');

    expect(await reconcileWorkItemDepEndpoints(db.sql)).toMatchObject({
      defects: 0,
      mismatched: [],
      dangling: [],
    });
  });
});
