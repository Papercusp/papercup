/**
 * goals:get — single goal by id, with full-mode children lineage (Gap 11).
 *
 * Drizzle-mock with a FIFO fixture queue (harness/get.test.ts convention):
 * each `.select()` call shifts the next fixture, so the goal-row query and
 * the children query draw separate fixtures and we can count how many ran.
 * The logic under test:
 *   - empty rows → `{ data:null, degraded:true,
 *     degradedReasons:['goal <id> not found'] }`
 *   - detail:'summary' (default) → {id,title} and fires NO second query
 *   - detail:'full' → spreads the whole goal + a `children` array assembled
 *     by a SECOND query whose predicate binds parentId === id
 *   - arg schema: id required non-empty, detail defaults to summary
 *
 * Folds Gap 15 (registration: goals:get defined + goals:read cap).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupByMcpName } from '@papercusp/tooldef';

let fixtureQueue: unknown[][] = [];
let queriesBuilt = 0;
const wherePredicates: unknown[] = [];

function makeBuilder() {
  const rows = fixtureQueue.shift() ?? [];
  queriesBuilt += 1;
  const builder: Record<string, unknown> = {};
  const chain = (key: string) =>
    (...args: unknown[]) => {
      if (key === 'where') wherePredicates.push(args[0]);
      return builder;
    };
  for (const k of ['from', 'where', 'limit']) builder[k] = chain(k);
  (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve);
  return builder;
}

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn(() => ({
    select: (..._args: unknown[]) => makeBuilder(),
  })),
}));

// Partially mock `eq` to a plain object — the real SQL chunk is circular
// (PgTable ↔ PgColumn) and can't be JSON.stringify'd. The rest of drizzle-orm
// is kept (the generated schema module imports `sql` at load).
vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('drizzle-orm')>()),
  eq: (col: { name?: string }, value: unknown) => ({ kind: 'eq', col: col?.name, value }),
}));

import tool from './get';

const CTX = () => ({
  principal: { slug: 'op', workspaceId: 'default' } as never,
  tx: {} as never,
  log: vi.fn(),
});

const GOAL_ROW = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'g-1',
  title: 'Ship v1',
  body: 'rationale + acceptance criteria',
  parentId: null,
  budgetCents: 9999,
  ...over,
});

beforeEach(() => {
  fixtureQueue = [];
  queriesBuilt = 0;
  wherePredicates.length = 0;
});

describe('goals:get — not-found degrade (Gap 11)', () => {
  it('empty rows → degraded envelope with the goal-<id> reason', async () => {
    fixtureQueue = [[]];
    const res = await tool.handler({ id: 'g-404', detail: 'summary' } as never, CTX() as never);
    expect(res.data).toBeNull();
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons).toEqual(['goal g-404 not found']);
    expect(queriesBuilt).toBe(1); // never reaches the children query
  });
});

describe('goals:get — summary skips the children query (Gap 11)', () => {
  it('summary (default) projects {id,title} and fires exactly ONE query', async () => {
    fixtureQueue = [[GOAL_ROW()]];
    const res = await tool.handler({ id: 'g-1', detail: 'summary' } as never, CTX() as never);
    expect(res.data).toEqual({ id: 'g-1', title: 'Ship v1' });
    const json = JSON.stringify(res.data);
    expect(json).not.toContain('rationale'); // body dropped
    expect(json).not.toContain('9999'); // budget dropped
    expect(queriesBuilt).toBe(1); // NO second children query in summary mode
    expect(res.data).not.toHaveProperty('children');
  });
});

describe('goals:get — full mode fires the children query (Gap 11)', () => {
  it('full spreads the goal and attaches children from a SECOND query', async () => {
    const goal = GOAL_ROW();
    fixtureQueue = [
      [goal],
      [
        { id: 'g-2', title: 'Child A' },
        { id: 'g-3', title: 'Child B' },
      ],
    ];
    const res = await tool.handler({ id: 'g-1', detail: 'full' } as never, CTX() as never);
    expect(queriesBuilt).toBe(2); // goal row + children
    expect(res.data).toEqual({
      ...goal,
      children: [
        { id: 'g-2', title: 'Child A' },
        { id: 'g-3', title: 'Child B' },
      ],
    });
  });

  it('full mode with no children → empty children array (second query still fires)', async () => {
    fixtureQueue = [[GOAL_ROW()], []];
    const res = await tool.handler({ id: 'g-1', detail: 'full' } as never, CTX() as never);
    expect(queriesBuilt).toBe(2);
    expect((res.data as Record<string, unknown>).children).toEqual([]);
  });

  it('the children query binds parentId === id (lineage edge)', async () => {
    fixtureQueue = [[GOAL_ROW({ id: 'parent-7' })], []];
    await tool.handler({ id: 'parent-7', detail: 'full' } as never, CTX() as never);
    // wherePredicates[0] = goal lookup (eq id), [1] = children (eq parent_id id)
    expect(wherePredicates).toHaveLength(2);
    expect(wherePredicates[0]).toEqual({ kind: 'eq', col: 'id', value: 'parent-7' });
    expect(wherePredicates[1]).toEqual({ kind: 'eq', col: 'parent_id', value: 'parent-7' });
  });
});

describe('goals:get — arg schema (Gap 11)', () => {
  it('requires a non-empty id', () => {
    expect(tool.args.safeParse({ id: '' }).success).toBe(false);
    expect(tool.args.safeParse({ id: 'g-1' }).success).toBe(true);
  });

  it('detail defaults to summary and rejects unknown values', () => {
    expect(tool.args.parse({ id: 'g-1' }).detail).toBe('summary');
    expect(() => tool.args.parse({ id: 'g-1', detail: 'lineage' })).toThrow();
  });
});

describe('goals:get — registration smoke (Gap 15)', () => {
  it('is registered under goals:get with the goals:read capability', () => {
    const t = lookupByMcpName('goals:get')!;
    expect(t).toBeDefined();
    expect(t.capabilities).toContain('goals:read');
  });
});
