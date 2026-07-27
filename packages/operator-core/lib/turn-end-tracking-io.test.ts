/**
 * turn-end-tracking-io.test.ts — unit coverage for `checkpointOnRelease`
 * (EI-18734870651452334).
 *
 * Bug: a work-item claim released with NO agent-written checkpoint (compaction,
 * a dead-session force-release, the stale-claim reaper backstop) is
 * indistinguishable from never-started work — the next claimant can silently
 * rebuild an already-shipped feature. The P-015 turn-end sweep already
 * mechanically checkpoints STALE held items, but only at turn end; this closes
 * the gap at the RELEASE seam itself, which is where the actual loss happens.
 *
 * These tests exercise the function in isolation (deps mocked) — the wiring
 * into `releaseWorkItem` is fire-and-forget by design (never blocks/fails the
 * release), so it is proven here at the unit level rather than via a timing-
 * dependent integration assertion.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const getWorkItemCheckpointWithMeta = vi.fn();
const setWorkItemCheckpoint = vi.fn();
const toolCallRowsFor = vi.fn();
const renderToolCallLog = vi.fn();

vi.mock('./work-item-checkpoint', () => ({
  getWorkItemCheckpointWithMeta: (...a: unknown[]) => getWorkItemCheckpointWithMeta(...a),
  setWorkItemCheckpoint: (...a: unknown[]) => setWorkItemCheckpoint(...a),
}));
vi.mock('./tool-call-log-store', () => ({
  toolCallRowsFor: (...a: unknown[]) => toolCallRowsFor(...a),
}));
vi.mock('./tool-call-log', () => ({
  renderToolCallLog: (...a: unknown[]) => renderToolCallLog(...a),
}));

const { checkpointOnRelease } = await import('./turn-end-tracking-io');

const REF = { releasingOwnerId: 'su-holder-1', workspaceId: 'ws-1', harness: 'papercusp', workItemId: 'WI-1' };

afterEach(() => {
  vi.clearAllMocks();
});

describe('checkpointOnRelease (EI-18734870651452334)', () => {
  it('is a no-op when a real agent-written checkpoint already exists — never overwrites it', async () => {
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: 'I already wrote real progress here', updatedAtMs: Date.now() });

    const result = await checkpointOnRelease(REF);

    expect(result).toEqual({ written: false });
    expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
  });

  it('writes a mechanical checkpoint when the checkpoint is missing (null)', async () => {
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null });
    toolCallRowsFor.mockResolvedValue([{ tool: 'Edit' }]);
    renderToolCallLog.mockReturnValue('Edit x3, Bash x1');
    setWorkItemCheckpoint.mockResolvedValue('written');

    const result = await checkpointOnRelease(REF);

    expect(result).toEqual({ written: true });
    expect(setWorkItemCheckpoint).toHaveBeenCalledTimes(1);
    const [ref, block] = setWorkItemCheckpoint.mock.calls[0] as [typeof REF, string];
    expect(ref).toEqual({ harness: REF.harness, workItemId: REF.workItemId, workspaceId: REF.workspaceId });
    expect(block).toContain('auto-checkpoint mechanical');
    expect(block).toContain(REF.releasingOwnerId);
    expect(block).toContain('EI-18734870651452334');
    expect(block).toContain('Edit x3, Bash x1');
  });

  it('writes a mechanical checkpoint when the checkpoint is present but blank/whitespace', async () => {
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: '   ', updatedAtMs: Date.now() });
    toolCallRowsFor.mockResolvedValue([]);
    renderToolCallLog.mockReturnValue('');
    setWorkItemCheckpoint.mockResolvedValue('written');

    const result = await checkpointOnRelease(REF);

    expect(result).toEqual({ written: true });
    expect(setWorkItemCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('still writes the mechanical checkpoint (journal note alone) when the tool-log fetch throws', async () => {
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null });
    toolCallRowsFor.mockRejectedValue(new Error('ledger unavailable'));
    setWorkItemCheckpoint.mockResolvedValue('written');

    const result = await checkpointOnRelease(REF);

    expect(result).toEqual({ written: true });
    expect(setWorkItemCheckpoint).toHaveBeenCalledTimes(1);
    const [, block] = setWorkItemCheckpoint.mock.calls[0] as [typeof REF, string];
    expect(block).toContain('EI-18734870651452334');
  });

  it('fails soft (never throws, returns written:false) when reading the existing checkpoint throws', async () => {
    getWorkItemCheckpointWithMeta.mockRejectedValue(new Error('db down'));

    const result = await checkpointOnRelease(REF);

    expect(result).toEqual({ written: false });
    expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
  });

  it('fails soft (never throws, returns written:false) when the checkpoint write itself throws', async () => {
    getWorkItemCheckpointWithMeta.mockResolvedValue({ checkpoint: null, updatedAtMs: null });
    toolCallRowsFor.mockResolvedValue([]);
    renderToolCallLog.mockReturnValue('');
    setWorkItemCheckpoint.mockRejectedValue(new Error('write failed'));

    const result = await checkpointOnRelease(REF);

    expect(result).toEqual({ written: false });
  });
});
