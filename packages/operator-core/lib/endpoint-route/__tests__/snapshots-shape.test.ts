/**
 * Tests for /api/snapshots/:id/shape — 404, 500, shape extraction,
 * malformed-shapeJson graceful handling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../telemetry', () => ({
  recordRouteInvocation: vi.fn(async () => {}),
}));
vi.mock('../../require-flag', () => ({
  gateApiRoute: vi.fn(async () => null),
}));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function call(id: string) {
  const { Hono } = await import('hono');
  const { registerAllRoutes } = await import('../register');
  const app = new Hono().basePath('/api');
  registerAllRoutes(app);
  return app.request(`/api/snapshots/${id}/shape`);
}

describe('GET /api/snapshots/:id/shape', () => {
  // First test in the file pays the full registerAllRoutes cold-import (the
  // whole operator route graph) under vi.resetModules() — generous headroom for
  // a fully-parallel full-suite run on the contended dev box (30s still tripped
  // under the release gate's green-checkpoint with the fleet at load ~50).
  it('returns 404 when snapshot is unknown', { timeout: 120000 }, async () => {
    vi.doMock('../../snapshot-discovery', () => ({
      findSnapshot: async () => null,
    }));
    const r = await call('snap_doesntexist');
    expect(r.status).toBe(404);
  });

  it('returns 500 when manifest cannot be read from tarball', async () => {
    vi.doMock('../../snapshot-discovery', () => ({
      findSnapshot: async () => ({ id: 'snap_x', tarballPath: '/no/such/path.tar.gz' }),
    }));
    vi.doMock('@papercusp/export-state', () => ({
      effectiveVersionPin: (p: any) => p.versionPin
        ? { mode: p.versionPin.mode, allowOverride: p.versionPin.allowOverride ?? 'security-patch' }
        : { mode: p.pluginVersionPinned === false ? 'semver' : 'exact', allowOverride: 'security-patch' },
      readManifestFromTarball: async () => { throw new Error('tarball missing'); },
    }));
    const r = await call('snap_x');
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body.error).toContain('tarball missing');
  });

  it('extracts shape + pinning info per plugin', async () => {
    vi.doMock('../../snapshot-discovery', () => ({
      findSnapshot: async () => ({ id: 'snap_x', tarballPath: '/fake/path.tar.gz' }),
    }));
    vi.doMock('@papercusp/export-state', () => ({
      effectiveVersionPin: (p: any) => p.versionPin
        ? { mode: p.versionPin.mode, allowOverride: p.versionPin.allowOverride ?? 'security-patch' }
        : { mode: p.pluginVersionPinned === false ? 'semver' : 'exact', allowOverride: 'security-patch' },
      readManifestFromTarball: async () => ({
        plugins: [
          {
            name: 'github-repo',
            version: '0.1.0',
            pluginVersionPinned: true,
            configJson: JSON.stringify({ repo: 'sample' }),
            shapeJson: JSON.stringify({
              fields: {
                github_token: { reason: 'secret-strip', oauth: { provider: 'github' } },
                owner: { reason: 'shareable-false' },
              },
              warnings: [],
            }),
          },
          {
            name: 'pre-v1-plugin',
            version: '0.1.0',
            configJson: JSON.stringify({ x: 1 }),
          },
        ],
      }),
    }));

    const r = await call('snap_x');
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.plugins).toHaveLength(2);

    const ghr = body.plugins[0];
    expect(ghr.name).toBe('github-repo');
    expect(ghr.pluginVersionPinned).toBe(true);
    expect(ghr.shape.fields.github_token.reason).toBe('secret-strip');
    expect(ghr.shape.fields.owner.reason).toBe('shareable-false');

    const old = body.plugins[1];
    expect(old.shape).toBeNull();
    expect(old.pluginVersionPinned).toBe(true);
  });

  it('handles malformed shapeJson gracefully (shape=null, no error)', async () => {
    vi.doMock('../../snapshot-discovery', () => ({
      findSnapshot: async () => ({ id: 'snap_x', tarballPath: '/fake/path.tar.gz' }),
    }));
    vi.doMock('@papercusp/export-state', () => ({
      effectiveVersionPin: (p: any) => p.versionPin
        ? { mode: p.versionPin.mode, allowOverride: p.versionPin.allowOverride ?? 'security-patch' }
        : { mode: p.pluginVersionPinned === false ? 'semver' : 'exact', allowOverride: 'security-patch' },
      readManifestFromTarball: async () => ({
        plugins: [{ name: 'broken', version: '0.1.0', shapeJson: '{not json' }],
      }),
    }));
    const r = await call('snap_x');
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.plugins[0].shape).toBeNull();
  });
});
