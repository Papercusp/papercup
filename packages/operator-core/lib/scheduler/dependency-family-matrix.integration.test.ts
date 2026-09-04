/**
 * dependency-family-matrix.integration.test.ts — all four blocked×blocker family
 * combinations, each routed through the door that actually governs it.
 *
 * Plan: dependency-subsystem-thorough-testing-2026-08-02 (P-007).
 * @covers INV-01 INV-02 INV-04 INV-05
 *
 * WHY THIS FILE EXISTS. D-017's escape was an ASYMMETRY, not an outage.
 * `syncFeatureBlockEdges` was genuinely authoritative for the feature family and
 * silently wrote inert edges for the issue family — a qualifier that was true of the
 * code and stated nowhere. Tests that exercised one family were structurally incapable
 * of seeing it, and tests that asserted a single global ref form would have "fixed" it
 * in the wrong direction: unifying the BLOCKED-side ref form over-gates the feature
 * family, which is D-007's recorded retraction. So family is not a parameter to sweep
 * for completeness here; it is the axis the bug lived on.
 *
 * ⚠ THE TWO DOORS (plan D-002). Readiness is enforced by DIFFERENT SQL per family, and
 * asserting the wrong one manufactures a false regression:
 *
 *   feature-family blocked item -> harness_shared.work_item_is_blocked(...), whose
 *     blocked leg matches `blocked_ref = p_harness || '#' || p_feature` (qualified).
 *   issue-family blocked item   -> depsBlockedExclusionSql() in work-items.ts, whose
 *     blocked leg matches `d.blocked_ref = wi.feature_id` (bare).
 *
 * That split is deliberate and documented at unsatisfiedBlockerSql: "the BLOCKED-side
 * ref form stays per-family ... unifying that would over-gate the feature family. Only
 * the BLOCKER side is shared."
 *
 * ⚠ THE ISSUE DOOR IS IMPORTED, NEVER RE-IMPLEMENTED. Inlining that predicate here
 * would create the seventh copy of the blocking floor that D-007 exists to prevent —
 * and blocking-floor-single-source.test.ts would (correctly) fail this file for it. A
 * test that re-states the floor cannot detect the floor drifting.
 *
 * Real Postgres (testcontainer; Docker required).
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/dependency-family-matrix.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  USER_TRUST_LIST_DDL,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';
import { defineScenario, seedScenario, type Family } from '../testing/dependency-fixture';
import { WIDE_TRIGGER_DDL } from './dependency-trigger-fixture';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l) && !/\bGRANT\b/.test(l) && !/^\s*(BEGIN|COMMIT);\s*$/.test(l))
    .join('\n');

// Keep work-items.ts safe to import at module load and point its getOrgPg() at the
// throwaway test db (same pattern as claim-respects-blocking.integration.test.ts).
const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const WS = 'papercusp-workspace'; // deliberately NOT 'default' — see P-006 / INV-11
const H = 'papercusp';

const { depsBlockedExclusionSql } = await import('../work-items');

let db: FreshPgDb;

/** FEATURE-family door: the migration-719 oracle. */
async function featureDoorBlocked(id: string): Promise<boolean> {
  const rows = (await db.sql`
    SELECT harness_shared.work_item_is_blocked(${H}, ${id}, ${WS}) AS blocked`) as unknown as Array<{
    blocked: boolean;
  }>;
  return rows[0]!.blocked === true;
}

/**
 * ISSUE-family door: the REAL floor fragment, imported and embedded exactly as the claim
 * path embeds it. The fragment is written as "NOT blocked" (a NOT EXISTS exclusion), so
 * the verdict is its negation.
 */
