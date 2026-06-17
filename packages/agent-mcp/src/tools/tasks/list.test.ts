/**
 * tasks:list — summary/full projection, 3-way predicate, limit cap, and the
 * declared-flat-schema-vs-full-mode serialization gap.
 *
 * Two harness idioms in one file (intentional — they exercise different
 * layers):
 *
 *   1. The drizzle-mock (goals/list.test.ts convention) drives `tool.handler`
 *      directly: it captures the `.select()` projection, the resolved
 *      `.limit()`, and the `.where()` predicate object, with no live PG. This
 *      is where summary/full shaping, the 3-way predicate, and limit
 *      passthrough are pinned.
 *
 *   2. The `dispatchProjectedTool` path (audit/list.test.ts convention) runs
 *      the tool end-to-end THROUGH the registry + result serialization. This
 *      is Gap 16: the tool DECLARES a flat 4-field `result` schema, but full
 *      mode returns ~11-field rows — we assert the extra columns (summary /
 *      attempts / expected_cost_cents / kind) SURVIVE serialization rather
 *      than being stripped to the declared shape.
 *
 * Also folds Gap 15 (registration smoke: tasks:list defined + tasks:read cap).
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupByMcpName, dispatchProjectedTool, type UnifiedToolContext } from '@papercusp/tooldef';

// ---- drizzle-mock leg (direct handler) ----------------------------------
let fixtureRows: unknown[] = [];
let limitArg: number | null = null;
let selectProjection: Record<string, unknown> | null = null;
let wherePredicate: unknown = undefined;

function makeBuilder() {
  const builder: Record<string, unknown> = {};
  const chain = (key: string) =>
    (...args: unknown[]) => {
      if (key === 'select') selectProjection = args[0] as Record<string, unknown>;
      if (key === 'where') wherePredicate = args[0];
      if (key === 'limit') limitArg = args[0] as number;
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

// Partially mock the drizzle operators to capture (column, value) as plain
// inspectable objects — the real SQL chunks are circular (PgTable ↔ PgColumn)
// and can't be JSON.stringify'd. We keep the rest of drizzle-orm intact (the
// generated schema module imports `sql` etc. at load time). `eq` records
// {col: <db column name>, value}; `and` wraps its operands into a flat tree.
vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('drizzle-orm')>()),
  eq: (col: { name?: string }, value: unknown) => ({ kind: 'eq', col: col?.name, value }),
  and: (...preds: unknown[]) => ({ kind: 'and', preds }),
  desc: (col: { name?: string }) => ({ kind: 'desc', col: col?.name }),
}));

import tool from './list';

const CTX = () => ({
  principal: { slug: 'op', workspaceId: 'default' } as never,
  tx: {} as never,
  log: vi.fn(),
});

// A full ~11-column row as the consolidated-features query returns it.
const FULL_ROW = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  harness_slug: 'sheets',
  feature_id: 'F-1',
  title: 'Wire the export button',
  summary: 'a long summary that summary-mode must drop',
  status: 'todo',
  updated_ts: 1_780_000_000_000,
  attempts: 3,
  kind: 'feature',
  project_id: 'proj-9',
  expected_cost_cents: 4242,
  goal_id: 'g-1',
  ...over,
});

beforeEach(() => {
  fixtureRows = [];
  limitArg = null;
  selectProjection = null;
  wherePredicate = undefined;
});

describe('tasks:list — summary projection (Gap 9)', () => {
  it('summary keeps only {harnessSlug,id,title,status}, dropping summary/attempts/cost/kind', async () => {
    fixtureRows = [FULL_ROW()];
    const res = await tool.handler({ detail: 'summary', limit: 50 } as never, CTX() as never);
    expect(res.data).toEqual([
      { harnessSlug: 'sheets', id: 'F-1', title: 'Wire the export button', status: 'todo' },
    ]);
    const json = JSON.stringify(res.data);
    expect(json).not.toContain('a long summary'); // summary dropped
    expect(json).not.toContain('4242'); // expected_cost_cents dropped
    expect(json).not.toContain('proj-9'); // project_id dropped
    expect(res.data).not.toHaveProperty('0.attempts');
  });

  it('maps feature_id → id and harness_slug → harnessSlug uniformly across rows', async () => {
    fixtureRows = [FULL_ROW({ feature_id: 'F-1' }), FULL_ROW({ feature_id: 'F-2', harness_slug: 'docs' })];
    const res = await tool.handler({ detail: 'summary', limit: 50 } as never, CTX() as never);
    expect((res.data as Array<Record<string, unknown>>).map((r) => r.id)).toEqual(['F-1', 'F-2']);
    expect((res.data as Array<Record<string, unknown>>).map((r) => r.harnessSlug)).toEqual(['sheets', 'docs']);
  });

  it('empty rows → empty array', async () => {
    fixtureRows = [];
    const res = await tool.handler({ detail: 'summary', limit: 50 } as never, CTX() as never);
    expect(res.data).toEqual([]);
  });

  it('requests the full ~11-column set even in summary mode (shaping is post-query)', async () => {
    await tool.handler({ detail: 'summary', limit: 50 } as never, CTX() as never);
    expect(Object.keys(selectProjection!).sort()).toEqual(
      [
        'attempts',
        'expected_cost_cents',
        'feature_id',
        'goal_id',
        'harness_slug',
        'kind',
        'project_id',
        'status',
        'summary',
        'title',
        'updated_ts',
      ].sort(),
    );
  });
});

describe('tasks:list — full mode returns the raw row (Gap 9)', () => {
  it('full returns the raw snake_case rows untouched', async () => {
    const rows = [FULL_ROW()];
    fixtureRows = rows;
    const res = await tool.handler({ detail: 'full', limit: 50 } as never, CTX() as never);
    expect(res.data).toEqual(rows);
  });
});

describe('tasks:list — 3-way predicate (Gap 9)', () => {
  it('no filters → where() receives undefined (no predicate)', async () => {
    await tool.handler({ detail: 'summary', limit: 50 } as never, CTX() as never);
    expect(wherePredicate).toBeUndefined();
  });

  it('a single filter binds an eq() predicate (not wrapped in and())', async () => {
    await tool.handler({ detail: 'summary', limit: 50, status: 'todo' } as never, CTX() as never);
    // exactly one predicate → passed straight through as the bare eq() (the
    // `preds.length ? and(...) : undefined` keeps a single pred unwrapped).
    expect(wherePredicate).toEqual({ kind: 'and', preds: [{ kind: 'eq', col: 'status', value: 'todo' }] });
  });

  it('all three filters (harnessSlug+status+goalId) collapse into one and(...) predicate', async () => {
    await tool.handler(
      { detail: 'summary', limit: 50, harnessSlug: 'sheets', status: 'todo', goalId: 'g-1' } as never,
      CTX() as never,
    );
    expect(wherePredicate).toEqual({
      kind: 'and',
      preds: [
        { kind: 'eq', col: 'harness_slug', value: 'sheets' },
        { kind: 'eq', col: 'status', value: 'todo' },
        { kind: 'eq', col: 'goal_id', value: 'g-1' },
      ],
    });
  });
});

describe('tasks:list — limit cap (Gap 9)', () => {
  it('defaults limit to 50 and detail to summary when omitted', () => {
    const parsed = tool.args.parse({});
    expect(parsed.limit).toBe(50);
    expect(parsed.detail).toBe('summary');
  });

  it('rejects a limit above the 200 cap, accepts the boundary', () => {
    expect(tool.args.safeParse({ limit: 201 }).success).toBe(false);
    expect(tool.args.safeParse({ limit: 200 }).success).toBe(true);
  });

  it('rejects a non-positive limit', () => {
    expect(tool.args.safeParse({ limit: 0 }).success).toBe(false);
    expect(tool.args.safeParse({ limit: -5 }).success).toBe(false);
  });

  it('passes the resolved limit through to the query builder', async () => {
    await tool.handler({ detail: 'summary', limit: 17 } as never, CTX() as never);
    expect(limitArg).toBe(17);
  });
});

// ---- dispatchProjectedTool leg (Gap 16 + Gap 15) ------------------------
// The handler-direct mock above is shared (drizzle is module-mocked), so the
// dispatch path uses the SAME `fixtureRows`/`limitArg` state — set fixtureRows
// before each dispatch call.

const MAKE_CTX = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'ws_1',
  harnessSlug: 'sheets',
  role: 'architect',
  runId: 'run_T',
  spawnId: 'spw_T',
  principal: { slug: 'p1', workspaceId: 'ws_1', capabilities: new Set(['tasks:read']) },
  tx: {} as never,
  ...over,
});

beforeAll(async () => {
  await import('./list');
});

describe('tasks:list — registration smoke (Gap 15)', () => {
  it('is registered under tasks:list with the tasks:read capability', () => {
    const t = lookupByMcpName('tasks:list')!;
    expect(t).toBeDefined();
    expect(t.capabilities).toContain('tasks:read');
  });
});

describe('tasks:list — declared-schema vs full-mode serialization (Gap 16)', () => {
  it('full-mode extra columns SURVIVE serialization despite the flat 4-field result schema', async () => {
    fixtureRows = [FULL_ROW()];
    const t = lookupByMcpName('tasks:list')!;
    const r = await dispatchProjectedTool(t, 'tasks:list', { detail: 'full', limit: 50 }, MAKE_CTX(), {});
    expect(r.ok).toBe(true);
    const text = (r.result!.content[0] as { text: string }).text;
    const out = JSON.parse(text) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(1);
    // The declared result schema is the flat summary shape; full mode must NOT
    // be coerced down to it — every extra column has to round-trip.
    expect(out[0]).toMatchObject({
      summary: 'a long summary that summary-mode must drop',
      attempts: 3,
      expected_cost_cents: 4242,
      kind: 'feature',
    });
    expect(text).toContain('a long summary');
    expect(text).toContain('4242');
  });

  it('summary-mode dispatch yields exactly the declared 4-field shape', async () => {
    fixtureRows = [FULL_ROW()];
    const t = lookupByMcpName('tasks:list')!;
    const r = await dispatchProjectedTool(t, 'tasks:list', { detail: 'summary', limit: 50 }, MAKE_CTX(), {});
    expect(r.ok).toBe(true);
    const out = JSON.parse((r.result!.content[0] as { text: string }).text) as Array<Record<string, unknown>>;
    expect(Object.keys(out[0]).sort()).toEqual(['harnessSlug', 'id', 'status', 'title']);
  });

  it('rejects an over-cap limit at the dispatch boundary (invalid_args)', async () => {
    const t = lookupByMcpName('tasks:list')!;
    const r = await dispatchProjectedTool(t, 'tasks:list', { limit: 201 }, MAKE_CTX(), {});
    expect(r.ok).toBe(false);
    expect(r.error?.message ?? '').toMatch(/invalid_args|limit|200|less|max/i);
  });
});
