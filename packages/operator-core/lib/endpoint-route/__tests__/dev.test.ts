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
import devSql, { __test__ as sqlInternals } from '../routes/dev/sql';
import { requirePrincipal, PrincipalCheckError } from '../../auth/require-principal';
import { getOrgPg } from '@papercusp/db-org';
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

/**
 * Gap 3 — the SQL allowlist is a SECURITY boundary, and its real attack
 * surface is `splitStatements` + the per-statement gate, NOT the
 * single-leading-keyword check the smoke tests above cover. These drive the
 * exported allowlist primitives directly AND assert end-to-end that the
 * mutator never reaches the DB (spy on `tx.unsafe`).
 *
 * The gate, statement-by-statement, must reject if ANY statement either (a)
 * has a non-allowlisted leading keyword, or (b) — the scary case — leads
 * with an allowed keyword (`WITH`) but carries a data-modifying body.
 */
describe('dev/sql allowlist — adversarial split / CTE / comment / dollar-quote', () => {
  const { leadingKeyword, splitStatements, isDataModifying } = sqlInternals;

  // A tx.unsafe spy lets us assert the DB-level outcome: a rejected request
  // must 400 *before* any statement is handed to the connection. Returns the
  // spy so each test can assert it was never called.
  function installTxSpy() {
    const unsafe = vi.fn(async () => [] as unknown[]);
    vi.mocked(getOrgPg).mockReturnValue({
      sql: Object.assign(
        (_s: TemplateStringsArray) => Promise.resolve([]),
        { begin: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ unsafe })) },
      ),
      // db is unused on the sql path but keep the shape consistent with the mock.
      db: { select: () => ({ from: () => ({ limit: () => ({ offset: () => Promise.resolve([]) }) }) }) },
    } as unknown as ReturnType<typeof getOrgPg>);
    return unsafe;
  }

  async function callSql(sql: string) {
    const unsafe = installTxSpy();
    const res = await appWith(devSql as AnyRoute).request('/dev/sql', post({ sql }));
    const body = await res.json();
    return { res, body, unsafe };
  }

  // (a) benign leader + trailing mutator. The splitter MUST isolate the 2nd
  // statement so the gate sees DELETE as a leading keyword and rejects.
  it('(a) rejects "SELECT 1; DELETE …" — splitter isolates the trailing mutator', async () => {
    const sql = 'SELECT 1; DELETE FROM harness_shared.work_items';
    // primitive-level: two statements, second leads with DELETE.
    const parts = splitStatements(sql);
    expect(parts).toEqual(['SELECT 1', 'DELETE FROM harness_shared.work_items']);
    expect(leadingKeyword(parts[1])).toBe('DELETE');
    // end-to-end: 400 rejected, mutator never reached the DB.
    const { res, body, unsafe } = await callSql(sql);
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/rejected/);
    expect(unsafe).not.toHaveBeenCalled();
  });

  // (b) THE SCARY ONE — data-modifying CTE. Leading keyword is the allowed
  // WITH, so the leading-keyword gate alone WOULD let the DELETE through.
  // The data-modifying scan must catch it.
  it('(b) rejects a data-modifying CTE "WITH x AS (DELETE … RETURNING *) SELECT * FROM x"', async () => {
    const sql = 'WITH x AS (DELETE FROM harness_shared.work_items RETURNING *) SELECT * FROM x';
    // The leading-keyword gate by itself is FOOLED — leader is WITH (allowed).
    expect(leadingKeyword(sql)).toBe('WITH');
    expect(ALLOWED_LEADING_HAS(leadingKeyword(sql))).toBe(true);
    // The data-modifying scan is what actually defends here.
    expect(isDataModifying(sql)).toBe(true);
    // end-to-end: 400 rejected, DELETE never reached the DB. THIS asserts the
    // bypass is closed — if it 200s or calls unsafe, the boundary is broken.
    const { res, body, unsafe } = await callSql(sql);
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/rejected/);
    expect(unsafe).not.toHaveBeenCalled();
  });

  // also cover data-modifying CTEs with INSERT / UPDATE / MERGE bodies.
  it.each([
    ['INSERT', 'WITH x AS (INSERT INTO harness_shared.work_items DEFAULT VALUES RETURNING *) SELECT * FROM x'],
    ['UPDATE', 'WITH x AS (UPDATE harness_shared.work_items SET title = $$z$$ RETURNING *) SELECT * FROM x'],
    ['MERGE', 'WITH x AS (MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE) SELECT 1'],
  ])('(b) rejects data-modifying CTE with %s body', async (_kw, sql) => {
    expect(isDataModifying(sql)).toBe(true);
    const { res, body, unsafe } = await callSql(sql);
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/rejected/);
    expect(unsafe).not.toHaveBeenCalled();
  });

  // (c) comment-masked DDL. leadingKeyword skips comments, so the real verb
  // (DROP) is what gets gated.
  it('(c) rejects block-comment-masked DDL "/* SELECT */ DROP TABLE t"', async () => {
    const sql = '/* SELECT */ DROP TABLE harness_shared.work_items';
    expect(leadingKeyword(sql)).toBe('DROP');
    const { res, body, unsafe } = await callSql(sql);
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/rejected/);
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('(c) rejects line-comment-masked DDL "--\\nDROP TABLE t"', async () => {
    const sql = '--\nDROP TABLE harness_shared.work_items';
    expect(leadingKeyword(sql)).toBe('DROP');
    const { res, body, unsafe } = await callSql(sql);
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/rejected/);
    expect(unsafe).not.toHaveBeenCalled();
  });

  // A comment must NOT be able to *create* a false-allow either: a SELECT
  // whose only "DROP" lives inside a comment stays allowed (no false reject),
  // proving stripNoise scans the skeleton, not the raw text.
  it('(c) a SELECT mentioning DROP only inside a comment is NOT mis-rejected', () => {
    expect(isDataModifying('SELECT 1 /* not a real DROP TABLE */')).toBe(false);
    expect(isDataModifying("SELECT 'DELETE FROM x' AS lit")).toBe(false);
    expect(isDataModifying('SELECT 1 -- DROP TABLE t')).toBe(false);
  });

  // (d) dollar-quoted body. A naive splitter would mis-count the `;` inside
  // `$$;$$`; the dollar-quote-aware splitter must keep it in one statement so
  // the trailing real DROP is correctly isolated and rejected.
  it('(d) rejects "SELECT $$;$$; DROP TABLE t" — dollar-quote-aware split isolates DROP', async () => {
    const sql = 'SELECT $$;$$; DROP TABLE harness_shared.work_items';
    const parts = splitStatements(sql);
    expect(parts).toEqual(['SELECT $$;$$', 'DROP TABLE harness_shared.work_items']);
    expect(leadingKeyword(parts[1])).toBe('DROP');
    const { res, body, unsafe } = await callSql(sql);
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/rejected/);
    expect(unsafe).not.toHaveBeenCalled();
  });

  // tagged dollar-quotes too ($tag$ … $tag$) — the `;` inside must not split.
  it('(d) dollar-quoted ";" with a named tag does not falsely split', () => {
    expect(splitStatements('SELECT $q$a;b$q$')).toEqual(['SELECT $q$a;b$q$']);
  });

  // Sanity: legit read-only statements still pass BOTH gates.
  it('legit read-only statements pass the allowlist (no false rejects)', async () => {
    for (const sql of [
      'SELECT 1',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'EXPLAIN SELECT 1',
      'SELECT 1; SELECT 2',
      "SELECT 'delete me' AS msg",
    ]) {
      expect(isDataModifying(sql)).toBe(false);
      for (const part of splitStatements(sql)) {
        expect(leadingKeyword(part)).not.toBeNull();
      }
    }
  });
});

