/**
 * Unit tests for `system:hive-git-gc` (G-9, p2p-git-live-activation-2026-07-09 /
 * P-205). gcHiveGitRepo / getPotGitMode are mocked — asserts config resolution,
 * the hive-git-mode self-gate (no-op on legacy), repo-path resolution, and that
 * a missing repo_key skips the tick instead of throwing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above these declarations; vi.hoisted() lifts the
// backing vi.fn()s along with them so the factory below can safely close over them
// (a bare top-level const here throws "Cannot access '<name>' before initialization").
const { gcMock, hiveGitRepoPathMock, getHiveGitModeMock } = vi.hoisted(() => ({
  gcMock: vi.fn(async (..._args: unknown[]) => ({
    archivedNamespaces: [] as string[],
    deletedRefs: ['a', 'b'],
    errors: [] as string[],
    keptRefs: ['c'],
  })),
  hiveGitRepoPathMock: vi.fn((potHomeSlug: string, repoKey: string) => `/repos/${potHomeSlug}/${repoKey}`),
  getHiveGitModeMock: vi.fn(async (_ws: string, _hive: string) => 'legacy' as 'legacy' | 'bridged' | 'p2p-only'),
}));
vi.mock('../../sync/pot-git/gc', () => ({
  gcHiveGitRepo: gcMock,
}));

/* Stub set derived from the REAL export list, so adding an export to storage.ts
 * cannot silently break this file — see EI-18748959711888135, where an absent
 * export threw inside a caller's try/catch, became a console.warn, and
 * vitest-fail-on-console red-pinned the fleet gate. Inert stubs resolve a promise
 * (storage's exports are mostly async and are often fire-and-forget); explicit
 * stubs below win. */
vi.mock('../../sync/pot-git/storage', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const inert = Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === 'function' ? vi.fn(async () => undefined) : v,
    ]),
  );
  return { ...inert, hiveGitRepoPath: hiveGitRepoPathMock };
});

vi.mock('../git-sync/hive-git-mode', () => ({
  getPotGitMode: getHiveGitModeMock,
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
    const action = getSystemAction('pot-git-gc')!;
    await action(ctx({ pot_home_slug: 'shop-hive', repo_key: 'repo-1' }));
    expect(getHiveGitModeMock).toHaveBeenCalledWith('ws-1', 'shop-hive');
    expect(gcMock).not.toHaveBeenCalled();
  });

  it('runs gc against the resolved repo path on a bridged hive', async () => {
    getHiveGitModeMock.mockResolvedValue('bridged');
    const action = getSystemAction('pot-git-gc')!;
    await action(ctx({ pot_home_slug: 'shop-hive', repo_key: 'repo-1' }));
    expect(hiveGitRepoPathMock).toHaveBeenCalledWith('shop-hive', 'repo-1');
    expect(gcMock).toHaveBeenCalledTimes(1);
    expect(gcMock.mock.calls[0][0]).toBe('/repos/shop-hive/repo-1');
  });

  it('runs gc on a p2p-only hive too', async () => {
    getHiveGitModeMock.mockResolvedValue('p2p-only');
    const action = getSystemAction('pot-git-gc')!;
    await action(ctx({ pot_home_slug: 'shop-hive', repo_key: 'repo-1' }));
    expect(gcMock).toHaveBeenCalledTimes(1);
  });

  it('forwards keep_published_refs_per_namespace when a positive number', async () => {
    getHiveGitModeMock.mockResolvedValue('bridged');
    const action = getSystemAction('pot-git-gc')!;
    await action(ctx({ pot_home_slug: 'shop-hive', repo_key: 'repo-1', keep_published_refs_per_namespace: 5 }));
    expect(gcMock.mock.calls[0][1]).toEqual({ keepPublishedRefsPerNamespace: 5 });
  });

  it('omits keepPublishedRefsPerNamespace when absent/invalid', async () => {
    getHiveGitModeMock.mockResolvedValue('bridged');
    const action = getSystemAction('pot-git-gc')!;
    await action(ctx({ pot_home_slug: 'shop-hive', repo_key: 'repo-1', keep_published_refs_per_namespace: -1 }));
    expect(gcMock.mock.calls[0][1]).toEqual({});
  });

  it('falls back to ctx.installSlug when pot_home_slug is missing', async () => {
    getHiveGitModeMock.mockResolvedValue('bridged');
    const action = getSystemAction('pot-git-gc')!;
    await action(ctx({ repo_key: 'repo-1' }));
    expect(getHiveGitModeMock).toHaveBeenCalledWith('ws-1', 'shop-hive');
    expect(hiveGitRepoPathMock).toHaveBeenCalledWith('shop-hive', 'repo-1');
  });

  /**
   * P-051 rename guards. The routine row is the ONLY caller of these names, so
   * both halves of the rename are reachable only through data: `target_role`
   * (the registered action name) and `trigger_config` (the home-slug key). A
   * plain rename would have broken BOTH silently — an unresolved target is a
   * quiet no-op tick, and an unread config key falls back to `installSlug`,
   * which is *usually* the same value and so hides the bug on most rows.
   */
  it('is ALSO registered under the pre-rename `hive-git-gc` target (transitional alias)', async () => {
    getHiveGitModeMock.mockResolvedValue('bridged');
    // Same function object: rows still targeting the old name during the
    // bg-host restart window run identical code, not a divergent copy.
    expect(getSystemAction('hive-git-gc')).toBe(getSystemAction('pot-git-gc'));
    await getSystemAction('hive-git-gc')!(ctx({ pot_home_slug: 'shop-hive', repo_key: 'repo-1' }));
    expect(gcMock).toHaveBeenCalledTimes(1);
  });

  it('still honours the pre-rename `hive_home_slug` config key', async () => {
    getHiveGitModeMock.mockResolvedValue('bridged');
    const action = getSystemAction('pot-git-gc')!;
    // installSlug is deliberately DIFFERENT from the config value, so a
    // regression that ignored the legacy key would fall back to 'shop-hive'
    // and this assertion would catch it instead of coincidentally passing.
    await action({
      installSlug: 'shop-hive',
      workspaceId: 'ws-1',
      triggerConfig: { hive_home_slug: 'legacy-home', repo_key: 'repo-1' },
      payloadTemplate: null,
    });
    expect(hiveGitRepoPathMock).toHaveBeenCalledWith('legacy-home', 'repo-1');
  });

  it('skips the tick (no throw, no gc call) when repo_key is missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const action = getSystemAction('pot-git-gc')!;
      await expect(action(ctx({ pot_home_slug: 'shop-hive' }))).resolves.toBeUndefined();
      expect(getHiveGitModeMock).not.toHaveBeenCalled();
      expect(gcMock).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing trigger_config.repo_key'));
    } finally {
      warnSpy.mockRestore();
    }
  });
});
