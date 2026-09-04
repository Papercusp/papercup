/**
 * dependency-tenant-matrix.integration.test.ts — the dependency subsystem on the axis
 * every historical fixture held constant.
 *
 * Plan: dependency-subsystem-thorough-testing-2026-08-02 (P-006).
 * @covers INV-11 INV-04 INV-05
 *
 * WHY THIS FILE EXISTS. The blocking oracle was hardcoded to workspace 'default' and
 * shipped that way for months. It was not under-tested: the suite was green throughout.
 * It was green *because* every fixture constructed its rows in 'default', so the
 * hardcoded literal and the fixture agreed by coincidence on every single test. The bug
 * lived precisely on the axis the coverage never varied, which is the one shape a
 * coverage percentage can never report — those lines were covered.
 *
 * So this file's subject is not "does blocking work" (claim-respects-blocking proves
 * that). It is "does blocking work when the tenant is NOT the one the code might have
 * assumed", and, more sharply, "can one tenant's edges affect another's items".
 *
 * THE DISCRIMINATING CASE IS ISOLATION, NOT MERELY A DIFFERENT TENANT. Running the
 * existing assertions under a non-'default' workspace catches a *hardcoded* literal, but
 * it does NOT catch a scope that is simply missing — an unscoped `WHERE feature_id = $1`
 * returns the right answer whenever only one tenant exists in the table, which is true in
 * every single-tenant fixture including a non-'default' one. Only seeding the SAME ids
 * under TWO tenants at once, and blocking them in one, can tell those apart. Migration
 * 719's defect was on the BLOCKER leg specifically, so the sweep drives both legs.
 *
 * Real Postgres (testcontainer; Docker required).
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/dependency-tenant-matrix.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';
import {
  defineScenario,
  expectedBlockedIds,
  seedScenario,
  standardScenario,
  type DependencyScenarioSpec,
} from '../testing/dependency-fixture';
import { WIDE_TRIGGER_DDL } from './dependency-trigger-fixture';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l) && !/\bGRANT\b/.test(l) && !/^\s*(BEGIN|COMMIT);\s*$/.test(l))
    .join('\n');

let db: FreshPgDb;

/** The workspace-scoped oracle (migration 719's 3-arg form). */
async function oracleBlocked(harness: string, id: string, workspace: string): Promise<boolean> {
  const rows = (await db.sql`
    SELECT harness_shared.work_item_is_blocked(${harness}, ${id}, ${workspace}) AS blocked`) as Array<{
    blocked: boolean;
  }>;
  return rows[0]!.blocked === true;
}

/** The maintained sidecar's membership: a row present ⇒ NOT ready. */
async function sidecarBlocked(harness: string, id: string, workspace: string): Promise<boolean> {
  const rows = (await db.sql`
    SELECT 1 FROM harness_shared.work_item_blocked
     WHERE workspace_id = ${workspace} AND harness_slug = ${harness} AND feature_id = ${id}
     LIMIT 1`) as unknown as unknown[];
  return rows.length > 0;
}

/**
 * Every FEATURE-family item the oracle withholds, sorted.
 *
 * ⚠ FEATURE-FAMILY ONLY, and this is a real property of the system rather than a
 * convenience. `work_item_is_blocked` matches its blocked leg as
 * `blocked_ref = p_harness || '#' || p_feature` — the harness-qualified form — so it is
 * structurally the FEATURE-family oracle. Issue-family readiness is enforced by a
 * DIFFERENT door: `depsBlockedExclusionSql` in work-items.ts, whose predicate is
 * `d.blocked_ref = wi.feature_id`, i.e. the BARE form INV-01 requires for that family.
 *
 * I checked this against live data before writing it down, because the shape looks
 * alarming: 27 of 27 issue-family blocked edges carry a bare ref that this oracle can
 * never match, which reads exactly like "every issue-family edge is inert" — the D-017
 * bug again. It is not. Those edges are matched by the other door. Asserting issue items
 * against THIS oracle would have manufactured a false regression report.
 */
async function oracleBlockedFeatures(spec: DependencyScenarioSpec): Promise<string[]> {
  const out: string[] = [];
  for (const item of spec.items) {
    if (item.family !== 'feature') continue;
    if (await oracleBlocked(spec.harness, item.id, spec.workspace)) out.push(item.id);
  }
  return out.sort();
}

/** The spec's expectation, narrowed to the family this oracle is responsible for. */
function expectedBlockedFeatures(spec: DependencyScenarioSpec): string[] {
  const featureIds = new Set(spec.items.filter((i) => i.family === 'feature').map((i) => i.id));
  return expectedBlockedIds(spec).filter((id) => featureIds.has(id));
}

