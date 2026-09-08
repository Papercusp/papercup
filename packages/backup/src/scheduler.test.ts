import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  intervalRows: [] as Array<{
    workspace_id: string;
    cadence_minutes: number;
    last_started_at: Date | string | null;
  }>,
  acquireMigrationLock: vi.fn(),
  useMigrationLock: false,
  readIntervalSnapshotAdmission: vi.fn(),
  sql: vi.fn(),
}));

const getSettings = vi.fn();
const snapshot = vi.fn();

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: 'kopia 1.0.0', stderr: '' })),
}));

vi.mock('./config', () => ({
  backupHost: () => ({
    getSql: () => h.sql,
    // Keep the legacy no-host-lock fixture behavior for cadence tests that
    // exercise scheduler admission independently. Lock-specific cases opt in
    // explicitly so an undefined probe result retains its real "busy" meaning.
    acquireMigrationLock: h.useMigrationLock ? h.acquireMigrationLock : undefined,
    readIntervalSnapshotAdmission: h.readIntervalSnapshotAdmission,
  }),
}));

vi.mock('./singleton', () => ({
  workspaceBackupFor: () => ({ getSettings, snapshot }),
}));

import { runBackupSchedulerTick, triggerSnapshotEvent } from './scheduler';

function settings(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    cadenceMode: 'event',
    eventTriggers: ['pre_destructive', 'startup'],
    ...overrides,
  };
}

describe('triggerSnapshotEvent cadence admission', () => {
  beforeEach(() => {
    getSettings.mockReset();
    snapshot.mockReset();
    h.intervalRows = [];
    h.useMigrationLock = false;
    h.acquireMigrationLock.mockReset().mockResolvedValue(undefined);
    h.readIntervalSnapshotAdmission.mockReset().mockResolvedValue({ status: 'admit' });
    h.sql.mockReset().mockImplementation(async (strings: TemplateStringsArray) => {
      const statement = strings.join(' ');
      if (statement.includes('SELECT s.workspace_id')) return h.intervalRows;
      if (statement.includes('INSERT INTO harness_shared.backup_events')) return [];
      throw new Error(`unexpected SQL: ${statement}`);
    });
  });

  it('does not run lifecycle events in interval-only mode', async () => {
    getSettings.mockResolvedValue(settings({ cadenceMode: 'interval' }));

    await triggerSnapshotEvent('interval-only', 'pre_destructive');
    await triggerSnapshotEvent('interval-only-startup', 'startup');

    expect(snapshot).not.toHaveBeenCalled();
  });

  it('runs an opted-in lifecycle event in event mode', async () => {
    getSettings.mockResolvedValue(settings());

    await triggerSnapshotEvent('event-only', 'pre_destructive', { source: 'test' });

    expect(snapshot).toHaveBeenCalledWith('pre_destructive', { source: 'test' });
    expect(h.readIntervalSnapshotAdmission).not.toHaveBeenCalled();
  });

  it('does not run an event omitted from the trigger list', async () => {
    getSettings.mockResolvedValue(settings({ cadenceMode: 'both', eventTriggers: [] }));

    await triggerSnapshotEvent('both-without-trigger', 'pre_destructive');

    expect(snapshot).not.toHaveBeenCalled();
  });
});

