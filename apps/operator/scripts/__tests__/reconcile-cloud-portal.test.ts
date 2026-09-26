import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcilePortal } from '../systemd/reconcile-cloud-portal.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'portal-reconcile-'));
  roots.push(root);
  const portalRoot = join(root, 'portal');
  const runtimeRoot = join(root, 'runtime');
  return {
    config: {
      portalRoot,
      runtimeRoot,
      integrationRoot: root,
      deployScript: join(root, 'deploy-cloud-portal.sh'),
      npm: 'npm',
      port: 3801,
      env: {},
    },
    release: {
      path: join(runtimeRoot, 'release-1'),
      manifest: { sourceRoot: portalRoot, sourceRootDigest: 'root-1' },
    },
  };
}

describe('cloud portal source reconciliation', () => {
  it('rebuilds when linked source changes even though rootDigest and release path match', async () => {
    const { config, release } = fixture();
    const run = vi.fn().mockResolvedValue(undefined);
    const writeReceipt = vi.fn().mockResolvedValue(undefined);
    const withHandoffLock = vi.fn(async (handoff: () => Promise<unknown>) => handoff());
    const result = await reconcilePortal(config, {
      fingerprint: vi.fn().mockResolvedValue({ digest: 'linked-new', rootDigest: 'root-1' }),
      releaseAt: vi.fn().mockResolvedValue(release),
      receiptAt: vi.fn().mockResolvedValue({
        releasePath: release.path,
        sourceDigest: 'linked-old',
        sourceRootDigest: 'root-1',
      }),
      healthy: vi.fn().mockResolvedValue(true),
      run,
      writeReceipt,
      withHandoffLock,
    });
    expect(result.status).toBe('deployed');
    expect(run.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ['npm', ['run', 'build']],
      ['bash', [config.deployScript, '--handoff']],
    ]);
    expect(writeReceipt).toHaveBeenCalledWith(
      join(config.runtimeRoot, '.papercusp-reconcile.json'),
      expect.objectContaining({ releasePath: release.path, sourceDigest: 'linked-new' }),
    );
    expect(withHandoffLock).toHaveBeenCalledTimes(1);
  });

  it('skips a healthy release with an exact full-source receipt', async () => {
    const { config, release } = fixture();
    const run = vi.fn();
    const result = await reconcilePortal(config, {
      fingerprint: vi.fn().mockResolvedValue({ digest: 'linked-1', rootDigest: 'root-1' }),
      releaseAt: vi.fn().mockResolvedValue(release),
      receiptAt: vi.fn().mockResolvedValue({
        releasePath: release.path,
        sourceDigest: 'linked-1',
        sourceRootDigest: 'root-1',
      }),
      healthy: vi.fn().mockResolvedValue(true),
      run,
      withHandoffLock: vi.fn(async (handoff: () => Promise<unknown>) => handoff()),
    });
    expect(result.status).toBe('fresh');
    expect(run).not.toHaveBeenCalled();
  });

  it('never records success when linked source moves during the build', async () => {
    const { config, release } = fixture();
    const run = vi.fn().mockResolvedValue(undefined);
    const writeReceipt = vi.fn();
    await expect(reconcilePortal(config, {
      fingerprint: vi.fn()
        .mockResolvedValueOnce({ digest: 'linked-before', rootDigest: 'root-1' })
        .mockResolvedValueOnce({ digest: 'linked-after', rootDigest: 'root-1' }),
      releaseAt: vi.fn().mockResolvedValue(release),
      receiptAt: vi.fn().mockResolvedValue(null),
      run,
      writeReceipt,
      withHandoffLock: vi.fn(async (handoff: () => Promise<unknown>) => handoff()),
    })).rejects.toThrow('portal_linked_source_changed_during_build');
    expect(run).toHaveBeenCalledTimes(1);
    expect(writeReceipt).not.toHaveBeenCalled();
  });
});
