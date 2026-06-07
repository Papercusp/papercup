/**
 * features:search — branch selection + arg-binding tests.
 *
 * `ctx.tx` is mocked as a sql template tag capturing the query text and
 * bound values. The logic under test:
 *   - invalid slug → `{ data: [], degraded: true }` (no query fired)
 *   - a non-empty `query` selects the FTS branch (plainto_tsquery +
 *     ts_rank_cd); whitespace-only / absent query selects the recency
 *     branch (rank hardcoded 0)
 *   - `status` binds null when omitted; the literal value when set
 *   - `tags` are filtered to non-empty strings; the emptiness boolean and
 *     the array are both bound
 *   - a query error degrades with the sliced message instead of throwing
 *   - arg schema: limit default 25 / max 100
 *
 * SQL semantics aren't exercised (no live PG) — only branch choice +
 * binding + the degraded envelope.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import tool from './search';

let lastText = '';
let lastValues: unknown[] = [];
let nextRows: unknown[] = [];
let failNext: Error | null = null;
let queriesFired = 0;

const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
  queriesFired += 1;
  lastText = strings.join(' ');
  lastValues = values;
  if (failNext) return Promise.reject(failNext);
  return Promise.resolve(nextRows);
};

const CTX = () =>
  ({
    principal: { slug: 'op', workspaceId: 'ws_1' },
    tx,
    log: vi.fn(),
  }) as never;

const ARGS = (over: Record<string, unknown> = {}) =>
  tool.args.parse({ slug: 'sheets', ...over }) as never;

beforeEach(() => {
  lastText = '';
  lastValues = [];
  nextRows = [];
  failNext = null;
  queriesFired = 0;
});

describe('features:search — degraded paths', () => {
  it('rejects an invalid slug without querying', async () => {
    const res = await tool.handler(ARGS({ slug: 'not a slug!' }), CTX());
    expect(res).toEqual({
      data: [],
      degraded: true,
      degradedReasons: ['invalid slug "not a slug!"'],
    });
    expect(queriesFired).toBe(0);
  });

  it('degrades with the sliced error message when the query throws', async () => {
    failNext = new Error('relation does not exist'.padEnd(300, '!'));
    const res = await tool.handler(ARGS(), CTX());
    expect(res.data).toEqual([]);
    expect(res.degraded).toBe(true);
    const reason = (res.degradedReasons as string[])[0];
    expect(reason.startsWith('features:search query failed: relation does not exist')).toBe(true);
    // message sliced to 200 chars + the fixed prefix
    expect(reason.length).toBeLessThanOrEqual('features:search query failed: '.length + 200);
  });
});

describe('features:search — branch selection', () => {
  it('uses the FTS branch when a query is supplied', async () => {
    await tool.handler(ARGS({ query: 'auth tokens' }), CTX());
    expect(lastText).toContain('plainto_tsquery');
    expect(lastText).toContain('ts_rank_cd');
    expect(lastValues).toContain('auth tokens');
  });

  it('uses the recency branch when query is omitted', async () => {
    await tool.handler(ARGS(), CTX());
    expect(lastText).not.toContain('plainto_tsquery');
    expect(lastText).toContain('updated_ts DESC');
  });

  it('treats a whitespace-only query as no query', async () => {
    await tool.handler(ARGS({ query: '   ' }), CTX());
    expect(lastText).not.toContain('plainto_tsquery');
  });

  it('returns the rows verbatim', async () => {
    nextRows = [
      { feature_id: 'F-1', title: 'T', summary: null, status: 'todo', tags: ['a'], updated_ts: 5, rank: 0 },
    ];
    const res = await tool.handler(ARGS(), CTX());
    expect(res.data).toEqual(nextRows);
    expect(res.degraded).toBeUndefined();
  });
});

describe('features:search — filter binding', () => {
  it('binds status as null when omitted', async () => {
    await tool.handler(ARGS(), CTX());
    expect(lastValues).toContain(null);
  });

  it('binds the status literal when set', async () => {
    await tool.handler(ARGS({ status: 'passed' }), CTX());
    expect(lastValues).toContain('passed');
  });

  it('drops empty-string tags and binds the cleaned array + its emptiness flag', async () => {
    // The schema rejects '' entries; the handler's own filter is the
    // defensive layer for direct calls — exercise it by bypassing parse.
    await tool.handler({ slug: 'sheets', tags: ['auth', ''], limit: 25 } as never, CTX());
    expect(lastValues).toContainEqual(['auth']);
    expect(lastValues).toContain(false); // tags.length === 0 → false
  });

  it('binds the emptiness flag true for an all-empty tags array', async () => {
    await tool.handler(ARGS({ tags: [] }), CTX());
    expect(lastValues).toContain(true);
  });

  it('binds the limit', async () => {
    await tool.handler(ARGS({ limit: 7 }), CTX());
    expect(lastValues).toContain(7);
  });
});

describe('features:search — arg schema', () => {
  it('defaults limit to 25 and caps at 100', () => {
    expect(tool.args.parse({ slug: 's' }).limit).toBe(25);
    expect(() => tool.args.parse({ slug: 's', limit: 101 })).toThrow();
    expect(() => tool.args.parse({ slug: 's', limit: 0 })).toThrow();
  });

  it('rejects empty-string tag entries at the schema layer', () => {
    expect(() => tool.args.parse({ slug: 's', tags: [''] })).toThrow();
  });
});
