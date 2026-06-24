/**
 * plan-items-tools.integration.test.ts — invokes the plan_items:* TOOL HANDLERS
 * (not just the stores) end-to-end against real PG, to verify the dispatch glue:
 * identity resolution (resolveAgentIdentity(ctx)), scope resolution, the store call,
 * and the JSON response shape. The stores' own logic is covered by
 * ../../plan-items/plan-items.integration.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l) && !/\bGRANT\b/.test(l) && !/^\s*(BEGIN|COMMIT);\s*$/.test(l))
    .join('\n');

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../plans/source', () => ({
  resolvePlanScope: async (opts?: { workspaceId?: string; harnessSlug?: string }) => ({
    workspaceId: opts?.workspaceId ?? 'default',
    harnessSlug: opts?.harnessSlug ?? 'papercup',
  }),
  readPlanBySlug: async (slug: string) =>
    slug === 'demo-plan'
      ? { archived: false, parsed: { items: [{ id: 'P-001', storedStatus: 'todo' }, { id: 'P-002', storedStatus: 'todo' }] }, row: { items: [{ id: 'P-001', status: 'todo' }, { id: 'P-002', status: 'todo' }] } }
      : null,
}));

// Pin PLAN_ITEM_CLAIM_AUTO_CONVERT OFF (it graduated default-ON). This lifecycle
// test exercises the BARE plan-item claim path (asserts result.status:'claimed')
// and its minimal fixture has no work_items convert schema; with the flag ON the
// claim mints a work_item via convertPlanItem and fails on the absent schema. The
// auto-convert path has its own coverage (convertPlanItem tests). Other flags
// delegate to the real resolver unchanged.
vi.mock('@papercusp/flags/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/flags/server')>();
  return {
    ...actual,
    getFlag: async (flag: string, distinct: string) =>
      flag === 'papercusp-claim-auto-convert' ? false : actual.getFlag(flag, distinct),
  };
});

// Tool default exports.
const adoptName = (await import('./adopt-name')).default;
const assign = (await import('./assign')).default;
const myItems = (await import('./my-items')).default;
const claim = (await import('./claim')).default;
const heartbeat = (await import('./heartbeat')).default;
const status = (await import('./status')).default;
const release = (await import('./release')).default;

// Minimal ctx the tool handlers + resolveAgentIdentity read.
const ctxA = { isSuperuser: true, uiClientId: 'sess-A', workspaceId: 'default' };
const ctxB = { isSuperuser: true, uiClientId: 'sess-B', workspaceId: 'default' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(tool: any, args: unknown, ctx: unknown): Promise<any> {
  const res = await tool.handler(args, ctx);
  // Bulk tools (plan_items:claim/assign/…) return the canonical { data: envelope };
  // a non-bulk / guard path returns a raw { content } ToolResult.
  return res.data ?? JSON.parse(res.content[0].text);
}

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('pi-tools');
  h.sql = db.sql;
  await db.sql.unsafe(readMigration('140-plan-item-assignments.sql')).simple();
  await db.sql.unsafe(readMigration('141-plan-item-claims.sql')).simple();
}, 90_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.plan_item_assignments, harness_shared.agent_names,
                       harness_shared.agent_name_sessions, harness_shared.plan_item_claims,
                       harness_shared.plan_work_group_members`;
});

describe('plan_items:* tool handlers (real PG, through dispatch glue)', () => {
  it('full flow: adopt → assign → my_items → claim → heartbeat → status → release', async () => {
    const adopted = await call(adoptName, { name: 'builder-1' }, ctxA);
    expect(adopted.ok).toBe(true);
    expect(adopted.adopted.agentName).toBe('builder-1');

    // The write verbs are dual-arity (bulk-endpoint-standardization-2026-06-21 P-004):
    // a single inline call is n=1 → { ok, results:[one], counts }; correlate by { plan, item }.
    const assigned = await call(assign, { plan: 'demo-plan', item: 'P-001', assignee: 'builder-1' }, ctxA);
    expect(assigned.ok).toBe(true);
    expect(assigned.results[0]).toMatchObject({ ok: true, plan: 'demo-plan', item: 'P-001' });
    expect(assigned.results[0].assignment.assigneeName).toBe('builder-1');

    const mine = await call(myItems, {}, ctxA);
    expect(mine.ok).toBe(true);
    expect(mine.agent_name).toBe('builder-1');
    expect(mine.items.map((m: { assignment: { itemId: string } }) => m.assignment.itemId)).toContain('P-001');

    const claimed = await call(claim, { plan: 'demo-plan', item: 'P-001' }, ctxA);
    expect(claimed.ok).toBe(true);
    expect(claimed.results[0].ok).toBe(true);
    expect(claimed.results[0].result.status).toBe('claimed');

    const hb = await call(heartbeat, { plan: 'demo-plan', item: 'P-001', kind: 'activity' }, ctxA);
    expect(hb.results[0].held).toBe(true);

    const st = await call(status, { plan: 'demo-plan' }, ctxA);
    const p1 = st.items.find((i: { itemId: string }) => i.itemId === 'P-001');
    expect(p1.disposition).toBe('active');

    const rel = await call(release, { plan: 'demo-plan', item: 'P-001' }, ctxA);
    expect(rel.results[0].released).toBe(true);
  });

  it('assign validates the item exists in the plan (per-item error under the envelope)', async () => {
    // A throw from the store becomes that item's { ok:false, error } — the batch
    // never throws (runBulk), top-level ok stays true, counts.failed is the truth.
    const env = await call(assign, { plan: 'demo-plan', item: 'P-999', assignee: 'builder-1' }, ctxA);
    expect(env.ok).toBe(true);
    expect(env.counts).toEqual({ ok: 0, failed: 1 });
    expect(env.results[0]).toMatchObject({ ok: false, plan: 'demo-plan', item: 'P-999' });
    expect(String(env.results[0].error)).toMatch(/not found/);
  });

  it('a different session cannot claim another name’s assigned item (policy via dispatch)', async () => {
    await call(adoptName, { name: 'builder-1' }, ctxA);
    await call(assign, { plan: 'demo-plan', item: 'P-001', assignee: 'builder-1' }, ctxA);
    // ctxB has not adopted builder-1 → refused (per item, top-level ok stays true).
    const env = await call(claim, { plan: 'demo-plan', item: 'P-001' }, ctxB);
    expect(env.ok).toBe(true);
    expect(env.results[0].ok).toBe(false);
    expect(env.results[0].result.status).toBe('refused');
  });

  it('my_items without an adopted name (and no explicit) errors clearly', async () => {
    await expect(call(myItems, {}, ctxB)).rejects.toThrow(/no agent-name/);
  });

  it('cross-user assign to another user’s name is refused (D-005 pull-only)', async () => {
    // ctxA registers builder-1 under user sess-A by adopting+assigning.
    await call(adoptName, { name: 'builder-1' }, ctxA);
    await call(assign, { plan: 'demo-plan', item: 'P-001', assignee: 'builder-1' }, ctxA);
    // ctxB (a different user) tries to assign to builder-1 → refused per item.
    const env = await call(assign, { plan: 'demo-plan', item: 'P-002', assignee: 'builder-1' }, ctxB);
    expect(env.ok).toBe(true);
    expect(env.results[0].ok).toBe(false);
    expect(String(env.results[0].refused)).toMatch(/another user/);
  });
});
