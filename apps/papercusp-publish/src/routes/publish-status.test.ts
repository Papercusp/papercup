/**
 * publish-status.test.ts — GET /publish/status/:deploymentId (Plan 2 Phase A).
 *
 * Status polling mirrors CF Pages state into the deployments row. The behaviors
 * that matter: unknown deployment → 404, **another tenant's deployment → 403**
 * (cross-tenant isolation), a terminal/non-pollable status returns the row
 * verbatim, a still-building deployment re-polls CF and (when the stage advanced)
 * writes the new status + completed_at + failure_reason, a CF stage that flips to
 * 'failed' surfaces the failure reason, and a transient CF error is swallowed
 * (returns the current row, no write). Driven via the real route with a
 * pass-through jwtMiddleware and the DB / CF deps mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getDeployment: vi.fn(),
  getProject: vi.fn(),
  setDeploymentStatus: vi.fn(async () => {}),
  cfGetDeployment: vi.fn(),
}));

// Pass-through auth: bind the tenant the handler reads.
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
  setDeploymentStatus: h.setDeploymentStatus,
}));
// Use the real cfStageToStatus mapping; only stub the network getDeployment.
vi.mock('../cf-pages.ts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getDeployment: h.cfGetDeployment };
});

import { publishStatusRoute } from './publish-status.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const env: any = { DB: {} };
const status = (id: string) =>
  publishStatusRoute().request(`/publish/status/${id}`, { method: 'GET' }, env);

const baseDep = (over: Record<string, unknown> = {}) => ({
  id: 'dep-1',
  tenant_id: 'tenant-1',
  harness_slug: 'demo',
  status: 'building',
  failure_reason: null,
  cf_deployment_id: 'cfdep-1',
  vanity_url: 'https://v.example',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.getDeployment.mockResolvedValue(baseDep());
  h.getProject.mockResolvedValue({ cf_project_name: 'cf-demo' });
});
afterEach(() => vi.clearAllMocks());

describe('GET /publish/status/:deploymentId', () => {
  it('404s an unknown deployment', async () => {
    h.getDeployment.mockResolvedValue(null);
    const res = await status('nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'unknown deployment' });
  });

  it('CROSS-TENANT: 403 when the deployment belongs to another tenant', async () => {
    h.getDeployment.mockResolvedValue(baseDep({ tenant_id: 'someone-else' }));
    const res = await status('dep-1');
    expect(res.status).toBe(403);
    expect(h.cfGetDeployment).not.toHaveBeenCalled();
  });

  it('returns a terminal status verbatim without polling CF', async () => {
    h.getDeployment.mockResolvedValue(baseDep({ status: 'live' }));
    const res = await status('dep-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'live',
      vanityUrl: 'https://v.example',
      failureReason: null,
    });
    expect(h.cfGetDeployment).not.toHaveBeenCalled();
    expect(h.setDeploymentStatus).not.toHaveBeenCalled();
  });

  it('does not poll CF when cf_deployment_id is missing', async () => {
    h.getDeployment.mockResolvedValue(baseDep({ cf_deployment_id: null }));
    const res = await status('dep-1');
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('building');
    expect(h.cfGetDeployment).not.toHaveBeenCalled();
  });

  it('does not write when the CF stage has not advanced past current status', async () => {
    // building → cfStageToStatus(build/active) = 'building' == current ⇒ no write.
    h.cfGetDeployment.mockResolvedValue({
      id: 'cfdep-1',
      url: 'https://cf',
      latest_stage: { name: 'build', status: 'active' },
    });
    const res = await status('dep-1');
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('building');
    expect(h.cfGetDeployment).toHaveBeenCalled();
    expect(h.setDeploymentStatus).not.toHaveBeenCalled();
  });

  it('advances to live, persists with completed_at, and returns the new status', async () => {
    h.cfGetDeployment.mockResolvedValue({
      id: 'cfdep-1',
      url: 'https://cf',
      latest_stage: { name: 'deploy', status: 'success' }, // → 'live'
    });
    const res = await status('dep-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'live', failureReason: null });
    expect(h.setDeploymentStatus).toHaveBeenCalledWith(
      expect.anything(),
      'dep-1',
      'live',
      expect.objectContaining({ completed_at: expect.any(Number) }),
    );
  });

  it('flips to failed, surfaces the failure reason, and persists it', async () => {
    h.cfGetDeployment.mockResolvedValue({
      id: 'cfdep-1',
      url: 'https://cf',
      latest_stage: { name: 'deploy', status: 'failure' }, // → 'failed'
    });
    const res = await status('dep-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'failed', failureReason: 'deploy' });
    expect(h.setDeploymentStatus).toHaveBeenCalledWith(
      expect.anything(),
      'dep-1',
      'failed',
      expect.objectContaining({ failure_reason: 'deploy', completed_at: expect.any(Number) }),
    );
  });

  it('swallows a transient CF error and returns the current row unchanged', async () => {
    h.cfGetDeployment.mockRejectedValue(new Error('cf 503'));
    const res = await status('dep-1');
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('building');
    expect(h.setDeploymentStatus).not.toHaveBeenCalled();
  });

  it('does not poll a deployment whose project row is missing', async () => {
    h.getProject.mockResolvedValue(null);
    const res = await status('dep-1');
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('building');
    expect(h.cfGetDeployment).not.toHaveBeenCalled();
    expect(h.setDeploymentStatus).not.toHaveBeenCalled();
  });
});
