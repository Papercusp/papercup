/**
 * features:get — drizzle-path projection + degraded tests.
 *
 * Follows the goals/list.test.ts convention for drizzle-zod tools:
 * `drizzle-orm/postgres-js` is mocked with a chainable thenable builder so
 * the handler's query resolves to fixture rows without PG. The logic under
 * test:
 *   - invalid slug → `{ data: null, degraded: true }` WITHOUT building a
 *     query
 *   - no row → degraded `feature <id> not found in harness <slug>`
 *   - a hit returns the row verbatim as `data`
 *   - the lookup is limited to 1 row
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

let fixtureRows: unknown[] = [];
let limitArg: number | null = null;
let drizzleCalls = 0;

function makeBuilder() {
  const builder: Record<string, unknown> = {};
  const chain = (key: string) =>
    (...args: unknown[]) => {
      if (key === 'limit') limitArg = args[0] as number;
      return builder;
    };
  for (const k of ['select', 'from', 'where', 'limit']) builder[k] = chain(k);
  (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(fixtureRows).then(resolve);
  return builder;
}

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn(() => {
    drizzleCalls += 1;
    return makeBuilder();
  }),
}));

import tool from './get';

const CTX = () =>
  ({
    principal: { slug: 'op', workspaceId: 'ws_1' },
    tx: {} as never,
    log: vi.fn(),
  }) as never;

beforeEach(() => {
  fixtureRows = [];
  limitArg = null;
  drizzleCalls = 0;
});

describe('features:get', () => {
  it('rejects an invalid slug before touching the db', async () => {
    const res = await tool.handler({ slug: 'in valid', feature_id: 'F-1' } as never, CTX());
    expect(res).toEqual({ data: null, degraded: true, degradedReasons: ['invalid slug "in valid"'] });
    expect(drizzleCalls).toBe(0);
  });

  it('degrades when the feature is not found', async () => {
    const res = await tool.handler({ slug: 'sheets', feature_id: 'F-404' } as never, CTX());
    expect(res.data).toBeNull();
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons).toEqual(['feature F-404 not found in harness sheets']);
  });

  it('returns the full row verbatim on a hit, limited to 1', async () => {
    const row = {
      harnessSlug: 'sheets',
      featureId: 'F-001',
      title: 'Auth',
      status: 'todo',
      body: 'full body',
    };
    fixtureRows = [row];
    const res = await tool.handler({ slug: 'sheets', feature_id: 'F-001' } as never, CTX());
    expect(res.data).toEqual(row);
    expect(res.degraded).toBeUndefined();
    expect(limitArg).toBe(1);
  });
});
