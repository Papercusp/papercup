/**
 * audit:list — pure projection + filter-passthrough tests.
 *
 * NOTE: a `name: 'audit:list'` hit in define-tool.test.ts is an INLINE
 * test FIXTURE (a throwaway defineTool call), not coverage of THIS
 * handler — `tools/audit/list.ts` was untested before this file.
 *
 * Legacy (principal-gated) tool reading `ctx.tx`. We mock `tx` as a sql
 * template tag, capture the bound `${...}` values, and feed crafted
 * rows. The pure logic under test:
 *   - detail:'summary' (default) projects each row to
 *     {id, ts, actor, action, subject} — DROPPING `details`
 *   - detail:'full' returns the raw rows (details retained)
 *   - the three nullable filters (actor / action / sinceTs) are bound to
 *     the query, defaulting to null when omitted
 *   - `limit` defaults to 100 and is capped at 500 by the zod schema
 *     (an over-cap value is rejected as invalid_args, not silently
 *     clamped)
 *
 * SQL filtering itself isn't exercised (no live PG) — only the JS
 * projection + arg binding.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupByMcpName, dispatchProjectedTool, type UnifiedToolContext } from '@papercusp/tooldef';

let lastValues: unknown[] = [];
let nextRows: Array<Record<string, unknown>> = [];
const tx = (_strings: TemplateStringsArray, ...values: unknown[]) => {
  lastValues = values;
  return Promise.resolve(nextRows);
};

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
  principal: { slug: 'p1', workspaceId: 'ws_1', capabilities: new Set(['audit:read']) },
  tx,
  ...over,
});

type Payload = Array<Record<string, unknown>>;

async function call(
  args: Record<string, unknown>,
  rows: Array<Record<string, unknown>> = [],
): Promise<Payload> {
  nextRows = rows;
  lastValues = [];
  const tool = lookupByMcpName('audit:list')!;
  const r = await dispatchProjectedTool(tool, 'audit:list', args, MAKE_CTX(), {});
  expect(r.ok).toBe(true);
  return JSON.parse((r.result!.content[0] as { text: string }).text) as Payload;
}

const ROW = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'audit-1',
  ts: 1_780_000_000_000,
  actor: 'agent:worker',
  action: 'feature.update',
  subject: 'F-42',
  details: { before: 1, after: 2 },
  ...over,
});

beforeAll(async () => {
  await import('./list');
});

beforeEach(() => {
  lastValues = [];
  nextRows = [];
});

describe('audit:list — registration', () => {
  it('is registered with the audit:read capability', () => {
    const tool = lookupByMcpName('audit:list')!;
    expect(tool).toBeDefined();
    expect(tool.capabilities).toContain('audit:read');
  });
});

describe('audit:list — detail projection', () => {
  it("summary (default) drops `details` and keeps {id, ts, actor, action, subject}", async () => {
    const out = await call({}, [ROW()]);
    expect(out[0]).toEqual({
      id: 'audit-1',
      ts: 1_780_000_000_000,
      actor: 'agent:worker',
      action: 'feature.update',
      subject: 'F-42',
    });
    expect(out[0]).not.toHaveProperty('details');
  });

  it("detail 'full' returns the raw rows including `details`", async () => {
    const out = await call({ detail: 'full' }, [ROW()]);
    expect(out[0]).toEqual({
      id: 'audit-1',
      ts: 1_780_000_000_000,
      actor: 'agent:worker',
      action: 'feature.update',
      subject: 'F-42',
      details: { before: 1, after: 2 },
    });
    expect(out[0].details).toEqual({ before: 1, after: 2 });
  });

  it('summary projects every row uniformly', async () => {
    const out = await call({}, [ROW({ id: 'a' }), ROW({ id: 'b', actor: 'user:avi' })]);
    expect(out).toHaveLength(2);
    expect(out.every((r) => !('details' in r))).toBe(true);
    expect(out.map((r) => r.actor)).toEqual(['agent:worker', 'user:avi']);
  });

  it('empty rows → empty array (both detail modes)', async () => {
    expect(await call({}, [])).toEqual([]);
    expect(await call({ detail: 'full' }, [])).toEqual([]);
  });
});

describe('audit:list — nullable filter passthrough', () => {
  it('binds null for actor / action / sinceTs when all omitted', async () => {
    await call({});
    // No filter value should be a non-null primitive; verify none of the
    // user-supplied filters leaked a value (limit is the only non-null).
    expect(lastValues).toContain(null);
    expect(lastValues.filter((v) => v === null).length).toBeGreaterThanOrEqual(3);
  });

  it('binds the actor filter when provided', async () => {
    await call({ actor: 'user:avi' });
    expect(lastValues).toContain('user:avi');
  });

  it('binds the action filter when provided', async () => {
    await call({ action: 'feature.delete' });
    expect(lastValues).toContain('feature.delete');
  });

  it('binds the sinceTs filter when provided', async () => {
    await call({ sinceTs: 1_777_000_000_000 });
    expect(lastValues).toContain(1_777_000_000_000);
  });

  it('binds all three filters together', async () => {
    // `sinceTs` must be a REAL epoch-millisecond value: the schema now floors
    // it at MS_EPOCH_FLOOR (EI-20216014898419956) so a wrong-unit value is
    // refused instead of silently matching every row. This was `5` — a toy
    // placeholder that the floor correctly rejects. Deliberately distinct
    // from the single-filter case above so a mis-bound value is still visible.
    await call({ actor: 'a', action: 'b', sinceTs: 1_778_000_000_000 });
    expect(lastValues).toContain('a');
    expect(lastValues).toContain('b');
    expect(lastValues).toContain(1_778_000_000_000);
  });
});

describe('audit:list — limit default + cap', () => {
  it('binds the default limit of 100 as the last value when omitted', async () => {
    await call({});
    expect(lastValues[lastValues.length - 1]).toBe(100);
  });

  it('binds an explicit in-range limit', async () => {
    await call({ limit: 250 });
    expect(lastValues[lastValues.length - 1]).toBe(250);
  });

  it('accepts the boundary limit of 500', async () => {
    await call({ limit: 500 });
    expect(lastValues[lastValues.length - 1]).toBe(500);
  });

  it('rejects a limit over the 500 cap (zod .max enforces it)', async () => {
    const tool = lookupByMcpName('audit:list')!;
    const r = await dispatchProjectedTool(tool, 'audit:list', { limit: 501 }, MAKE_CTX(), {});
    expect(r.ok).toBe(false);
    expect(r.error?.message ?? '').toMatch(/invalid_args|limit|500|less|max/i);
  });

  it('rejects a non-positive limit', async () => {
    const tool = lookupByMcpName('audit:list')!;
    const r = await dispatchProjectedTool(tool, 'audit:list', { limit: 0 }, MAKE_CTX(), {});
    expect(r.ok).toBe(false);
    expect(r.error?.message ?? '').toMatch(/invalid_args|limit|positive|greater/i);
  });
});

/**
 * EI-20216014898419956 — the epoch-unit floor, asserted through the REAL
 * dispatch path rather than the bare zod schema.
 *
 * The schema-level cases live in `src/__tests__/audit-list-since-shape.test.ts`.
 * These exist because the item is about what the CALLER IS TOLD, and a schema
 * that refuses correctly is still a failure if the dispatch layer flattens the
 * message to a bare "invalid_args" on the way out. Note the assertions below
 * deliberately avoid the loose `/invalid_args|.../` alternation used above:
 * that pattern matches the generic envelope text unconditionally, so it would
 * pass even if the custom guidance never reached the caller.
 */
