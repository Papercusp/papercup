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
  vi.doUnmock('../../bounded-timeout');
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
    expect(fireSpy).toHaveBeenCalledWith('papercusp', 'default', null);
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
    expect(fireSpy).toHaveBeenCalledWith('papercusp', 'default', null);
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
      remote_egress: {
        status: 'confirmed',
        confirmed: true,
        pushed_scopes: ['superproject'],
        evidence: 'outcome.pushed includes superproject',
      },
      outcome: { status: 'synced', headSha: 'abc123def456', pushed: ['superproject'] },
    });
  });

  it('does not report remote sync when a bridged/commit-only tick only creates a local commit', async () => {
    const outcome = {
      status: 'synced' as const,
      headSha: '99dd16f98c9715157cf562e004439f1219067934',
      pushed: [],
      merged: [],
      oversized: [],
      contentErrors: [],
      strandedSubmodules: [],
    };
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'sidestage' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => null }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: vi.fn(async () => outcome) }));

    const { default: tool } = await import('./run');
    const result = parse((await tool.handler({}, MAKE_CTX())) as never);

    expect(result).toMatchObject({
      ok: true,
      status: 'committed',
      success: true,
      committed: true,
      remote_egress: {
        status: 'unverified',
        confirmed: false,
        pushed_scopes: [],
        evidence: 'outcome.pushed does not include superproject',
        completion_event: {
          key: 'git-sync:egressed:99dd16f98c9715157cf562e004439f1219067934',
          payload_field: 'sha',
        },
        await_tool: 'events:await',
      },
      outcome: { status: 'synced', headSha: '99dd16f98c9715157cf562e004439f1219067934', pushed: [] },
    });
    expect(result.note).toMatch(/origin\/staging egress is NOT confirmed/);
    expect(result.note).toMatch(/not a delivery signal/);
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

  it('makes a timeout explicitly non-terminal and exposes the commit event plus routine progress reference', async () => {
    vi.doMock('../../bounded-timeout', () => ({
      withBoundedTimeout: async () => ({ value: undefined, degraded: true, reason: 'timeout', elapsedMs: 45_000 }),
    }));
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => null }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: vi.fn(async () => undefined) }));

    const { default: tool } = await import('./run');
    const result = parse((await tool.handler({}, MAKE_CTX())) as never);

    expect(result).toMatchObject({
      ok: false,
      fired: true,
      status: 'in_progress',
      success: false,
      committed: false,
      degraded: true,
      continuation: {
        completion_event: { key: 'git-sync:committed', payload_field: 'sha' },
        await_tool: 'git-sync:await',
        progress_ref: {
          surface: 'routine.metadata',
          workspace_id: 'default',
          install_slug: 'papercusp',
          target_role: 'system:git-sync',
          fields: ['fire_started_at', 'last_status', 'last_synced_at', 'head_sha', 'git_sync_activity'],
        },
      },
    });
  });

  it('returns a structured lock-retry continuation when the fire skips on a held resource', async () => {
    const holders = [
      {
        owner: 'su-peer',
        owner_label: 'peer agent',
        mode: 'exclusive',
        status: 'held',
        lock_id: 'lock-1',
        reason: 'manual git work',
        acquired_ts: '2026-08-21T10:00:00.000Z',
        expires_ts: '2026-08-21T10:10:00.000Z',
        fence_seq: 42,
      },
    ];
    const outcome = {
      status: 'skipped' as const,
      reason: 'held_exclusive',
      blockedOn: 'git-sync:papercusp',
      holders,
    };
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => null }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: vi.fn(async () => outcome) }));

    const { default: tool } = await import('./run');
    const result = parse((await tool.handler({}, MAKE_CTX())) as never);

    expect(result).toMatchObject({
      ok: true,
      fired: true,
      status: 'skipped',
      success: false,
      committed: false,
      outcome,
      continuation: {
        completion_event: {
          key: 'git-sync:lock-retry',
          payload_fields: ['installSlug', 'workspaceId', 'resource', 'reason', 'holders'],
        },
        await_tool: 'events:await',
        progress_ref: {
          surface: 'agent_resource_locks',
          workspace_id: 'default',
          install_slug: 'papercusp',
          resource: 'git-sync:papercusp',
          fields: ['resource', 'reason', 'holders'],
        },
      },
    });
    expect(result.note).toMatch(/git-sync:lock-retry/);
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

  it('pins the workspace-scoped canonical tree through both HEAD probes and the fired action', async () => {
    const canonical = '/hives/sidestage';
    const sibling = '/workspace/sidestage';
    const projectDirForSlug = vi.fn(async (_slug: string, workspaceId?: string) =>
      workspaceId === 'papercusp-workspace' ? canonical : sibling);
    const execFileMock = vi.fn(
      (_file: string, _args: string[], opts: Record<string, unknown>, cb: (...a: unknown[]) => void) =>
        cb(null, 'abc123\n', ''),
    );
    const fireSpy = vi.fn(async () => ({
      status: 'nothing' as const,
      pushed: [],
      merged: [],
      oversized: [],
      contentErrors: [],
      strandedSubmodules: [],
    }));
    vi.doMock('node:child_process', () => ({ execFile: execFileMock }));
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'operator-home' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'papercusp-workspace' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: fireSpy }));

    const { default: tool } = await import('./run');
    await tool.handler({ installSlug: 'sidestage' }, MAKE_CTX());

    expect(projectDirForSlug).toHaveBeenCalledExactlyOnceWith('sidestage', 'papercusp-workspace');
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls.map((call) => call[2]?.cwd)).toEqual([canonical, canonical]);
    expect(fireSpy).toHaveBeenCalledExactlyOnceWith('sidestage', 'papercusp-workspace', canonical);
    expect(fireSpy).not.toHaveBeenCalledWith('sidestage', 'papercusp-workspace', sibling);
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
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => null }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: vi.fn(async () => undefined) }));

    const { default: tool } = await import('./run');
    const roles = (tool as { agentRoles?: readonly string[] }).agentRoles ?? [];
    for (const r of ['worker', 'scoper', 'validator', 'reviewer', 'debugger', 'cup', 'release-fixer', 'release-manager']) {
      expect(roles).toContain(r);
    }
  });
});
