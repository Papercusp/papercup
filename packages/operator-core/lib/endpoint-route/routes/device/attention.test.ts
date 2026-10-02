import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const source = vi.hoisted(() => ({
  lookup: vi.fn(), dispatch: vi.fn(), listWorkItems: vi.fn(),
  releaseGateTile: vi.fn(), poolTile: vi.fn(), systemAlerts: vi.fn(),
}));
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (definition: unknown) => definition,
  lookupByMcpName: source.lookup,
  dispatchProjectedTool: source.dispatch,
}));
vi.mock('../../../agent-tools/index', () => ({}));
vi.mock('../../../work-items', () => ({ listWorkItems: source.listWorkItems }));
vi.mock('../../../device-monitoring', () => ({
  releaseGateTile: source.releaseGateTile, poolTile: source.poolTile, systemAlerts: source.systemAlerts,
}));

import routes from './attention';

const attention = routes[0] as unknown as {
  handler: (req: Request, ctx: { principal: { kind: string; slug: string; workspaceId: string } }) => Promise<Response>;
};
const context = { principal: { kind: 'device', slug: 'phone-test', workspaceId: 'paired-workspace' } };
const read = () => attention.handler(new Request('http://localhost/api/device/attention'), context);
const dispatched = (body: unknown) => ({ result: { content: [{ type: 'text', text: JSON.stringify(body) }] } });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  source.lookup.mockReturnValue({});
  source.dispatch.mockResolvedValue(dispatched({ groups: [] }));
  source.listWorkItems.mockResolvedValue([]);
  source.releaseGateTile.mockResolvedValue({ gate: 'green', red: false, checkedAtMs: 1 });
  source.poolTile.mockResolvedValue({ exhausted: false, accounts: [] });
  source.systemAlerts.mockReturnValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe('device attention read integrity', () => {
  it('reports an empty inbox only after every source was successfully measured', async () => {
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      groups: [], workItems: [], systemAlerts: [], counts: { groups: 0, workItems: 0, systemAlerts: 0 },
    });
    expect(source.dispatch).toHaveBeenCalledWith(expect.anything(), 'plans:attention', {},
      expect.objectContaining({ workspaceId: 'paired-workspace' }), {});
    expect(source.poolTile).toHaveBeenCalledExactlyOnceWith('paired-workspace');
  });

  it('retains attention groups, eligible work items and a system-only alert', async () => {
    const groups = [{ items: [{ title: 'Needs a reply' }] }];
    const blocked = { id: 'feature', family: 'feature', state: 'blocked' };
    const bug = { id: 'bug', family: 'issue', kind: 'bug', state: 'open' };
    const alert = { id: 'system:red', title: 'Release needs attention' };
    source.dispatch.mockResolvedValue(dispatched({ groups }));
    source.listWorkItems.mockResolvedValue([blocked, bug,
      { id: 'done', family: 'feature', state: 'done' },
      { id: 'task', family: 'issue', kind: 'task', state: 'open' }]);
    source.systemAlerts.mockReturnValue([alert]);
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      groups, workItems: [blocked, bug], systemAlerts: [alert],
      counts: { groups: 1, workItems: 2, systemAlerts: 1 },
    });
  });

  it('does not claim an empty inbox when the canonical reader is missing', async () => {
    source.lookup.mockReturnValue(undefined);
    const response = await read();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'attention_unavailable' });
    expect(source.listWorkItems).not.toHaveBeenCalled();
  });

  it.each([{}, { groups: null }, { groups: {} }, { ok: false, groups: [] }])(
    'rejects a missing, malformed or failed canonical result: %j', async (body) => {
      source.dispatch.mockResolvedValue(dispatched(body));
      expect((await read()).status).toBe(503);
    },
  );

  it.each(['invalid-json', 'mcp-error', 'thrown'])('surfaces canonical %s as unavailable', async (failure) => {
    if (failure === 'thrown') source.dispatch.mockRejectedValue(new Error('reader failed'));
    else source.dispatch.mockResolvedValue({ result: {
      isError: failure === 'mcp-error', content: [{ type: 'text', text: 'unreadable result' }],
    } });
    expect((await read()).status).toBe(503);
  });

  it('does not hide a failed work-item read behind valid groups', async () => {
    source.dispatch.mockResolvedValue(dispatched({ groups: [{ items: [{ title: 'Visible' }] }] }));
    source.listWorkItems.mockRejectedValue(new Error('work-item read failed'));
    expect((await read()).status).toBe(503);
  });

  it.each(['releaseGateTile', 'poolTile'] as const)('does not treat unknown %s as healthy', async (tile) => {
    source[tile].mockResolvedValue(null);
    expect((await read()).status).toBe(503);
  });

  it('does not hide a system-alert producer failure as a healthy zero', async () => {
    source.systemAlerts.mockImplementation(() => { throw new Error('composer unavailable'); });
    expect((await read()).status).toBe(503);
  });
});
