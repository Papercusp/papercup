/**
 * Tests for /api/snapshots/[id]/shape.
 *
 * Verifies 404 on missing snapshot, and shape extraction round-trip.
 * Mocks `findSnapshot` and `readManifestFromTarball` so we don't need a
 * real tarball on disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function call(id: string) {
  const { GET } = await import('./route');
  return GET(new Request(`http://x/api/snapshots/${id}/shape`), {
    params: Promise.resolve({ id }),
  });
}

describe('GET /api/snapshots/[id]/shape', () => {
  it('returns 404 when snapshot is unknown', async () => {
    vi.doMock('@/lib/snapshot-discovery', () => ({
      findSnapshot: async () => null,
    }));
    const r = await call('snap_doesntexist');
    expect(r.status).toBe(404);
  });

  it('returns 500 when manifest cannot be read from tarball', async () => {
    vi.doMock('@/lib/snapshot-discovery', () => ({
      findSnapshot: async () => ({ id: 'snap_x', tarballPath: '/no/such/path.tar.gz' }),
    }));
    vi.doMock('@papercusp/export-state', () => ({
      readManifestFromTarball: async () => { throw new Error('tarball missing'); },
    }));
    const r = await call('snap_x');
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body.error).toContain('tarball missing');
  });

  it('extracts shape + pinning info per plugin', async () => {
    vi.doMock('@/lib/snapshot-discovery', () => ({
      findSnapshot: async () => ({ id: 'snap_x', tarballPath: '/fake/path.tar.gz' }),
    }));
    vi.doMock('@papercusp/export-state', () => ({
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
            // No shapeJson — pre-V1 snapshot. Should default pinned=true and shape=null.
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
    // Default `true` per spec when absent.
    expect(old.pluginVersionPinned).toBe(true);
  });

  it('handles malformed shapeJson gracefully (shape=null, no error)', async () => {
    vi.doMock('@/lib/snapshot-discovery', () => ({
      findSnapshot: async () => ({ id: 'snap_x', tarballPath: '/fake/path.tar.gz' }),
    }));
    vi.doMock('@papercusp/export-state', () => ({
      readManifestFromTarball: async () => ({
        plugins: [
          { name: 'broken', version: '0.1.0', shapeJson: '{not json' },
        ],
      }),
    }));
    const r = await call('snap_x');
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.plugins[0].shape).toBeNull();
  });
});
