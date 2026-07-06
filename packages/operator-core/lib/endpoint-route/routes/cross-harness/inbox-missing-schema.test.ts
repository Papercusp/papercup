/**
 * inbox / supervisor-notes routes — a joined-but-unscaffolded harness (D-…):
 * scaffoldHarnessSchema is explicitly BEST-EFFORT at join time (join-link.ts:
 * "harness is still usable without schema" — a scaffold failure never fails
 * the join). Found live on the Mac-VM E2E battery (WI-3133 dim 7): a
 * remote-hive mirror whose `harness_<slug>` schema was never scaffolded made
 * `GET /api/harness/:slug/inbox` 500 with a raw Postgres
 * `relation "harness_x.messages" does not exist` instead of the same graceful
 * empty result outbox already gives for a schema-less harness. Pin the fix:
 * an undefined-table/relation error degrades to an empty list, not a 500.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@papercusp/agent-mcp', () => ({ defineTool: (d: unknown) => d }));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws' }));
vi.mock('../../../cross-harness-data', () => ({ readRecentActivity: vi.fn() }));
vi.mock('../../../operator-api-base', () => ({ operatorApiBase: () => 'http://127.0.0.1:0' }));

const undefinedTableError = () => {
  const e: any = new Error('relation "harness_x.messages" does not exist');
  e.code = '42P01';
  return e;
};

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({
    sql: Object.assign(
      async () => {
        throw undefinedTableError();
      },
      { unsafe: async () => { throw undefinedTableError(); } },
    ),
  }),
  withWorkspace: async () => [],
}));

describe('cross-harness inbox/supervisor-notes on a schema-less (join-scaffold-skipped) harness', () => {
  it('inbox: undefined-table degrades to {messages: []}, not a 500', async () => {
    const routes = (await import('./index')).default;
    const inboxRoute = routes.find((r: any) => r.path === '/harness/:slug/inbox') as any;
    const res: Response = await inboxRoute.handler(
      new Request('http://x/api/harness/x/inbox'),
      { params: { slug: 'x' } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ slug: 'x', status: 'pending', role: null, messages: [] });
  });

  it('supervisor-notes: undefined-table degrades to {notes: []}, not a 500', async () => {
    const routes = (await import('./index')).default;
    const notesRoute = routes.find((r: any) => r.path === '/harness/:slug/supervisor-notes') as any;
    const res: Response = await notesRoute.handler(
      new Request('http://x/api/harness/x/supervisor-notes'),
      { params: { slug: 'x' } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ slug: 'x', notes: [] });
  });
});
