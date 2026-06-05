/**
 * Smoke tests for the ported `dev` family — validation branches +
 * SQL playground safety gate. Heavy PG / drizzle / spawn paths are
 * mocked at the boundary.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));
vi.mock('../../auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => ({
    kind: 'user', slug: 'user:dev', workspaceId: 'ws',
    authMethod: 'cookie', trust: 'verified',
    capabilities: new Set<string>(), id: 'u1',
  })),
  PrincipalCheckError: class PrincipalCheckError extends Error {
    constructor(public status: number, public reason: string) { super(reason); }
  },
}));
vi.mock('../../process-kill', () => ({ killProcess: vi.fn(async () => ({ ok: true, pid: 1 })) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws' }));
vi.mock('@papercusp/db-org', async (orig) => ({
  // Keep real `generated`/`schemaOf` (side-effect-free schema defs) so route
  // modules importing them don't trip vitest's strict named-export check; the
  // overrides below stub the connection/workspace seams.
  ...((await orig()) as object),
  getOrgPg: vi.fn(() => ({
    sql: Object.assign(
      (_s: TemplateStringsArray) => Promise.resolve([]),
      { begin: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({
        unsafe: vi.fn(async () => []),
      })) },
    ),
    db: { select: () => ({ from: () => ({ limit: () => ({ offset: () => Promise.resolve([]) }) }) }) },
  })),
  withWorkspace: vi.fn(async (_ws: string, _cb: unknown) => {}),
  withWorkspaceQuery: vi.fn(async () => ({ rows: [], n: 0 })),
}));

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import devSql from '../routes/dev/sql';
import devProcessesKill from '../routes/dev/processes-kill';
import devTables from '../routes/dev/tables';
import devTableSchema from '../routes/dev/table-schema';
import devTableRows from '../routes/dev/table-rows';
import devDrizzleStudio from '../routes/dev/drizzle-studio';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

function appWith(entry: AnyRoute | AnyRoute[]): Hono {
  const app = new Hono();
  for (const def of Array.isArray(entry) ? entry : [entry]) registerRoute(app, def);
  return app;
}
const post = (body: object | string) => ({
  method: 'POST',
  body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});

afterEach(() => vi.clearAllMocks());

describe('dev family ports', () => {
  it('GET /dev/tables returns the table list', async () => {
    const res = await appWith(devTables as AnyRoute).request('/dev/tables');
    expect(res.status).toBe(200);
    // The route enumerates the real `generated` schema (now in scope via the
    // db-org mock spread), so the list is non-empty + shaped {name, exportName,
    // columnCount}. The old `[]` expectation was an artifact of an empty mock.
    const tables = (await res.json()).tables as Array<{ name: string; exportName: string; columnCount: number }>;
    expect(tables.length).toBeGreaterThan(0);
    expect(tables[0]).toMatchObject({
      name: expect.any(String),
      exportName: expect.any(String),
      columnCount: expect.any(Number),
    });
  });

  it('GET /dev/tables/:exportName returns 404 for unknown table', async () => {
    const res = await appWith(devTableSchema as AnyRoute).request('/dev/tables/nope');
    expect(res.status).toBe(404);
  });

  it('GET /dev/tables/:exportName/rows returns 404 for unknown table', async () => {
    const res = await appWith(devTableRows as AnyRoute).request('/dev/tables/nope/rows');
    expect(res.status).toBe(404);
  });

  it('POST /dev/sql rejects invalid JSON', async () => {
    const res = await appWith(devSql as AnyRoute).request('/dev/sql', post('not json'));
    expect(res.status).toBe(400);
  });

  it('POST /dev/sql rejects missing sql field with validation error', async () => {
    const res = await appWith(devSql as AnyRoute).request('/dev/sql', post({}));
    expect(res.status).toBe(400);
  });

  it('POST /dev/sql rejects INSERT (safety gate)', async () => {
    const res = await appWith(devSql as AnyRoute).request('/dev/sql', post({ sql: 'INSERT INTO t VALUES (1)' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/rejected/);
  });

  it('POST /dev/sql rejects UPDATE (safety gate)', async () => {
    const res = await appWith(devSql as AnyRoute).request('/dev/sql', post({ sql: 'UPDATE t SET x=1' }));
    expect(res.status).toBe(400);
  });

  it('POST /dev/sql accepts SELECT (passes safety gate)', async () => {
    const res = await appWith(devSql as AnyRoute).request('/dev/sql', post({ sql: 'SELECT 1' }));
    // 200 with empty result or 400 if the mocked tx rejects — either way NOT a safety-gate rejection.
    const body = await res.json();
    expect(body.error?.toString() ?? '').not.toMatch(/rejected/);
  });

  it('POST /dev/sql accepts WITH cte (passes safety gate)', async () => {
    const res = await appWith(devSql as AnyRoute).request('/dev/sql', post({ sql: 'WITH x AS (SELECT 1) SELECT * FROM x' }));
    const body = await res.json();
    expect(body.error?.toString() ?? '').not.toMatch(/rejected/);
  });

  it('POST /dev/processes/kill rejects missing pid with 400', async () => {
    const res = await appWith(devProcessesKill as AnyRoute).request('/dev/processes/kill', post({}));
    expect(res.status).toBe(400);
  });

  it('POST /dev/processes/kill returns 200 with valid pid', async () => {
    const res = await appWith(devProcessesKill as AnyRoute).request('/dev/processes/kill', post({ pid: 12345 }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('GET /dev/drizzle-studio returns status (not running)', async () => {
    const res = await appWith(devDrizzleStudio as AnyRoute[]).request('/dev/drizzle-studio');
    expect(res.status).toBe(200);
    expect((await res.json()).running).toBe(false);
  });

  it('DELETE /dev/drizzle-studio returns not-running when no proc', async () => {
    const res = await appWith(devDrizzleStudio as AnyRoute[]).request('/dev/drizzle-studio', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await res.json()).running).toBe(false);
  });
});
