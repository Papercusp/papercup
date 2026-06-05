/**
 * pending_events:list — PURE unit tests for predicate composition,
 * consumed-derivation, and field remap, exercised directly.
 *
 * Focus:
 *   - 0 filters → `.where(undefined)` (no predicate).
 *   - 1 filter  → `.where(and(eq))` (the source always wraps non-empty
 *                 preds in `and(...preds)`, even for a single predicate).
 *   - 2 filters → `.where(and(eq, eq))` (composed).
 *   - `consumed = consumed_at != null` derivation.
 *   - column → camelCase field remap.
 *
 * `drizzle-orm`'s `and`/`eq`/`desc` are mocked to opaque tagged markers so
 * the test can read which predicate(s) were composed; the postgres-js
 * `drizzle` factory is mocked to a chainable awaitable builder that records
 * the `.where()` argument.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

let fixtureRows: unknown[] = [];
let whereArg: unknown = '__unset__';

function makeBuilder() {
  const builder: Record<string, unknown> = {};
  const chain = (key: string) =>
    (...args: unknown[]) => {
      if (key === 'where') whereArg = args[0];
      return builder;
    };
  for (const k of ['select', 'from', 'where', 'orderBy', 'limit']) builder[k] = chain(k);
  (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(fixtureRows).then(resolve);
  return builder;
}

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn(() => makeBuilder()),
}));

// Partially mock the operators so we can recognise them structurally — keep
// every other drizzle-orm export real (the generated schema imports `sql`,
// `text`, etc. from here at module load). `eq`/`and` return tagged objects;
// `desc` is opaque.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ __op: 'eq', col, val }),
    and: (...preds: unknown[]) => ({ __op: 'and', preds }),
    desc: (col: unknown) => ({ __op: 'desc', col }),
  };
});

import tool from './list';

const CTX = () => ({
  principal: { slug: 'op', workspaceId: 'default' } as never,
  tx: {} as never,
  log: vi.fn(),
});

beforeEach(() => {
  fixtureRows = [];
  whereArg = '__unset__';
});

describe('pending_events:list — predicate composition', () => {
  it('0 filters → where(undefined)', async () => {
    await tool.handler({ detail: 'summary', limit: 50 } as never, CTX() as never);
    expect(whereArg).toBeUndefined();
  });

  it('1 filter (kind) → where(and(eq)) — single predicate, still wrapped in and()', async () => {
    await tool.handler({ detail: 'summary', kind: 'hook', limit: 50 } as never, CTX() as never);
    const w = whereArg as { __op: string; preds: Array<{ __op: string }> };
    expect(w.__op).toBe('and');
    expect(w.preds).toHaveLength(1);
    expect(w.preds[0].__op).toBe('eq');
  });

  it('1 filter (targetRole) → where(and(eq)) with one predicate', async () => {
    await tool.handler({ detail: 'summary', targetRole: 'worker', limit: 50 } as never, CTX() as never);
    const w = whereArg as { __op: string; preds: Array<{ __op: string }> };
    expect(w.__op).toBe('and');
    expect(w.preds).toHaveLength(1);
  });

  it('2 filters → where(and(eq, eq))', async () => {
    await tool.handler(
      { detail: 'summary', kind: 'hook', targetRole: 'worker', limit: 50 } as never,
      CTX() as never,
    );
    const w = whereArg as { __op: string; preds: Array<{ __op: string }> };
    expect(w.__op).toBe('and');
    expect(w.preds).toHaveLength(2);
    expect(w.preds.every((p) => p.__op === 'eq')).toBe(true);
  });
});

describe('pending_events:list — consumed derivation + field remap', () => {
  it('derives consumed=false when consumed_at is null', async () => {
    fixtureRows = [
      {
        id: 'e1',
        kind: 'hook',
        target_role: 'worker',
        due_at: 10,
        created_at: 5,
        consumed_at: null,
      },
    ];
    const res = await tool.handler({ detail: 'summary', limit: 50 } as never, CTX() as never);
    expect(res.data).toEqual([
      { id: 'e1', kind: 'hook', targetRole: 'worker', dueAt: 10, createdAt: 5, consumed: false },
    ]);
  });

  it('derives consumed=true when consumed_at is set', async () => {
    fixtureRows = [
      {
        id: 'e2',
        kind: 'hook',
        target_role: null,
        due_at: null,
        created_at: 7,
        consumed_at: 123456,
      },
    ];
    const res = await tool.handler({ detail: 'summary', limit: 50 } as never, CTX() as never);
    const row = (res.data as Array<{ consumed: boolean; targetRole: unknown }>)[0];
    expect(row.consumed).toBe(true);
    expect(row.targetRole).toBeNull();
    // The raw `consumed_at` value is NOT leaked into the shaped row.
    expect(JSON.stringify(res.data)).not.toContain('123456');
  });
});