// tiny local helper so test reads like the gate (ALLOWED_LEADING is private).
function ALLOWED_LEADING_HAS(kw: string | null): boolean {
  return kw != null && new Set(['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'TABLE', 'VALUES']).has(kw);
}

/**
 * Gap 4 — the dev/sql trust gate. The smoke suite mocks requirePrincipal
 * permanently-open, so the `auth: { trust: ['verified','trusted'] }` gate is
 * never exercised. Here we make requirePrincipal THROW PrincipalCheckError
 * (untrusted caller) and assert the route 403s BEFORE touching the DB.
 */
describe('dev/sql trust gate (Gap 4)', () => {
  it('returns 403 for an untrusted principal and never opens a transaction', async () => {
    const beginSpy = vi.fn();
    vi.mocked(getOrgPg).mockReturnValue({
      sql: Object.assign(
        (_s: TemplateStringsArray) => Promise.resolve([]),
        { begin: beginSpy },
      ),
      db: { select: () => ({ from: () => ({ limit: () => ({ offset: () => Promise.resolve([]) }) }) }) },
    } as unknown as ReturnType<typeof getOrgPg>);
    vi.mocked(requirePrincipal).mockRejectedValueOnce(new PrincipalCheckError(403, 'untrusted'));

    const res = await appWith(devSql as AnyRoute).request('/dev/sql', post({ sql: 'SELECT 1' }));

    expect(res.status).toBe(403);
    expect(beginSpy).not.toHaveBeenCalled();
  });
});
