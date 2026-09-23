import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../../define-route';

const h = vi.hoisted(() => ({
  available: vi.fn(() => true),
  forward: vi.fn(async (_path: string, _body: unknown): Promise<Response | null> => null),
  prepare: vi.fn(async (input: unknown) => input),
  start: vi.fn(async (_input: unknown) => ({ operationId: 'init-1', hostId: 'host-1', status: 'accepted' })),
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'workspace-1' }));
vi.mock('../../../dbos/bootstrap', () => ({ dbosStarted: h.available }));
vi.mock('../../../workspace-host/controller-forwarding', () => ({ defaultWorkspaceHostRequestForwarder: h.forward }));
vi.mock('../../../workspace-host/initialization-admission', async (original) => ({
  ...await original<object>(), prepareWorkspaceHostInitialization: h.prepare,
}));
vi.mock('../../../dbos/workspace-host-provision-workflow', () => ({
  startWorkspaceHostInitializationWorkflow: h.start,
  WorkspaceHostOperationIdentityConflictError: class extends Error {},
  WorkspaceHostProvisioningConflictError: class extends Error {},
}));

import route from './initialize';
import { WorkspaceHostReleaseBindingError } from '../../../workspace-host/release-stage-receipt';

const ctx: RouteContext = {
  principal: null, input: undefined, params: { hostId: 'host-1' }, log: () => {}, signal: new AbortController().signal,
};
function post(extra: Record<string, unknown> = {}) {
  return new Request('http://127.0.0.1/workspace-hosts/host-1/initialize', {
    method: 'POST', body: JSON.stringify({ source: { kind: 'empty' }, credentialRefs: {}, credentialDelivery: {}, ...extra }),
  });
}

describe('workspace-host initialize agent coverage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('carries explicit normalized coverage into the production runner', async () => {
    const response = await route.handler(post({ requestedAgents: ['omp', 'claude'] }), ctx);
    expect(response.status).toBe(202);
    expect(h.start).toHaveBeenCalledWith(expect.objectContaining({ requestedAgents: ['claude', 'omp'] }));
    expect(await response.json()).toMatchObject({ status: 'accepted', auditUrl: '/api/workspace-hosts/host-1/audit' });
    expect(response.headers.get('location')).toBe('/api/workspace-hosts/host-1/audit');
  });

  it('preserves the all-agent default when coverage is omitted', async () => {
    expect((await route.handler(post(), ctx)).status).toBe(202);
    expect(h.start.mock.calls[0][0]).not.toHaveProperty('requestedAgents');
  });

  it.each([[], ['claude', 'claude'], ['unknown'], null, 'claude'].map((requestedAgents) => ({ requestedAgents })))(
    'refuses malformed coverage before resolving the provider or credentials: %j',
    async ({ requestedAgents }) => {
      const response = await route.handler(post({ requestedAgents }), ctx);
      expect(response.status).toBe(422);
      expect(h.forward).not.toHaveBeenCalled();
      expect(h.prepare).not.toHaveBeenCalled();
      expect(h.start).not.toHaveBeenCalled();
    },
  );

  it('forwards one operation identity before resolving credentials on a request-only host', async () => {
    h.forward.mockResolvedValueOnce(Response.json({ status: 'accepted' }, { status: 202 }));
    const response = await route.handler(post({ operationId: 'retry-1' }), ctx);
    expect(response.status).toBe(202);
    expect(h.forward).toHaveBeenCalledWith('/api/workspace-hosts/host-1/initialize', expect.objectContaining({ operationId: 'retry-1' }));
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('refuses without dispatch when the durable executor is unavailable', async () => {
    h.available.mockReturnValueOnce(false);
    expect((await route.handler(post(), ctx)).status).toBe(503);
    expect(h.start).not.toHaveBeenCalled();
  });

  it('carries an explicit release task into admission and reports it back', async () => {
    const response = await route.handler(post({ releaseTaskId: 'release-task-1' }), ctx);
    expect(response.status).toBe(202);
    expect(h.prepare).toHaveBeenCalledWith(expect.objectContaining({ releaseTaskId: 'release-task-1' }));
    expect(h.start).toHaveBeenCalledWith(expect.objectContaining({ releaseTaskId: 'release-task-1' }));
    expect(await response.json()).toMatchObject({ releaseTaskId: 'release-task-1' });
  });

  it.each([42, '', '../task', 'x'.repeat(65)])('refuses a malformed release task before anything else: %j', async (releaseTaskId) => {
    expect((await route.handler(post({ releaseTaskId }), ctx)).status).toBe(400);
    expect(h.forward).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it('answers a receipt that could never be written as a conflict, and an unknown task as not found', async () => {
    h.prepare.mockRejectedValueOnce(new WorkspaceHostReleaseBindingError('bundle-mismatch', 'workspace.root-bootstrap', 'other bytes'));
    const conflict = await route.handler(post({ releaseTaskId: 'release-task-1' }), ctx);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ reason: 'bundle-mismatch' });
    h.prepare.mockRejectedValueOnce(new WorkspaceHostReleaseBindingError('task-not-found', 'workspace.root-bootstrap', 'no task'));
    expect((await route.handler(post({ releaseTaskId: 'nope' }), ctx)).status).toBe(404);
    expect(h.start).not.toHaveBeenCalled();
  });

  it('retains identity when the enqueue outcome cannot be established', async () => {
    h.start.mockRejectedValueOnce(new Error('private transport detail'));
    const response = await route.handler(post({ operationId: 'lost-response' }), ctx);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({ outcome: 'unknown', operationId: 'lost-response' });
    expect(JSON.stringify(body)).not.toContain('private transport detail');
  });
});
