/**
 * goals:create — the write half of `harness_shared.goals`
 * (goal-mode-2026-08-07 P-009).
 *
 * The behaviours worth pinning are the ones the SCHEMA punishes silently:
 * `workspace_id` is NOT NULL with a `CHECK (workspace_id <> '')`, so the
 * blank-stamp fallback that other write tools use here would produce a
 * constraint error instead of a legible refusal — and would have re-created the
 * blank-workspace rows EI-280 had to repair. The rest is the goal-vs-pot
 * distinction: the kill criterion and spend ceiling must survive the write,
 * because they are the whole reason a goal needs a record of its own.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import tool, { goalId, GOAL_STATUSES } from './create';

type Call = { sql: string; params: unknown[] };
let calls: Call[] = [];
let gucWorkspace: string | null = null;

/** A postgres-js-shaped tagged-template `tx` that records what it was asked. */
function makeTx() {
  return (strings: TemplateStringsArray, ...params: unknown[]) => {
    const sql = strings.join('?');
    calls.push({ sql, params });
    if (/current_setting/.test(sql)) return Promise.resolve([{ ws: gucWorkspace }]);
    return Promise.resolve([]);
  };
}

const CTX = (over: Record<string, unknown> = {}) => ({
  tx: makeTx() as never,
  workspaceId: 'papercusp-workspace',
  harnessSlug: 'papercusp',
  ...over,
});

const ARGS = (over: Record<string, unknown> = {}) =>
  tool.args.parse({ title: 'Ship a paid app', ...over });

/**
 * `handler` is typed as the `ToolResult | ToolResponse<unknown>` union, so a
 * bare `res.data` does not narrow. The rest of this package's test corpus reads
 * it unnarrowed and carries the resulting TS2339s in its baseline; narrowing
 * here keeps these files from adding to that pile.
 */
type Res = { data: unknown; degraded?: boolean; degradedReasons?: string[] };
const call = async (args: unknown, ctx: unknown): Promise<Res> =>
  (await tool.handler(args as never, ctx as never)) as Res;

beforeEach(() => {
  calls = [];
  gucWorkspace = null;
});

describe('goals:create — workspace resolution', () => {
  it('prefers the app.workspace_id GUC over ctx.workspaceId', async () => {
    gucWorkspace = 'from-guc';
    const res = await call(ARGS(), CTX());
    expect((res.data as { workspace_id: string }).workspace_id).toBe('from-guc');
  });

  it('falls back to ctx.workspaceId when the GUC is unset', async () => {
    const res = await call(ARGS(), CTX());
    expect((res.data as { workspace_id: string }).workspace_id).toBe('papercusp-workspace');
  });

  it('REFUSES rather than writing a blank workspace_id the CHECK would reject', async () => {
    const res = await call(ARGS(), CTX({ workspaceId: undefined }));
    expect(res.data).toBeNull();
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons?.join(' ')).toMatch(/workspace/i);
    // The refusal must happen BEFORE the insert, not be cleaned up after one.
    expect(calls.some((c) => /INSERT INTO/.test(c.sql))).toBe(false);
  });

  it('treats the wildcard workspace "*" as no concrete workspace', async () => {
    const res = await call(ARGS(), CTX({ workspaceId: '*' }));
    expect(res.data).toBeNull();
    expect(calls.some((c) => /INSERT INTO/.test(c.sql))).toBe(false);
  });

  it('refuses when no harness is in scope — a goal is filed against an install', async () => {
    const res = await call(ARGS(), CTX({ harnessSlug: undefined }));
    expect(res.data).toBeNull();
    expect(res.degradedReasons?.join(' ')).toMatch(/harness/i);
    expect(calls.some((c) => /INSERT INTO/.test(c.sql))).toBe(false);
  });
});

describe('goals:create — what the row must carry', () => {
  it('persists the kill criterion, which no pot could carry for a multi-project goal', async () => {
    const res = await call(ARGS({ killCriterion: 'no paying user after 2 weeks' }), CTX());
    expect((res.data as { kill_criterion: string }).kill_criterion).toBe('no paying user after 2 weeks');
    const insert = calls.find((c) => /INSERT INTO/.test(c.sql))!;
    expect(JSON.stringify(insert.params)).toContain('no paying user after 2 weeks');
  });

  it('persists the declared spend ceiling', async () => {
    const res = await call(ARGS({ budgetCents: 50_000 }), CTX());
    expect((res.data as { budget_cents: number }).budget_cents).toBe(50_000);
  });

  it('writes null metadata rather than an empty object when there is nothing to record', async () => {
    await call(ARGS(), CTX());
    const insert = calls.find((c) => /INSERT INTO/.test(c.sql))!;
    expect(insert.params).toContain(null);
    expect(JSON.stringify(insert.params)).not.toContain('{}');
  });

  it('supports a sub-goal via parentId (the table\'s self-referencing lineage edge)', async () => {
    const res = await call(ARGS({ parentId: 'parent-abc123' }), CTX());
    expect((res.data as { parent_id: string }).parent_id).toBe('parent-abc123');
  });
});

describe('goals:create — arg contract', () => {
  it('defaults status to active', () => {
    expect(tool.args.parse({ title: 'x' }).status).toBe('active');
  });

  it('accepts every declared status and rejects an invented one', () => {
    for (const s of GOAL_STATUSES) {
      expect(tool.args.safeParse({ title: 'x', status: s }).success).toBe(true);
    }
    expect(tool.args.safeParse({ title: 'x', status: 'abandoned' }).success).toBe(false);
  });

  it('requires a title and rejects a negative or fractional budget', () => {
    expect(tool.args.safeParse({}).success).toBe(false);
    expect(tool.args.safeParse({ title: '' }).success).toBe(false);
    expect(tool.args.safeParse({ title: 'x', budgetCents: -1 }).success).toBe(false);
    expect(tool.args.safeParse({ title: 'x', budgetCents: 1.5 }).success).toBe(false);
  });
});

describe('goalId', () => {
  it('derives a readable slug from the title', () => {
    expect(goalId('Ship a paid app')).toMatch(/^ship-a-paid-app-[0-9a-f]{6}$/);
  });

  it('is collision-resistant for identical titles', () => {
    expect(goalId('same')).not.toBe(goalId('same'));
  });

  it('still produces a valid id when the title has no usable characters', () => {
    expect(goalId('!!! ???')).toMatch(/^goal-[0-9a-f]{6}$/);
  });

  it('bounds the stem so a long title cannot produce an unwieldy key', () => {
    const id = goalId('x'.repeat(300));
    expect(id.length).toBeLessThanOrEqual(48 + 1 + 6);
  });
});
