/**
 * dependency-oracle.property.integration.test.ts — the SHIPPED blocking oracle, over
 * randomly generated dependency graphs.
 *
 * Plan: dependency-subsystem-thorough-testing-2026-08-02 (P-010).
 * @covers INV-04 INV-05 INV-09 INV-11
 *
 * WHAT THE SUBJECT IS, AND WHY IT IS THE MIGRATION AND NOT THE FIXTURE. The oracle here
 * is `harness_shared.work_item_is_blocked`, loaded from the REAL migrations (379 + 719)
 * exactly as claim-respects-blocking and the tenant matrix load it — never from the
 * hand-written re-definition in test/_work-items-schema.ts. That distinction is the whole
 * difference between a test and a tautology: checking a hand-written SQL function against
 * a hand-written TypeScript model proves the author was self-consistent twice, and would
 * stay green with the shipped migration deleted.
 *
 * THE DIVISION OF LABOUR:
 *   subject  work_item_is_blocked (shipped SQL)        — answers "is this item withheld"
 *   oracle   expectedBlockedIds  (pure TS, P-002)      — the SPEC, computed without PG
 * Two independent implementations of the same proposition. Disagreement on ANY generated
 * graph is a real finding in one of them.
 *
 * ⚠ THE PLAN ITEM'S OWN WORDING IS SUPERSEDED HERE, deliberately. P-010 as written asks
 * to prove "blocking is transitive through a chain of arbitrary depth". That is the
 * reading INV-09 was CORRECTED away from (see its `note`): the system is
 * one-hop-with-terminality, and that is correct rather than a leak — a blocker that has
 * REACHED a terminal state releases its dependent whatever sits behind it, and the
 * genuinely transitive rule would deadlock any item whose finished prerequisite happens
 * to sit downstream of an abandoned root. Asserting transitivity would therefore have
 * encoded a bug as an expectation. What survives from the plan's intent — and is proved
 * below — is the DEPTH obligation: an unfinished chain withholds to arbitrary depth, and
 * the release frontier advances exactly one link per completion.
 *
 * WHY RANDOM GRAPHS EARN THEIR KEEP HERE SPECIFICALLY. INV-09's note records that the
 * invariant was, as first written, unfalsifiable by depth alone: on any chain where every
 * intermediate is unfinished, the one-hop and transitive readings AGREE on every item. So
 * a fixture author seeding a natural chain cannot tell them apart no matter how deep they
 * go. The two readings diverge only when a TERMINAL node sits above a non-terminal one —
 * a shape nobody draws by hand. Random statuses over random DAGs produce it constantly,
 * and the generator-honesty control at the bottom of this file PROVES the sample contains
 * it rather than assuming so.
 *
 * FEATURE FAMILY ONLY, and that is a property of the system, not a convenience.
 * `work_item_is_blocked` matches its blocked leg as `blocked_ref = harness || '#' || id`,
 * so it is structurally the feature-family door; issue-family readiness is enforced by
 * `depsBlockedExclusionSql` in work-items.ts against the BARE ref. Sweeping issue items
 * against this oracle would manufacture a false regression — the family axis is covered
 * by P-007, which drives each family through its own door.
 *
 * Real Postgres (testcontainer; Docker required).
 *
 * Run:
 *   npm run test:file -- packages/operator-core/lib/scheduler/dependency-oracle.property.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';
import {
  defineScenario,
  expectedBlockedIds,
  seedScenario,
  FEATURE_TERMINAL_STATES,
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

/**
 * The status pool the generator draws from.
 *
 * ⚠ IT DELIBERATELY INCLUDES STATES FROM THE OTHER FAMILY'S VOCABULARY (`closed`,
 * `resolved`), and that is what made this suite worth writing. Every item here is
 * FEATURE family, and the shipped oracle's feature leg treats terminality as
 * `NOT IN ('passed','deprecated','done','dropped')` — so `closed` on a feature blocker
 * is NOT terminal and the dependent stays withheld.
 *
 * On its first run this property refuted the FIXTURE, not the system: `expectedBlockedIds`
 * defaulted to the family-blind UNION of both families' terminal lists, so it called a
 * `closed` feature blocker satisfied while the oracle did not. Minimal counterexample,
 * shrunk by fast-check in under a second:
 *
 *     dag [[], [0]]   statuses ['closed', 'open']
 *     oracle: WI-1 withheld   ·   fixture model: WI-1 free
 *
 * The fixture is now family-aware (FEATURE_TERMINAL_STATES / ISSUE_TERMINAL_STATES) and
 * the pool stays broad on purpose: narrowing it to the four "realistic" feature states
 * would delete the only shape that can catch that class of drift again.
 */
const STATUS_POOL = [
  'open',
  'wip',
  ...FEATURE_TERMINAL_STATES,
  // Issue-family terminal vocabulary — NON-terminal for a feature blocker.
  'closed',
  'resolved',
] as const;

/** Terminality for a FEATURE-family blocker — every item in this file is feature family. */
const isTerminal = (s: string) => FEATURE_TERMINAL_STATES.includes(s);

/** Node i's feature id. */
const nodeId = (i: number) => `WI-${i}`;

