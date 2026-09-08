/**
 * Recurrence guard for WI-40369.
 *
 * `./configure` is imported for its SIDE EFFECT (`configureBackup({...})` runs
 * at module-eval time), and it is reachable from the agent-tools registry
 * import graph — which unrelated prompt/registry suites pull in transitively.
 * Those suites routinely install a PARTIAL mock of `../workspace-registry`:
 *
 *     vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: ... }));
 *
 * Under vitest, reading a property the mock factory does not define is a HARD
 * throw ("No \"workspacesRoot\" export is defined on the ... mock"), not
 * `undefined`. So passing an imported binding straight into the config object
 * literal dereferences it during that evaluation and fails the ENTIRE
 * unrelated suite file at import — which is exactly what red-pinned
 * lib/agent-tools/oracle/prompts.test.ts and the three
 * lib/agent-tools/operator/__tests__/converse-prompt-*.test.ts files in the
 * green-checkpoint operator-core lane (each passed when run solo).
 *
 * The fix is that every host seam handed to `configureBackup` is a THUNK, so
 * the source module is not dereferenced until the seam is actually called —
 * which a unit suite that merely loads the registry never does.
 *
 * FALSIFIABILITY: revert `workspacesRoot: () => workspacesRoot()` in
 * ./configure.ts back to the bare shorthand `workspacesRoot,` and this test
 * fails at the dynamic import below.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({
  configureBackup: vi.fn(),
  managedSetInterval: vi.fn(() => ({ stop: vi.fn() })),
  readQualificationAdmission: vi.fn(),
  readCheckpointSerializerAuthority: vi.fn(),
}));

const pg = vi.hoisted(() => {
  const client = Object.assign(
    vi.fn((_strings: readonly string[], ..._values: unknown[]): Promise<unknown> => Promise.resolve([])),
    { end: vi.fn(async () => {}) },
  );
  return { client, postgres: vi.fn(() => client) };
});

vi.mock('@papercusp/backup', () => ({ configureBackup: h.configureBackup }));
vi.mock('@papercusp/scheduled-registry', () => ({ managedSetInterval: h.managedSetInterval }));
vi.mock('postgres', () => ({ default: pg.postgres }));
vi.mock('../release-checkpoint-config', () => ({
  readQualificationAdmission: h.readQualificationAdmission,
}));
vi.mock('../release/checkpoint-serializer-authority', () => ({
  readCheckpointSerializerAuthority: h.readCheckpointSerializerAuthority,
}));

// The exact partial mock the stranded suites install: `activeWorkspaceId` only.
// Every OTHER export of ../workspace-registry is undefined-and-throwing here.
vi.mock('../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-test'),
}));

beforeEach(() => {
  h.readQualificationAdmission.mockReset().mockResolvedValue({ status: 'clear' });
  h.readCheckpointSerializerAuthority.mockReset().mockResolvedValue({
    status: 'none',
    reason: 'routine-not-found',
  });
});

async function configuredHost(): Promise<{
  readIntervalSnapshotAdmission: (workspaceId: string) => Promise<unknown>;
  acquireMigrationLock: (options?: { tryOnly?: boolean }) => Promise<{
    release: () => Promise<void>;
  } | undefined>;
  scheduleInterval: (name: string, intervalMs: number, callback: () => void | Promise<void>) => { stop: () => void };
}> {
  await import('./configure');
  return h.configureBackup.mock.calls[0]![0] as {
    readIntervalSnapshotAdmission: (workspaceId: string) => Promise<unknown>;
    acquireMigrationLock: (options?: { tryOnly?: boolean }) => Promise<{
      release: () => Promise<void>;
    } | undefined>;
    scheduleInterval: (name: string, intervalMs: number, callback: () => void | Promise<void>) => { stop: () => void };
  };
}

describe('backup host binding — lazy host seams (WI-40369)', () => {
  it('evaluates ./configure under a PARTIAL ../workspace-registry mock without throwing', async () => {
    await expect(import('./configure')).resolves.toBeDefined();
    expect(h.configureBackup).toHaveBeenCalledTimes(1);
  });

  it('does not read `workspacesRoot` off the module at import time', async () => {
    // Positive control: the mock really is partial, so a direct property read
    // DOES throw. If this control stops throwing, the guard above proves
    // nothing and must be re-derived rather than trusted.
    const mod = (await import('../workspace-registry')) as Record<string, unknown>;
    // The OLD eager form — `workspacesRoot,` shorthand in the config literal —
    // is exactly this property read, and it throws.
    expect(() => (mod as { workspacesRoot: unknown }).workspacesRoot).toThrow();
    // The CURRENT lazy form defers the same read into a thunk, so building the
    // config object is safe; only CALLING the seam would touch the mock.
    expect(() => ({
      workspacesRoot: () => (mod as { workspacesRoot: () => string }).workspacesRoot(),
    })).not.toThrow();
  });

  it('anchors both release-authority reads to the operator-home workspace, not the snapshot workspace', async () => {
    const host = await configuredHost();

    await expect(host.readIntervalSnapshotAdmission('shared-hive-test-aviynw')).resolves.toEqual({
      status: 'admit',
    });
    expect(h.readQualificationAdmission).toHaveBeenCalledWith({ workspaceId: 'ws-test' });
    expect(h.readCheckpointSerializerAuthority).toHaveBeenCalledWith({ workspaceId: 'ws-test' });
  });

  it('defers an interval snapshot under a qualification hold', async () => {
    h.readQualificationAdmission.mockResolvedValue({
      status: 'held',
      hold: { governingRef: 'plan#D-001', blockingItems: ['WI-1'] },
    });
    const host = await configuredHost();

    await expect(host.readIntervalSnapshotAdmission('workspace-a')).resolves.toEqual({
      status: 'defer',
      reason: 'qualification-held',
      evidence: { governingRef: 'plan#D-001', blockingItems: ['WI-1'] },
    });
  });

  it('fails closed when serializer authority is unreadable', async () => {
    h.readCheckpointSerializerAuthority.mockResolvedValue({
      status: 'unreadable',
      error: 'authority store offline',
    });
    const host = await configuredHost();

    await expect(host.readIntervalSnapshotAdmission('workspace-a')).resolves.toEqual({
      status: 'defer',
      reason: 'checkpoint-serializer-unreadable',
      evidence: { error: 'authority store offline' },
    });
  });

  it('defers while the checkpoint serializer authority is held', async () => {
    h.readCheckpointSerializerAuthority.mockResolvedValue({
      status: 'held',
      itemId: 'WI-40086',
      ownerId: 'su-owner',
      pauseReason: 'pause',
      holdReason: 'hold',
    });
    const host = await configuredHost();

    await expect(host.readIntervalSnapshotAdmission('shared-hive-test-aviynw')).resolves.toEqual({
      status: 'defer',
      reason: 'checkpoint-serializer-held',
      evidence: { itemId: 'WI-40086', ownerId: 'su-owner' },
    });
    expect(h.readCheckpointSerializerAuthority).toHaveBeenCalledWith({ workspaceId: 'ws-test' });
  });

  it('uses one dedicated postgres session for the advisory lock and closes it on release', async () => {
    const host = await configuredHost();

    const lock = await host.acquireMigrationLock();
    expect(pg.postgres).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        max: 1,
        prepare: false,
        connection: { application_name: 'pcbackup-workspace' },
      }),
    );
    // WI-1194246: BOTH timeouts are reset before the acquisition. `statement_timeout`
    // also cancels a `pg_advisory_lock` wait, so resetting only `lock_timeout` would
    // leave this deliberately-unbounded rendezvous cancellable the moment a role-level
    // statement_timeout exists. Order matters only in that both precede the acquire.
    expect(pg.client).toHaveBeenCalledTimes(3);
    expect(String(pg.client.mock.calls[0]![0])).toContain('SET lock_timeout = 0');
    expect(String(pg.client.mock.calls[1]![0])).toContain('SET statement_timeout = 0');
    expect(String(pg.client.mock.calls[2]![0])).toContain('pg_advisory_lock');

    if (!lock) throw new Error('blocking advisory-lock acquisition unexpectedly returned no lock');
    await lock.release();
    expect(pg.client).toHaveBeenCalledTimes(4);
    expect(String(pg.client.mock.calls[3]![0])).toContain('pg_advisory_unlock');
    expect(pg.client.end).toHaveBeenCalledTimes(1);

    // The release handle is idempotent, so a defensive double-finally cannot
    // issue an unlock against a session that has already been closed.
    await lock.release();
    expect(pg.client).toHaveBeenCalledTimes(4);
    expect(pg.client.end).toHaveBeenCalledTimes(1);
  });

  it('returns no lock and closes the session when a try-only probe is busy', async () => {
    const host = await configuredHost();
    pg.client.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ acquired: false }]);

    await expect(host.acquireMigrationLock({ tryOnly: true })).resolves.toBeUndefined();
    expect(String(pg.client.mock.calls.at(-1)?.[0])).toContain('pg_try_advisory_lock');
    expect(pg.client.end).toHaveBeenCalled();
  });

  it('transfers a try-only lock when the probe succeeds', async () => {
    const host = await configuredHost();
    pg.client.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ acquired: true }]);

    const lock = await host.acquireMigrationLock({ tryOnly: true });
    expect(lock).toBeDefined();
    expect(String(pg.client.mock.calls.at(-1)?.[0])).toContain('pg_try_advisory_lock');

    await lock!.release();
    expect(String(pg.client.mock.calls.at(-1)?.[0])).toContain('pg_advisory_unlock');
    expect(pg.client.end).toHaveBeenCalled();
  });

  it('routes package lifecycle heartbeats through the named managed scheduler', async () => {
    const host = await configuredHost();
    const callback = vi.fn();

    host.scheduleInterval('backup-snapshot-heartbeat:workspace-a', 30_000, callback);

    expect(h.managedSetInterval).toHaveBeenCalledWith(
      'backup-snapshot-heartbeat:workspace-a',
      30_000,
      callback,
      { category: 'lifecycle', classification: 'must-sample' },
    );
  });
});
