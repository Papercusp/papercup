import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../../define-route';

const h = vi.hoisted(() => ({
  profile: vi.fn(() => ({})),
  operations: vi.fn(async () => ({ operations: {}, deliveryCapabilities: { fileTransfer: true } })),
  run: vi.fn(async (_input: unknown) => ({ operationId: 'init-1', plan: { steps: [] }, receipts: [] })),
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'workspace-1' }));
vi.mock('../../../workspace-host/credential-material-source', () => ({ createOperatorWorkspaceHostCredentialMaterialSource: () => ({}) }));
vi.mock('../../../workspace-host/initialization-runner', () => ({ runWorkspaceHostInitialization: h.run }));
vi.mock('../../../workspace-host/initialization-operations-resolver', () => ({
  resolveWorkspaceHostInitializationControllerProfile: h.profile,
  resolveWorkspaceHostInitializationOperationsForHost: h.operations,
  UnsupportedWorkspaceHostInitializationTargetError: class extends Error {},
  WorkspaceHostDesiredSpecUnavailableError: class extends Error {},
  WorkspaceHostInitializationControllerProfileError: class extends Error {},
}));

import route from './initialize';

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
    expect(response.status).toBe(200);
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ requestedAgents: ['claude', 'omp'] }));
  });

  it('preserves the all-agent default when coverage is omitted', async () => {
    expect((await route.handler(post(), ctx)).status).toBe(200);
    expect(h.run.mock.calls[0][0]).not.toHaveProperty('requestedAgents');
  });

  it.each([[], ['claude', 'claude'], ['unknown'], null, 'claude'].map((requestedAgents) => ({ requestedAgents })))(
    'refuses malformed coverage before resolving the provider or credentials: %j',
    async ({ requestedAgents }) => {
      const response = await route.handler(post({ requestedAgents }), ctx);
      expect(response.status).toBe(422);
      expect(h.profile).not.toHaveBeenCalled();
      expect(h.operations).not.toHaveBeenCalled();
      expect(h.run).not.toHaveBeenCalled();
    },
  );
});
