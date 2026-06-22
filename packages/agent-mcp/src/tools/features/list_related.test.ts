/**
 * features:list_related — bulk keyed-array contract + source-lookup/coercion tests
 * (bulk-endpoint-standardization-2026-06-21).
 *
 * The per-item op runs two queries: a source-feature lookup (tags + see_also)
 * and the related-rows union. `ctx.tx` is mocked as a sql template tag routing
 * on the query text. The compound key is `(slug, feature_id)` and `limit` rides
 * per item; the handler returns the house envelope
 * `{ ok, results:[{ ok, slug, feature_id, related? | error }], counts }`.
 *
 * The logic under test:
 *   - inline `{ slug, feature_id }` (n=1) → a single result keyed by (slug, feature_id)
 *   - invalid slug → that item's `{ ok:false, error:'invalid slug …' }` (no query fired)
 *   - source not found (or its lookup rejecting — `.catch(() => [])`)
 *     → that item's `{ ok:false, error:'source feature … not found' }`
 *   - tags JSONB coercion: non-array → [], mixed-type arrays keep only strings;
 *     see_also non-array → []
 *   - source with no tags AND no see_also → `{ ok:true, related:[] }` WITHOUT
 *     firing the second query
 *   - srcTags / srcSeeAlso / the tag-emptiness flag are bound to the related query
 *   - a related-query error → that item's `{ ok:false, error: '… query failed: …' }`
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

type Out = { data: any };
const env = async (over: Record<string, unknown> = {}) =>
  ((await tool.handler(ARGS(over), CTX())) as Out).data;
// The single result (the n=1 path always has exactly one result).
const one = async (over: Record<string, unknown> = {}) => (await env(over)).results[0];

beforeEach(() => {
  srcRows = [];
  srcReject = false;
  relatedRows = [];
  relatedFail = null;
  relatedValues = null;
  relatedFired = 0;
});

describe('features:list_related — keyed-array envelope + failure items', () => {
  it('inline { slug, feature_id } returns a single result keyed by (slug, feature_id)', async () => {
    srcRows = [{ tags: ['a'], see_also: ['F-009'] }];
    relatedRows = [{ feature_id: 'F-009', title: 'X', status: 'passed', tags: ['a'], updated_ts: 9, relation_kind: 'both' }];
    const b = await env();
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, slug: 'sheets', feature_id: 'F-001', related: relatedRows });
  });

  it('rejects an invalid slug as that item without querying', async () => {
    const r = await one({ slug: '!!' });
    expect(r).toMatchObject({ ok: false, slug: '!!', feature_id: 'F-001', error: 'invalid slug "!!"' });
    expect(relatedFired).toBe(0);
  });

  it('a missing source feature fails only that item', async () => {
    const r = await one();
    expect(r).toMatchObject({ ok: false, slug: 'sheets', feature_id: 'F-001', error: 'source feature F-001 not found' });
    expect(relatedFired).toBe(0);
  });

  it('treats a rejecting source lookup as not-found (catch → [])', async () => {
    srcReject = true;
    const r = await one();
    expect(r).toMatchObject({ ok: false, error: 'source feature F-001 not found' });
  });

  it('fails the item with the sliced message when the related query throws', async () => {
    srcRows = [{ tags: ['a'], see_also: null }];
    relatedFail = new Error('boom');
    const r = await one();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('features:list_related query failed: boom');
  });

  it('items:[…] runs many; an invalid-slug item fails only itself', async () => {
    srcRows = [{ tags: ['a'], see_also: ['F-009'] }];
    relatedRows = [{ feature_id: 'F-009', title: 'X', status: 'passed', tags: ['a'], updated_ts: 9, relation_kind: 'both' }];
    const b = (
      (await tool.handler(
        tool.args.parse({
          items: [
            { slug: 'sheets', feature_id: 'F-001' },
            { slug: 'bad slug', feature_id: 'F-002' },
          ],
        }) as never,
        CTX(),
      )) as Out
    ).data;
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results.map((r: { feature_id: string; ok: boolean }) => [r.feature_id, r.ok])).toEqual([
      ['F-001', true],
      ['F-002', false],
    ]);
    expect(b.results[1].error).toBe('invalid slug "bad slug"');
  });
});

describe('features:list_related — source coercion + short-circuit', () => {
  it('returns ok with empty related WITHOUT the second query when src has no tags/see_also', async () => {
    srcRows = [{ tags: null, see_also: null }];
    const r = await one();
    expect(r).toMatchObject({ ok: true, related: [] });
    expect(relatedFired).toBe(0);
  });

  it('treats a non-array tags value as empty', async () => {
    srcRows = [{ tags: 'oops-not-an-array', see_also: null }];
    const r = await one();
    expect(r).toMatchObject({ ok: true, related: [] });
    expect(relatedFired).toBe(0);
  });

  it('keeps only string entries from a mixed-type tags array', async () => {
    srcRows = [{ tags: ['auth', 42, null, 'ui'], see_also: null }];
    await one();
    expect(relatedFired).toBe(1);
    expect(relatedValues).toContainEqual(['auth', 'ui']);
  });

  it('runs on see_also alone (empty tags) and binds the emptiness flag false', async () => {
    srcRows = [{ tags: null, see_also: ['F-002'] }];
    relatedRows = [{ feature_id: 'F-002', title: 'T', status: 'todo', tags: null, updated_ts: 1, relation_kind: 'see_also' }];
    const r = await one();
    expect(r.related).toEqual(relatedRows);
    expect(relatedValues).toContainEqual(['F-002']);
    // srcTags.length > 0 → false bound for the tag-overlap arm
    expect(relatedValues).toContain(false);
  });

  it('binds the limit and returns rows verbatim', async () => {
    srcRows = [{ tags: ['a'], see_also: ['F-009'] }];
    relatedRows = [{ feature_id: 'F-009', title: 'X', status: 'passed', tags: ['a'], updated_ts: 9, relation_kind: 'both' }];
    const r = await one({ limit: 11 });
    expect(relatedValues).toContain(11);
    expect(r.related).toEqual(relatedRows);
    expect(r.ok).toBe(true);
  });
});

describe('features:list_related — arg schema', () => {
  it('defaults limit to 5 and caps at 20 (single-call shape)', () => {
    expect(tool.args.parse({ slug: 's', feature_id: 'F-1' }).limit).toBe(5);
    expect(() => tool.args.parse({ slug: 's', feature_id: 'F-1', limit: 21 })).toThrow();
    expect(() => tool.args.parse({ slug: 's', feature_id: 'F-1', limit: 0 })).toThrow();
  });

  it('defaults per-item limit to 5 (items shape)', () => {
    expect(tool.args.parse({ items: [{ slug: 's', feature_id: 'F-1' }] }).items![0].limit).toBe(5);
  });

  it('rejects a call with neither a single key nor items', () => {
    expect(() => tool.args.parse({ limit: 5 })).toThrow();
  });
});
