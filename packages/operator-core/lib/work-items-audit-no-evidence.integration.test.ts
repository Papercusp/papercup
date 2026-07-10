/**
 * work-items-audit-no-evidence.integration.test.ts — the P-005 completion-integrity
 * audit filter (fleet-leader-frictions-six-improvements-2026-07-10).
 *
 * A DRAIN/fleet leader's wake loop spot-audits "stale-done closes": terminal rows
 * that were flipped closed by a bare state write and carry NO structured completion
 * record. Before P-005 that audit was a hand-written PG query over
 * `terminal_completion_ref IS NULL`; now it is one filter:
 * `work_items:list { audit: 'no-evidence' }`.
 *
 * Proves against real Postgres (testcontainer; Docker required):
 *   • a TERMINAL row with `terminal_completion_ref IS NULL` IS listed by the audit —
 *     in BOTH families (feature 'done' bare-close; issue 'resolved' bare-close);
 *   • a terminal row WITH a completion ref (what work_items:complete stamps) is
 *     excluded — evidence satisfied;
 *   • a NON-terminal row is never listed (an open item owes no evidence yet), even
 *     with a null ref;
 *   • `audit` composes with an explicit `state` (narrow the audit to one close state);
 *   • omitted `audit` is byte-identical to before (evidenced + bare rows both list).
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/work-items-audit-no-evidence.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, USER_TRUST_LIST_DDL, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const wi = await import('./work-items');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

/** Seed one work_items base row (either family — item_kind decides). */
async function seed(
  id: string,
  opts: { kind?: string; status?: string; terminalRef?: string | null; createdTs?: number } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, workspace_id, created_ts, updated_ts, terminal_completion_ref)
    VALUES (${H}, ${id}, ${opts.kind ?? 'feature'}, ${`title ${id}`}, ${opts.status ?? 'open'},
       ${WS}, ${opts.createdTs ?? 0}, ${opts.createdTs ?? 0}, ${opts.terminalRef ?? null})`;
}

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

beforeAll(async () => {
  db = await createFreshPgDb('wi-audit-no-evidence');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
}, 180_000);
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
});

describe("listWorkItems { audit: 'no-evidence' } (P-005)", () => {
  it('lists TERMINAL bare-closes in BOTH families; excludes evidenced + open rows', async () => {
    // Feature family
    await seed('F-bare-done', { kind: 'feature', status: 'done' }); // terminal, no ref → AUDIT HIT
    await seed('F-evidenced', { kind: 'feature', status: 'done', terminalRef: 'completion:abc' }); // excluded
    await seed('F-open', { kind: 'feature', status: 'in-progress' }); // non-terminal → excluded
    // Issue family
    await seed('WI-bare-resolved', { kind: 'change', status: 'resolved' }); // AUDIT HIT
    await seed('WI-evidenced', { kind: 'bug', status: 'resolved', terminalRef: 'completion:def' }); // excluded
    await seed('WI-open', { kind: 'bug', status: 'open' }); // excluded

    const audited = await wi.listWorkItems({ harness: H, audit: 'no-evidence' });
    expect(ids(audited)).toEqual(['F-bare-done', 'WI-bare-resolved']);
  });

  it('a dropped/deprecated bare-close is audit material too (the whole terminal set owes evidence)', async () => {
    await seed('F-dropped', { kind: 'feature', status: 'dropped' });
    await seed('WI-deprecated', { kind: 'change', status: 'deprecated' });
    const audited = await wi.listWorkItems({ harness: H, audit: 'no-evidence' });
    expect(ids(audited)).toEqual(['F-dropped', 'WI-deprecated']);
  });

  it("composes with an explicit `state` — audit narrowed to that close state only", async () => {
    await seed('F-bare-done', { kind: 'feature', status: 'done' });
    await seed('WI-bare-resolved', { kind: 'change', status: 'resolved' });
    const onlyDone = await wi.listWorkItems({ harness: H, audit: 'no-evidence', state: 'done' });
    expect(ids(onlyDone)).toEqual(['F-bare-done']);
  });

  it('omitted audit is byte-identical to before — evidenced and bare rows both list', async () => {
    await seed('F-bare-done', { kind: 'feature', status: 'done' });
    await seed('F-evidenced', { kind: 'feature', status: 'done', terminalRef: 'completion:abc' });
    const plain = await wi.listWorkItems({ harness: H, state: 'done' });
    expect(ids(plain)).toEqual(['F-bare-done', 'F-evidenced']);
  });

  it('an empty backlog audits to an empty list (never throws)', async () => {
    expect(await wi.listWorkItems({ harness: H, audit: 'no-evidence' })).toEqual([]);
  });
});
