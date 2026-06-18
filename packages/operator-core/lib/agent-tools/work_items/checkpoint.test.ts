/**
 * Unit tests for work_items:checkpoint (bee-context-efficiency P-010·P-011·P-012).
 * The store (setWorkItemCheckpoint) + getWorkItem are mocked — this exercises the
 * tool's contract: harness resolution (arg → ctx.harnessSlug → work-item lookup),
 * write-vs-clear, and clean error surfacing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const setWorkItemCheckpoint = vi.fn();
const getWorkItem = vi.fn();
vi.mock('../../work-item-checkpoint', () => ({
  setWorkItemCheckpoint: (...a: unknown[]) => setWorkItemCheckpoint(...a),
}));
vi.mock('../../work-items', () => ({
  getWorkItem: (...a: unknown[]) => getWorkItem(...a),
}));

import checkpoint from './checkpoint';

const baseCtx = { uiClientId: 'opspawn-bee-1', sigVerifiedSpawn: true, workspaceId: 'default', harnessSlug: 'papercup' } as never;
const noHarnessCtx = { uiClientId: 'opspawn-bee-1', sigVerifiedSpawn: true, workspaceId: 'default' };
const parse = (x: unknown) => (checkpoint.args as { parse: (x: unknown) => unknown }).parse(x);
const call = async (x: unknown, ctx: unknown = baseCtx) => {
  const res = await checkpoint.handler(parse(x) as never, ctx as never);
  return JSON.parse((res.content[0] as { text: string }).text);
};

beforeEach(() => {
  setWorkItemCheckpoint.mockReset();
  getWorkItem.mockReset();
});

describe('work_items:checkpoint', () => {
  it('writes a checkpoint with the harness from ctx (no lookup)', async () => {
    setWorkItemCheckpoint.mockResolvedValue('did step 1; next: step 2');
    const out = await call({ id: 'WI-7', checkpoint: 'did step 1; next: step 2' });
    expect(getWorkItem).not.toHaveBeenCalled();
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      { harness: 'papercup', workItemId: 'WI-7', workspaceId: 'default' },
      'did step 1; next: step 2',
    );
    expect(out).toMatchObject({ ok: true, workItemId: 'WI-7', harness: 'papercup', cleared: false });
    expect(out.length).toBeGreaterThan(0);
  });

  it('clears the checkpoint when blank/omitted (cleared:true)', async () => {
    setWorkItemCheckpoint.mockResolvedValue(null);
    const out = await call({ id: 'WI-7' });
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      { harness: 'papercup', workItemId: 'WI-7', workspaceId: 'default' },
      undefined,
    );
    expect(out).toMatchObject({ ok: true, cleared: true, length: 0 });
  });

  it('falls back to an explicit harness arg over ctx', async () => {
    setWorkItemCheckpoint.mockResolvedValue('x');
    await call({ id: 'WI-7', checkpoint: 'x', harness: 'other-harness' });
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'other-harness' }),
      'x',
    );
  });

  it('resolves the harness via a work-item lookup when neither arg nor ctx has one', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-9', harness: 'looked-up' });
    setWorkItemCheckpoint.mockResolvedValue('y');
    const out = await call({ id: 'WI-9', checkpoint: 'y' }, noHarnessCtx);
    expect(getWorkItem).toHaveBeenCalledWith('WI-9');
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'looked-up' }),
      'y',
    );
    expect(out.ok).toBe(true);
  });

  it('errors cleanly when no harness can be resolved', async () => {
    getWorkItem.mockResolvedValue(null);
    const out = await call({ id: 'WI-404', checkpoint: 'z' }, noHarnessCtx);
    expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
    expect(out.ok).toBe(false);
    expect(out.error).toContain('could not resolve a harness');
  });

  it('surfaces a store error cleanly', async () => {
    setWorkItemCheckpoint.mockRejectedValue(new Error('pg down'));
    const out = await call({ id: 'WI-7', checkpoint: 'x' });
    expect(out).toEqual({ ok: false, error: 'pg down' });
  });
});
