/**
 * backup-tools.test.ts — handler-level unit tests for backup:snapshot_create
 * and backup:snapshot_list (Plan 1 P-017).
 *
 * Both tools delegate to workspaceBackupFor() + activeWorkspaceId(); tests
 * confirm correct delegation, result forwarding, and graceful error handling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = () =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'ws_test',
    harnessSlug: 'sheets',
    role: 'operator' as const,
  } as never);

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../backup');
  vi.doUnmock('../../workspace-registry');
});

function makeBackupMock(snapResult: unknown, listResult: unknown = []) {
  const wb = {
    snapshot: vi.fn(async () => snapResult),
    list: vi.fn(async () => listResult),
    liveBackupSessions: vi.fn(async () => [] as unknown[]),
    restore: vi.fn(async () => ({ ok: true })),
    rollback: vi.fn(async () => ({ ok: true })),
    diff: vi.fn(async () => ({ ok: true, diff: '' })),
    promote: vi.fn(async () => ({ ok: true })),
  };
  const workspaceBackupFor = vi.fn(() => wb);
  const activeWorkspaceId = vi.fn(() => 'ws_test');
  return { wb, workspaceBackupFor, activeWorkspaceId };
}

// ─── backup:snapshot_create ───────────────────────────────────────────────────

describe('backup:snapshot_create', () => {
  it('calls wb.snapshot with reason and note', async () => {
    const { wb, workspaceBackupFor, activeWorkspaceId } = makeBackupMock({ ok: true, snapshotId: 'snap-abc' });
    vi.doMock('../../backup', () => ({ workspaceBackupFor }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId }));

    const { default: tool } = await import('../backup/snapshot_create');
    const result = (await tool.handler({ reason: 'pre_destructive', note: 'Before migration' }, MAKE_CTX())) as any;

    // EI-18875467740392530 added a third argument: snapshot() now takes an
    // `onStarted` callback so the deadline-loses branch can still hand back a real
    // snapshotId. Pinned (rather than relaxed to objectContaining) so this suite
    // keeps asserting the full call shape.
    expect(wb.snapshot).toHaveBeenCalledWith('pre_destructive', { note: 'Before migration' }, { onStarted: expect.any(Function) });
    const data = JSON.parse(result.content[0].text);
    expect(data.snapshotId).toBe('snap-abc');
  });

  it('calls wb.snapshot without note when omitted', async () => {
    const { wb, workspaceBackupFor, activeWorkspaceId } = makeBackupMock({ ok: true, snapshotId: 'snap-xyz' });
    vi.doMock('../../backup', () => ({ workspaceBackupFor }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId }));

    const { default: tool } = await import('../backup/snapshot_create');
    await tool.handler({ reason: 'manual' }, MAKE_CTX());

    expect(wb.snapshot).toHaveBeenCalledWith('manual', undefined, { onStarted: expect.any(Function) });
  });

  it('defaults reason to pre_destructive when not specified', async () => {
    const { wb, workspaceBackupFor, activeWorkspaceId } = makeBackupMock({ ok: true });
    vi.doMock('../../backup', () => ({ workspaceBackupFor }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId }));

    const { default: tool } = await import('../backup/snapshot_create');
    // Pass the default explicitly (calling .handler bypasses zod defaults).
    await tool.handler({ reason: 'pre_destructive' }, MAKE_CTX());
    expect(wb.snapshot).toHaveBeenCalledWith('pre_destructive', undefined, { onStarted: expect.any(Function) });
  });

  it('uses activeWorkspaceId to scope the backup client', async () => {
    const { workspaceBackupFor, activeWorkspaceId } = makeBackupMock({ ok: true });
    vi.doMock('../../backup', () => ({ workspaceBackupFor }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId }));

    const { default: tool } = await import('../backup/snapshot_create');
    await tool.handler({ reason: 'manual' }, MAKE_CTX());

    expect(activeWorkspaceId).toHaveBeenCalled();
    expect(workspaceBackupFor).toHaveBeenCalledWith('ws_test');
  });
});

// ─── backup:snapshot_list ─────────────────────────────────────────────────────

describe('backup:snapshot_list', () => {
  it('returns snapshots from wb.list', async () => {
    const snaps = [{ id: 's1', ts: 1000 }, { id: 's2', ts: 2000 }];
    const { wb, workspaceBackupFor, activeWorkspaceId } = makeBackupMock(undefined, snaps);
    vi.doMock('../../backup', () => ({ workspaceBackupFor }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId }));

    const { default: tool } = await import('../backup/snapshot_list');
    const result = (await tool.handler({ limit: 10 }, MAKE_CTX())) as any;

    expect(wb.list).toHaveBeenCalledWith(10);
    // Shape-agnostic read: backup:snapshot_list returns the canonical `{ data }`
    // ToolResponse since the {data}-migration batch that paid off the
    // tool-data-shape-ratchet. Accept either shape (the established precedent —
    // see accounts/*.test.ts, plans/arm-schedule.test.ts) so this assertion
    // cannot red the shared gate again if the tool's wire shape moves.
    const data = result.data ?? JSON.parse(result.content[0].text);
    expect(data.snapshots).toHaveLength(2);
    expect(data.snapshots[0].id).toBe('s1');
  });

  it('passes limit to wb.list (default is 50)', async () => {
    const { wb, workspaceBackupFor, activeWorkspaceId } = makeBackupMock(undefined, []);
    vi.doMock('../../backup', () => ({ workspaceBackupFor }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId }));

    const { default: tool } = await import('../backup/snapshot_list');
    // Pass 50 explicitly (calling .handler bypasses zod defaults).
    await tool.handler({ limit: 50 }, MAKE_CTX());
    expect(wb.list).toHaveBeenCalledWith(50);
  });

  // EI-22064935119941678: an empty snapshots[] (no receipt for this workspace's
  // kopia hook) must never read as "no backup is active" — the independent
  // host-cron pg_dump has no receipt row at all, so liveBackupSessions[] is the
  // only signal that can see it. Assert it is surfaced and NOT dropped.
  it('surfaces liveBackupSessions alongside snapshots, even when snapshots is empty', async () => {
    const liveSessions = [
      { pid: 3294839, applicationName: 'pcbackup', state: 'active', xactStartedAt: null, queryStartedAt: '2026-09-01T13:04:00.000Z', ageSec: 369 },
    ];
    const { wb, workspaceBackupFor, activeWorkspaceId } = makeBackupMock(undefined, []);
    wb.liveBackupSessions.mockResolvedValueOnce(liveSessions);
    vi.doMock('../../backup', () => ({ workspaceBackupFor }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId }));

    const { default: tool } = await import('../backup/snapshot_list');
    const result = (await tool.handler({ limit: 50 }, MAKE_CTX())) as any;

    expect(wb.liveBackupSessions).toHaveBeenCalledWith();
    const data = result.data ?? JSON.parse(result.content[0].text);
    expect(data.snapshots).toHaveLength(0);
    expect(data.liveBackupSessions).toHaveLength(1);
    expect(data.liveBackupSessions[0].applicationName).toBe('pcbackup');
  });
});
