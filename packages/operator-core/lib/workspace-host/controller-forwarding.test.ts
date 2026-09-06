import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WORKSPACE_HOST_CONTROLLER_FORWARD_TIMEOUT_MS,
  forwardWorkspaceHostRequest,
  type WorkspaceHostControllerForwardingOptions,
} from './controller-forwarding';

const row = (overrides: Partial<Awaited<ReturnType<WorkspaceHostControllerForwardingOptions['collectControllers']>>[number]> = {}) => ({
  port: 3271,
  pid: 4271,
  label: 'bg-host:3271',
  process: 'bg-host',
  ok: true,
  timers: [],
  dbosSchedules: [],
  stallWaker: null,
  elapsedMs: 1,
  ...overrides,
});

describe('workspace-host controller forwarding', () => {
  it('selects the direct bg-host sibling and relays the typed response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ ok: true, status: 'succeeded' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await forwardWorkspaceHostRequest(
      '/api/workspace-hosts/provision',
      { connectionId: 'connection-1' },
      {
        isRequestOnly: () => true,
        collectControllers: async () => [
          row({ port: 3070, label: 'operator:3070', process: 'operator' }),
          row(),
        ],
        fetchImpl,
      },
    );

    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toEqual({ ok: true, status: 'succeeded' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:3271/api/workspace-hosts/provision',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ connectionId: 'connection-1' }),
      }),
    );
  });

  it('does not select a relayed primary row or any non-controller sibling', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const response = await forwardWorkspaceHostRequest(
      '/api/workspace-hosts/action',
      { action: 'stop', workspaceId: 'host-1' },
      {
        isRequestOnly: () => true,
        collectControllers: async () => [
          row({ label: 'bg-host(primary via :3070)', port: 3070 }),
          row({ label: 'operator:3270', port: 3270, process: 'operator' }),
        ],
        fetchImpl,
      },
    );

    expect(response).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('bypasses discovery on a local controller and degrades bounded transport failures', async () => {
    const collectControllers = vi.fn(async () => [row()]);
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('controller unavailable');
    });

    await expect(
      forwardWorkspaceHostRequest(
        '/api/workspace-hosts/action',
        { action: 'stop', workspaceId: 'host-1' },
        { isRequestOnly: () => false, collectControllers, fetchImpl },
      ),
    ).resolves.toBeNull();
    expect(collectControllers).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(
      forwardWorkspaceHostRequest(
        '/api/workspace-hosts/action',
        { action: 'stop', workspaceId: 'host-1' },
        {
          isRequestOnly: () => true,
          collectControllers: async () => [row()],
          fetchImpl,
          timeoutMs: DEFAULT_WORKSPACE_HOST_CONTROLLER_FORWARD_TIMEOUT_MS,
        },
      ),
    ).resolves.toBeNull();
  });
});
