/**
 * list_clients.test.ts — the ui:list_clients HANDLER (sql-tagged-template mocked). Pins
 * the projection: count, self_client_id (from ctx.uiClientId), the per-row is_self flag
 * (client_id === ctx.uiClientId), and the Date→ISO mapping. A regression that mis-flags
 * is_self (so the agent can't tell which tab spawned it) is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/ui/list_clients.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(() => ({ sql: vi.fn(async () => h.rows) })),
}));

const tool = (await import('./list_clients')).default;

type Out = { content: { text: string }[] };
const call = (ctx: Record<string, unknown> = {}) => tool.handler({} as never, ctx as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);
const row = (client_id: string) => ({
  client_id, workspace_id: 'ws-1', url: 'https://app/x', title: 'X',
  opened_at: new Date('2026-01-01T00:00:00Z'), last_seen_at: new Date('2026-01-02T00:00:00Z'),
});

beforeEach(() => {
  vi.clearAllMocks();
  h.rows = [row('c1'), row('c2')];
});

describe('ui:list_clients handler', () => {
  it('marks the spawning tab is_self=true and reports self_client_id + count', async () => {
    const b = body(await call({ uiClientId: 'c1' }));
    expect(b).toMatchObject({ self_client_id: 'c1', count: 2 });
    expect(b.clients[0]).toMatchObject({ client_id: 'c1', is_self: true, last_seen_at: '2026-01-02T00:00:00.000Z' });
    expect(b.clients[1]).toMatchObject({ client_id: 'c2', is_self: false });
  });

  it('no spawning tab → self_client_id null and nothing is_self', async () => {
    const b = body(await call({}));
    expect(b.self_client_id).toBeNull();
    expect(b.clients.every((c: { is_self: boolean }) => c.is_self === false)).toBe(true);
  });
});
