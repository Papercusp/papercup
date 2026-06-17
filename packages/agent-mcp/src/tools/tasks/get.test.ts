/**
 * tasks:get — single-row fetch by (harnessSlug, id) (Gap 10).
 *
 * Drizzle-mock convention (goals/list.test.ts): the builder serves a single
 * fixture and captures the `.where()` predicate. The logic under test:
 *   - empty rows → `{ data:null, degraded:true, degradedReasons:['task
 *     <slug>/<id> not found'] }` — a graceful degrade, NOT a throw
 *   - detail:'summary' (default) → 4-field {harnessSlug,id,title,status}
 *   - detail:'full' → the raw row untouched
 *   - the predicate binds BOTH harnessSlug and featureId (and(eq,eq))
 *   - arg schema requires non-empty slug + id, detail defaults to summary
 *
 * Folds Gap 15 (registration: tasks:get defined + tasks:read cap).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupByMcpName } from '@papercusp/tooldef';

let fixtureRows: unknown[] = [];
let wherePredicate: unknown = undefined;

function makeBuilder() {
  const builder: Record<string, unknown> = {};
  const chain = (key: string) =>
    (...args: unknown[]) => {
      if (key === 'where') wherePredicate = args[0];
      return builder;
    };
  for (const k of ['select', 'from', 'where', 'limit']) builder[k] = chain(k);
  (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(fixtureRows).then(resolve);
  return builder;
}

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn(() => makeBuilder()),
}));

// Partially mock the drizzle operators (keep the rest — the generated schema
// module imports `sql` at load). The real SQL chunks are circular and can't be
// serialized; `eq` records {col, value}; `and` wraps.
vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('drizzle-orm')>()),
  eq: (col: { name?: string }, value: unknown) => ({ kind: 'eq', col: col?.name, value }),
  and: (...preds: unknown[]) => ({ kind: 'and', preds }),
}));

import tool from './get';

const CTX = () => ({
  principal: { slug: 'op', workspaceId: 'default' } as never,
  tx: {} as never,
  log: vi.fn(),
});

const ROW = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  harnessSlug: 'sheets',
  featureId: 'F-1',
  title: 'Wire export',
  summary: 'long body dropped in summary',
  status: 'todo',
  attempts: 2,
  expectedCostCents: 99,
  ...over,
});

beforeEach(() => {
  fixtureRows = [];
  wherePredicate = undefined;
});

describe('tasks:get — not-found degrade (Gap 10)', () => {
  it('empty rows → degraded envelope, NOT a throw', async () => {
    fixtureRows = [];
    const res = await tool.handler({ harnessSlug: 'sheets', id: 'F-404', detail: 'summary' } as never, CTX() as never);
    expect(res.data).toBeNull();
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons).toEqual(['task sheets/F-404 not found']);
  });

  it('the degrade reason carries the <slug>/<id> identity', async () => {
    fixtureRows = [];
    const res = await tool.handler({ harnessSlug: 'docs', id: 'X-9', detail: 'full' } as never, CTX() as never);
    expect(res.degradedReasons![0]).toBe('task docs/X-9 not found');
  });
});

describe('tasks:get — summary/full projection (Gap 10)', () => {
  it('summary (default) projects {harnessSlug,id,title,status}, dropping summary/attempts/cost', async () => {
    fixtureRows = [ROW()];
    const res = await tool.handler({ harnessSlug: 'sheets', id: 'F-1', detail: 'summary' } as never, CTX() as never);
    expect(res.data).toEqual({ harnessSlug: 'sheets', id: 'F-1', title: 'Wire export', status: 'todo' });
    const json = JSON.stringify(res.data);
    expect(json).not.toContain('long body dropped'); // summary dropped
    expect(json).not.toContain('99'); // expectedCostCents dropped
    expect(res.degraded).toBeUndefined();
  });

  it('maps featureId → id in the summary projection', async () => {
    fixtureRows = [ROW({ featureId: 'ABC-123' })];
    const res = await tool.handler({ harnessSlug: 'sheets', id: 'ABC-123', detail: 'summary' } as never, CTX() as never);
    expect((res.data as Record<string, unknown>).id).toBe('ABC-123');
  });

  it('full returns the raw row untouched (featureId, summary, attempts retained)', async () => {
    const row = ROW();
    fixtureRows = [row];
    const res = await tool.handler({ harnessSlug: 'sheets', id: 'F-1', detail: 'full' } as never, CTX() as never);
    expect(res.data).toEqual(row);
    expect((res.data as Record<string, unknown>).summary).toBe('long body dropped in summary');
  });
});

describe('tasks:get — composite predicate (Gap 10)', () => {
  it('binds BOTH harnessSlug and featureId into the and(eq,eq) predicate', async () => {
    fixtureRows = [ROW()];
    await tool.handler({ harnessSlug: 'sheets', id: 'F-77', detail: 'summary' } as never, CTX() as never);
    expect(wherePredicate).toEqual({
      kind: 'and',
      preds: [
        { kind: 'eq', col: 'harness_slug', value: 'sheets' },
        { kind: 'eq', col: 'feature_id', value: 'F-77' },
      ],
    });
  });
});

describe('tasks:get — arg schema (Gap 10)', () => {
  it('requires a non-empty harnessSlug and id', () => {
    expect(tool.args.safeParse({ harnessSlug: '', id: 'F-1' }).success).toBe(false);
    expect(tool.args.safeParse({ harnessSlug: 's', id: '' }).success).toBe(false);
    expect(tool.args.safeParse({ harnessSlug: 's', id: 'F-1' }).success).toBe(true);
  });

  it('detail defaults to summary and rejects unknown values', () => {
    expect(tool.args.parse({ harnessSlug: 's', id: 'F-1' }).detail).toBe('summary');
    expect(() => tool.args.parse({ harnessSlug: 's', id: 'F-1', detail: 'everything' })).toThrow();
  });
});

describe('tasks:get — registration smoke (Gap 15)', () => {
  it('is registered under tasks:get with the tasks:read capability', () => {
    const t = lookupByMcpName('tasks:get')!;
    expect(t).toBeDefined();
    expect(t.capabilities).toContain('tasks:read');
  });
});
