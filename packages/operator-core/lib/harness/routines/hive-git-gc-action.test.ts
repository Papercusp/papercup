/**
 * Unit tests for `system:hive-git-gc` (G-9, p2p-git-live-activation-2026-07-09 /
 * P-205). gcHiveGitRepo / getHiveGitMode are mocked — asserts config resolution,
 * the hive-git-mode self-gate (no-op on legacy), repo-path resolution, and that
 * a missing repo_key skips the tick instead of throwing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const gcMock = vi.fn(async (..._args: unknown[]) => ({
  archivedNamespaces: [] as string[],
  deletedRefs: ['a', 'b'],
  errors: [] as string[],
  keptRefs: ['c'],
}));
vi.mock('../../sync/hive-git/gc', () => ({
  gcHiveGitRepo: gcMock,
}));

const hiveGitRepoPathMock = vi.fn((hiveHomeSlug: string, repoKey: string) => `/repos/${hiveHomeSlug}/${repoKey}`);
vi.mock('../../sync/hive-git/storage', () => ({
  hiveGitRepoPath: hiveGitRepoPathMock,
}));

const getHiveGitModeMock = vi.fn(async (_ws: string, _hive: string) => 'legacy' as 'legacy' | 'bridged' | 'p2p-only');
vi.mock('../git-sync/hive-git-mode', () => ({
  getHiveGitMode: getHiveGitModeMock,
}));

// Import AFTER the mocks so the module's registerSystemAction side-effect binds them.
import { getSystemAction } from './system-actions';
import './hive-git-gc-action';

beforeEach(() => {
  gcMock.mockClear();
  hiveGitRepoPathMock.mockClear();
  getHiveGitModeMock.mockClear();
  getHiveGitModeMock.mockResolvedValue('legacy');
});

function ctx(triggerConfig: Record<string, unknown>) {
  return { installSlug: 'shop-hive', workspaceId: 'ws-1', triggerConfig, payloadTemplate: null };
}

describe('system:hive-git-gc', () => {
  it('self-gates as a no-op on a legacy hive (never calls gcHiveGitRepo)', async () => {
    getHiveGitModeMock.mockResolvedValue('legacy');
    const action = getSystemAction('hive-git-gc')!;
    await action(ctx({ hive_home_slug: 'shop-hive', repo_key: 'repo-1' }));
    expect(getHiveGitModeMock).toHaveBeenCalledWith('ws-1', 'shop-hive');
    expect(gcMock).not.toHaveBeenCalled();
  });

  it('runs gc against the resolved repo path on a bridged hive', async () => {
    getHiveGitModeMock.mockResolvedValue('bridged');
    const action = getSystemAction('hive-git-gc')!;
    await action(ctx({ hive_home_slug: 'shop-hive', repo_key: 'repo-1' }));
    expect(hiveGitRepoPathMock).toHaveBeenCalledWith('shop-hive', 'repo-1');
    expect(gcMock).toHaveBeenCalledTimes(1);
    expect(gcMock.mock.calls[0][0]).toBe('/repos/shop-hive/repo-1');
  });

  it('runs gc on a p2p-only hive too', async () => {
    getHiveGitModeMock.mockResolvedValue('p2p-only');
    const action = getSystemAction('hive-git-gc')!;
    await action(ctx({ hive_home_slug: 'shop-hive', repo_key: 'repo-1' }));
    expect(gcMock).toHaveBeenCalledTimes(1);
  });

  it('forwards keep_published_refs_per_namespace when a positive number', async () => {
    getHiveGitModeMock.mockResolvedValue('bridged');
    const action = getSystemAction('hive-git-gc')!;
    await action(ctx({ hive_home_slug: 'shop-hive', repo_key: 'repo-1', keep_published_refs_per_namespace: 5 }));
    expect(gcMock.mock.calls[0][1]).toEqual({ keepPublishedRefsPerNamespace: 5 });
  });

  it('omits keepPublishedRefsPerNamespace when absent/invalid', async () => {
    getHiveGitModeMock.mockResolvedValue('bridged');
    const action = getSystemAction('hive-git-gc')!;
    await action(ctx({ hive_home_slug: 'shop-hive', repo_key: 'repo-1', keep_published_refs_per_namespace: -1 }));
    expect(gcMock.mock.calls[0][1]).toEqual({});
  });

  it('falls back to ctx.installSlug when hive_home_slug is missing', async () => {
    getHiveGitModeMock.mockResolvedValue('bridged');
    const action = getSystemAction('hive-git-gc')!;
    await action(ctx({ repo_key: 'repo-1' }));
    expect(getHiveGitModeMock).toHaveBeenCalledWith('ws-1', 'shop-hive');
    expect(hiveGitRepoPathMock).toHaveBeenCalledWith('shop-hive', 'repo-1');
  });

  it('skips the tick (no throw, no gc call) when repo_key is missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const action = getSystemAction('hive-git-gc')!;
      await expect(action(ctx({ hive_home_slug: 'shop-hive' }))).resolves.toBeUndefined();
      expect(getHiveGitModeMock).not.toHaveBeenCalled();
      expect(gcMock).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing trigger_config.repo_key'));
    } finally {
      warnSpy.mockRestore();
    }
  });
});
