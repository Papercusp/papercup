/**
 * messages:inbox — PURE unit tests for the handler's security + shaping
 * logic, exercised directly (not through the dispatcher, whose content
 * wrapper would drop the degraded envelope).
 *
 * Focus:
 *   - SLUG_RE reject → degraded envelope (blocks SQL-identifier injection
 *     into `harness_<slug>` before any query runs).
 *   - slug → schema-identifier transform (`-`→`_`, lowercase) is fed to
 *     ctx.tx() as an identifier (not interpolated as a value).
 *   - FEATURE_ID_RE arg-schema rejection (zod regex).
 *   - summary projection shape.
 *   - catch → degraded.
 *
 * The handler uses `ctx.tx` two ways: as an identifier fn (`ctx.tx('harness_x')`)
 * and as a tagged-template query (`ctx.tx\`SELECT ...\``). The mock records
 * both call shapes.
 */

import { describe, expect, it, vi } from 'vitest';
import tool from './inbox';

interface TxMock {
  /** Identifier strings passed to ctx.tx('ident'). */
  idents: string[];
  /** The query template's static string parts (first call only). */
  lastQueryStrings: string[] | null;
  /** The interpolated values of the query template (first call only). */
  lastQueryValues: unknown[] | null;
}

/**
 * Build a `ctx.tx` that behaves like a postgres-js client used both as a
 * tagged template AND as an identifier helper. When invoked as a tagged
 * template (`tx\`...\``), the first arg is a TemplateStringsArray; we
 * resolve to `rows`. When invoked as `tx('schema_ident')`, the first arg
 * is a plain string; we return a tagged sentinel so callers can tell the
 * two apart.
 */
function makeTx(opts: { rows?: unknown[]; throwOnQuery?: boolean } = {}) {
  const state: TxMock = {
    idents: [],
    lastQueryStrings: null,
    lastQueryValues: null,
  };
  const tx = (first: unknown, ...rest: unknown[]) => {
    // Tagged-template invocation: first arg is the strings array.
    if (Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, 'raw')) {
      state.lastQueryStrings = [...(first as unknown as string[])];
      state.lastQueryValues = rest;
      if (opts.throwOnQuery) return Promise.reject(new Error('relation "messages" does not exist'));
      return Promise.resolve(opts.rows ?? []);
    }
    // Identifier invocation: ctx.tx('harness_foo')
    state.idents.push(String(first));
    return { __ident: String(first) };
  };
  return { tx, state };
}

const CTX = (tx: unknown) => ({
  principal: { slug: 'op', workspaceId: 'default' } as never,
  tx: tx as never,
  log: vi.fn(),
});

describe('messages:inbox — SLUG_RE security reject', () => {
  it('rejects a slug with a SQL-injection identifier payload before querying', async () => {
    const { tx, state } = makeTx();
    const res = await tool.handler(
      { slug: 'foo"; DROP SCHEMA x; --', detail: 'summary', status: 'pending', limit: 50 } as never,
      CTX(tx) as never,
    );
    expect(res.degraded).toBe(true);
    expect(res.data).toEqual([]);
    expect(res.degradedReasons?.[0]).toContain('invalid slug');
    // The injection string is echoed back JSON-quoted — and no query/ident
    // call was ever made (rejected before touching ctx.tx).
    expect(res.degradedReasons?.[0]).toContain(JSON.stringify('foo"; DROP SCHEMA x; --'));
    expect(state.idents).toEqual([]);
    expect(state.lastQueryStrings).toBeNull();
  });

  it('rejects a slug containing whitespace', async () => {
    const { tx } = makeTx();
    const res = await tool.handler(
      { slug: 'has space', detail: 'summary', status: 'pending', limit: 50 } as never,
      CTX(tx) as never,
    );
    expect(res.degraded).toBe(true);
  });
});

