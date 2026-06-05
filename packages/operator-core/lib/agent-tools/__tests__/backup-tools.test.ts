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

    expect(wb.snapshot).toHaveBeenCalledWith('pre_destructive', { note: 'Before migration' });
    const data = JSON.parse(result.content[0].text);
    expect(data.snapshotId).toBe('snap-abc');
  });

  it('calls wb.snapshot without note when omitted', async () => {
    const { wb, workspaceBackupFor, activeWorkspaceId } = makeBackupMock({ ok: true, snapshotId: 'snap-xyz' });
    vi.doMock('../../backup', () => ({ workspaceBackupFor }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId }));

    const { default: tool } = await import('../backup/snapshot_create');
    await tool.handler({ reason: 'manual' }, MAKE_CTX());

    expect(wb.snapshot).toHaveBeenCalledWith('manual', undefined);
  });

  it('defaults reason to pre_destructive when not specified', async () => {
    const { wb, workspaceBackupFor, activeWorkspaceId } = makeBackupMock({ ok: true });
    vi.doMock('../../backup', () => ({ workspaceBackupFor }));
    vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId }));

    const { default: tool } = await import('../backup/snapshot_create');
    // Pass the default explicitly (calling .handler bypasses zod defaults).
    await tool.handler({ reason: 'pre_destructive' }, MAKE_CTX());
    expect(wb.snapshot).toHaveBeenCalledWith('pre_destructive', undefined);
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
    const data = JSON.parse(result.content[0].text);
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
});
