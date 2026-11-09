/**
 * git-sync:run — fires the shared fireGitSyncNow once on demand (WI-1320). Mocks the
 * helper + repo-dir resolver and asserts it's invoked with the resolved slug/workspace
 * and the payload shape. projectDirForSlug returns null, so the HEAD-delta path (execFile)
 * is not exercised — committed:false.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promisify } from 'node:util';
import { payloadMatchesFilter } from '../../events/await/pattern';

// This suite checks returned event descriptors and the real payload matcher.
// Notification delivery is outside that boundary; importing its engine also
// imports the live coordination/DB graph inside each timed dynamic tool import.
vi.mock('../../events/await/engine', () => ({ emitAwaitedEvent: vi.fn() }));

const MAKE_CTX = (role = 'operator', overrides: Record<string, unknown> = {}) =>
  ({ log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), role, ...overrides }) as never;

function parse(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

// The operator test process can itself be launched from a request-only host
// (PAPERCUSP_BACKGROUND_WORKERS=0). Most cases below exercise the mutating
// background-host path, so pin that topology explicitly instead of inheriting
// the runner's ambient deployment role. The one refusal case flips to `0` and
// restores this suite baseline in its finally block.
const savedBackgroundWorkers = process.env.PAPERCUSP_BACKGROUND_WORKERS;
beforeEach(() => {
  process.env.PAPERCUSP_BACKGROUND_WORKERS = '1';
  vi.resetModules();
});
afterAll(() => {
  if (savedBackgroundWorkers === undefined) delete process.env.PAPERCUSP_BACKGROUND_WORKERS;
  else process.env.PAPERCUSP_BACKGROUND_WORKERS = savedBackgroundWorkers;
});
afterEach(() => {
  vi.doUnmock('../../serving-build');
  vi.doUnmock('../../serving-host-identity');
  vi.doUnmock('../../module-repo-root');
  vi.doUnmock('../../harness/operator-home-harness');
  vi.doUnmock('../../workspace-registry');
  vi.doUnmock('../../operator-notes');
  vi.doUnmock('../../harness/git-sync/git-sync-action');
  vi.doUnmock('../../bounded-timeout');
  vi.doUnmock('node:child_process');
});

describe('git-sync:run', () => {
  const repairMetadata = { base: 'a'.repeat(40), expectedPendingLockSha256: 'b'.repeat(64),
    requestId: 'selected-parent-repair', generation: 1 };
  const selectedLibraries = () => [
    { path: 'libs/generic/resumable-download' as const, expectedBasePin: '1'.repeat(40), selectedCommit: '2'.repeat(40) },
    { path: 'libs/papercusp' as const, expectedBasePin: '3'.repeat(40), selectedCommit: '4'.repeat(40) },
  ];

  it('keeps metadata repair inputs closed and requires an observed pending-lock identity', async () => {
    const { default: tool } = await import('./run');
    expect(tool.args.safeParse({ repairMetadata }).success).toBe(true);
    expect(tool.args.safeParse({ repairMetadata: { ...repairMetadata, expectedPendingLockSha256: null } }).success).toBe(true);
    for (const invalid of [{ ...repairMetadata, path: '/tmp/arbitrary' }, { ...repairMetadata, bytes: 'payload' },
      { ...repairMetadata, base: 'HEAD' }, { ...repairMetadata, expectedPendingLockSha256: undefined },
      { ...repairMetadata, generation: 0 }, { ...repairMetadata, generation: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(tool.args.safeParse({ repairMetadata: invalid }).success).toBe(false);
    }
  });

  it('refuses a metadata repair without an explicit execution target before firing', async () => {
    const fireSpy = vi.fn();
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: fireSpy }));
    const { default: tool } = await import('./run');
    expect(parse(await tool.handler({ repairMetadata }, MAKE_CTX()) as never))
      .toMatchObject({ ok: false, fired: false, reason: 'metadata-repair-target-required' });
    expect(fireSpy).not.toHaveBeenCalled();
  });

  it('admits only the closed sorted unique published-library vector, including explicit empty v2', async () => {
    const { default: tool } = await import('./run');
    const selections = selectedLibraries();
    for (const publishedLibrarySelections of [[], selections, [selections[1]]]) {
      expect(tool.args.safeParse({ repairMetadata: { ...repairMetadata, publishedLibrarySelections } }).success).toBe(true);
    }
    for (const publishedLibrarySelections of [null, [...selections].reverse(), [selections[0], selections[0]],
      [...selections, selections[0]], [{ ...selections[0], path: 'apps/other' }],
      [{ ...selections[0], selectedCommit: 'HEAD' }], [{ ...selections[0], expectedBasePin: 'origin/main' }],
      [{ ...selections[0], origin: { tip: 'f'.repeat(40) } }]]) {
      expect(tool.args.safeParse({ repairMetadata: { ...repairMetadata, publishedLibrarySelections } }).success).toBe(false);
    }
  });

  it.each([false, true])('detaches nested public selections before the first await (empty=%s)', async empty => {
    let resolveRepo!: (value: null) => void;
    const repo = new Promise<null>(resolve => { resolveRepo = resolve; });
    const fireSpy = vi.fn(async (..._args: unknown[]) => undefined);
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => repo }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: fireSpy }));
    vi.doMock('../../serving-build', () => ({ getServingBuild: () => 'staging', sameMcpExecutionTarget:
      (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b) }));
    vi.doMock('../../serving-host-identity', () => ({ getServingHostIdentity: () => ({ buildSha: 'c'.repeat(40) }) }));
    vi.doMock('../../module-repo-root', () => ({ moduleRepoRoot: () => '/selected' }));
    const { default: tool } = await import('./run');
    const selections = empty ? [] : selectedLibraries();
    const expected = structuredClone(selections);
    const repair = { ...repairMetadata, publishedLibrarySelections: selections };
    const pending = tool.handler({ repairMetadata: repair,
      target: { environment: 'staging', buildSha: 'c'.repeat(40), installRoot: '/selected' } }, MAKE_CTX());
    if (selections.length) selections[0]!.selectedCommit = '9'.repeat(40);
    selections.reverse();
    resolveRepo(null);
    await pending;
    expect(fireSpy).toHaveBeenCalledExactlyOnceWith('papercusp', 'default', null,
      { ...repairMetadata, publishedLibrarySelections: expected });
    const forwarded = fireSpy.mock.calls[0]![3] as typeof repair;
    expect(Object.isFrozen(forwarded)).toBe(true);
    expect(Object.isFrozen(forwarded.publishedLibrarySelections)).toBe(true);
    for (const row of forwarded.publishedLibrarySelections) expect(Object.isFrozen(row)).toBe(true);
  });

  it('forwards the frozen typed repair exactly once to the existing action on the exact worker', async () => {
    const fireSpy = vi.fn(async (..._args: unknown[]) => undefined);
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => null }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: fireSpy }));
    vi.doMock('../../serving-build', () => ({ getServingBuild: () => 'staging', sameMcpExecutionTarget:
      (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b) }));
    vi.doMock('../../serving-host-identity', () => ({ getServingHostIdentity: () => ({ buildSha: 'c'.repeat(40) }) }));
    vi.doMock('../../module-repo-root', () => ({ moduleRepoRoot: () => '/selected' }));
    const { default: tool } = await import('./run');
    const target = { environment: 'staging' as const, buildSha: 'c'.repeat(40), installRoot: '/selected' };
    await tool.handler({ repairMetadata, target }, MAKE_CTX());
    expect(fireSpy).toHaveBeenCalledExactlyOnceWith('papercusp', 'default', null, repairMetadata);
    expect(Object.isFrozen(fireSpy.mock.calls[0]![3])).toBe(true);
  });

  it('previews a metadata repair on a request-only host without firing it', async () => {
    process.env.PAPERCUSP_BACKGROUND_WORKERS = '0';
    const fireSpy = vi.fn();
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => null }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: fireSpy }));
    const { default: tool } = await import('./run');
    expect(parse(await tool.handler({ repairMetadata, dryRun: true }, MAKE_CTX()) as never))
      .toMatchObject({ ok: true, fired: false, status: 'preview', repair_metadata: repairMetadata });
    expect(fireSpy).not.toHaveBeenCalled();
  });

  it.each(['committed', 'already-published', 'persistence-error'] as const)(
    'reports metadata repair %s separately from current HEAD and egress', async phase => {
      const commit = 'e'.repeat(40);
      const head = 'd'.repeat(40);
      const receipt = { ...repairMetadata, custodyRef: 'refs/papercusp/source-custody/test',
        commit, tree: 'f'.repeat(40), publication: phase === 'already-published' ? phase : 'committed',
        remoteEgressConfirmed: false, routineMetadataRecorded: phase !== 'persistence-error' };
      const outcome = { status: phase === 'persistence-error' ? 'error' : 'synced', headSha: head,
        committedCount: phase === 'already-published' ? 0 : 1, pushed: [], merged: [],
        ...(phase === 'already-published' ? {} : { localCommitSha: commit }),
        ...(phase === 'persistence-error' ? { errors: [{ scope: 'superproject', message: 'outcome-persistence' }] } : {}),
        metadataRepair: receipt };
      const fireSpy = vi.fn(async () => outcome);
      vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
      vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
      vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => null }));
      vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: fireSpy }));
      vi.doMock('../../serving-build', () => ({ getServingBuild: () => 'staging', sameMcpExecutionTarget:
        (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b) }));
      vi.doMock('../../serving-host-identity', () => ({ getServingHostIdentity: () => ({ buildSha: 'c'.repeat(40) }) }));
      vi.doMock('../../module-repo-root', () => ({ moduleRepoRoot: () => '/selected' }));
      const { default: tool } = await import('./run');
      const result = parse(await tool.handler({ repairMetadata,
        target: { environment: 'staging', buildSha: 'c'.repeat(40), installRoot: '/selected' } }, MAKE_CTX()) as never);
      expect(result).toMatchObject({ status: phase === 'persistence-error' ? 'error' : 'committed',
        outcome: { metadataRepair: receipt, headSha: head } });
      expect(result.note).toContain(`at commit ${commit}; current HEAD ${head}`);
      expect(result.note).toContain('Remote egress is unconfirmed');
      expect(result.note).toContain(phase === 'already-published' ? 'already-published' : 'committed');
      if (phase === 'persistence-error') expect(result.note).toContain('Operation reported errors');
      expect(fireSpy).toHaveBeenCalledTimes(1);
    });

  it('checks the exact target again at the worker before firing', async () => {
    const fireSpy = vi.fn(async () => undefined);
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => null }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: fireSpy }));
    vi.doMock('../../serving-host-identity', () => ({ getServingHostIdentity: () => ({ buildSha: 'a'.repeat(40) }) }));
    vi.doMock('../../module-repo-root', () => ({ moduleRepoRoot: () => '/selected' }));
    const { default: tool } = await import('./run');
    const { getServingBuild } = await import('../../serving-build');
    const target = { environment: getServingBuild(), buildSha: 'a'.repeat(40), installRoot: '/selected' };
    for (const changed of [{ ...target, environment: target.environment === 'main' ? 'staging' as const : 'main' as const },
      { ...target, buildSha: 'b'.repeat(40) }, { ...target, installRoot: '/another' }]) {
      expect(parse(await tool.handler({ target: changed }, MAKE_CTX()) as never))
        .toMatchObject({ ok: false, fired: false, reason: 'execution-target-mismatch' });
    }
    expect(fireSpy).not.toHaveBeenCalled();
    expect(parse(await tool.handler({ target }, MAKE_CTX()) as never)).toMatchObject({ ok: true, fired: true });
    expect(fireSpy).toHaveBeenCalledExactlyOnceWith('papercusp', 'default', null);
  });

  it('accepts an optional reason without rejecting the strict args schema', async () => {
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => null }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: vi.fn(async () => undefined) }));

    const { default: tool } = await import('./run');
    const parsed = tool.args.safeParse({ reason: 'gate red; commit the current staging tree' });

    expect(parsed.success).toBe(true);
    expect((parsed.data as { reason?: string }).reason).toBe('gate red; commit the current staging tree');
    expect(tool.args.safeParse({ definitelyNotAnArg: 'x' }).success).toBe(false);
  });

  it('returns a result-backed receipt for late commits and fails closed on ambiguous outcomes', async () => {
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => null }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: vi.fn(async () => undefined) }));

    const { default: tool } = await import('./run');
    const receipt = tool.abortCompletionReceipt;
    expect(receipt).toBeTypeOf('function');
    const attempt = { callId: 'git-sync-call-1', toolName: 'git-sync:run' };
    const result = (payload: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    }) as never;
    const commitSha = 'a'.repeat(40);

    expect(receipt!({}, result({
      ok: true,
      fired: true,
      slug: 'papercusp',
      status: 'synced',
      outcome: {
        status: 'synced',
        localCommitSha: commitSha,
        headSha: commitSha,
        committedCount: 1,
      },
    }), attempt)).toMatchObject({
      status: 'recorded',
      effectRef: 'git-sync-run:git-sync-call-1:commit:' + commitSha,
      diagnostics: {
        slug: 'papercusp',
        resultStatus: 'synced',
        outcomeStatus: 'synced',
        committedCount: 1,
        localCommitSha: commitSha,
      },
    });

    expect(receipt!({}, result({
      ok: true,
      fired: true,
      slug: 'papercusp',
      status: 'nothing',
      outcome: { status: 'nothing', committedCount: 0 },
    }), attempt)).toMatchObject({ status: 'not-recorded' });

    expect(receipt!({}, result({
      ok: false,
      fired: true,
      slug: 'papercusp',
      status: 'in_progress',
      degraded: true,
    }), attempt)).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['fire-not-terminal'],
    });

    expect(receipt!({}, result({
      ok: true,
      fired: true,
      slug: 'papercusp',
      status: 'error',
      outcome: { status: 'error', committedCount: 1 },
    }), attempt)).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-completed-effect-identity'],
    });
  });

  it('records a clamped fire reason once while preserving the existing response', async () => {
    const fireSpy = vi.fn(async () => undefined);
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => null }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: fireSpy }));

    const { default: tool } = await import('./run');
    const metadata = vi.fn();
    const reason = 'x'.repeat(5000);
    const result = parse((await tool.handler({ reason }, MAKE_CTX('operator', { metadata }))) as never);

    expect(fireSpy).toHaveBeenCalledExactlyOnceWith('papercusp', 'default', null);
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(metadata).toHaveBeenCalledWith({ fireReason: 'x'.repeat(1000) });
    expect(result).toMatchObject({ ok: true, fired: true, slug: 'papercusp', committed: false });
  });

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

  it('returns a read-only preview for a registered repository without firing git-sync', async () => {
    const fireSpy = vi.fn(async () => undefined);
    const execFileMock = vi.fn(
      (_file: string, args: string[], _opts: Record<string, unknown>, cb: (...a: unknown[]) => void) => {
        if (args[0] === 'rev-parse') {
          cb(null, 'abc123\n', '');
          return;
        }
        cb(null, ' M packages/example.ts\0?? scratch.txt\0', '');
      },
    );
    // Node's real child_process.execFile has a bespoke promisify implementation
    // that resolves to { stdout, stderr }. Keep this callback mock observable
    // while exposing the same promisified contract used by run.ts.
    Object.defineProperty(execFileMock, promisify.custom, {
      value: (_file: string, args: string[], opts: Record<string, unknown>) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFileMock(_file, args, opts, (...callbackArgs: unknown[]) => {
            const [error, stdout, stderr] = callbackArgs as [unknown, string, string];
            if (error) {
              reject(error);
              return;
            }
            resolve({ stdout, stderr });
          });
        }),
    });
    vi.doMock('node:child_process', () => ({ execFile: execFileMock }));
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => '/repo' }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: fireSpy }));

    const { default: tool } = await import('./run');
    const result = parse((await tool.handler({ installSlug: 'papercusp', dryRun: true }, MAKE_CTX())) as never);

    expect(result).toMatchObject({
      ok: true,
      fired: false,
      dry_run: true,
      slug: 'papercusp',
      status: 'preview',
      preview: {
        repo_path: '/repo',
        head_sha: 'abc123',
        dirty: true,
        dirty_paths: ['packages/example.ts', 'scratch.txt'],
        dirty_paths_truncated: false,
        error: null,
      },
    });
    expect(fireSpy).not.toHaveBeenCalled();
    expect(execFileMock.mock.calls.map((call) => call[1])).toEqual([
      ['rev-parse', 'HEAD'],
      ['status', '--porcelain=v1', '-z', '-uall'],
    ]);
    expect(execFileMock.mock.calls[1]?.[2]).toMatchObject({
      env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0' }),
    });
  });

  it('returns an honest no-repository preview without spawning git or firing git-sync', async () => {
    const fireSpy = vi.fn(async () => undefined);
    const execFileMock = vi.fn();
    vi.doMock('node:child_process', () => ({ execFile: execFileMock }));
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'operator-home' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => null }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: fireSpy }));

    const { default: tool } = await import('./run');
    const result = parse((await tool.handler({ harness: 'repo-less', dryRun: true }, MAKE_CTX())) as never);

    expect(result).toMatchObject({
      ok: true,
      fired: false,
      dry_run: true,
      slug: 'repo-less',
      status: 'preview',
      preview: {
        repo_path: null,
        head_sha: null,
        dirty: null,
        dirty_paths: null,
        dirty_paths_truncated: false,
        error: 'No repository path is registered for install "repo-less".',
      },
    });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(fireSpy).not.toHaveBeenCalled();
  });

  it('refuses a mutating fire on a request-only host while preserving dry-run preview', async () => {
    const priorBackgroundWorkers = process.env.PAPERCUSP_BACKGROUND_WORKERS;
    process.env.PAPERCUSP_BACKGROUND_WORKERS = '0';
    try {
      const fireSpy = vi.fn(async () => undefined);
      vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
      vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
      vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => null }));
      vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: fireSpy }));

      const { default: tool } = await import('./run');
      const refused = parse((await tool.handler({ harness: 'papercusp' }, MAKE_CTX())) as never);
      const preview = parse((await tool.handler({ harness: 'papercusp', dryRun: true }, MAKE_CTX())) as never);

      expect(refused).toMatchObject({
        ok: false,
        fired: false,
        slug: 'papercusp',
        status: 'refused',
        success: false,
        committed: false,
        reason: 'request-only-host',
        retry: {
          tool: 'git-sync:run',
          host_role: 'background-workers',
          dev_box_url: 'http://127.0.0.1:3271',
        },
      });
      expect(refused.note).toMatch(/PAPERCUSP_BACKGROUND_WORKERS=0/);
      expect(refused.note).toContain(
        'ptool git-sync:run --url=http://127.0.0.1:3271 --json-file <args.json>',
      );
      expect(refused.note).toMatch(/workspace.*shared.*bearer/i);
      expect(refused.note).toMatch(/background mode.*inspect its log/i);
      expect(refused.note).not.toContain('node scripts/mcp-call.mjs');
      expect(preview).toMatchObject({
        ok: true,
        fired: false,
        dry_run: true,
        status: 'preview',
      });
      expect(fireSpy).not.toHaveBeenCalled();
    } finally {
      if (priorBackgroundWorkers === undefined) delete process.env.PAPERCUSP_BACKGROUND_WORKERS;
      else process.env.PAPERCUSP_BACKGROUND_WORKERS = priorBackgroundWorkers;
    }
  });

  it('surfaces repository inspection failures as unknown dirtiness instead of claiming clean', async () => {
    const fireSpy = vi.fn(async () => undefined);
    const execFileMock = vi.fn(
      (_file: string, args: string[], _opts: Record<string, unknown>, cb: (...a: unknown[]) => void) => {
        if (args[0] === 'rev-parse') {
          cb(null, 'abc123\n', '');
          return;
        }
        cb(new Error('git status failed'));
      },
    );
    Object.defineProperty(execFileMock, promisify.custom, {
      value: (_file: string, args: string[], opts: Record<string, unknown>) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFileMock(_file, args, opts, (...callbackArgs: unknown[]) => {
            const [error, stdout, stderr] = callbackArgs as [unknown, string, string];
            if (error) {
              reject(error);
              return;
            }
            resolve({ stdout, stderr });
          });
        }),
    });
    vi.doMock('node:child_process', () => ({ execFile: execFileMock }));
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => '/repo' }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: fireSpy }));

    const { default: tool } = await import('./run');
    const result = parse((await tool.handler({ installSlug: 'papercusp', dryRun: true }, MAKE_CTX())) as never);

    expect(result).toMatchObject({
      ok: true,
      fired: false,
      dry_run: true,
      status: 'preview',
      preview: {
        repo_path: '/repo',
        head_sha: 'abc123',
        dirty: null,
        dirty_paths: null,
        dirty_paths_truncated: false,
        error: 'git status failed',
      },
    });
    expect(fireSpy).not.toHaveBeenCalled();
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
          surface: 'routines:list',
          tool: 'routines:list',
          args: { installSlug: 'papercusp', name: 'git-sync' },
          workspace_id: 'default',
          install_slug: 'papercusp',
          target_role: 'system:git-sync',
          fields: [
            'health.fire_started_at',
            'health.last_status',
            'health.last_synced_at',
            'health.head_sha',
            'health.git_sync_activity',
          ],
        },
      },
    });
  });

  it('does not run a trailing HEAD probe after a timed-out fire', async () => {
    vi.doMock('../../bounded-timeout', () => ({
      withBoundedTimeout: async () => ({ value: undefined, degraded: true, reason: 'timeout', elapsedMs: 45_000 }),
    }));
    const execFileMock = vi.fn(
      (_file: string, _args: string[], _opts: Record<string, unknown>, cb: (...a: unknown[]) => void) =>
        cb(null, 'abc123\n', ''),
    );
    Object.defineProperty(execFileMock, promisify.custom, {
      value: (_file: string, _args: string[], _opts: Record<string, unknown>) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFileMock(_file, _args, _opts, (...callbackArgs: unknown[]) => {
            const [error, stdout, stderr] = callbackArgs as [unknown, string, string];
            if (error) {
              reject(error);
              return;
            }
            resolve({ stdout, stderr });
          });
        }),
    });
    vi.doMock('node:child_process', () => ({ execFile: execFileMock }));
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => '/repo' }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: vi.fn(async () => undefined) }));

    const { default: tool } = await import('./run');
    const result = parse((await tool.handler({}, MAKE_CTX())) as never);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'in_progress',
      degraded: true,
      head_before: 'abc123',
      head_after: null,
    });
  });

  const SKIP_HOLDERS = [
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

  const mockSkippedFire = async (outcome: Record<string, unknown>) => {
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => null }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: vi.fn(async () => outcome) }));
    const { default: tool } = await import('./run');
    return parse((await tool.handler({}, MAKE_CTX())) as never);
  };

  it('does not attribute a concurrent HEAD advance to a held_exclusive skip', async () => {
    const heads = ['before', 'after'];
    const execFileMock = vi.fn(
      (_file: string, _args: string[], _opts: Record<string, unknown>, cb: (...args: unknown[]) => void) => {
        const stdout = heads.shift() ?? '';
        cb(null, `${stdout}\n`, '');
      },
    );
    Object.defineProperty(execFileMock, promisify.custom, {
      value: (_file: string, args: string[], opts: Record<string, unknown>) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFileMock(_file, args, opts, (...callbackArgs: unknown[]) => {
            const [error, stdout, stderr] = callbackArgs as [unknown, string, string];
            if (error) {
              reject(error);
              return;
            }
            resolve({ stdout, stderr });
          });
        }),
    });

    const outcome = {
      status: 'skipped' as const,
      reason: 'held_exclusive',
      blockedOn: 'git-sync:papercusp',
      holders: SKIP_HOLDERS,
    };
    vi.doMock('node:child_process', () => ({ execFile: execFileMock }));
    vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('../../operator-notes', () => ({ projectDirForSlug: async () => '/repo' }));
    vi.doMock('../../harness/git-sync/git-sync-action', () => ({ fireGitSyncNow: vi.fn(async () => outcome) }));

    const { default: tool } = await import('./run');
    const result = parse((await tool.handler({}, MAKE_CTX())) as never);

    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: true,
      fired: true,
      status: 'skipped',
      success: false,
      committed: false,
      head_before: 'before',
      head_after: 'after',
      outcome,
    });
  });

  // EI-22726196301284168: `held_exclusive` still must not advertise the global
  // lock-retry key, whose emitter deliberately excludes this refusal class. The
  // release path emits an exact resource key at the release boundary. The event
  // is only a notification; it does not reserve the resource for the retry.
  it.each([
    { holders: [{ ...SKIP_HOLDERS[0], acquired_ts: new Date(20_000).toISOString() }] },
    { holders: [] },
    { holders: [{ ...SKIP_HOLDERS[0], acquired_ts: 'unavailable' }] },
  ])('EI-281444: rejects a deferred old release for current holders $holders', async ({ holders }) => {
    const result = await mockSkippedFire({
      status: 'skipped', reason: 'held_exclusive', blockedOn: 'git-sync:papercusp', holders,
    });
    const { continuation } = result as {
      continuation: { completion_event: { payload_filter: Record<string, unknown> } };
    };
    const filter = continuation.completion_event.payload_filter;
    const release = { resource: 'git-sync:papercusp', workspaceId: 'default' };
    expect(payloadMatchesFilter(filter, { ...release, releasedAtMs: 10_000 })).toBe(false);
    expect(payloadMatchesFilter(filter, { ...release, releasedAtMs: Date.now() + 1_000 })).toBe(true);
    expect(payloadMatchesFilter(filter, release)).toBe(false);
    if (holders[0]?.acquired_ts === new Date(20_000).toISOString()) {
      expect(payloadMatchesFilter(filter, { ...release, releasedAtMs: 20_000 })).toBe(true);
    }
  });

  it('advertises the exact resource release event for a held_exclusive skip', async () => {
    const outcome = {
      status: 'skipped' as const,
      reason: 'held_exclusive',
      blockedOn: 'git-sync:papercusp',
      holders: SKIP_HOLDERS,
    };
    const result = await mockSkippedFire(outcome);

    expect(result).toMatchObject({
      ok: true,
      fired: true,
      status: 'skipped',
      success: false,
      committed: false,
      outcome,
      // Live holder state is still genuinely useful and is retained.
      continuation: {
        completion_event: {
          key: 'resource:released:git-sync:papercusp',
          payload_fields: ['resource', 'workspaceId', 'releasedAtMs'],
          payload_filter: {
            all: [
              { resource: { equals: 'git-sync:papercusp' } },
              { workspaceId: { equals: 'default' } },
              { releasedAtMs: { gte: Date.parse(SKIP_HOLDERS[0].acquired_ts) } },
            ],
          },
        },
        await_tool: 'events:await',
        progress_ref: {
          surface: 'locks:list',
          tool: 'locks:list',
          args: { resource: 'git-sync:papercusp' },
          workspace_id: 'default',
          install_slug: 'papercusp',
          resource: 'git-sync:papercusp',
          fields: ['resources[].holders', 'resources[].held', 'holders', 'draining'],
        },
      },
    });
    // The global retry key remains a dead drop for this class and must not be
    // substituted for the exact release-boundary key.
    const { continuation } = result as { continuation: Record<string, unknown> };
    expect(continuation.completion_event).toMatchObject({
      key: 'resource:released:git-sync:papercusp',
    });
    expect(continuation.completion_event).not.toMatchObject({ key: 'git-sync:lock-retry' });
    expect(result.note).toMatch(/exact resource release event/);
    expect(result.note).toMatch(/does not reserve the resource/);
    expect(result.note).toMatch(/may skip again and return a fresh continuation/);
    expect(result.note).not.toMatch(/retry safely/);
    expect(result.note).not.toMatch(/git-sync:lock-retry/);
  });

  it('names an in-flight git-sync auto-commit instead of calling it a peer', async () => {
    const outcome = {
      status: 'skipped' as const,
      reason: 'held_exclusive',
      blockedOn: 'git-sync:papercusp',
      holders: [
        {
          owner: 'system:git-sync:3063386:026aff27-f42d-4d44-94b8-045f102f989a',
          owner_label: 'git-sync:papercusp',
          mode: 'exclusive',
          status: 'held',
          lock_id: 'lock-system-git-sync',
          reason: 'auto-commit papercusp',
          acquired_ts: '2026-09-05T13:42:29.066Z',
          expires_ts: '2026-09-05T13:52:29.066Z',
          fence_seq: 42,
        },
      ],
    };
    const result = await mockSkippedFire(outcome);

    expect(result.note).toMatch(/an in-flight git-sync auto-commit holds git-sync:papercusp/);
    expect(result.note).not.toMatch(/a peer holds git-sync:papercusp/);
    const { continuation } = result as { continuation: Record<string, unknown> };
    expect(continuation).toMatchObject({
      completion_event: {
        key: 'resource:released:git-sync:papercusp',
        payload_fields: ['resource', 'workspaceId', 'releasedAtMs'],
        payload_filter: {
          all: [
            { resource: { equals: 'git-sync:papercusp' } },
            { workspaceId: { equals: 'default' } },
            { releasedAtMs: { gte: Date.parse('2026-09-05T13:42:29.066Z') } },
          ],
        },
      },
      await_tool: 'events:await',
    });
  });

  it('uses the workspace barrier release as a retry hint for an exclusive_pending workspace barrier', async () => {
    const outcome = {
      status: 'skipped' as const,
      reason: 'exclusive_pending',
      blockedOn: 'git-sync',
      // A queued dev:restart exclusive may have no current exclusive holder.
      // The release event must name the workspace-wide row that will be released.
      holders: [],
    };
    const result = await mockSkippedFire(outcome);

    expect(result).toMatchObject({
      ok: true,
      fired: true,
      status: 'skipped',
      outcome,
      continuation: {
        completion_event: {
          key: 'resource:released:git-sync',
          payload_fields: ['resource', 'workspaceId', 'releasedAtMs'],
          payload_filter: {
            all: [
              { resource: { equals: 'git-sync' } },
              { workspaceId: { equals: 'default' } },
              { releasedAtMs: { gte: expect.any(Number) } },
            ],
          },
        },
        await_tool: 'events:await',
        progress_ref: {
          surface: 'locks:list',
          args: { resource: 'git-sync' },
        },
      },
    });
    expect(result.note).toMatch(/workspace-wide barrier/);
    expect(result.note).not.toMatch(/git-sync:lock-retry/);
  });

  // POSITIVE CONTROL for the cases above: only resource-backed refusal classes use
  // the exact release event. A DB contention skip still uses the live retry signal.
  it('still returns the lock-retry continuation for a non-held_exclusive skip, whose emitter does fire', async () => {
    const outcome = {
      status: 'skipped' as const,
      reason: 'lock_contended',
      blockedOn: 'libs-papercusp-submodule',
      holders: SKIP_HOLDERS,
    };
    const result = await mockSkippedFire(outcome);

    expect(result).toMatchObject({
      ok: true,
      fired: true,
      status: 'skipped',
      outcome,
      continuation: {
        completion_event: {
          key: 'git-sync:lock-retry',
          payload_fields: ['installSlug', 'workspaceId', 'resource', 'reason', 'holders'],
          payload_filter: {
            all: [
              { installSlug: { equals: 'papercusp' } },
              { workspaceId: { equals: 'default' } },
              { resource: { equals: 'libs-papercusp-submodule' } },
            ],
          },
        },
        await_tool: 'events:await',
        progress_ref: {
          surface: 'locks:list',
          tool: 'locks:list',
          args: { resource: 'libs-papercusp-submodule' },
          workspace_id: 'default',
          install_slug: 'papercusp',
          resource: 'libs-papercusp-submodule',
          fields: ['resources[].holders', 'resources[].held', 'holders', 'draining'],
        },
      },
    });
    expect(result.note).toMatch(/git-sync:lock-retry/);
  });

  it('describes a structured skipped-locked outcome instead of calling it unknown', async () => {
    const outcome = {
      status: 'skipped-locked' as const,
      dirtyPathCount: 2,
      committedCount: 0,
      skippedPaths: [
        { scope: 'superproject', path: 'next-env.d.ts', owner: 'su-loopback' },
        { scope: 'superproject', path: 'tsconfig.json', owner: 'su-loopback' },
      ],
    };

    const result = await mockSkippedFire(outcome);

    expect(result).toMatchObject({
      ok: true,
      fired: true,
      status: 'skipped-locked',
      success: false,
      committed: false,
      outcome,
    });
    expect(result.note).toContain('structured skipped-locked outcome');
    expect(result.note).toContain('outcome.skippedPaths');
    expect(result.note).not.toContain('no structured outcome');
  });

  // WI-4940: the trailing `git rev-parse HEAD` (headSha, called unconditionally after
  // fireGitSyncNow resolves — the exact spot the reporter's 120s hang landed in, AFTER
  // the commit had already succeeded) must be bounded, not a bare unbounded execFile.
  it('bounds the HEAD-delta execFile call with a timeout so a hung git process cannot hang the whole tool call', async () => {
    const execFileMock = vi.fn(
      (_file: string, _args: string[], opts: Record<string, unknown>, cb: (...a: unknown[]) => void) => {
        // Simulate node's own timeout-kill behavior: execFile with `timeout` set rejects
        // with a killed error instead of ever resolving — assert the fix actually wires
        // a bounded `timeout` through, and that the handler still resolves cleanly.
        expect(opts).toMatchObject({ timeout: expect.any(Number) });
        expect((opts.timeout as number) > 0).toBe(true);
        cb(Object.assign(new Error('killed'), { killed: true }));
      },
    );
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
      workspaceId === 'papercusp-workspace' ? canonical : sibling,
    );
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
    for (const r of [
      'worker',
      'scoper',
      'validator',
      'reviewer',
      'debugger',
      'cup',
      'release-fixer',
      'release-manager',
    ]) {
      expect(roles).toContain(r);
    }
  });
});