describe('interval snapshot admission rendezvous', () => {
  beforeEach(() => {
    getSettings.mockReset().mockResolvedValue(settings({ cadenceMode: 'interval' }));
    snapshot.mockReset().mockResolvedValue({ snapshotId: 1 });
    h.useMigrationLock = false;
    h.acquireMigrationLock.mockReset().mockResolvedValue(undefined);
    h.intervalRows = [{
      workspace_id: 'interval-admission-ws',
      cadence_minutes: 60,
      last_started_at: null,
    }];
    h.readIntervalSnapshotAdmission.mockReset().mockResolvedValue({ status: 'admit' });
    h.sql.mockReset().mockImplementation(async (strings: TemplateStringsArray) => {
      const statement = strings.join(' ');
      if (statement.includes('SELECT s.workspace_id')) return h.intervalRows;
      if (statement.includes('INSERT INTO harness_shared.backup_events')) return [];
      throw new Error(`unexpected SQL: ${statement}`);
    });
  });

  it('defers before consuming cadence state, records why, and retries after clear', async () => {
    h.readIntervalSnapshotAdmission
      .mockResolvedValueOnce({
        status: 'defer',
        reason: 'qualification-held',
        evidence: { governingRef: 'plan#D-001' },
      })
      .mockResolvedValueOnce({ status: 'admit' });

    await runBackupSchedulerTick();

    expect(snapshot).not.toHaveBeenCalled();
    const eventCall = h.sql.mock.calls.find(([strings]) =>
      (strings as TemplateStringsArray).join(' ').includes('INSERT INTO harness_shared.backup_events'));
    expect(eventCall).toBeDefined();
    expect(eventCall).toEqual(expect.arrayContaining([
      'interval-admission-ws',
      expect.stringContaining('qualification-held'),
    ]));

    await runBackupSchedulerTick();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledWith('interval', undefined));
    expect(h.readIntervalSnapshotAdmission).toHaveBeenCalledTimes(2);
  });

  it('fails closed and records an unreadable host admission without firing', async () => {
    h.intervalRows = [{
      workspace_id: 'interval-admission-unreadable-ws',
      cadence_minutes: 60,
      last_started_at: null,
    }];
    h.readIntervalSnapshotAdmission.mockRejectedValue(new Error('authority store offline'));

    await runBackupSchedulerTick();

    expect(snapshot).not.toHaveBeenCalled();
    const eventCall = h.sql.mock.calls.find(([strings]) =>
      (strings as TemplateStringsArray).join(' ').includes('INSERT INTO harness_shared.backup_events'));
    expect(eventCall).toEqual(expect.arrayContaining([
      'interval-admission-unreadable-ws',
      expect.stringContaining('interval-admission-unreadable'),
    ]));
  });

  it('defers a due interval while the cross-process migration rendezvous is busy', async () => {
    h.intervalRows = [{
      workspace_id: 'interval-lock-busy-ws',
      cadence_minutes: 60,
      last_started_at: null,
    }];
    h.useMigrationLock = true;
    h.acquireMigrationLock.mockResolvedValueOnce(undefined);

    await runBackupSchedulerTick();

    expect(h.acquireMigrationLock).toHaveBeenCalledWith({ tryOnly: true });
    expect(snapshot).not.toHaveBeenCalled();
    const eventCall = h.sql.mock.calls.find(([strings]) =>
      (strings as TemplateStringsArray).join(' ').includes('INSERT INTO harness_shared.backup_events'));
    expect(eventCall).toEqual(expect.arrayContaining([
      'interval-lock-busy-ws',
      expect.stringContaining('migration-rendezvous-busy'),
    ]));

    // The busy probe must leave cadence state untouched so the next tick can
    // retry the same due interval after the other process releases the lock.
    const lock = { release: vi.fn(async () => {}) };
    h.acquireMigrationLock.mockResolvedValueOnce(lock);
    await runBackupSchedulerTick();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledWith(
      'interval',
      undefined,
      { migrationLock: lock },
    ));
  });

  it('transfers an admitted lock to the snapshot and releases it if settings changed', async () => {
    h.intervalRows = [{
      workspace_id: 'interval-settings-changed-ws',
      cadence_minutes: 60,
      last_started_at: null,
    }];
    const lock = { release: vi.fn(async () => {}) };
    h.useMigrationLock = true;
    h.acquireMigrationLock.mockResolvedValueOnce(lock);
    getSettings.mockResolvedValueOnce({ enabled: false });

    await runBackupSchedulerTick();

    expect(snapshot).not.toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it('does not settle until the admitted snapshot completes', async () => {
    h.intervalRows = [{
      workspace_id: 'interval-await-ws',
      cadence_minutes: 60,
      last_started_at: null,
    }];
    let releaseSnapshot!: () => void;
    const snapshotFinished = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    snapshot.mockReturnValueOnce(snapshotFinished);

    let settled = false;
    const tick = runBackupSchedulerTick().then(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(snapshot).toHaveBeenCalledWith('interval', undefined);
    });
    expect(settled).toBe(false);

    releaseSnapshot();
    await tick;
    expect(settled).toBe(true);
  });
});
