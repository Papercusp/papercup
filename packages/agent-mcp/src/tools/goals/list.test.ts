/**
 * goals:list — documents the shared summary/full + limit-cap convention
 * the drizzle-zod list tools follow (goals:list, tasks:list, …), exercised
 * directly.
 *
 * Focus:
 *   - summary detail → `{ id, title }` projection (drops body + budget).
 *   - full detail → raw rows untouched.
 *   - the `limit` arg-schema cap: max 200, positive int, default 50.
 *   - the resolved limit is passed through to the query builder.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

let fixtureRows: unknown[] = [];
let limitArg: number | null = null;
let selectProjection: Record<string, unknown> | null = null;

function makeBuilder() {
  const builder: Record<string, unknown> = {};
  const chain = (key: string) =>
    (...args: unknown[]) => {
      if (key === 'select') selectProjection = args[0] as Record<string, unknown>;
      if (key === 'limit') limitArg = args[0] as number;
      return builder;
    };
  for (const k of ['select', 'from', 'orderBy', 'limit']) builder[k] = chain(k);
  (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(fixtureRows).then(resolve);
  return builder;
}

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn(() => makeBuilder()),
}));

import tool from './list';

// ctx.tx must be BOTH the drizzle handle (mocked above) AND a callable
// tagged-template tag: the readiness fold (goal-dag-shared-substrate-2026-08-18
// P-003) reads blocked-by edges through it directly. Returning [] = no edges ⇒
// every goal actionable, premise intact.
const CTX = () => ({
  principal: { slug: 'op', workspaceId: 'default' } as never,
  tx: ((..._args: unknown[]) => Promise.resolve([])) as never,
  log: vi.fn(),
});

beforeEach(() => {
  fixtureRows = [];
  limitArg = null;
  selectProjection = null;
});

describe('goals:list — summary/full projection', () => {
  it('summary keeps {id,title} + readiness, dropping body + budget_cents', async () => {
    fixtureRows = [
      { id: 'g1', title: 'Ship v1', body: 'long body', parent_id: null, budget_cents: 9999, created_at: 1, workspace_id: 'default', status: 'active' },
    ];
    const res = await tool.handler({ detail: 'summary', limit: 50 } as never, CTX() as never);
    // `deactivated` (P-004 / D-011): the summary carries no `status`, so it
    // could never state the falsehood outright — but listing a goal nothing is
    // holding indistinguishably from a live one is the same failure by
    // omission. No holder row + no declared policy ⇒ requireLive defaults true
    // ⇒ deactivated.
    expect(res.data).toEqual([
      { id: 'g1', title: 'Ship v1', actionable: true, premiseInvalidated: false, deactivated: true },
    ]);
    expect(JSON.stringify(res.data)).not.toContain('long body');
    expect(JSON.stringify(res.data)).not.toContain('9999');
  });

  it('full returns the raw rows + readiness, with status DERIVED (P-004)', async () => {
    const rows = [{ id: 'g1', title: 'Ship v1', body: 'b', parent_id: null, budget_cents: 5, created_at: 1, workspace_id: 'default', status: 'active' }];
    fixtureRows = rows;
    const res = await tool.handler({ detail: 'full', limit: 50 } as never, CTX() as never);
    expect(res.data).toEqual(
      rows.map((r) => ({
        ...r,
        actionable: true,
        premiseInvalidated: false,
        // The derived reading REPLACES the column here for the same reason as
        // goals:get — an agent reads `status`, so `status` must be true.
        status: 'dormant',
        rawStatus: 'active',
        deactivated: true,
        holderLiveness: 'unheld',
        holderPolicy: { requireLive: true, onLoss: 'deactivate', isDefault: true },
      })),
    );
    // `launch_settings` is an INPUT to the fold, not part of the response — the
    // resolved `holderPolicy` reports what it meant.
    expect((res as { data: Record<string, unknown>[] }).data[0]).not.toHaveProperty(
      'launch_settings',
    );
  });

  it('requests the full column set even in summary mode (shaping is post-query)', async () => {
    await tool.handler({ detail: 'summary', limit: 50 } as never, CTX() as never);
    expect(Object.keys(selectProjection!).sort()).toEqual(
      // `launch_settings` joins the projection for P-004: the deactivation fold
      // needs the goal's own holder policy, and re-reading it per row would be
      // a second query for a column this SELECT is already in a position to ask
      // for.
      ['body', 'budget_cents', 'created_at', 'id', 'parent_id', 'title', 'workspace_id', 'status', 'launch_settings'].sort(),
    );
  });
});

describe('goals:list — limit-cap convention', () => {
  it('defaults limit to 50 when omitted', () => {
    const parsed = tool.args.parse({});
    expect(parsed.limit).toBe(50);
    expect(parsed.detail).toBe('summary');
  });

  it('rejects a limit above the 200 cap', () => {
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
