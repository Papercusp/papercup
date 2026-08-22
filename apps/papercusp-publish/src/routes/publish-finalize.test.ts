/**
 * publish-finalize.test.ts — POST /publish/finalize (Plan 2 Phase A, P-003).
 *
 * Finalize turns an uploaded deployment into a live CF Pages deployment. The
 * behaviors that matter: deploymentId required, unknown → 404, **another
 * tenant's deployment → 403** (cross-tenant isolation), incomplete uploads →
 * 409, the happy path creates the CF deployment + flips status to 'building' +
 * fires the R2 archive write (waitUntil) + audits, and a CF failure marks the
 * deployment 'failed' + returns 502. Driven via app.fetch (executionCtx
 * provided for waitUntil) with the DB / CF / R2 deps mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getDeployment: vi.fn(),
  getProject: vi.fn(),
  listDeploymentFiles: vi.fn(),
  setDeploymentStatus: vi.fn(async () => {}),
  audit: vi.fn(async () => {}),
  clientIp: vi.fn(() => '1.2.3.4'),
  createDeployment: vi.fn(),
  archivePath: vi.fn(() => 'archive/key'),
  writeManifest: vi.fn(async () => {}),
}));

vi.mock('../jwt-middleware.ts', () => ({
  jwtMiddleware: () => async (c: any, next: any) => {
    c.set('tenantId', 'tenant-1');
    c.set('jwt', { sub: 'tenant-1' });
    await next();
  },
}));
vi.mock('../db.ts', () => ({
  getDeployment: h.getDeployment,
  getProject: h.getProject,
  listDeploymentFiles: h.listDeploymentFiles,
  setDeploymentStatus: h.setDeploymentStatus,
  audit: h.audit,
  clientIp: h.clientIp,
}));
vi.mock('../cf-pages.ts', () => ({ createDeployment: h.createDeployment }));
vi.mock('../r2-archive.ts', () => ({ archivePath: h.archivePath, writeManifest: h.writeManifest }));

import { publishFinalizeRoute } from './publish-finalize.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const env: any = { DB: {} };
const execCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
const finalize = (body: unknown) =>
  publishFinalizeRoute().fetch(
    new Request('http://x/publish/finalize', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    env,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execCtx as any,
  );
const outcomes = () => (h.audit.mock.calls as unknown[][]).map((c) => c[2]);

beforeEach(() => {
  vi.clearAllMocks();
  h.getDeployment.mockResolvedValue({
    id: 'dep-1', tenant_id: 'tenant-1', harness_slug: 'demo',
    vanity_url: 'https://v.example', manifest_sha: 's', bytes_total: 10, created_at: 1,
  });
  h.getProject.mockResolvedValue({ cf_project_name: 'cf-demo', vanity_subdomain: 'v' });
  h.listDeploymentFiles.mockResolvedValue([{ path: 'a.html', sha256: 'sa', bytes: 5, uploaded: 1 }]);
  h.createDeployment.mockResolvedValue({ id: 'cfdep-1', url: 'https://cf', latest_stage: { name: 'deploy', status: 'success' } });
});
afterEach(() => vi.clearAllMocks());

describe('POST /publish/finalize', () => {
  it('requires a deploymentId', async () => {
    const res = await finalize({});
    expect(res.status).toBe(400);
  });

  it('404s an unknown deployment', async () => {
    h.getDeployment.mockResolvedValue(null);
    const res = await finalize({ deploymentId: 'nope' });
    expect(res.status).toBe(404);
  });

  it('CROSS-TENANT: 403 when the deployment belongs to another tenant', async () => {
    h.getDeployment.mockResolvedValue({ id: 'dep-1', tenant_id: 'someone-else', harness_slug: 'demo' });
    const res = await finalize({ deploymentId: 'dep-1' });
    expect(res.status).toBe(403);
    expect(h.createDeployment).not.toHaveBeenCalled();
  });

  it('409 when uploads are incomplete', async () => {
    h.listDeploymentFiles.mockResolvedValue([{ path: 'a', sha256: 'sa', bytes: 5, uploaded: 0 }]);
    const res = await finalize({ deploymentId: 'dep-1' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'uploads incomplete', missingCount: 1 });
  });

  it('finalizes: 200 building, flips status, archives, audits', async () => {
    const res = await finalize({ deploymentId: 'dep-1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'building', vanityUrl: 'https://v.example' });
    expect(h.setDeploymentStatus).toHaveBeenCalledWith(
      expect.anything(), 'dep-1', 'building',
      expect.objectContaining({ cf_deployment_id: 'cfdep-1' }),
    );
    expect(execCtx.waitUntil).toHaveBeenCalledTimes(1); // R2 archive write
    expect(outcomes()).toContain('finalized');
  });

  it('502 + marks failed when the CF deployment fails', async () => {
    h.createDeployment.mockRejectedValue(new Error('cf down'));
    const res = await finalize({ deploymentId: 'dep-1' });
    expect(res.status).toBe(502);
    expect(h.setDeploymentStatus).toHaveBeenCalledWith(
      expect.anything(), 'dep-1', 'failed', expect.objectContaining({ failure_reason: 'cf down' }),
    );
    expect(outcomes()).toContain('cf_error');
  });
});
