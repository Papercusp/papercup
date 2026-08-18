import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` factories are HOISTED above these declarations, and the federation-scope
// factory below references `resolveWorkspaceHiveScope` EAGERLY (directly in the object
// literal it returns). A plain `const … = vi.fn()` is therefore still in the temporal
// dead zone when that factory runs, which vitest surfaces as a module-mocking error
// caused by `ReferenceError: Cannot access 'resolveWorkspaceHiveScope' before
// initialization`. `vi.hoisted()` lifts the mock fn alongside the factories so it is
// initialised first.
//
// `activeWs` below needs no such treatment: it is only ever read LAZILY, inside the
// arrow handed to `activeWorkspaceId`, which runs at test time.
const { resolveWorkspaceHiveScope } = vi.hoisted(() => ({
  resolveWorkspaceHiveScope: vi.fn(),
}));
let activeWs: string | null = 'ws-test';

vi.mock('../workspace-registry', () => ({
  activeWorkspaceId: () => activeWs,
}));
vi.mock('../agent-tools/coordination/federation-scope', () => ({
  resolveWorkspaceHiveScope,
}));

import { knownQueryNamesV2, resolveNamedQueryV2 } from './index';

describe('hive.workspaceScope named query (pot-seat-pools-prose-ux-2026-07-18 P-002)', () => {
  beforeEach(() => {
    activeWs = 'ws-test';
    resolveWorkspaceHiveScope.mockReset();
  });

  it('registers the query name', () => {
    expect(knownQueryNamesV2()).toContain('hive.workspaceScope');
  });

  it('resolves a single shared hive as kind:one with its homeSlug', async () => {
    resolveWorkspaceHiveScope.mockResolvedValue({ kind: 'one', homeSlug: 'acme-hive' });
    await expect(resolveNamedQueryV2('hive.workspaceScope', {})).resolves.toEqual([
      { kind: 'one', homeSlug: 'acme-hive', candidates: ['acme-hive'] },
    ]);
    expect(resolveWorkspaceHiveScope).toHaveBeenCalledWith('ws-test');
  });

  it('resolves multiple shared hives as kind:many with candidates, no homeSlug', async () => {
    resolveWorkspaceHiveScope.mockResolvedValue({ kind: 'many', candidates: ['hive-a', 'hive-b'] });
    await expect(resolveNamedQueryV2('hive.workspaceScope', {})).resolves.toEqual([
      { kind: 'many', homeSlug: null, candidates: ['hive-a', 'hive-b'] },
    ]);
  });

  it('resolves no shared hive as kind:none', async () => {
    resolveWorkspaceHiveScope.mockResolvedValue({ kind: 'none' });
    await expect(resolveNamedQueryV2('hive.workspaceScope', {})).resolves.toEqual([
      { kind: 'none', homeSlug: null, candidates: [] },
    ]);
  });

  it('degrades to kind:none without throwing when the workspace is unresolved', async () => {
    activeWs = null as unknown as string;
    await expect(resolveNamedQueryV2('hive.workspaceScope', {})).resolves.toEqual([
      { kind: 'none', homeSlug: null, candidates: [] },
    ]);
    expect(resolveWorkspaceHiveScope).not.toHaveBeenCalled();
  });

  it('degrades to kind:none without throwing when the scope resolver rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveWorkspaceHiveScope.mockRejectedValue(new Error('hive registry unavailable'));
    await expect(resolveNamedQueryV2('hive.workspaceScope', {})).resolves.toEqual([
      { kind: 'none', homeSlug: null, candidates: [] },
    ]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
