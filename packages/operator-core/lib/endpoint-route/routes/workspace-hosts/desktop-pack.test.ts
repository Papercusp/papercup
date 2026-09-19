import { beforeEach, expect, it, vi } from 'vitest';
import type { RouteContext } from '../../define-route';

const h = vi.hoisted(() => ({
  forward: vi.fn(async (): Promise<Response | null> => null),
  available: vi.fn(() => true),
  prepare: vi.fn(async (input: unknown) => input),
  start: vi.fn(async () => ({ operationId: 'pack-1', hostId: 'host-1', status: 'accepted' })),
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-1' }));
vi.mock('../../../dbos/bootstrap', () => ({ dbosStarted: h.available }));
vi.mock('../../../workspace-host/controller-forwarding', () => ({ defaultWorkspaceHostRequestForwarder: h.forward }));
vi.mock('../../../workspace-host/initialization-admission', () => ({ prepareWorkspaceHostDesktopPack: h.prepare }));
vi.mock('../../../dbos/workspace-host-provision-workflow', () => ({
  startWorkspaceHostDesktopPackWorkflow: h.start,
  WorkspaceHostOperationIdentityConflictError: class extends Error {},
  WorkspaceHostProvisioningConflictError: class extends Error {},
}));
import route from './desktop-pack';
const ctx: RouteContext = { principal: null, input: undefined, params: { hostId: 'host-1' }, log: () => {}, signal: new AbortController().signal };
const post = (body: unknown) => new Request('http://127.0.0.1/workspace-hosts/host-1/desktop-pack', { method: 'POST', body: JSON.stringify(body) });
beforeEach(() => vi.clearAllMocks());

it('admits only the fixed installer and returns an operation receipt', async () => {
  const response = await route.handler(post({ operationId: 'pack-1' }), ctx);
  expect(response.status).toBe(202);
  expect(h.start).toHaveBeenCalledWith(expect.objectContaining({ action: 'install-desktop-pack', hostId: 'host-1', workspaceId: 'ws-1', operationId: 'pack-1' }));
  expect(await response.json()).toMatchObject({ status: 'accepted', auditUrl: '/api/workspace-hosts/host-1/audit' });
});

it.each([{ script: 'id' }, { url: 'https://untrusted.invalid' }, { unixUser: 'root' }, { operationId: '' }, []])('refuses caller-controlled installation fields: %j', async (body) => {
  expect((await route.handler(post(body), ctx)).status).toBe(400);
  expect(h.start).not.toHaveBeenCalled();
  expect(h.forward).not.toHaveBeenCalled();
});

it('forwards the same operation identity without local installation on a request-only host', async () => {
  h.forward.mockResolvedValueOnce(Response.json({ status: 'accepted' }, { status: 202 }));
  expect((await route.handler(post({ operationId: 'pack-1' }), ctx)).status).toBe(202);
  expect(h.forward).toHaveBeenCalledWith('/api/workspace-hosts/host-1/desktop-pack', { operationId: 'pack-1' });
  expect(h.start).not.toHaveBeenCalled();
});
