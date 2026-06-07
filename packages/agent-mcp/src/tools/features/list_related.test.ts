/**
 * features:list_related — source-lookup + coercion + degraded-path tests.
 *
 * The handler runs two queries: a source-feature lookup (tags + see_also)
 * and the related-rows union. `ctx.tx` is mocked as a sql template tag
 * routing on the query text. The logic under test:
 *   - invalid slug → `{ data: [], degraded: true }` (no query fired)
 *   - source not found (or its lookup rejecting — `.catch(() => [])`)
 *     → degraded `source feature <id> not found`
 *   - tags JSONB coercion: non-array → [], mixed-type arrays keep only
 *     strings; see_also non-array → []
 *   - source with no tags AND no see_also → `{ data: [], degraded: false }`
 *     WITHOUT firing the second query
 *   - srcTags / srcSeeAlso / the tag-emptiness flag are bound to the
 *     related query
 *   - a related-query error degrades with the sliced message
 *   - arg schema: limit default 5 / max 20
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import tool from './list_related';

let srcRows: Array<{ tags: unknown; see_also: string[] | null }> = [];
let srcReject = false;
let relatedRows: unknown[] = [];
let relatedFail: Error | null = null;
let relatedValues: unknown[] | null = null;
let relatedFired = 0;

const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join(' ');
  if (text.includes('SELECT tags, see_also')) {
    return srcReject ? Promise.reject(new Error('src boom')) : Promise.resolve(srcRows);
  }
  relatedFired += 1;
  relatedValues = values;
  if (relatedFail) return Promise.reject(relatedFail);
  return Promise.resolve(relatedRows);
};

const CTX = () =>
  ({
    principal: { slug: 'op', workspaceId: 'ws_1' },
    tx,
    log: vi.fn(),
  }) as never;

const ARGS = (over: Record<string, unknown> = {}) =>
  tool.args.parse({ slug: 'sheets', feature_id: 'F-001', ...over }) as never;

beforeEach(() => {
  srcRows = [];
  srcReject = false;
  relatedRows = [];
  relatedFail = null;
  relatedValues = null;
  relatedFired = 0;
});

describe('features:list_related — degraded paths', () => {
  it('rejects an invalid slug without querying', async () => {
    const res = await tool.handler(ARGS({ slug: '!!' }), CTX());
    expect(res).toEqual({ data: [], degraded: true, degradedReasons: ['invalid slug "!!"'] });
    expect(relatedFired).toBe(0);
  });

  it('degrades when the source feature is missing', async () => {
    const res = await tool.handler(ARGS(), CTX());
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons).toEqual(['source feature F-001 not found']);
    expect(relatedFired).toBe(0);
  });

  it('treats a rejecting source lookup as not-found (catch → [])', async () => {
    srcReject = true;
    const res = await tool.handler(ARGS(), CTX());
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons).toEqual(['source feature F-001 not found']);
  });

  it('degrades with the sliced message when the related query throws', async () => {
    srcRows = [{ tags: ['a'], see_also: null }];
    relatedFail = new Error('boom');
    const res = await tool.handler(ARGS(), CTX());
    expect(res.data).toEqual([]);
    expect(res.degraded).toBe(true);
    expect((res.degradedReasons as string[])[0]).toBe('features:list_related query failed: boom');
  });
});

describe('features:list_related — source coercion + short-circuit', () => {
  it('returns empty NON-degraded without the second query when src has no tags/see_also', async () => {
    srcRows = [{ tags: null, see_also: null }];
    const res = await tool.handler(ARGS(), CTX());
    expect(res).toEqual({ data: [], degraded: false });
    expect(relatedFired).toBe(0);
  });

  it('treats a non-array tags value as empty', async () => {
    srcRows = [{ tags: 'oops-not-an-array', see_also: null }];
    const res = await tool.handler(ARGS(), CTX());
    expect(res).toEqual({ data: [], degraded: false });
    expect(relatedFired).toBe(0);
  });

  it('keeps only string entries from a mixed-type tags array', async () => {
    srcRows = [{ tags: ['auth', 42, null, 'ui'], see_also: null }];
    await tool.handler(ARGS(), CTX());
    expect(relatedFired).toBe(1);
    expect(relatedValues).toContainEqual(['auth', 'ui']);
  });

  it('runs on see_also alone (empty tags) and binds the emptiness flag false', async () => {
    srcRows = [{ tags: null, see_also: ['F-002'] }];
    relatedRows = [
      { feature_id: 'F-002', title: 'T', status: 'todo', tags: null, updated_ts: 1, relation_kind: 'see_also' },
    ];
    const res = await tool.handler(ARGS(), CTX());
    expect(res.data).toEqual(relatedRows);
    expect(relatedValues).toContainEqual(['F-002']);
    // srcTags.length > 0 → false bound for the tag-overlap arm
    expect(relatedValues).toContain(false);
  });

  it('binds the limit and excludes nothing client-side (rows verbatim)', async () => {
    srcRows = [{ tags: ['a'], see_also: ['F-009'] }];
    relatedRows = [
      { feature_id: 'F-009', title: 'X', status: 'passed', tags: ['a'], updated_ts: 9, relation_kind: 'both' },
    ];
    const res = await tool.handler(ARGS({ limit: 11 }), CTX());
    expect(relatedValues).toContain(11);
    expect(res.data).toEqual(relatedRows);
    expect(res.degraded).toBeUndefined();
  });
});

describe('features:list_related — arg schema', () => {
  it('defaults limit to 5 and caps at 20', () => {
    expect(tool.args.parse({ slug: 's', feature_id: 'F-1' }).limit).toBe(5);
    expect(() => tool.args.parse({ slug: 's', feature_id: 'F-1', limit: 21 })).toThrow();
    expect(() => tool.args.parse({ slug: 's', feature_id: 'F-1', limit: 0 })).toThrow();
  });
});
