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
import { dispatchProjectedTool, lookupByMcpName, type UnifiedToolContext } from '@papercusp/tooldef';

let fixtureRows: unknown[] = [];
let edgeRows: unknown[] = [];
let goalStatusRows: unknown[] = [];
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
  tx: ((strings: TemplateStringsArray) => {
    const query = strings.join(' ');
    if (query.includes('FROM harness_shared.work_item_deps')) return Promise.resolve(edgeRows);
    if (query.includes('FROM harness_shared.goals')) return Promise.resolve(goalStatusRows);
    return Promise.resolve([]);
  }) as never,
  log: vi.fn(),
});

beforeEach(() => {
  fixtureRows = [];
  edgeRows = [];
  goalStatusRows = [];
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
        blockedBy: [],
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

  it('full exposes each blockedBy status + verdict while summary stays flat (P-003)', async () => {
    fixtureRows = [
      {
        id: 'g1',
        title: 'Ship v1',
        body: 'b',
        parent_id: null,
        budget_cents: 5,
        created_at: 1,
        workspace_id: 'default',
        status: 'active',
      },
    ];
    edgeRows = [{ blocked_ref: 'g1', blocker_kind: 'goal', blocker_ref: 'prereq-goal' }];
    goalStatusRows = [{ id: 'prereq-goal', status: 'killed' }];

    const full = await tool.handler({ detail: 'full', limit: 50 } as never, CTX() as never);
    expect(full.data[0]).toMatchObject({
      actionable: false,
      premiseInvalidated: true,
      blockedBy: [
        { kind: 'goal', ref: 'prereq-goal', status: 'killed', verdict: 'invalidating' },
      ],
    });

    const summary = await tool.handler({ detail: 'summary', limit: 50 } as never, CTX() as never);
    expect(summary.data[0]).not.toHaveProperty('blockedBy');
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

describe('goals:list — workspace-global call-scope contract', () => {
  it('advertises the transport-scoped workspace and rejects harness routing', async () => {
    const registered = lookupByMcpName('goals:list');
    expect(registered).toBeDefined();
    expect(registered!.description).toMatch(/workspace-global/i);
    expect(registered!.description).toMatch(/do not pass [`"]?harness/i);

    const accepted = await dispatchProjectedTool(
      registered!,
      'goals:list',
      { detail: 'summary', limit: 1 },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        harnessSlug: 'papercusp',
        role: 'operator',
        runId: 'run-goals-list-scope',
        spawnId: 'spawn-goals-list-scope',
        principal: { slug: 'op', workspaceId: 'default', capabilities: new Set(['goals:read']) } as never,
        tx: ((strings: TemplateStringsArray) => {
          const query = strings.join(' ');
          if (query.includes('FROM harness_shared.work_item_deps')) return Promise.resolve([]);
          if (query.includes('FROM harness_shared.goals')) return Promise.resolve([]);
          return Promise.resolve([]);
        }) as never,
      } as UnifiedToolContext,
      {},
    );
    expect(accepted.ok).toBe(true);

    const rejected = await dispatchProjectedTool(
      registered!,
      'goals:list',
      { harness: 'papercusp' },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        harnessSlug: 'papercusp',
        role: 'operator',
        runId: 'run-goals-list-scope-invalid',
        spawnId: 'spawn-goals-list-scope-invalid',
        principal: { slug: 'op', workspaceId: 'default', capabilities: new Set(['goals:read']) } as never,
        tx: (() => Promise.resolve([])) as never,
      } as UnifiedToolContext,
      {},
    );
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.message ?? '').toMatch(/Unrecognized key|harness|detail|limit/i);
  });
});