beforeAll(async () => {
  db = await createFreshPgDb('dependency-tenant-matrix');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  // 379: the maintained readiness sidecar, its maintenance triggers, and the
  // work_item_is_blocked oracle. 719: makes that oracle workspace-scoped (the fix for the
  // very defect this file exists to guard). Applying 379 WITHOUT 719 is what shipped.
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
 * The tenant sweep. 'default'/'papercup' is included deliberately and LAST: it is the
 * historical assumption, and it must keep working — a fix that scoped correctly but broke
 * the default tenant would be a different bug, not a fix.
 */
const TENANTS: ReadonlyArray<{ name: string; workspace: string; harness: string }> = [
  { name: 'non-default workspace + non-default harness', workspace: 'papercusp-workspace', harness: 'papercusp' },
  { name: 'a second unrelated tenant', workspace: 'tenant-b-workspace', harness: 'tenant-b-pot' },
  { name: "a harness whose slug contains the other tenant's name as a prefix", workspace: 'tenant-b-workspace-2', harness: 'tenant-b-pot-extended' },
  { name: "the historical 'default' assumption", workspace: 'default', harness: 'papercup' },
];

describe('tenant matrix — the standard scenario behaves identically under every tenant (P-006)', () => {
  for (const tenant of TENANTS) {
    it(`${tenant.name}: the oracle withholds exactly the feature-family items with a live blocker`, async () => {
      const spec = standardScenario({ workspace: tenant.workspace, harness: tenant.harness });
      await seedScenario(db.sql as never, spec);

      // The expectation is computed from the SPEC, independently of the database — and the
      // defective edges (kind-mismatch, wrong-qualifier, dangling) are expected to gate
      // NOTHING, so this encodes the bug's cost as well as the fix's success.
      expect(await oracleBlockedFeatures(spec)).toEqual(expectedBlockedFeatures(spec));
    });

    it(`${tenant.name}: the sweep is not vacuous — at least one item IS withheld`, async () => {
      // Guards the assertion above, which compares two computed sets and would pass
      // trivially if both were empty. Under this scenario F-blocked has a live
      // (non-terminal, correctly-formed) blocker, so an empty result means the rig is
      // broken rather than the system being clean. This is the check that caught both
      // fixture bugs P-006 found.
      const spec = standardScenario({ workspace: tenant.workspace, harness: tenant.harness });
      await seedScenario(db.sql as never, spec);
      expect(await oracleBlockedFeatures(spec)).not.toHaveLength(0);
    });

    it(`${tenant.name}: the maintained sidecar agrees with the oracle for every feature item`, async () => {
      const spec = standardScenario({ workspace: tenant.workspace, harness: tenant.harness });
      await seedScenario(db.sql as never, spec);

      for (const item of spec.items) {
        if (item.family !== 'feature') continue;
        const oracle = await oracleBlocked(spec.harness, item.id, spec.workspace);
        const sidecar = await sidecarBlocked(spec.harness, item.id, spec.workspace);
        expect(sidecar, `${item.id} under ${spec.workspace}/${spec.harness}`).toBe(oracle);
      }
    });
  }
});

describe('tenant ISOLATION — one tenant\'s edges can never gate another\'s items (P-006)', () => {
  /**
   * Two tenants, identical item ids, edges in ONE of them.
   *
   * This is the case a non-'default' single-tenant fixture cannot produce. With only one
   * tenant in the table, an unscoped `WHERE feature_id = $1` returns the correct answer
   * for every row — so a MISSING scope and a CORRECT scope are observationally identical
   * until a second tenant exists. That is why the original defect survived a green suite.
   */
  const A = { workspace: 'tenant-a-ws', harness: 'tenant-a-pot' };
  const B = { workspace: 'tenant-b-ws', harness: 'tenant-b-pot' };

  const blockedIn = (t: { workspace: string; harness: string }) =>
    defineScenario({
      ...t,
      items: [
        { id: 'F-shared-id', family: 'feature', status: 'open' },
        { id: 'F-shared-blocker', family: 'feature', status: 'wip' },
      ],
      edges: [{ blocked: 'F-shared-id', blocker: 'F-shared-blocker' }],
    });

  const cleanIn = (t: { workspace: string; harness: string }) =>
    defineScenario({
      ...t,
      items: [
        { id: 'F-shared-id', family: 'feature', status: 'open' },
        { id: 'F-shared-blocker', family: 'feature', status: 'wip' },
      ],
      edges: [],
    });

  it('an edge in tenant A does NOT withhold the same-id item in tenant B', async () => {
    await seedScenario(db.sql as never, blockedIn(A));
    await seedScenario(db.sql as never, cleanIn(B));

    expect(await oracleBlocked(A.harness, 'F-shared-id', A.workspace)).toBe(true);
    // The whole point. An unscoped blocked-leg lookup answers true here.
    expect(await oracleBlocked(B.harness, 'F-shared-id', B.workspace)).toBe(false);
  });

  it('the SIDECAR is isolated too — membership is per-tenant, not per-id', async () => {
    await seedScenario(db.sql as never, blockedIn(A));
    await seedScenario(db.sql as never, cleanIn(B));

    expect(await sidecarBlocked(A.harness, 'F-shared-id', A.workspace)).toBe(true);
    expect(await sidecarBlocked(B.harness, 'F-shared-id', B.workspace)).toBe(false);
  });

  it("completing tenant A's blocker does not disturb tenant B, and vice versa", async () => {
    await seedScenario(db.sql as never, blockedIn(A));
    await seedScenario(db.sql as never, blockedIn(B));
    expect(await oracleBlocked(A.harness, 'F-shared-id', A.workspace)).toBe(true);
    expect(await oracleBlocked(B.harness, 'F-shared-id', B.workspace)).toBe(true);

    // Terminal in A only.
    await db.sql`
      UPDATE harness_shared.work_items SET status='done'
       WHERE workspace_id=${A.workspace} AND harness_slug=${A.harness} AND feature_id='F-shared-blocker'`;

    expect(await oracleBlocked(A.harness, 'F-shared-id', A.workspace)).toBe(false);
    // INV-05 released in A must NOT release B — the BLOCKER leg is the migration-719 defect.
    expect(await oracleBlocked(B.harness, 'F-shared-id', B.workspace)).toBe(true);
    expect(await sidecarBlocked(B.harness, 'F-shared-id', B.workspace)).toBe(true);
  });

  it('two HARNESSES inside ONE workspace are isolated (the (workspace, harness, id) key, not workspace alone)', async () => {
    // The repo documents the key as (workspace_id, harness_slug, slug/id). A scope that
    // stopped at workspace_id would pass every test above and fail here.
    const H1 = { workspace: 'shared-ws', harness: 'pot-one' };
    const H2 = { workspace: 'shared-ws', harness: 'pot-two' };
    await seedScenario(db.sql as never, blockedIn(H1));
    await seedScenario(db.sql as never, cleanIn(H2));

    expect(await oracleBlocked(H1.harness, 'F-shared-id', H1.workspace)).toBe(true);
    expect(await oracleBlocked(H2.harness, 'F-shared-id', H2.workspace)).toBe(false);
  });

  it('a blocker that exists ONLY in another tenant does not satisfy the edge — it reads as absent', async () => {
    // The blocker-leg mirror of the first case: the edge names a blocker whose only row
    // lives in a different tenant. Cross-tenant resolution would find a 'wip' row and
    // withhold; correct scoping finds nothing, and an absent blocker never deadlocks
    // (the INV-04 dangling rule). Either answer is defensible in principle — what is NOT
    // defensible is resolving it ACROSS the tenant boundary, which is what this pins.
    await seedScenario(
      db.sql as never,
      defineScenario({
        ...A,
        items: [{ id: 'F-orphan', family: 'feature', status: 'open' }],
        edges: [{ blocked: 'F-orphan', blocker: 'F-elsewhere', defect: 'dangling' }],
      }),
    );
    // The blocker id exists, but only under tenant B.
    await seedScenario(
      db.sql as never,
      defineScenario({
        ...B,
        items: [{ id: 'F-elsewhere', family: 'feature', status: 'wip' }],
        edges: [],
      }),
    );

    expect(await oracleBlocked(A.harness, 'F-orphan', A.workspace)).toBe(false);
  });
});

describe('tenant matrix negative control — the sweep can actually fail (P-006)', () => {
  it('a REAL blocker in the tenant under test IS reported, so a uniformly-false oracle would not pass', async () => {
    // Every isolation assertion above expects `false`. An oracle that returned false
    // unconditionally would satisfy all of them, and the suite would be green with
    // blocking entirely disabled. This is the paired positive that makes those falses
    // mean something.
    const spec = blockedInTenant('control-ws', 'control-pot');
    await seedScenario(db.sql as never, spec);
    expect(await oracleBlocked('control-pot', 'F-shared-id', 'control-ws')).toBe(true);
    expect(await sidecarBlocked('control-pot', 'F-shared-id', 'control-ws')).toBe(true);
  });
});

function blockedInTenant(workspace: string, harness: string): DependencyScenarioSpec {
  return defineScenario({
    workspace,
    harness,
    items: [
      { id: 'F-shared-id', family: 'feature', status: 'open' },
      { id: 'F-shared-blocker', family: 'feature', status: 'wip' },
    ],
    edges: [{ blocked: 'F-shared-id', blocker: 'F-shared-blocker' }],
  });
}
