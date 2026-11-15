import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  read: vi.fn(), pot: vi.fn(), canonical: vi.fn(), home: vi.fn(), workspace: vi.fn(),
}));
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({ ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()), defineTool: (tool: unknown) => tool }));
vi.mock('../../../owner-steering', () => ({
  getOwnerSteering: mocks.read,
  DEFAULT_OWNER_STEERING: { directive: null, pauseNewWork: false, pausedUntil: null },
}));
vi.mock('../../../hive-store', () => ({ getHiveBySlug: mocks.pot }));
vi.mock('../../../federated-pot-scope', () => ({ resolveFederatedPotScope: mocks.canonical }));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: mocks.workspace }));
vi.mock('../../../pot/wake', () => ({ resolvePotHomeSlug: mocks.home }));
import route from './hive-steering';

const clear = { directive: null, pauseNewWork: false, pausedUntil: null };
async function read(query = '?workspace=ws-a&hive=local-a') {
  return route.handler(new Request(`http://localhost/api/operator/hive-steering${query}`), {} as never);
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.workspace.mockReturnValue('default-ws');
  mocks.home.mockImplementation((value) => value || 'default-pot');
  mocks.pot.mockResolvedValue({ canonicalHomeSlug: 'pot-a' });
  mocks.canonical.mockResolvedValue('pot-a');
  mocks.read.mockResolvedValue(clear);
});

describe('hive steering availability and canonical scope (D006)', () => {
  it('preserves legacy fields and reports successful own-scope restrictions', async () => {
    mocks.read.mockResolvedValue({ ...clear, pauseNewWork: true, directive: 'hold' });
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...clear, pauseNewWork: true, directive: 'hold',
      steeringRead: { availability: 'available', workspaceId: 'ws-a', potHomeSlug: 'pot-a' },
    });
    expect(mocks.pot).toHaveBeenCalledWith('ws-a', 'local-a');
    expect(mocks.read).toHaveBeenCalledWith('ws-a', 'pot-a');
  });
  it('distinguishes HTTP200 backend failure defaults from an authoritative clear', async () => {
    mocks.read.mockRejectedValueOnce(new Error('backend read failed'));
    const failed = await read();
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual({ ...clear,
      steeringRead: { availability: 'unavailable', workspaceId: 'ws-a', potHomeSlug: 'pot-a' },
    });
    expect(await (await read()).json()).toEqual({ ...clear,
      steeringRead: { availability: 'available', workspaceId: 'ws-a', potHomeSlug: 'pot-a' },
    });
  });
  it('does not claim authority for an unknown pot in another workspace', async () => {
    mocks.pot.mockResolvedValue(null);
    expect((await (await read('?workspace=ws-b&hive=local-a')).json()).steeringRead)
      .toEqual({ availability: 'unavailable', workspaceId: 'ws-b', potHomeSlug: null });
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('marks missing home and failed canonical resolution unavailable', async () => {
    mocks.home.mockReturnValueOnce(null);
    expect((await (await read('')).json()).steeringRead.availability).toBe('unavailable');
    mocks.canonical.mockRejectedValueOnce(new Error('registry failed'));
    expect((await (await read()).json()).steeringRead.availability).toBe('unavailable');
  });
  it('retains default workspace/home behavior for legacy consumers', async () => {
    const body = await (await read('')).json();
    expect(body.pauseNewWork).toBe(false);
    expect(body.steeringRead.workspaceId).toBe('default-ws');
    expect(mocks.pot).toHaveBeenCalledWith('default-ws', 'default-pot');
  });
});
