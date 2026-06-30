/**
 * git-sync:run — fires the registered `system:git-sync` action once on demand (WI-1320).
 * Mocks the collaborators (system-action registry, sql, repo-dir) and asserts the action
 * is invoked with a cron-tick-equivalent ctx and the payload shape. projectDirForSlug
 * returns null here, so the HEAD-delta path (execFile) is not exercised — committed:false.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (role = 'operator') =>
  ({ log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), role } as never);

function parse(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.doUnmock('@papercusp/db-org');
  vi.doUnmock('../../harness/operator-home-harness');
  vi.doUnmock('../../workspace-registry');
  vi.doUnmock('../../harness/routines/system-actions');
  vi.doUnmock('../../operator-notes');
  vi.doUnmock('../../harness/git-sync/git-sync-action');
});

describe('git-sync:run', () => {
  it('fires the system:git-sync action with a cron-tick-equivalent ctx and reports it', async () => {
    const actionSpy = vi.fn(async () => undefined);
    const sqlTag = vi.fn(async () => [{ trigger_config: { push: true, branch: 'staging' } }]);
    vi.doMock('@papercusp/db-org', async () => ({
      ...(await vi.importActual<Record<string, unknown>>('@papercusp/db-org')),
      getOrgPg: () => ({ sql: sqlTag }),
    }));
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../harness/routines/system-actions', () => ({ getSystemAction: () => actionSpy }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => null }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({}));

    const { default: tool } = await import('./run');
    const result = await tool.handler({}, MAKE_CTX());

    expect(actionSpy).toHaveBeenCalledTimes(1);
    expect(actionSpy).toHaveBeenCalledWith({
      installSlug: 'papercusp',
      workspaceId: 'default',
      triggerConfig: { push: true, branch: 'staging' },
      payloadTemplate: null,
    });
    expect(parse(result as never)).toMatchObject({ ok: true, fired: true, slug: 'papercusp', committed: false });
  });

  it('rejects a non-operator role', async () => {
    vi.doMock('../../harness/routines/system-actions', () => ({ getSystemAction: () => vi.fn() }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({}));
    const { default: tool } = await import('./run');
    await expect(tool.handler({}, MAKE_CTX('bee'))).rejects.toThrow(/operator, architect, or queen/);
  });
});
