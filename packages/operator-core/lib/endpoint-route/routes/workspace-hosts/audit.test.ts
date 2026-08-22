import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  activeWorkspaceId: vi.fn(() => 'tenant-1'),
  exportAudit: vi.fn(),
}));

vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: H.activeWorkspaceId }));
vi.mock('../../../workspace-host/observability-store', () => ({ exportWorkspaceHostAudit: H.exportAudit }));

import routeDefinition from './audit';

type Route = {
  method: string;
  path: string;
  auth: string;
  handler: (request: Request, context: { params: Record<string, string> }) => Promise<Response>;
};

const route = routeDefinition as unknown as Route;

beforeEach(() => {
  H.activeWorkspaceId.mockClear();
  H.exportAudit.mockReset().mockResolvedValue({
    schemaVersion: 'papercusp-workspace-host-audit-v1',
    host: { id: 'host-1' },
  });
});

describe('GET /workspace-hosts/:workspaceId/audit', () => {
  it('is loopback-only and downloads the active tenant host audit', async () => {
    expect(route).toMatchObject({
      method: 'GET',
      path: '/workspace-hosts/:workspaceId/audit',
      auth: 'loopback',
    });

    const response = await route.handler(new Request('http://127.0.0.1/api/workspace-hosts/host-1/audit'), {
      params: { workspaceId: 'host-1' },
    });

    expect(response.status).toBe(200);
    expect(H.exportAudit).toHaveBeenCalledWith('tenant-1', 'host-1');
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="papercusp-workspace-host-host-1-audit-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    await expect(response.json()).resolves.toMatchObject({ host: { id: 'host-1' } });
  });

  it('rejects malformed ids before reading the store', async () => {
    const response = await route.handler(new Request('http://127.0.0.1/api/workspace-hosts/bad/audit'), {
      params: { workspaceId: 'bad/id' },
    });
    expect(response.status).toBe(400);
    expect(H.exportAudit).not.toHaveBeenCalled();
  });

  it('returns 404 when the host is outside the active workspace or absent', async () => {
    H.exportAudit.mockResolvedValue(null);
    const response = await route.handler(new Request('http://127.0.0.1/api/workspace-hosts/missing/audit'), {
      params: { workspaceId: 'missing' },
    });
    expect(response.status).toBe(404);
  });
});
