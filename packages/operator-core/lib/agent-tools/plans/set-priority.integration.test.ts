/**
 * set-priority.integration.test.ts — the plans:set-priority MCP tool handler,
 * against a real Postgres. Calls tool.handler(args, ctx) directly (the standard
 * way these handlers are unit/integration tested) with withWorkspace bound to the
 * testcontainer.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - the handler UPDATEs harness_plans.op_priority for the (workspace, harness,
 *    plan) row — a number sets the dispatch rank, null clears it;
 *  - it is SCOPED to args.slug — sibling plans are untouched;
 *  - the JSON result echoes slug/harness/priority.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, withWorkspace: async (_ws: string, fn: (tx: postgres.Sql) => unknown) => fn(h.sql) };
});

const setPriorityTool = (await import('./set-priority')).default;
const call = (slug: string, priority: number | null, harness = 'web') =>
  setPriorityTool.handler({ slug, priority, harness } as never, {} as never);

let rootSql: postgres.Sql;
const prioOf = async (plan: string, harness = 'web') =>
  (await rootSql<{ op_priority: number | null }[]>`SELECT op_priority FROM harness_shared.harness_plans WHERE harness_slug=${harness} AND plan_slug=${plan}`)[0]?.op_priority;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `sp_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL columns the handler touches (mig 122): op_priority integer, op_updated_at timestamptz.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL,
      op_priority integer, op_updated_at timestamptz,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.harness_plans`;
  // DEFAULT_WORKSPACE_ID is 'default' — seed two plans in harness 'web'.
  await rootSql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, op_priority) VALUES
    ('default', 'web', 'p1', NULL), ('default', 'web', 'p2', 99)`;
});

describe('plans:set-priority handler (PG)', () => {
  it('sets the op_priority for the named plan and echoes it', async () => {
    const res = (await call('p1', 5)) as { content: { text: string }[] };
    expect(await prioOf('p1')).toBe(5);
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ ok: true, slug: 'p1', harnessSlug: 'web', priority: 5 });
  });

  it('a null priority CLEARS the rank', async () => {
    await call('p2', null);
    expect(await prioOf('p2')).toBeNull();
  });

  it('is scoped to args.slug — a sibling plan is untouched', async () => {
    await call('p1', 7);
    expect(await prioOf('p1')).toBe(7);
    expect(await prioOf('p2')).toBe(99); // p2 unchanged
  });
});
