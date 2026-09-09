import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchBundleManifestMock = vi.hoisted(() => vi.fn());

vi.mock('./bundle-manifest-io', () => ({
  fetchBundleManifest: fetchBundleManifestMock,
  BundleManifestError: class BundleManifestError extends Error {
    readonly status = 422;
  },
}));

const { installOfflineContentBundleAppFromCupboard } = await import('./offline-content-bundle-install-io');

const roots: string[] = [];
const priorHome = process.env.PAPERCUSP_HOME;

afterEach(() => {
  fetchBundleManifestMock.mockReset();
  if (priorHome === undefined) delete process.env.PAPERCUSP_HOME;
  else process.env.PAPERCUSP_HOME = priorHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('offline content bundle installer', () => {
  it('passes a working tmpDir to manifest and content installers before PG exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'offline-content-bundle-'));
    roots.push(root);
    process.env.PAPERCUSP_HOME = root;
    fetchBundleManifestMock.mockImplementation(async (_input, deps) => {
      expect(typeof deps.tmpDir).toBe('function');
      expect(deps.tmpDir()).toBe(tmpdir());
      return { name: 'empty offline bundle' };
    });

    await expect(
      installOfflineContentBundleAppFromCupboard(
        { githubUrl: 'https://github.com/Papercusp/templates' },
        { workspaceId: 'workspace-host', offlineContentOnly: true },
      ),
    ).resolves.toMatchObject({ ok: true, result: { ok: true } });
    expect(fetchBundleManifestMock).toHaveBeenCalledOnce();
  });
});
