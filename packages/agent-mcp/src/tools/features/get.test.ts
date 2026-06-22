/**
 * features:get — bulk keyed-array contract tests
 * (bulk-endpoint-standardization-2026-06-21).
 *
 * Follows the goals/list.test.ts convention for drizzle-zod tools:
 * `drizzle-orm/postgres-js` is mocked with a chainable thenable builder so
 * the handler's query resolves to fixture rows without PG. The compound key is
 * `(slug, feature_id)`; the handler returns the house envelope
 * `{ ok, results:[{ ok, slug, feature_id, feature? | error }], counts }`.
 *
 * Per-item routing: the handler calls drizzle(ctx.tx) once per item then
 * filters by featureId via `eq()`. We mock `drizzle-orm`'s `eq` to capture the
 * `F-…` value, and the drizzle builder's thenable resolves the fixture rows for
 * that captured feature id.
 *
 * The logic under test:
 *   - inline `{ slug, feature_id }` (n=1) → a single result keyed by (slug, feature_id)
 *   - `items:[…]` (many) → one result per item, correlated by key
 *   - invalid slug → that item's `{ ok:false, error: 'invalid slug …' }` WITHOUT a query
 *   - no row → that item's `{ ok:false, error: 'feature … not found …' }`
 *   - a hit returns the row verbatim as `feature`
 *   - one bad item never fails the rest (top-level ok stays true)
 *   - the lookup is limited to 1 row per item
 *
 * Run: cd packages/agent-mcp && npx vitest run src/tools/features/get.test.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Per-call fixture: map a feature_id → rows it should resolve to.
let rowsByFeatureId: Map<string, unknown[]> = new Map();
let limitArgs: number[] = [];
let drizzleCalls = 0;
// The feature_id captured from the latest eq(featureId, value) in the builder.
let currentFeatureId = '';

vi.mock('drizzle-orm', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => {
      if (typeof val === 'string' && val.startsWith('F-')) currentFeatureId = val;
      return (actual.eq as (...a: unknown[]) => unknown)(col, val);
    },
  };
});

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn(() => {
    drizzleCalls += 1;
    const builder: Record<string, unknown> = {};
    const chain = (key: string) =>
      (...args: unknown[]) => {
        if (key === 'limit') limitArgs.push(args[0] as number);
        return builder;
      };
    for (const k of ['select', 'from', 'where', 'limit']) builder[k] = chain(k);
    (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(rowsByFeatureId.get(currentFeatureId) ?? []).then(resolve);
    return builder;
  }),
}));

import tool from './get';

type Out = { content: { text: string }[] };
const body = async (args: unknown) =>
  JSON.parse(((await tool.handler(args as never, CTX())) as Out).content[0].text);

const CTX = () =>
  ({
    principal: { slug: 'op', workspaceId: 'ws_1' },
    tx: {} as never,
    log: vi.fn(),
  }) as never;

beforeEach(() => {
  rowsByFeatureId = new Map();
  limitArgs = [];
  drizzleCalls = 0;
  currentFeatureId = '';
});

describe('features:get (bulk keyed-array)', () => {
  it('inline { slug, feature_id } returns a single result, limited to 1', async () => {
    const row = { harnessSlug: 'sheets', featureId: 'F-001', title: 'Auth', status: 'todo', body: 'full body' };
    rowsByFeatureId.set('F-001', [row]);
    const b = await body({ slug: 'sheets', feature_id: 'F-001' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, slug: 'sheets', feature_id: 'F-001', feature: row });
    expect(limitArgs).toContain(1);
  });

  it('rejects an invalid slug as that item without touching the db', async () => {
    const b = await body({ slug: 'in valid', feature_id: 'F-1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({
      ok: false,
      slug: 'in valid',
      feature_id: 'F-1',
      error: 'invalid slug "in valid"',
    });
    // The invalid-slug item short-circuits before building/executing a query:
    // no limit(1) was bound. (drizzle(ctx.tx) is hoisted out of the per-item
    // loop, so drizzleCalls is 1 regardless — the query-skip signal is limitArgs.)
    expect(limitArgs).toEqual([]);
  });

  it('a not-found feature fails only itself', async () => {
    const b = await body({ slug: 'sheets', feature_id: 'F-404' });
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({
      ok: false,
      slug: 'sheets',
      feature_id: 'F-404',
      error: 'feature F-404 not found in harness sheets',
    });
  });

  it('items:[…] fetches many; a not-found / invalid-slug item fails only itself', async () => {
    rowsByFeatureId.set('F-001', [{ featureId: 'F-001', title: 'A' }]);
    rowsByFeatureId.set('F-002', [{ featureId: 'F-002', title: 'B' }]);
    const b = await body({
      items: [
        { slug: 'sheets', feature_id: 'F-001' },
        { slug: 'sheets', feature_id: 'F-404' },
        { slug: 'bad slug', feature_id: 'F-002' },
      ],
    });
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 1, failed: 2 });
    expect(b.results.map((r: { feature_id: string; ok: boolean }) => [r.feature_id, r.ok])).toEqual([
      ['F-001', true],
      ['F-404', false],
      ['F-002', false],
    ]);
    expect(b.results[1].error).toBe('feature F-404 not found in harness sheets');
    expect(b.results[2].error).toBe('invalid slug "bad slug"');
  });
});
