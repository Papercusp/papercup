/**
 * get_state.test.ts — the ui:get_state HANDLER. Demonstrates the sql-tagged-template mock
 * (getOrgPg().sql is a vi.fn that returns rows) for an inline-sql handler. Pins the
 * genuine handler logic:
 *   • client_id defaults to ctx.uiClientId; absent both → client_id_required (isError);
 *   • the cross-workspace guard short-circuits;
 *   • no row → client_not_found (isError);
 *   • the URL parse (pathname / nuqs params / hash) + the stale computation (age > 60s),
 *     including the parse fallback for a non-URL value.
 * A regression in the param parsing or the stale threshold is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/ui/get_state.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(() => ({ sql: vi.fn(async () => h.rows) })),
}));
vi.mock('./_workspace-guard', () => ({ uiCrossWorkspaceBlock: vi.fn(async () => null) }));

import { uiCrossWorkspaceBlock } from './_workspace-guard';
const blockM = vi.mocked(uiCrossWorkspaceBlock);
const tool = (await import('./get_state')).default;

type Out = { content: { text: string }[]; isError?: boolean };
const call = (args: Record<string, unknown>, ctx: Record<string, unknown> = {}) =>
  tool.handler(args as never, ctx as never) as Promise<Out>;
const row = (over: Record<string, unknown> = {}) => ({
  url: 'https://app.example/foo?tab=x&panel=open',
  title: 'Foo',
  workspace_id: 'ws-1',
  last_seen_at: new Date(Date.now() - 120_000), // 2 min ago → stale
  opened_at: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  blockM.mockResolvedValue(null);
  h.rows = [row()];
});

describe('ui:get_state handler', () => {
  it('requires a client_id (none passed, ctx.uiClientId unset)', async () => {
    const out = await call({}, {});
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/client_id_required/);
  });

  it('short-circuits on the cross-workspace guard', async () => {
    blockM.mockResolvedValue('blocked: other workspace');
    const out = await call({ client_id: 'c1' });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/blocked/);
  });

  it('maps a missing row to client_not_found', async () => {
    h.rows = [];
    const out = await call({}, { uiClientId: 'c1' });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/client_not_found/);
  });

  it('parses the URL into pathname/params/hash and flags stale (age > 60s)', async () => {
    const out = await call({}, { uiClientId: 'c1' });
    const b = JSON.parse(out.content[0]!.text);
    expect(b).toMatchObject({
      client_id: 'c1', workspace_id: 'ws-1', pathname: '/foo',
      params: { tab: 'x', panel: 'open' }, hash: null, title: 'Foo', stale: true,
    });
    expect(b.age_seconds).toBeGreaterThanOrEqual(100);
  });

  it('a fresh last_seen is NOT stale', async () => {
    h.rows = [row({ last_seen_at: new Date() })];
    const b = JSON.parse((await call({}, { uiClientId: 'c1' })).content[0]!.text);
    expect(b.stale).toBe(false);
  });

  it('falls back gracefully for a non-URL value', async () => {
    h.rows = [row({ url: 'not-a-url' })];
    const b = JSON.parse((await call({}, { uiClientId: 'c1' })).content[0]!.text);
    expect(b).toMatchObject({ pathname: 'not-a-url', params: {}, hash: null });
  });
});
