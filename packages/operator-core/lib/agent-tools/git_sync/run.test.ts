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
  vi.doUnmock('node:child_process');
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

  it('accepts the standard harness scope spelling as an alias for installSlug', async () => {
    const fireSpy = vi.fn(async () => undefined);
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'operator-home' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => null }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: fireSpy }));

    const { default: tool } = await import('./run');
    const result = await tool.handler({ harness: 'papercusp' }, MAKE_CTX());

    expect(fireSpy).toHaveBeenCalledTimes(1);
    expect(fireSpy).toHaveBeenCalledWith('papercusp', 'default');
    expect(parse(result as never)).toMatchObject({ ok: true, fired: true, slug: 'papercusp', committed: false });
  });

  it('returns the shared synced outcome instead of inferring success from a HEAD delta', async () => {
    const outcome = {
      status: 'synced' as const,
      headSha: 'abc123def456',
      pushed: ['superproject'],
      merged: [],
      oversized: [],
      contentErrors: [],
    };
    const fireSpy = vi.fn(async () => outcome);
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => null }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: fireSpy }));

    const { default: tool } = await import('./run');
    const result = parse((await tool.handler({}, MAKE_CTX())) as never);

    expect(result).toMatchObject({
      ok: true,
      status: 'synced',
      success: true,
      committed: true,
      outcome: { status: 'synced', headSha: 'abc123def456', pushed: ['superproject'] },
    });
  });

  it('surfaces an explicit error outcome and does not report a clean-tree success', async () => {
    const outcome = {
      status: 'error' as const,
      errors: [{ scope: 'libs/generic/cache', message: 'push failed: HTTP 403' }],
      pushed: [],
      merged: [],
      oversized: [],
      contentErrors: [],
    };
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => null }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: vi.fn(async () => outcome) }));

    const { default: tool } = await import('./run');
    const result = parse((await tool.handler({}, MAKE_CTX())) as never);

    expect(result).toMatchObject({
      ok: true,
      status: 'error',
      success: false,
      committed: false,
      outcome: { status: 'error', errors: [{ scope: 'libs/generic/cache', message: 'push failed: HTTP 403' }] },
    });
  });

  // WI-4940: the trailing `git rev-parse HEAD` (headSha, called unconditionally after
  // fireGitSyncNow resolves — the exact spot the reporter's 120s hang landed in, AFTER
  // the commit had already succeeded) must be bounded, not a bare unbounded execFile.
  it('bounds the HEAD-delta execFile call with a timeout so a hung git process cannot hang the whole tool call', async () => {
    const execFileMock = vi.fn((_file: string, _args: string[], opts: Record<string, unknown>, cb: (...a: unknown[]) => void) => {
      // Simulate node's own timeout-kill behavior: execFile with `timeout` set rejects
      // with a killed error instead of ever resolving — assert the fix actually wires
      // a bounded `timeout` through, and that the handler still resolves cleanly.
      expect(opts).toMatchObject({ timeout: expect.any(Number) });
      expect((opts.timeout as number) > 0).toBe(true);
      cb(Object.assign(new Error('killed'), { killed: true }));
    });
    vi.doMock('node:child_process', () => ({ execFile: execFileMock }));
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => '/repo' }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: vi.fn(async () => undefined) }));

    const { default: tool } = await import('./run');
    const result = await tool.handler({}, MAKE_CTX());

    expect(execFileMock).toHaveBeenCalled();
    expect(parse(result as never)).toMatchObject({ ok: true, fired: true, head_before: null, head_after: null });
  });

  // EI-18117741153424215: git-sync:run is the COMMIT lever of the three-part release
  // pipeline (COMMIT → git-sync:run, VERDICT → release:checkpoint-run, DEPLOY →
  // release:deploy) — same shape as its two siblings, which EI-7426 already fixed. It
  // used to copy an operator-config-write gate (wrong here — firing an already-scheduled,
  // idempotent commit+push mutates no config), so release-fixer (told by its own persona
  // to poll for its fix landing on staging before firing checkpoint-run) hit a recurring
  // structural tool-error trying to speed that commit up. There is now no in-handler role
  // gate; the invoke allowlist (SU_ROLES + cup/release-fixer/release-manager) is the
  // access control, mirroring release:checkpoint-run and release:deploy.
  it.each(['worker', 'debugger', 'cup', 'release-fixer', 'release-manager'])(
    'fires git-sync for a non-operator red-fixing role (%s) — no operator-config-write gate (EI-7426/EI-18117741153424215)',
    async (role) => {
      const fireSpy = vi.fn(async () => undefined);
      vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
      vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
      vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => null }));
      vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: fireSpy }));

      const { default: tool } = await import('./run');
      const result = await tool.handler({}, MAKE_CTX(role));

      expect(fireSpy).toHaveBeenCalledTimes(1);
      expect(parse(result as never)).toMatchObject({ ok: true, fired: true });
    },
  );

  it('advertises the invoke allowlist to the red-fix cohort (mirrors release:checkpoint-run / release:deploy)', async () => {
    const { default: tool } = await import('./run');
    const roles = (tool as { agentRoles?: readonly string[] }).agentRoles ?? [];
    for (const r of ['worker', 'scoper', 'validator', 'reviewer', 'debugger', 'cup', 'release-fixer', 'release-manager']) {
      expect(roles).toContain(r);
    }
  });
});
