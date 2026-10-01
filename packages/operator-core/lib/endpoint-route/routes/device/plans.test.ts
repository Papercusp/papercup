import { beforeEach, describe, expect, it, vi } from 'vitest';

const source = vi.hoisted(() => ({
  listPlanIndexRows: vi.fn(),
  listPlanIndexRowsForWorkspace: vi.fn(),
  readPlanBySlug: vi.fn(),
  harnessExistsInWorkspace: vi.fn(),
}));

vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (definition: unknown) => definition,
  dispatchProjectedTool: vi.fn(),
  lookupByMcpName: vi.fn(),
}));
vi.mock('../../../agent-tools/index', () => ({}));
vi.mock('../../../agent-tools/plans/source', () => source);
vi.mock('../../../device-harnesses', () => source);

import routes from './plans';

const list = routes[0] as unknown as {
  handler: (req: Request, ctx: { principal: { kind: string; slug: string; workspaceId: string } }) => Promise<Response>;
};
const context = { principal: { kind: 'device', slug: 'phone-test', workspaceId: 'paired-workspace' } };
const row = (slug: string, updatedAt: string, harnessSlug = 'hive-home') => ({
  planSlug: slug, harnessSlug, updatedAt, title: null, status: null,
  updated: null, owner: null, archived: false,
  items: [{ status: 'done' }, { status: 'todo' }, { status: 'todo' }],
  nowState: 'Compatibility work', nowNext: 'Verify the candidate',
});

beforeEach(() => {
  vi.resetAllMocks();
  source.listPlanIndexRowsForWorkspace.mockResolvedValue([]);
  source.listPlanIndexRows.mockResolvedValue([]);
  source.harnessExistsInWorkspace.mockResolvedValue(true);
});

describe('device plans list', () => {
  it.each(['', '?harness=all', '?harness=*'])('reads the paired workspace index once for All Pots %s', async (query) => {
    source.listPlanIndexRowsForWorkspace.mockResolvedValue([
      row('older', '2026-08-01'), row('newer', '2026-10-01'),
    ]);
    const response = await list.handler(new Request(`http://localhost/api/device/plans${query}`), context);
    expect(response.status).toBe(200);
    expect(source.listPlanIndexRowsForWorkspace).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'paired-workspace', includeArchived: false,
      includeInstances: true, heavyFields: true,
    });
    expect(source.listPlanIndexRows).not.toHaveBeenCalled();
    expect(source.harnessExistsInWorkspace).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.plans.map((p: { slug: string }) => p.slug)).toEqual(['newer', 'older']);
    expect(body.plans[0]).toEqual({
      slug: 'newer', harness: 'hive-home', title: 'newer', status: null,
      updated: '2026-10-01', owner: null, archived: false,
      itemCounts: { done: 1, todo: 2 },
      nowState: 'Compatibility work', nowNext: 'Verify the candidate',
    });
  });

  it('keeps archive selection and same-named plans from different Hive homes', async () => {
    source.listPlanIndexRowsForWorkspace.mockResolvedValue([
      row('release', '2026-10-01', 'home-a'), row('release', '2026-10-01', 'home-b'),
    ]);
    const response = await list.handler(new Request('http://localhost/api/device/plans?includeArchived=true'), context);
    expect(source.listPlanIndexRowsForWorkspace).toHaveBeenCalledWith(expect.objectContaining({ includeArchived: true }));
    expect((await response.json()).plans).toHaveLength(2);
  });

  it('pins a selected member pot to the paired workspace for canonical Hive resolution', async () => {
    source.listPlanIndexRows.mockResolvedValue([row('release', '2026-10-01')]);
    const response = await list.handler(new Request('http://localhost/api/device/plans?harness=member-pot'), context);
    expect(response.status).toBe(200);
    expect(source.harnessExistsInWorkspace).toHaveBeenCalledExactlyOnceWith('paired-workspace', 'member-pot');
    expect(source.listPlanIndexRows).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'paired-workspace', harnessSlug: 'member-pot', includeArchived: false,
      includeInstances: true, heavyFields: true,
    });
    expect(source.listPlanIndexRowsForWorkspace).not.toHaveBeenCalled();
  });

  it('rejects a foreign pot before querying its plans', async () => {
    source.harnessExistsInWorkspace.mockResolvedValue(false);
    const response = await list.handler(new Request('http://localhost/api/device/plans?harness=foreign-pot'), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'harness_not_in_workspace' });
    expect(source.listPlanIndexRows).not.toHaveBeenCalled();
    expect(source.listPlanIndexRowsForWorkspace).not.toHaveBeenCalled();
  });

  it('surfaces a failed source read instead of reporting a healthy empty workspace', async () => {
    source.listPlanIndexRowsForWorkspace.mockRejectedValue(new Error('plan index unavailable'));
    await expect(list.handler(new Request('http://localhost/api/device/plans'), context))
      .rejects.toThrow('plan index unavailable');
  });
});
