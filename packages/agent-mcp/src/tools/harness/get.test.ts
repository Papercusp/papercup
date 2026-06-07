/**
 * harness:get — summary/full projection + featureCounts assembly.
 *
 * Follows the goals/list.test.ts drizzle-mock convention. The handler runs
 * up to two builder queries (the project row, then — full only — the
 * grouped feature counts); the mock serves fixtures from a FIFO queue. The
 * logic under test:
 *   - not found → `{ data: null, degraded: true }`
 *   - detail:'summary' (the default) projects {slug, name, status,
 *     updated_ts} from the camelCase row — and skips the counts query
 *   - detail:'full' spreads the whole row + assembles featureCounts from
 *     the grouped rows, coercing n via Number and DROPPING null statuses
 *   - arg schema: detail defaults to 'summary', rejects unknown values
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

let fixtureQueue: unknown[][] = [];
let queriesBuilt = 0;

function makeBuilder() {
  // Each builder serves the next fixture in FIFO order — one builder per
  // `.select()` call, so the project-row query and the counts query get
  // their own fixtures.
  const rows = fixtureQueue.shift() ?? [];
  queriesBuilt += 1;
  const builder: Record<string, unknown> = {};
  for (const k of ['from', 'where', 'limit', 'groupBy']) {
    builder[k] = (..._args: unknown[]) => builder;
  }
  (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve);
  return builder;
}

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn(() => ({
    select: (..._args: unknown[]) => makeBuilder(),
  })),
}));

import tool from './get';

const CTX = () =>
  ({
    principal: { slug: 'op', workspaceId: 'ws_1' },
    tx: {} as never,
    log: vi.fn(),
  }) as never;

const PROJECT_ROW = {
  slug: 'sheets',
  name: 'Sheets',
  status: 'active',
  updatedTs: 1765432100000,
  repoPath: '/tmp/sheets',
  extra: 'kept-in-full',
};

beforeEach(() => {
  fixtureQueue = [];
  queriesBuilt = 0;
});

describe('harness:get', () => {
  it('degrades when the harness is missing', async () => {
    fixtureQueue = [[]];
    const res = await tool.handler({ slug: 'nope', detail: 'summary' } as never, CTX());
    expect(res.data).toBeNull();
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons).toEqual(['harness nope not found']);
  });

  it('summary projects {slug, name, status, updated_ts} and skips the counts query', async () => {
    fixtureQueue = [[PROJECT_ROW]];
    const res = await tool.handler({ slug: 'sheets', detail: 'summary' } as never, CTX());
    expect(res.data).toEqual({
      slug: 'sheets',
      name: 'Sheets',
      status: 'active',
      updated_ts: 1765432100000,
    });
    expect(JSON.stringify(res.data)).not.toContain('repoPath');
    expect(queriesBuilt).toBe(1);
  });

  it('full spreads the row and assembles featureCounts, dropping null statuses', async () => {
    fixtureQueue = [
      [PROJECT_ROW],
      [
        { status: 'passed', n: 2 },
        { status: 'todo', n: '5' }, // count() can surface as a string — Number-coerced
        { status: null, n: 9 }, // dropped
      ],
    ];
    const res = await tool.handler({ slug: 'sheets', detail: 'full' } as never, CTX());
    expect(res.degraded).toBeUndefined();
    expect(res.data).toEqual({
      ...PROJECT_ROW,
      featureCounts: { passed: 2, todo: 5 },
    });
    expect(queriesBuilt).toBe(2);
  });

  it('arg schema: detail defaults to summary and rejects unknown values', () => {
    expect(tool.args.parse({ slug: 's' }).detail).toBe('summary');
    expect(() => tool.args.parse({ slug: 's', detail: 'everything' })).toThrow();
  });
});
