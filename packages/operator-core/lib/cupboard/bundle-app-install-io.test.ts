import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  installRubric: vi.fn(),
}));

vi.mock('./install-rubric-io', () => ({
  installRubricFromCupboard: h.installRubric,
}));

const { makeBundleAppInstallers } = await import('./bundle-app-install-io');

const roots: string[] = [];

afterEach(() => {
  h.installRubric.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bundle-app offline content install wiring', () => {
  it('passes skipSeed and accepts the on-disk rubric when startup owns the deferred seed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bundle-app-deferred-rubric-'));
    roots.push(root);
    const installedTo = join(root, 'rubric');
    mkdirSync(installedTo);
    h.installRubric.mockResolvedValue({
      ok: true,
      result: { rubricId: 'quality', installedTo, seeded: false },
    });
    const installers = makeBundleAppInstallers('workspace-host', {
      workspaceId: 'workspace-host',
      offlineContentOnly: true,
      deferRubricSeed: true,
    });

    await expect(
      installers.installRubric({
        id: 'quality',
        githubUrl: 'https://github.com/Papercusp/templates',
        listingRef: 'quality',
      }),
    ).resolves.toEqual({ ok: true });
    expect(h.installRubric).toHaveBeenCalledWith({
      githubUrl: 'https://github.com/Papercusp/templates',
      listingRef: 'quality',
      skipSeed: true,
    });
    expect(JSON.parse(readFileSync(join(installedTo, '.papercusp-bundle-source.json'), 'utf8'))).toMatchObject({
      source: 'https://github.com/Papercusp/templates#quality',
      listingRef: 'quality',
    });
  });

  it('retains the ordinary live-install contract: an unseeded rubric is not successful', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bundle-app-required-rubric-seed-'));
    roots.push(root);
    const installedTo = join(root, 'rubric');
    mkdirSync(installedTo);
    h.installRubric.mockResolvedValue({
      ok: true,
      result: {
        rubricId: 'quality',
        installedTo,
        seeded: false,
        seedError: 'postgres unavailable',
      },
    });
    const installers = makeBundleAppInstallers('workspace', { workspaceId: 'workspace' });

    await expect(
      installers.installRubric({
        id: 'quality',
        githubUrl: 'https://github.com/Papercusp/templates',
        listingRef: 'quality',
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'rubric "quality" installed but did not seed: postgres unavailable',
    });
    expect(h.installRubric).toHaveBeenCalledWith({
      githubUrl: 'https://github.com/Papercusp/templates',
      listingRef: 'quality',
      skipSeed: false,
    });
  });
});
