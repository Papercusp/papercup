import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveWorkspaceHiveScope = vi.fn();
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
    resolveWorkspaceHiveScope.mockRejectedValue(new Error('hive registry unavailable'));
    await expect(resolveNamedQueryV2('hive.workspaceScope', {})).resolves.toEqual([
      { kind: 'none', homeSlug: null, candidates: [] },
    ]);
  });
});
