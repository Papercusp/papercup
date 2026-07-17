/**
 * claim-spec-null-semantics.integration.test.ts — EI-13306 recurrence + parity guard.
 *
 * THE BUG THIS PINS. A claim-spec filter that NEGATES a predicate over a NULLABLE field
 * (`not:{plan = X}`, `not:{plan glob X}`, `plan != X`) used to compile to a bare
 * `NOT (source_plan_slug::text = 'X')`. SQL three-valued logic makes that NULL for every row
 * whose plan is NULL, and a WHERE clause drops a NULL row — so the filter silently deleted the
 * entire backlog. It starved a 10-agent drain fleet TWICE in one day; the second time the
 * claimable pool was measured collapsing 2341 -> 4. It fails SILENT: the spec validates
 * (ok:true, errors:[]) and get_next returns an honest-looking "no claimable item in fleet
 * scope", so the spec — the one thing that is fine — gets blamed.
 *
 * These run against REAL Postgres (testcontainer; Docker required) ON PURPOSE. The defect IS
 * SQL null semantics, so a unit test asserting the emitted string contains "COALESCE" would
 * pin the implementation while proving nothing about behavior. The only guard that can fail
 * for the right reason is one that executes the SQL against a real NULL column.
 *
 * PARITY. One spec language has TWO evaluators — this SQL compiler (get-next.ts, what
 * get_next actually runs) and a JS evaluator (claim-spec-match.ts, used by the assignment-
 * admission seams). They disagreed on exactly the shape that starved the fleet: JS's
 * `!matchLeaf(...)` ADMITS a null row while SQL's `NOT (...)` DROPPED it. Every case below
 * asserts BOTH engines agree, so they can never drift apart again unnoticed.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/claim-spec-null-semantics.integration.test.ts
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
import type { ClaimSpec, FilterNode } from './claim-spec';
import type { ClaimSpecSubject } from './claim-spec-match';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
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
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const { getNextWorkItem } = await import('./get-next');
const { validateClaimSpec } = await import('./claim-spec');
const { matchesClaimSpecFilter } = await import('./claim-spec-match');

const H = 'papercup';
const WS = 'default';
const PEER_PLAN = 'carry-idle-plans-to-completion-2026-07-17';
let db: FreshPgDb;

/** Seed a feature row with an EXPLICIT plan (or NULL — the case the whole file is about). */
async function seedFeature(id: string, opts: { plan?: string | null; createdTs?: number } = {}) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id,
       created_ts, updated_ts, source_plan_slug, title)
    VALUES (${H}, ${id}, 'feature', 'todo', ${null}, ${WS},
       ${opts.createdTs ?? 0}, 0, ${opts.plan ?? null}, ${id})`;
}

function spec(filter: FilterNode): ClaimSpec {
  const s: ClaimSpec = {
    specVersion: '1.0',
    specId: 'null-semantics',
    revision: 1,
    view: { filter },
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
  };
  const v = validateClaimSpec(s);
  // The trap's signature is that the spec VALIDATES and then mis-executes, so assert
  // validity explicitly — a filter rejected here would make the behavior tests vacuous.
  expect(v.ok, `spec invalid: ${v.errors.join('; ')}`).toBe(true);
  return s;
}

/** The JS-evaluator subject for a row with NO plan — the mirror of seedFeature({plan:null}). */
function nullPlanSubject(id: string): ClaimSpecSubject {
  return {
    id,
    title: id,
    kind: 'feature',
    priority: null,
    tags: [],
    paths: [],
    plan: null,
    planItem: [],
    age: 0,
    riskTier: null,
    redundancy: null,
    estCost: null,
    assignee: null,
  };
}

const BEE = { assignee: 'bee-1' };

beforeAll(async () => {
  db = await createFreshPgDb('sched-null-semantics');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`).simple();
}, 90_000);
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: false });
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps `;
});

// ────────────────────────────────────────────────────────────────────────────
// The regression: a negated predicate over a NULLABLE field must not eat the backlog.
// ────────────────────────────────────────────────────────────────────────────
describe('EI-13306 — a `not`/`!=` fence over a NULLABLE field admits NULL rows', () => {
  it('not:{plan = X} ADMITS a row whose plan is NULL (the exact fence that collapsed 2341 -> 4)', async () => {
    await seedFeature('F-noplan', { plan: null });
    const r = await getNextWorkItem(spec({ not: { field: 'plan', op: '=', value: PEER_PLAN } }), BEE, { harness: H });
    // Before the fix this was null: NOT (NULL = 'X') is NULL, so the row was dropped and the
    // fleet starved while the queue was full.
    expect(r?.workItem.id).toBe('F-noplan');
  });

  it('not:{plan glob X} ADMITS a row whose plan is NULL (EI-13306 original repro)', async () => {
    await seedFeature('F-noplan', { plan: null });
    const r = await getNextWorkItem(spec({ not: { field: 'plan', op: 'glob', value: 'p2p-*' } }), BEE, { harness: H });
    expect(r?.workItem.id).toBe('F-noplan');
  });

  it('plan != X ADMITS a NULL-plan row — consistent with the array branches', async () => {
    // text-array `!=` already compiled to NOT (v = ANY(COALESCE(col, ARRAY[]::text[]))) => true
    // on an absent value. Scalar `<>` was the odd one out, yielding NULL -> dropped.
    await seedFeature('F-noplan', { plan: null });
    const r = await getNextWorkItem(spec({ field: 'plan', op: '!=', value: PEER_PLAN }), BEE, { harness: H });
    expect(r?.workItem.id).toBe('F-noplan');
  });

  it('the fence still EXCLUDES the plan it names — null-safety did not widen it into a no-op', async () => {
    // The inverse failure: "fix" the NULL drop by making the filter match everything. The
    // fence must still do its job, or the peer-fleet collision it exists to prevent returns.
    await seedFeature('F-peer', { plan: PEER_PLAN });
    const r = await getNextWorkItem(spec({ not: { field: 'plan', op: '=', value: PEER_PLAN } }), BEE, { harness: H });
    expect(r).toBeNull();
  });

  it('fences OUT the named plan while KEEPING the NULL-plan backlog — the real-world spec', async () => {
    await seedFeature('F-peer', { plan: PEER_PLAN, createdTs: 10 }); // oldest: rank would pick it first
    await seedFeature('F-mine', { plan: null, createdTs: 20 });
    await seedFeature('F-other', { plan: 'some-other-plan', createdTs: 30 });
    const s = spec({
      all: [
        { field: 'kind', op: 'in', value: ['bug', 'change', 'task', 'feature'] },
        { not: { field: 'plan', op: '=', value: PEER_PLAN } },
      ],
    });
    const first = await getNextWorkItem(s, BEE, { harness: H });
    expect(first?.workItem.id).toBe('F-mine'); // NOT F-peer, and NOT starved to null
    const second = await getNextWorkItem(s, { assignee: 'bee-2' }, { harness: H });
    expect(second?.workItem.id).toBe('F-other');
    const third = await getNextWorkItem(s, { assignee: 'bee-3' }, { harness: H });
    expect(third).toBeNull(); // only the correctly-fenced peer row remains
  });

  it('a positive plan = X still EXCLUDES a NULL-plan row (null-safety is directional)', async () => {
    await seedFeature('F-noplan', { plan: null });
    const r = await getNextWorkItem(spec({ field: 'plan', op: '=', value: PEER_PLAN }), BEE, { harness: H });
    expect(r).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Parity: the SQL compiler and the JS evaluator must agree on a NULL subject.
// ────────────────────────────────────────────────────────────────────────────
describe('EI-13306 — SQL compiler and JS evaluator agree on NULL subjects', () => {
  const cases: Array<{ name: string; filter: FilterNode; admits: boolean }> = [
    { name: 'not:{plan = X}', filter: { not: { field: 'plan', op: '=', value: PEER_PLAN } }, admits: true },
    { name: 'not:{plan glob p2p-*}', filter: { not: { field: 'plan', op: 'glob', value: 'p2p-*' } }, admits: true },
    { name: 'plan != X', filter: { field: 'plan', op: '!=', value: PEER_PLAN }, admits: true },
    { name: 'plan = X', filter: { field: 'plan', op: '=', value: PEER_PLAN }, admits: false },
    { name: 'plan glob p2p-*', filter: { field: 'plan', op: 'glob', value: 'p2p-*' }, admits: false },
    { name: 'plan in [X]', filter: { field: 'plan', op: 'in', value: [PEER_PLAN] }, admits: false },
    // Double negation must round-trip rather than re-poison on the inner NULL.
    { name: 'not:{plan != X}', filter: { not: { field: 'plan', op: '!=', value: PEER_PLAN } }, admits: false },
    // A NULL leaf nested inside a combinator must not poison its healthy siblings.
    {
      name: 'all:[kind in [feature], not:{plan = X}]',
      filter: {
        all: [
          { field: 'kind', op: 'in', value: ['feature'] },
          { not: { field: 'plan', op: '=', value: PEER_PLAN } },
        ],
      },
      admits: true,
    },
    {
      name: 'any:[plan = X, kind in [feature]]',
      filter: {
        any: [
          { field: 'plan', op: '=', value: PEER_PLAN },
          { field: 'kind', op: 'in', value: ['feature'] },
        ],
      },
      admits: true,
    },
  ];

  for (const c of cases) {
    it(`${c.name} on a NULL-plan row: both engines ${c.admits ? 'ADMIT' : 'EXCLUDE'}`, async () => {
      await seedFeature('F-noplan', { plan: null });

      // Engine 1 — the SQL compiler, via a real get_next against real Postgres.
      const sqlAdmits = (await getNextWorkItem(spec(c.filter), BEE, { harness: H }))?.workItem.id === 'F-noplan';
      // Engine 2 — the JS evaluator used by the assignment-admission seams.
      const jsAdmits = matchesClaimSpecFilter(nullPlanSubject('F-noplan'), c.filter);

      expect(sqlAdmits, `SQL compiler disagreed with the expectation for ${c.name}`).toBe(c.admits);
      expect(jsAdmits, `JS evaluator disagreed with the expectation for ${c.name}`).toBe(c.admits);
      // Stated separately: even if BOTH were to drift to the same wrong answer, the cases
      // above fail — but this is the invariant that actually matters, so name it.
      expect(sqlAdmits, `ENGINE DIVERGENCE on ${c.name}: SQL=${sqlAdmits} JS=${jsAdmits}`).toBe(jsAdmits);
    });
  }
});
