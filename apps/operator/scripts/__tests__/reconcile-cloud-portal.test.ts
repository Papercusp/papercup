import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
      publicLinksEnv: join(root, 'portal-public-links.env'),
      env: {},
    },
    release: {
      path: join(runtimeRoot, 'release-1'),
      manifest: { sourceRoot: portalRoot, sourceRootDigest: 'root-1' },
    },
  };
}

describe('cloud portal source reconciliation', () => {
  it('builds with the fingerprinted file snapshot even when the inherited environment is stale', async () => {
    const { config, release } = fixture();
    const links = 'NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL=https://releases.example/pui\nNEXT_PUBLIC_PORTAL_DESKTOP_DOWNLOAD_URL=https://releases.example/desktop\n';
    writeFileSync(config.publicLinksEnv, links);
    config.env = { NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL: 'https://old.example/download' };
    const run = vi.fn().mockResolvedValue(undefined);
    const writeReceipt = vi.fn().mockResolvedValue(undefined);
    const deps = {
      fingerprint: vi.fn().mockResolvedValue({ digest: 'linked-1', rootDigest: 'root-1' }),
      releaseAt: vi.fn().mockResolvedValue(release),
      receiptAt: vi.fn().mockResolvedValue(null),
      healthy: vi.fn().mockResolvedValue(true), run, writeReceipt,
      withHandoffLock: vi.fn(async (handoff: () => Promise<unknown>) => handoff()),
    };
    await reconcilePortal(config, deps);
    expect(run.mock.calls[0][3]).toMatchObject({
      NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL: 'https://releases.example/pui',
      NEXT_PUBLIC_PORTAL_DESKTOP_DOWNLOAD_URL: 'https://releases.example/desktop',
    });
    const receipt = writeReceipt.mock.calls[0][1];
    deps.receiptAt.mockResolvedValue(receipt);
    run.mockClear();
    expect((await reconcilePortal(config, deps)).status).toBe('fresh');
    expect(run).not.toHaveBeenCalled();
    writeFileSync(config.publicLinksEnv, links.replace('/pui', '/pui-next'));
    expect((await reconcilePortal(config, deps)).status).toBe('deployed');
    expect(run.mock.calls[0][3].NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL).toBe('https://releases.example/pui-next');
  });
  it('exits a one-shot process after logging even when a dependency keeps a handle open', () => {
    const moduleUrl = new URL('../systemd/reconcile-cloud-portal.mjs', import.meta.url).href;
    const child = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e',
      `import { settleReconcileProcess } from ${JSON.stringify(moduleUrl)}; setInterval(() => {}, 60000); await settleReconcileProcess(Promise.resolve({ status: 'deployed', releasePath: '/tmp/release' }));`,
    ], { encoding: 'utf8', timeout: 30000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toContain('cloud-portal-reconcile: deployed /tmp/release');
  });

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
      publicLinksDigest: vi.fn().mockResolvedValue('links-1'),
      releaseAt: vi.fn().mockResolvedValue(release),
      receiptAt: vi.fn().mockResolvedValue({
        releasePath: release.path,
        sourceDigest: 'linked-1',
        sourceRootDigest: 'root-1',
        publicLinksDigest: 'links-1',
      }),
      healthy: vi.fn().mockResolvedValue(true),
      run,
      withHandoffLock: vi.fn(async (handoff: () => Promise<unknown>) => handoff()),
    });
    expect(result.status).toBe('fresh');
    expect(run).not.toHaveBeenCalled();
  });

  it('rebuilds when the durable public download links change without a source edit', async () => {
    const { config, release } = fixture();
    const run = vi.fn().mockResolvedValue(undefined);
    const writeReceipt = vi.fn().mockResolvedValue(undefined);
    const publicLinksDigest = vi.fn().mockResolvedValue('links-new');
    const result = await reconcilePortal(config, {
      fingerprint: vi.fn().mockResolvedValue({ digest: 'linked-1', rootDigest: 'root-1' }),
      releaseAt: vi.fn().mockResolvedValue(release),
      receiptAt: vi.fn().mockResolvedValue({
        releasePath: release.path,
        sourceDigest: 'linked-1',
        sourceRootDigest: 'root-1',
        publicLinksDigest: 'links-old',
      }),
      publicLinksDigest,
      healthy: vi.fn().mockResolvedValue(true),
      run,
      writeReceipt,
      withHandoffLock: vi.fn(async (handoff: () => Promise<unknown>) => handoff()),
    });
    expect(result.status).toBe('deployed');
    expect(run.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ['npm', ['run', 'build']],
      ['bash', [config.deployScript, '--handoff']],
    ]);
    expect(writeReceipt).toHaveBeenCalledWith(
      join(config.runtimeRoot, '.papercusp-reconcile.json'),
      expect.objectContaining({ publicLinksDigest: 'links-new' }),
    );
  });

  it('refuses to certify a build if its public-link input changes mid-build', async () => {
    const { config, release } = fixture();
    const run = vi.fn().mockResolvedValue(undefined);
    const writeReceipt = vi.fn();
    await expect(reconcilePortal(config, {
      fingerprint: vi.fn().mockResolvedValue({ digest: 'linked-1', rootDigest: 'root-1' }),
      releaseAt: vi.fn().mockResolvedValue(release),
      receiptAt: vi.fn().mockResolvedValue(null),
      publicLinksDigest: vi.fn()
        .mockResolvedValueOnce('links-before')
        .mockResolvedValueOnce('links-after'),
      run,
      writeReceipt,
      withHandoffLock: vi.fn(async (handoff: () => Promise<unknown>) => handoff()),
    })).rejects.toThrow('portal_public_links_changed_during_build');
    expect(run).toHaveBeenCalledTimes(1);
    expect(writeReceipt).not.toHaveBeenCalled();
  });

  it('never records success when the portal root source moves during the build', async () => {
    const { config, release } = fixture();
    const run = vi.fn().mockResolvedValue(undefined);
    const writeReceipt = vi.fn();
    await expect(reconcilePortal(config, {
      fingerprint: vi.fn()
        .mockResolvedValueOnce({ digest: 'linked-before', rootDigest: 'root-1' })
        .mockResolvedValueOnce({ digest: 'linked-after', rootDigest: 'root-2' }),
      releaseAt: vi.fn().mockResolvedValue(release),
      receiptAt: vi.fn().mockResolvedValue(null),
      run,
      writeReceipt,
      withHandoffLock: vi.fn(async (handoff: () => Promise<unknown>) => handoff()),
    })).rejects.toThrow('portal_linked_source_changed_during_build');
    expect(run).toHaveBeenCalledTimes(1);
    expect(writeReceipt).not.toHaveBeenCalled();
  });

  it('hands off linked-source drift while keeping the earlier digest for the next tick', async () => {
    const { config, release } = fixture();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const run = vi.fn().mockResolvedValue(undefined);
    const writeReceipt = vi.fn().mockResolvedValue(undefined);
    const withHandoffLock = vi.fn(async (handoff: () => Promise<unknown>) => handoff());
    const result = await reconcilePortal(config, {
      fingerprint: vi.fn()
        .mockResolvedValueOnce({ digest: 'linked-before', rootDigest: 'root-1' })
        .mockResolvedValueOnce({ digest: 'linked-during-build', rootDigest: 'root-1' })
        .mockResolvedValueOnce({ digest: 'linked-after-handoff', rootDigest: 'root-1' }),
      releaseAt: vi.fn().mockResolvedValue(release),
      receiptAt: vi.fn().mockResolvedValue(null),
      healthy: vi.fn().mockResolvedValue(true),
      run,
      writeReceipt,
      withHandoffLock,
    });
    expect(result.status).toBe('deployed');
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('linked sources changed during build'));
    warning.mockRestore();
    expect(withHandoffLock).toHaveBeenCalledTimes(1);
    expect(writeReceipt).toHaveBeenCalledWith(
      join(config.runtimeRoot, '.papercusp-reconcile.json'),
      expect.objectContaining({ sourceDigest: 'linked-before', sourceRootDigest: 'root-1' }),
    );
  });
});
