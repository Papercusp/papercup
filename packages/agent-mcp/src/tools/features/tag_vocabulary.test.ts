/**
 * features:tag_vocabulary — projection + degraded-path tests.
 *
 * `ctx.tx` is mocked as a sql template tag. The logic under test:
 *   - invalid slug → `{ data: [], degraded: true }` (no query fired)
 *   - rows project `{ tag, count }` with the PG bigint count coerced via
 *     `Number(...)` (a JS `bigint` fixture exercises the cast)
 *   - a query error degrades with the sliced message instead of throwing
 *   - slug + limit are bound; arg schema: limit default 100 / max 500
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import tool from './tag_vocabulary';

let lastValues: unknown[] = [];
let nextRows: Array<{ tag: string; count: bigint }> = [];
let failNext: Error | null = null;
let queriesFired = 0;

const tx = (_strings: TemplateStringsArray, ...values: unknown[]) => {
  queriesFired += 1;
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
  lastValues = [];
  nextRows = [];
  failNext = null;
  queriesFired = 0;
});

describe('features:tag_vocabulary', () => {
  it('rejects an invalid slug without querying', async () => {
    const res = await tool.handler(ARGS({ slug: 'has space' }), CTX());
    expect(res).toEqual({ data: [], degraded: true, degradedReasons: ['invalid slug "has space"'] });
    expect(queriesFired).toBe(0);
  });

  it('coerces bigint counts to numbers in the projection', async () => {
    nextRows = [
      { tag: 'auth', count: 3n },
      { tag: 'ui', count: 1n },
    ];
    const res = await tool.handler(ARGS(), CTX());
    expect(res.data).toEqual([
      { tag: 'auth', count: 3 },
      { tag: 'ui', count: 1 },
    ]);
    expect(typeof (res.data as Array<{ count: unknown }>)[0].count).toBe('number');
    expect(res.degraded).toBeUndefined();
  });

  it('degrades with the sliced message on a query error', async () => {
    failNext = new Error('jsonb_array_elements_text exploded');
    const res = await tool.handler(ARGS(), CTX());
    expect(res.data).toEqual([]);
    expect(res.degraded).toBe(true);
    expect((res.degradedReasons as string[])[0]).toBe(
      'features:tag_vocabulary query failed: jsonb_array_elements_text exploded',
    );
  });

  it('binds slug and limit', async () => {
    await tool.handler(ARGS({ limit: 42 }), CTX());
    expect(lastValues).toContain('sheets');
    expect(lastValues).toContain(42);
  });

  it('arg schema: limit defaults to 100, caps at 500, must be positive', () => {
    expect(tool.args.parse({ slug: 's' }).limit).toBe(100);
    expect(() => tool.args.parse({ slug: 's', limit: 501 })).toThrow();
    expect(() => tool.args.parse({ slug: 's', limit: 0 })).toThrow();
  });
});