/** A generated DAG in topological order: `blockers[i]` are the indices node i waits on, all < i. */
type Dag = readonly (readonly number[])[];

/** PG round-trips dominate here, so runs are budgeted rather than left at fast-check's 100.
 *  The value of this suite is shape DIVERSITY, not sample size — 40 graphs of ≤6 nodes
 *  already covers chains, diamonds, wide fan-in and disconnected components many times over. */
const PG_RUNS = { numRuns: 40 } as const;

const graphArb: fc.Arbitrary<{ dag: Dag; statuses: readonly string[] }> = fc
  .integer({ min: 2, max: 6 })
  .chain((n) =>
    fc.record({
      dag: fc.tuple(
        ...Array.from({ length: n }, (_, i) =>
          fc.subarray(Array.from({ length: i }, (_, j) => j)),
        ),
      ),
      statuses: fc.tuple(
        ...Array.from({ length: n }, () => fc.constantFrom<string>(...STATUS_POOL)),
      ),
    }),
  );

/** All items FEATURE family — see the header on why this oracle is that family's door. */
function toSpec(dag: Dag, statuses: readonly string[]): DependencyScenarioSpec {
  return defineScenario({
    items: dag.map((_, i) => ({ id: nodeId(i), family: 'feature' as const, status: statuses[i]! })),
    edges: dag.flatMap((blockers, i) =>
      blockers.map((j) => ({ blocked: nodeId(i), blocker: nodeId(j) })),
    ),
  });
}

/** The workspace-scoped oracle (migration 719's 3-arg form) — the shipped subject. */
async function oracleBlocked(harness: string, id: string, workspace: string): Promise<boolean> {
  const rows = (await db.sql`
    SELECT harness_shared.work_item_is_blocked(${harness}, ${id}, ${workspace}) AS blocked`) as Array<{
    blocked: boolean;
  }>;
  return rows[0]!.blocked === true;
}

/** Every id the SHIPPED oracle withholds, sorted to match `expectedBlockedIds`. */
async function oracleBlockedIds(spec: DependencyScenarioSpec): Promise<string[]> {
  const out: string[] = [];
  for (const item of spec.items) {
    if (await oracleBlocked(spec.harness, item.id, spec.workspace)) out.push(item.id);
  }
  return out.sort();
}

