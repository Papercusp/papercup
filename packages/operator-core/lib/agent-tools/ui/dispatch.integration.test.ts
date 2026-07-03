/**
 * dispatch.integration.test.ts — the ui:dispatch MCP tool handler, against a real
 * Postgres. It's a request/response over harness_shared.ui_intents: INSERT a
 * pending intent, poll until a browser tab flips its status, else time out.
 *
 * Regression for EI-6861 ("Tool ui:dispatch returns a structural error —
 * null-value-in-column-workspace-id"): migration 453 added a NOT NULL
 * workspace_id to harness_shared.ui_intents, and the tool must stamp it via
 * activeWorkspaceId() on every insert. This test recreates the table WITH that
 * NOT NULL constraint, so if a refactor ever drops workspace_id from the insert
 * again the INSERT throws and this test fails — the exact class that reached the
 * shared DB during the migration's deploy-ordering window (old 4-column code
 * inserting NULL). A fake-sql unit test cannot prove the constraint is satisfied.
 *
 * Also proves: `args` is stored as a real jsonb OBJECT (::text::jsonb) with
 * requested_by from the principal; the poll returns the response once status
 * leaves 'pending'; with no responder it times out (row → status=timeout).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
// uiCrossWorkspaceBlock is flag-gated (papercusp-ui-workspace-guard, default OFF).
// Keep it OFF so the handler exercises the insert path directly (no ui_clients dep).
vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => false }));

const dispatchTool = (await import('./dispatch')).default;
const call = (args: Record<string, unknown>, ctx: Record<string, unknown> = { principal: { slug: 'tester' } }) =>
  dispatchTool.handler(args as never, ctx as never) as Promise<{ isError?: boolean; content: { text: string }[] }>;

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `ui_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 2, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // Mirrors harness_shared.ui_intents including migration 453's NOT NULL
  // workspace_id — the constraint EI-6861 tripped on.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.ui_intents (
      id BIGSERIAL PRIMARY KEY,
      client_id text NOT NULL, intent text NOT NULL,
      args jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'pending', result jsonb, error_message text,
      requested_by text, workspace_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.ui_intents RESTART IDENTITY`;
});

// Concurrent "browser tab": flip the first pending intent to a terminal status.
async function respond(status: string, result: unknown) {
  for (let i = 0; i < 300; i++) {
    const r = await rootSql`UPDATE harness_shared.ui_intents SET status=${status}, result=${rootSql.json(result as never)}, completed_at=now() WHERE status='pending' RETURNING id`;
    if (r.length) return;
    await new Promise((res) => setTimeout(res, 10));
  }
}

describe('ui:dispatch handler (PG)', () => {
  it('stamps a non-null workspace_id and stores the intent (jsonb args + requested_by), returning the response when a tab answers', async () => {
    const [res] = await Promise.all([
      call({ client_id: 'c1', intent: 'set_url', args: { params: { tab: 'plans' } }, timeout_ms: 3000 }),
      respond('done', { navigated: true }),
    ]);
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ status: 'done', result: { navigated: true } });
    expect(res.isError).toBeFalsy();
    const row = (await rootSql<{ typ: string; tab: string; requested_by: string; workspace_id: string | null }[]>`
      SELECT jsonb_typeof(args) AS typ, args->'params'->>'tab' AS tab, requested_by, workspace_id FROM harness_shared.ui_intents`)[0]!;
    // Regression (EI-6861): the insert MUST supply a non-null workspace_id. With
    // the NOT NULL column, an insert that omitted it would already have thrown above.
    expect(row.workspace_id).toBeTruthy();
    expect(typeof row.workspace_id).toBe('string');
    expect(row.typ).toBe('object'); // args is a real jsonb object (::text::jsonb), not a string scalar
    expect(row.tab).toBe('plans');
    expect(row.requested_by).toBe('tester'); // principal.slug
  });

  it('times out when no tab answers: row → status=timeout, isError returned', async () => {
    const res = await call({ client_id: 'nobody', intent: 'set_url', args: {}, timeout_ms: 250 });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text).status).toBe('timeout');
    const row = (await rootSql<{ status: string; workspace_id: string | null }[]>`
      SELECT status, workspace_id FROM harness_shared.ui_intents`)[0]!;
    expect(row.status).toBe('timeout'); // the timeout UPDATE fired
    expect(row.workspace_id).toBeTruthy(); // still stamped even on the timeout path
  });
});
