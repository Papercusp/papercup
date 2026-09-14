import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  workspaceRoot: '/workspace/ws',
  restoreToClone: vi.fn(),
}));

vi.mock('../../backup', () => ({ workspaceBackupFor: vi.fn(() => h) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-1') }));
vi.mock('../../backup/durable-ops', () => ({ durableRestoreInPlace: vi.fn() }));

const { restoreCloneTarget, restoreCloneWithDeadline, RESTORE_CLONE_DEADLINE_MS } = await import('./restore-clone');
const tool = (await import('./restore')).default;

type Out = { content: { text: string }[] };
const body = (out: Out) => JSON.parse(out.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('backup:restore clone continuation', () => {
  it('derives the same deterministic clone target as WorkspaceBackup', () => {
    expect(restoreCloneTarget(h, { kopiaSnapshotId: 'snap-1', source: '/source tree' }))
      .toBe('/workspace/ws/.restored/snap-1/source_tree');
    expect(restoreCloneTarget(h, { kopiaSnapshotId: 'snap-1', target: '/explicit/clone' }))
      .toBe('/explicit/clone');
  });

  it('passes the target before starting the restore and returns its result', async () => {
    h.restoreToClone.mockResolvedValue({ targetPath: '/workspace/ws/.restored/snap-1/workspace_ws' });

    const result = await restoreCloneWithDeadline(h, { kopiaSnapshotId: 'snap-1', mode: 'clone' });

    expect(h.restoreToClone).toHaveBeenCalledWith({
      kopiaSnapshotId: 'snap-1',
      mode: 'clone',
      target: '/workspace/ws/.restored/snap-1/workspace_ws',
    });
    expect(result).toEqual({ targetPath: '/workspace/ws/.restored/snap-1/workspace_ws' });
  });

  it('returns a continuation at the deadline and observes a late rejection', async () => {
    vi.useFakeTimers();
    let rejectRestore!: (error: Error) => void;
    h.restoreToClone.mockReturnValue(new Promise((_resolve, reject) => { rejectRestore = reject; }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const resultPromise = restoreCloneWithDeadline(h, { kopiaSnapshotId: 'snap-slow' });
    await vi.advanceTimersByTimeAsync(RESTORE_CLONE_DEADLINE_MS);

    await expect(resultPromise).resolves.toMatchObject({
      stillRunning: true,
      targetPath: '/workspace/ws/.restored/snap-slow/workspace_ws',
      note: expect.stringContaining('backup:restore'),
    });

    rejectRestore(new Error('late Kopia failure'));
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('background clone restore'),
      expect.objectContaining({ message: 'late Kopia failure' }),
    );
    warn.mockRestore();
  });

  it('uses the bounded clone helper from the MCP handler and skips the ambient transaction', async () => {
    h.restoreToClone.mockResolvedValue({ targetPath: '/workspace/ws/.restored/snap-2/workspace_ws' });

    const out = await tool.handler({ kopiaSnapshotId: 'snap-2', mode: 'clone' } as never, {} as never) as Out;

    expect(body(out)).toEqual({ targetPath: '/workspace/ws/.restored/snap-2/workspace_ws' });
    expect((tool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});
