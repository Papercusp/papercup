import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WORKSPACE_HOST_CONTROLLER_FORWARD_TIMEOUT_MS,
  forwardWorkspaceHostRequest,
  type WorkspaceHostControllerForwardingOptions,
} from './controller-forwarding';
import { WORKSPACE_HOST_ADMISSION_WINDOW_MS } from './admission-window';

type ControllerRow = Awaited<
  ReturnType<NonNullable<WorkspaceHostControllerForwardingOptions['collectControllers']>>
>[number];

const row = (overrides: Partial<ControllerRow> = {}) => ({
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
  it.each(['initialize', 'desktop-pack'] as const)('preserves durable %s acceptance and its audit location', async (action) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ status: 'accepted', operationId: 'op-1' }, {
      status: 202, headers: { location: '/api/workspace-hosts/host-1/audit' },
    }));
    const response = await forwardWorkspaceHostRequest(`/api/workspace-hosts/host-1/${action}`, { operationId: 'op-1' }, {
      isRequestOnly: () => true, collectControllers: async () => [row()], fetchImpl,
    });
    expect(response?.status).toBe(202);
    expect(response?.headers.get('location')).toBe('/api/workspace-hosts/host-1/audit');
    await expect(response?.json()).resolves.toEqual({ status: 'accepted', operationId: 'op-1' });
  });

  it('selects the direct bg-host sibling and relays the typed response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ ok: true, status: 'succeeded' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await forwardWorkspaceHostRequest(
      '/api/workspace-hosts/provision',
      { connectionId: 'connection-1', operationId: 'provision-1' },
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
        body: JSON.stringify({ connectionId: 'connection-1', operationId: 'provision-1' }),
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

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toMatchObject({ outcome: 'not-dispatched' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports empty discovery separately from a discovery failure without dispatching', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const [collectControllers, reason] of [
      [async () => [], 'no-controller'],
      [async () => { throw new Error('private-token-canary'); }, 'discovery-failed'],
    ] as const) {
      const response = await forwardWorkspaceHostRequest('/api/workspace-hosts/action', { action: 'stop', workspaceId: 'host-1' }, {
        isRequestOnly: () => true, collectControllers, fetchImpl,
      });
      expect(response?.status).toBe(503);
      const body = await response!.json();
      expect(body).toMatchObject({
        outcome: 'not-dispatched',
        controllerDiscovery: { reason, candidates: [], omittedCandidates: 0 },
      });
      expect(JSON.stringify(body)).not.toContain('private-token-canary');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('bounds unreachable-candidate diagnostics while preserving omitted coverage', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const candidates = Array.from({ length: 10 }, (_, i) => row({
      port: 3271 + i, ok: false, elapsedMs: 1200, error: 'private-token-canary',
    }));
    const response = await forwardWorkspaceHostRequest('/api/workspace-hosts/action', { action: 'stop', workspaceId: 'host-1' }, {
      isRequestOnly: () => true, collectControllers: async () => candidates, fetchImpl,
    });
    expect(response?.status).toBe(503);
    const body = await response!.json();
    expect(body.controllerDiscovery.reason).toBe('no-controller');
    expect(body.controllerDiscovery.candidates).toHaveLength(8);
    expect(body.controllerDiscovery.omittedCandidates).toBe(2);
    expect(body.controllerDiscovery.candidates[0]).toEqual({ port: 3271, pid: 4271, role: 'bg-host', reachable: false, direct: true, elapsedMs: 1200 });
    expect(JSON.stringify(body)).not.toContain('private-token-canary');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('bypasses discovery on a local controller', async () => {
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

  });

  it('preserves an accepted operation identity when its response times out', async () => {
    const accepted = new Set<string>();
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      accepted.add(JSON.parse(String(init?.body)).operationId);
      throw new DOMException('response deadline exceeded', 'TimeoutError');
    });
    const response = await forwardWorkspaceHostRequest(
      '/api/workspace-hosts/action',
      { action: 'repair', workspaceId: 'host-1', operationId: 'repair-3' },
      {
        isRequestOnly: () => true,
        collectControllers: async () => [row()],
        fetchImpl,
        timeoutMs: DEFAULT_WORKSPACE_HOST_CONTROLLER_FORWARD_TIMEOUT_MS,
      },
    );

    expect(response?.status).toBe(504);
    await expect(response?.json()).resolves.toMatchObject({
      ok: false,
      outcome: 'unknown',
      operationId: 'repair-3',
    });
    expect(accepted.has('repair-3')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('returns the generated operation identity after losing an upstream response body', async () => {
    let submittedOperationId: string | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      submittedOperationId = JSON.parse(String(init?.body)).operationId;
      return new Response(new ReadableStream({
        start(controller) {
          controller.error(new Error('connection lost after dispatch'));
        },
      }));
    });
    const response = await forwardWorkspaceHostRequest(
      '/api/workspace-hosts/provision',
      { connectionId: 'connection-1' },
      { isRequestOnly: () => true, collectControllers: async () => [row()], fetchImpl },
    );

    expect(submittedOperationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response?.status).toBe(504);
    await expect(response?.json()).resolves.toMatchObject({
      ok: false,
      outcome: 'unknown',
      operationId: submittedOperationId,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  // EI-23712230399040759: a deadline at or under the controller's admission window reports every
  // slow-but-healthy admission as a lost response with an unknown outcome.
  it('outlives the controller admission window by a real margin', () => {
    expect(DEFAULT_WORKSPACE_HOST_CONTROLLER_FORWARD_TIMEOUT_MS - WORKSPACE_HOST_ADMISSION_WINDOW_MS).toBeGreaterThanOrEqual(
      5_000,
    );
  });
});
