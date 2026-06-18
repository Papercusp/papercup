/**
 * pause.integration.test.ts — the plans:pause MCP tool handler, against a real
 * Postgres (tool.handler called directly; withWorkspace bound to the testcontainer).
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - pause flips op_status to 'paused' ONLY for a STARTED plan — the
 *    `AND op_status IS NOT NULL` guard means a never-started plan (null op_status)
 *    matches 0 rows and returns { notStarted: true } WITHOUT writing 'paused';
 *  - it is scoped to args.slug.
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

const pauseTool = (await import('./pause')).default;
const call = (slug: string, harness = 'web') => pauseTool.handler({ slug, harness } as never, {} as never) as Promise<{ content: { text: string }[] }>;
const statusOf = async (plan: string) =>
  (await rootSql<{ op_status: string | null }[]>`SELECT op_status FROM harness_shared.harness_plans WHERE plan_slug=${plan}`)[0]?.op_status;

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `pp_${randomBytes(5).toString('hex')}`;
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
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL,
      op_status text, op_updated_at timestamptz,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.harness_plans`;
  await rootSql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, op_status) VALUES
    ('default', 'web', 'started-plan', 'started'),
    ('default', 'web', 'never-started', NULL),
    ('default', 'web', 'sibling', 'started')`;
});

describe('plans:pause handler (PG)', () => {
  it('pauses a STARTED plan', async () => {
    const res = await call('started-plan');
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ slug: 'started-plan', status: 'paused' });
    expect(await statusOf('started-plan')).toBe('paused');
  });

  it('a never-started plan (null op_status) returns notStarted and is NOT written', async () => {
    const res = await call('never-started');
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ notStarted: true });
    expect(await statusOf('never-started')).toBeNull(); // still null — the op_status IS NOT NULL guard held
  });

  it('is scoped to args.slug — a sibling started plan is untouched', async () => {
    await call('started-plan');
    expect(await statusOf('sibling')).toBe('started'); // unchanged
  });
});