describe('audit:list — sinceTs epoch-unit floor', () => {
  const dispatch = async (args: Record<string, unknown>) =>
    dispatchProjectedTool(lookupByMcpName('audit:list')!, 'audit:list', args, MAKE_CTX(), {});

  it('refuses an epoch-SECONDS value instead of matching every row', async () => {
    // Pre-fix this dispatched cleanly and bound a value that every row's `ts`
    // exceeds — a full result set, indistinguishable from a real one.
    const r = await dispatch({ sinceTs: 1_785_000_000 });
    expect(r.ok).toBe(false);
  });

  it('the caller-facing message names the unit and the repair', async () => {
    const r = await dispatch({ sinceTs: 1_785_000_000 });
    const message = r.error?.message ?? '';
    // A generic zod "too_small" carries neither of these, so this is what
    // proves the custom message survives dispatch-layer formatting.
    expect(message).toMatch(/millisecond/i);
    expect(message).toMatch(/1000/);
  });

  it('CONTROL: the equivalent epoch-MILLISECONDS value still dispatches and binds', async () => {
    // Without this, deleting the arg entirely would satisfy both cases above.
    await call({ sinceTs: 1_785_000_000_000 });
    expect(lastValues).toContain(1_785_000_000_000);
  });
});

describe('audit:list — per-call workspace arg (EI-61)', () => {
  // The `workspace` arg is consumed by the DISPATCH layer before the handler
  // runs (effectiveDispatchWorkspace, EI-30 — tx synthesis + ALS pin). The
  // tool declares it only so the advertised inputSchema
  // (additionalProperties:false) lets unscoped superuser clients pass it.

  it('advertises `workspace` in the inputSchema so clients can pass it', () => {
    const tool = lookupByMcpName('audit:list')!;
    const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(schema.properties).toHaveProperty('workspace');
    expect(schema.required ?? []).not.toContain('workspace');
  });

  it('accepts a workspace arg without binding it into the SQL query', async () => {
    await call({ workspace: 'papercusp-workspace' });
    expect(lastValues).not.toContain('papercusp-workspace');
  });

  it('workspace arg does not change the projection', async () => {
    const out = await call({ workspace: 'papercusp-workspace' }, [ROW()]);
    expect(out[0]).toEqual({
      id: 'audit-1',
      ts: 1_780_000_000_000,
      actor: 'agent:worker',
      action: 'feature.update',
      subject: 'F-42',
    });
  });
});