/** Seed one generated graph into a clean database. */
async function seedFresh(spec: DependencyScenarioSpec): Promise<void> {
  // Inside the property, not a beforeEach: beforeEach fires once per `it`, while a
  // property runs its body many times. Without this every run would inherit the last
  // graph's rows and the suite would be asserting against an accumulating union.
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps, harness_shared.work_item_blocked`;
  await seedScenario(db.sql as never, spec);
}

/**
 * THE READING INV-09 WAS CORRECTED AWAY FROM, implemented so it can be REFUTED.
 *
 * "An item with a blocked blocker is itself withheld" — i.e. blocking propagates through
 * a terminal node. Kept here purely as the foil for the discrimination control below; it
 * is NOT what the system does and must never be asserted as an expectation.
 */
function transitivelyBlockedIds(dag: Dag, statuses: readonly string[]): string[] {
  const memo = new Map<number, boolean>();
  const blocked = (i: number): boolean => {
    const hit = memo.get(i);
    if (hit !== undefined) return hit;
    memo.set(i, false); // acyclic by construction, so this only guards re-entry
    const v = dag[i]!.some((j) => !isTerminal(statuses[j]!) || blocked(j));
    memo.set(i, v);
    return v;
  };
  return dag.map((_, i) => i).filter(blocked).map(nodeId).sort();
}

beforeAll(async () => {
  db = await createFreshPgDb('dependency-oracle-property');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  // 379: the maintained readiness sidecar + its triggers + the work_item_is_blocked
  // oracle. 719: makes that oracle workspace-scoped. Applying 379 WITHOUT 719 is what
  // shipped, and is the defect the tenant axis of this suite would catch.
  await db.sql.unsafe(readMigration('379-maintained-ready-column.sql')).simple();
  await db.sql.unsafe(WIDE_TRIGGER_DDL).simple();
  await db.sql.unsafe(readMigration('719-fix-work-item-is-blocked-workspace-scope.sql')).simple();
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('the shipped oracle over random DAGs (P-010) — @covers INV-04 INV-09 INV-11', () => {
  it('withholds EXACTLY the items with a live direct blocker, for any generated graph', () => {
    // Set equality in both directions. Under-blocking is the D-017 escape (an edge that
    // gates nothing); over-blocking is the INV-05 failure (work that silently stalls).
    // A one-directional assertion would miss whichever half it did not check.
    return fc.assert(
      fc.asyncProperty(graphArb, async ({ dag, statuses }) => {
        const spec = toSpec(dag, statuses);
        await seedFresh(spec);
        expect(await oracleBlockedIds(spec)).toEqual(expectedBlockedIds(spec));
      }),
      PG_RUNS,
    );
  });

  it('withholds a fully-unfinished chain to ARBITRARY depth (the EI-9108 shape)', () => {
    // The plan's depth obligation, kept from its original wording. EI-9108 escaped at
    // depth 7, past anything the hand-written corpus contained; chains here run to 9.
    return fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 9 }), async (len) => {
        const dag: Dag = Array.from({ length: len }, (_, i) => (i === 0 ? [] : [i - 1]));
        const statuses = Array.from({ length: len }, () => 'open');
        const spec = toSpec(dag, statuses);
        await seedFresh(spec);

        // Every link except the root is withheld — depth does not attenuate blocking.
        expect(await oracleBlockedIds(spec)).toEqual(
          Array.from({ length: len - 1 }, (_, i) => nodeId(i + 1)).sort(),
        );
      }),
      PG_RUNS,
    );
  });

  it('advances the release frontier exactly ONE link per completion — @covers INV-05', () => {
    // The discriminating behaviour, and the reason this is not merely the previous test
    // run backwards: if blocking collapsed (too weak), finishing the root would free the
    // whole chain at once; if it were transitive (too strong), finishing the root would
    // free nothing beyond the next link either. Only one-hop-with-terminality produces a
    // frontier that steps by exactly one.
    return fc.assert(
      fc.asyncProperty(fc.integer({ min: 3, max: 7 }), async (len) => {
        const dag: Dag = Array.from({ length: len }, (_, i) => (i === 0 ? [] : [i - 1]));
        const statuses = Array.from({ length: len }, () => 'open');
        const spec = toSpec(dag, statuses);
        await seedFresh(spec);

        for (let done = 0; done < len - 1; done++) {
          // Complete the current frontier item.
          await db.sql`
            UPDATE harness_shared.work_items SET status = 'done'
             WHERE workspace_id = ${spec.workspace} AND harness_slug = ${spec.harness}
               AND feature_id = ${nodeId(done)}`;

          // Exactly the links strictly beyond the newly-freed one remain withheld.
          expect(await oracleBlockedIds(spec), `after completing ${nodeId(done)}`).toEqual(
            Array.from({ length: len - done - 2 }, (_, i) => nodeId(done + 2 + i)).sort(),
          );
        }
      }),
      { numRuns: 12 },
    );
  });

  it('releases a dependent whose direct blocker is terminal, even with unfinished work ABOVE it', () => {
    // INV-09's corrected clause, isolated. `open ← done ← open`: the tail's own direct
    // blocker is finished, so the tail is claimable even though something upstream of
    // that blocker never completed. The transitive reading calls this blocked, and it is
    // the single case that separates the two readings.
    return fc.assert(
      fc.asyncProperty(fc.constantFrom('open', 'wip'), async (liveStatus) => {
        const dag: Dag = [[], [0], [1]];
        const spec = toSpec(dag, [liveStatus, 'done', liveStatus]);
        await seedFresh(spec);

        // WI-1 waits on the unfinished WI-0, so it stays withheld; WI-2's own blocker
        // (WI-1) is done, so it is free. Both halves in one assertion, so neither a
        // blanket "everything blocked" nor "nothing blocked" could pass.
        expect(await oracleBlockedIds(spec)).toEqual([nodeId(1)]);
      }),
      { numRuns: 4 },
    );
  });
});

describe('the sample is honest (P-010, D-019/D-020)', () => {
  // Controls FOR THE PROPERTIES. A generator that quietly produced only trivial graphs
  // would make every assertion above vacuously true while looking exactly like a green
  // suite — the precise failure mode this plan exists to eliminate. These run without PG.

  it('produces graphs where the one-hop and TRANSITIVE readings actually disagree', () => {
    // The most important control in the file. INV-09's note records that the invariant was
    // once unfalsifiable by depth alone, because the two readings agree on every chain in
    // which nothing is finished. If the sample never contained a terminal node sitting
    // above a non-terminal one, the headline property would be green under a transitive
    // implementation too — i.e. it would not be testing INV-09 at all.
    let sawDisagreement = false;
    fc.assert(
      fc.property(graphArb, ({ dag, statuses }) => {
        const spec = toSpec(dag, statuses);
        const oneHop = expectedBlockedIds(spec);
        const transitive = transitivelyBlockedIds(dag, statuses);
        if (JSON.stringify(oneHop) !== JSON.stringify(transitive)) sawDisagreement = true;
        return true;
      }),
      { numRuns: 300 },
    );
    expect(
      sawDisagreement,
      'no generated graph distinguished one-hop from transitive blocking — the headline ' +
        'property would pass under either reading, so it does not constrain INV-09',
    ).toBe(true);
  });

  it('produces graphs in which something is blocked AND graphs in which nothing is', () => {
    // A sample of exclusively-empty expectations would make set equality trivial.
    let sawBlocked = false;
    let sawClear = false;
    fc.assert(
      fc.property(graphArb, ({ dag, statuses }) => {
        if (expectedBlockedIds(toSpec(dag, statuses)).length > 0) sawBlocked = true;
        else sawClear = true;
        return true;
      }),
      { numRuns: 300 },
    );
    expect(sawBlocked, 'no generated graph blocked anything').toBe(true);
    expect(sawClear, 'every generated graph blocked something').toBe(true);
  });
});
