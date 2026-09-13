import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sweep: vi.fn(),
  activeWorkspaceId: vi.fn(() => 'ws-1'),
  workspacesRoot: vi.fn(() => '/workspaces'),
}));

vi.mock('../../backup', () => ({
  DEFAULT_RESTORED_CLONE_MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000,
  sweepRestoredClones: h.sweep,
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: h.activeWorkspaceId,
  workspacesRoot: h.workspacesRoot,
}));

import tool from './restore_clone_cleanup';

beforeEach(() => {
  vi.clearAllMocks();
  h.sweep.mockResolvedValue({
    candidates: [],
    removed: [],
    kept: [],
    protected: [],
    bytesFreed: 0,
    dryRun: true,
  });
});

describe('backup:restore_clone_cleanup', () => {
  it('defaults to a dry-run with the explicit 30-day policy', async () => {
    await tool.handler({} as never, {} as never);

    expect(h.sweep).toHaveBeenCalledWith('/workspaces', {
      maxAgeMs: 30 * 24 * 60 * 60 * 1000,
      dryRun: true,
    });
  });

  it('passes an explicit policy and destructive opt-in through', async () => {
    await tool.handler({ maxAgeDays: 90, dryRun: false } as never, {} as never);

    expect(h.sweep).toHaveBeenCalledWith('/workspaces', {
      maxAgeMs: 90 * 24 * 60 * 60 * 1000,
      dryRun: false,
    });
  });

  it('returns the proof-aware report with workspace context', async () => {
    h.sweep.mockResolvedValue({
      candidates: ['/workspaces/ws-1/.restored/s1/live'],
      removed: [],
      kept: ['/workspaces/ws-1/.restored/s1/active'],
      protected: [{ path: '/workspaces/ws-1/.restored/s1/active', reason: 'active-restore' }],
      bytesFreed: 0,
      dryRun: true,
    });

    const result = await tool.handler({} as never, {} as never) as { data: Record<string, unknown> };

    expect(result.data).toMatchObject({
      workspaceId: 'ws-1',
      maxAgeDays: 30,
      candidates: ['/workspaces/ws-1/.restored/s1/live'],
      protected: [{ reason: 'active-restore' }],
      dryRun: true,
    });
  });
});