async function issueDoorBlocked(id: string): Promise<boolean> {
  const rows = (await db.sql`
    SELECT NOT (${depsBlockedExclusionSql(db.sql as never)}) AS blocked
      FROM harness_shared.work_items wi
     WHERE wi.workspace_id = ${WS} AND wi.harness_slug = ${H} AND wi.feature_id = ${id}`) as unknown as Array<{
    blocked: boolean;
  }>;
  // A missing row would silently return no rows and read as "not blocked" — fail loudly.
  if (rows.length !== 1) throw new Error(`issueDoorBlocked: expected 1 row for '${id}', got ${rows.length}`);
  return rows[0]!.blocked === true;
}

/** Route to the door that actually governs this family (D-002). */
const doorFor = (family: Family) => (family === 'feature' ? featureDoorBlocked : issueDoorBlocked);

beforeAll(async () => {
  db = await createFreshPgDb('dependency-family-matrix');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql.unsafe(readMigration('379-maintained-ready-column.sql')).simple();
  await db.sql.unsafe(WIDE_TRIGGER_DDL).simple();
  await db.sql.unsafe(readMigration('719-fix-work-item-is-blocked-workspace-scope.sql')).simple();
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps, harness_shared.work_item_blocked`;
});

/**
 * The four combinations. 'done' is the terminal state deliberately: it is terminal in
 * BOTH family vocabularies (feature = passed/deprecated/done/dropped, issue =
 * resolved/closed/done/dropped), so a release assertion cannot pass merely because the
 * test picked the vocabulary the code happens to check.
 */
const COMBOS: ReadonlyArray<{ blocked: Family; blocker: Family }> = [
  { blocked: 'feature', blocker: 'feature' },
  { blocked: 'feature', blocker: 'issue' },
  { blocked: 'issue', blocker: 'feature' },
  { blocked: 'issue', blocker: 'issue' },
];

const idFor = (family: Family, role: string) => (family === 'feature' ? `F-${role}` : `EI-${role}`);

function pairScenario(blocked: Family, blocker: Family, blockerStatus: string) {
  return defineScenario({
    workspace: WS,
    harness: H,
    items: [
      { id: idFor(blocked, 'blocked'), family: blocked, status: 'open' },
      { id: idFor(blocker, 'blocker'), family: blocker, status: blockerStatus },
    ],
    edges: [{ blocked: idFor(blocked, 'blocked'), blocker: idFor(blocker, 'blocker') }],
  });
}

describe('family matrix — every blocked×blocker combination gates, through its own door (P-007)', () => {
  for (const { blocked, blocker } of COMBOS) {
    const name = `${blocked} blocked-by ${blocker}`;
    const blockedId = idFor(blocked, 'blocked');
    const blockerId = idFor(blocker, 'blocker');
    const isBlocked = doorFor(blocked);

    it(`${name}: a live blocker WITHHOLDS the item`, async () => {
      await seedScenario(db.sql as never, pairScenario(blocked, blocker, 'open'));
      // The positive control. Three of these four combinations were inert in production
      // and every row-shape check reported them healthy.
      expect(await isBlocked(blockedId)).toBe(true);
    });

    it(`${name}: the item is RELEASED once the blocker is terminal`, async () => {
      await seedScenario(db.sql as never, pairScenario(blocked, blocker, 'open'));
      expect(await isBlocked(blockedId)).toBe(true);

      await db.sql`
        UPDATE harness_shared.work_items SET status='done'
         WHERE workspace_id=${WS} AND harness_slug=${H} AND feature_id=${blockerId}`;

      expect(await isBlocked(blockedId)).toBe(false);
    });

    it(`${name}: with NO edge at all the item is claimable — the silent-on-clean half`, async () => {
      await seedScenario(
        db.sql as never,
        defineScenario({
          workspace: WS,
          harness: H,
          items: [
            { id: blockedId, family: blocked, status: 'open' },
            { id: blockerId, family: blocker, status: 'open' },
          ],
          edges: [],
        }),
      );
      expect(await isBlocked(blockedId)).toBe(false);
    });
  }
});

describe('family matrix — a MALFORMED edge gates nothing, per family (the D-017 cost, P-007)', () => {
  /**
   * These assert the BUG'S COST, not the fix's success: an edge written in the wrong
   * form for its endpoint's family is well-formed, passes count/symmetry/acyclicity
   * checks, and withholds nothing. Every one of these was live on 2026-08-02.
   *
   * Each case is paired with the corresponding CORRECT edge above, which is what makes
   * a `false` here meaningful rather than vacuous — without the positive control, a
   * uniformly-unblocked system satisfies this whole describe.
   */
  for (const { blocked, blocker } of COMBOS) {
    const name = `${blocked} blocked-by ${blocker}`;
    const blockedId = idFor(blocked, 'blocked');
    const blockerId = idFor(blocker, 'blocker');
    const isBlocked = doorFor(blocked);

    it(`${name}: a kind-mismatched blocker endpoint is INERT`, async () => {
      await seedScenario(
        db.sql as never,
        defineScenario({
          workspace: WS,
          harness: H,
          items: [
            { id: blockedId, family: blocked, status: 'open' },
            { id: blockerId, family: blocker, status: 'open' },
          ],
          edges: [{ blocked: blockedId, blocker: blockerId, defect: 'kind-mismatch' }],
        }),
      );
      expect(await isBlocked(blockedId)).toBe(false);
    });

    it(`${name}: a blocker ref carrying the WRONG harness qualifier is INERT`, async () => {
      await seedScenario(
        db.sql as never,
        defineScenario({
          workspace: WS,
          harness: H,
          items: [
            { id: blockedId, family: blocked, status: 'open' },
            { id: blockerId, family: blocker, status: 'open' },
          ],
          edges: [{ blocked: blockedId, blocker: blockerId, defect: 'wrong-qualifier' }],
        }),
      );
      expect(await isBlocked(blockedId)).toBe(false);
    });
  }
});

describe('family matrix — the BLOCKED-side ref form is per-family and must stay that way (D-007, P-007)', () => {
  /**
   * The retraction guard. D-007 initially unified the blocked-side ref form across
   * families and had to be retracted because it OVER-GATES the feature family. These two
   * cases pin both directions, so a future "cleanup" that unifies the form fails here
   * with a reason instead of silently changing what the queue serves.
   */
  it('a FEATURE item is matched by its QUALIFIED ref, and a bare ref does not gate it', async () => {
    await seedScenario(
      db.sql as never,
      defineScenario({
        workspace: WS,
        harness: H,
        items: [
          { id: 'F-blocked', family: 'feature', status: 'open' },
          { id: 'F-blocker', family: 'feature', status: 'open' },
        ],
        edges: [{ blocked: 'F-blocked', blocker: 'F-blocker' }],
      }),
    );
    expect(await featureDoorBlocked('F-blocked')).toBe(true);

    // Rewrite the blocked ref into the ISSUE form. The feature door can no longer see it.
    await db.sql`
      UPDATE harness_shared.work_item_deps SET blocked_ref = 'F-blocked'
       WHERE blocked_ref = ${`${H}#F-blocked`}`;
    expect(await featureDoorBlocked('F-blocked')).toBe(false);
  });

  it('an ISSUE item is matched by its BARE ref, and a qualified ref does not gate it', async () => {
    await seedScenario(
      db.sql as never,
      defineScenario({
        workspace: WS,
        harness: H,
        items: [
          { id: 'EI-blocked', family: 'issue', status: 'open' },
          { id: 'EI-blocker', family: 'issue', status: 'open' },
        ],
        edges: [{ blocked: 'EI-blocked', blocker: 'EI-blocker' }],
      }),
    );
    expect(await issueDoorBlocked('EI-blocked')).toBe(true);

    // Rewrite the blocked ref into the FEATURE form. The issue door can no longer see it.
    await db.sql`
      UPDATE harness_shared.work_item_deps SET blocked_ref = ${`${H}#EI-blocked`}
       WHERE blocked_ref = 'EI-blocked'`;
    expect(await issueDoorBlocked('EI-blocked')).toBe(false);
  });
});
