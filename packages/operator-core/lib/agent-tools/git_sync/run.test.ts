/**
 * git-sync:run — fires the shared fireGitSyncNow once on demand (WI-1320). Mocks the
 * helper + repo-dir resolver and asserts it's invoked with the resolved slug/workspace
 * and the payload shape. projectDirForSlug returns null, so the HEAD-delta path (execFile)
 * is not exercised — committed:false.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (role = 'operator') =>
  ({ log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), role } as never);

function parse(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.doUnmock('../../harness/operator-home-harness');
  vi.doUnmock('../../workspace-registry');
  vi.doUnmock('../../operator-notes');
  vi.doUnmock('../../harness/git-sync/git-sync-action');
});

describe('git-sync:run', () => {
  it('fires fireGitSyncNow with the resolved slug + workspace and reports it', async () => {
    const fireSpy = vi.fn(async () => undefined);
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => null }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: fireSpy }));

    const { default: tool } = await import('./run');
    const result = await tool.handler({}, MAKE_CTX());

    expect(fireSpy).toHaveBeenCalledTimes(1);
    expect(fireSpy).toHaveBeenCalledWith('papercusp', 'default');
    expect(parse(result as never)).toMatchObject({ ok: true, fired: true, slug: 'papercusp', committed: false });
  });

  it('rejects a non-operator role', async () => {
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: vi.fn() }));
    const { default: tool } = await import('./run');
    await expect(tool.handler({}, MAKE_CTX('cup'))).rejects.toThrow(/operator, architect, or mug/);
  });
});