describe('messages:inbox — slug → schema-identifier transform', () => {
  it('lowercases and rewrites hyphens to underscores, fed to ctx.tx as an identifier', async () => {
    const { tx, state } = makeTx({ rows: [] });
    await tool.handler(
      { slug: 'My-Cool-Harness', detail: 'summary', status: 'pending', limit: 50 } as never,
      CTX(tx) as never,
    );
    // Migration 044: `harness_` || lower(replace(slug,'-','_'))
    expect(state.idents).toContain('harness_my_cool_harness');
  });

  it('REJECTS a dotted slug before any identifier/query call (audit P-029)', async () => {
    // Harness slugs are [a-z0-9-] (migration 044 derives the schema with
    // only hyphen→underscore mapping). A dot used to survive SLUG_RE into
    // the schema identifier — postgres-js splits dotted identifiers into
    // qualified parts, so 'Repo.V2' addressed a DIFFERENT schema.table
    // than any real harness schema. The grammar now rejects dots outright.
    const { tx, state } = makeTx({ rows: [] });
    const res = await tool.handler(
      { slug: 'Repo.V2', detail: 'summary', status: 'pending', limit: 50 } as never,
      CTX(tx) as never,
    );
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons?.[0]).toContain('invalid slug');
    expect(state.idents).toEqual([]);
    expect(state.lastQueryStrings).toBeNull();
  });

  it('the identifier transform itself never lets a non-[a-z0-9_] char through', async () => {
    // Defense-in-depth behind the SLUG_RE gate: the catch-all replace
    // guarantees one plain segment even if the grammar drifts
    // (resources/harness/issues.ts pattern).
    const { tx, state } = makeTx({ rows: [] });
    await tool.handler(
      { slug: 'My-Cool-Harness', detail: 'summary', status: 'pending', limit: 50 } as never,
      CTX(tx) as never,
    );
    for (const ident of state.idents) {
      expect(ident).toMatch(/^harness_[a-z0-9_]+$/);
    }
  });
});

describe('messages:inbox — FEATURE_ID_RE arg-schema rejection', () => {
  it('rejects a malformed feature_id at the zod boundary', () => {
    const parsed = tool.args.safeParse({ slug: 'ok', feature_id: 'lowercase-bad' });
    expect(parsed.success).toBe(false);
  });

  it('accepts a well-formed F-XXX feature_id', () => {
    const parsed = tool.args.safeParse({ slug: 'ok', feature_id: 'F-AUTH-001' });
    expect(parsed.success).toBe(true);
  });

  it('rejects a feature_id that does not start with an uppercase letter', () => {
    const parsed = tool.args.safeParse({ slug: 'ok', feature_id: '1-NOPE' });
    expect(parsed.success).toBe(false);
  });
});

describe('messages:inbox — summary projection', () => {
  it('maps rows to {id,from,feature,kind,subject} in summary detail', async () => {
    const row = {
      id: 'm1',
      created_at: '2026-06-04',
      from_slug: 'sender',
      from_feature_id: null,
      to_role: 'worker',
      to_feature_id: 'F-X-1',
      kind: 'directive',
      subject: 'do the thing',
      body: 'long body text',
      status: 'pending',
      parent_message_id: null,
    };
    const { tx } = makeTx({ rows: [row] });
    const res = await tool.handler(
      { slug: 'ok', detail: 'summary', status: 'pending', limit: 50 } as never,
      CTX(tx) as never,
    );
    expect(res.data).toEqual([
      { id: 'm1', from: 'sender', feature: 'F-X-1', kind: 'directive', subject: 'do the thing' },
    ]);
    // `body` is dropped from the summary projection.
    expect(JSON.stringify(res.data)).not.toContain('long body text');
  });

  it('full detail returns the raw rows untouched', async () => {
    const row = { id: 'm1', body: 'kept', subject: 's' };
    const { tx } = makeTx({ rows: [row] });
    const res = await tool.handler(
      { slug: 'ok', detail: 'full', status: 'all', limit: 50 } as never,
      CTX(tx) as never,
    );
    expect(res.data).toEqual([row]);
  });
});

describe('messages:inbox — query failure → degraded', () => {
  it('catches a thrown query and returns a degraded envelope (no throw)', async () => {
    const { tx } = makeTx({ throwOnQuery: true });
    const res = await tool.handler(
      { slug: 'ok', detail: 'summary', status: 'pending', limit: 50 } as never,
      CTX(tx) as never,
    );
    expect(res.degraded).toBe(true);
    expect(res.data).toEqual([]);
    expect(res.degradedReasons?.[0]).toContain('not readable');
    expect(res.degradedReasons?.[0]).toContain('does not exist');
  });
});
