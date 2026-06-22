/**
 * Unit tests for work_items:checkpoint (bee-context-efficiency P-010·P-011·P-012),
 * now on the bulk keyed-array contract (bulk-endpoint-standardization-2026-06-21).
 * The store (setWorkItemCheckpoint) + getWorkItem are mocked — this exercises the
 * tool's contract: per-item harness resolution (arg → ctx.harnessSlug → work-item
 * lookup), write-vs-clear, the many form, and clean per-item error surfacing.
 *
 * The single { id } call is now n=1 of the bulk call: it returns the house envelope
 * { ok, results:[{ ok, id, … | error }], counts } — assertions read results[0], not
 * the top level.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const setWorkItemCheckpoint = vi.fn();
const getWorkItem = vi.fn();
vi.mock('../../work-item-checkpoint', () => ({
  setWorkItemCheckpoint: (...a: unknown[]) => setWorkItemCheckpoint(...a),
}));
vi.mock('../../work-items', () => ({
  getWorkItem: (...a: unknown[]) => getWorkItem(...a),
  // checkpoint.ts fire-and-forgets markFeatureProgress (last_progress_at bump); the
  // mock must export it or the `void markFeatureProgress(...)` call throws (undefined)
  // and the handler returns ok:false (agent-activity-liveness-truth integration).
  markFeatureProgress: () => Promise.resolve(true),
}));

import checkpoint from './checkpoint';

const baseCtx = { uiClientId: 'opspawn-bee-1', sigVerifiedSpawn: true, workspaceId: 'default', harnessSlug: 'papercup' } as never;
const noHarnessCtx = { uiClientId: 'opspawn-bee-1', sigVerifiedSpawn: true, workspaceId: 'default' };
const parse = (x: unknown) => (checkpoint.args as { parse: (x: unknown) => unknown }).parse(x);
type Out = { data: any };
/** Parse the full bulk envelope. */
const env = async (x: unknown, ctx: unknown = baseCtx) => {
  const res = (await checkpoint.handler(parse(x) as never, ctx as never)) as Out;
  return (res.data);
};
/** The single-call result is n=1 of the bulk envelope — read results[0]. */
const one = async (x: unknown, ctx: unknown = baseCtx) => (await env(x, ctx)).results[0];

beforeEach(() => {
  setWorkItemCheckpoint.mockReset();
  getWorkItem.mockReset();
});

describe('work_items:checkpoint (bulk keyed-array)', () => {
  it('writes a checkpoint with the harness from ctx (no lookup)', async () => {
    setWorkItemCheckpoint.mockResolvedValue('did step 1; next: step 2');
    const out = await env({ id: 'WI-7', checkpoint: 'did step 1; next: step 2' });
    expect(out).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(getWorkItem).not.toHaveBeenCalled();
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      { harness: 'papercup', workItemId: 'WI-7', workspaceId: 'default' },
      'did step 1; next: step 2',
    );
    expect(out.results[0]).toMatchObject({ ok: true, id: 'WI-7', harness: 'papercup', cleared: false });
    expect(out.results[0].length).toBeGreaterThan(0);
  });

  it('clears the checkpoint when blank/omitted (cleared:true)', async () => {
    setWorkItemCheckpoint.mockResolvedValue(null);
    const r = await one({ id: 'WI-7' });
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      { harness: 'papercup', workItemId: 'WI-7', workspaceId: 'default' },
      undefined,
    );
    expect(r).toMatchObject({ ok: true, id: 'WI-7', cleared: true, length: 0 });
  });

  it('falls back to an explicit harness arg over ctx', async () => {
    setWorkItemCheckpoint.mockResolvedValue('x');
    await one({ id: 'WI-7', checkpoint: 'x', harness: 'other-harness' });
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'other-harness' }),
      'x',
    );
  });

  it('resolves the harness via a work-item lookup when neither arg nor ctx has one', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-9', harness: 'looked-up' });
    setWorkItemCheckpoint.mockResolvedValue('y');
    const r = await one({ id: 'WI-9', checkpoint: 'y' }, noHarnessCtx);
    expect(getWorkItem).toHaveBeenCalledWith('WI-9');
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'looked-up' }),
      'y',
    );
    expect(r.ok).toBe(true);
  });

  it('errors cleanly when no harness can be resolved (fails only that item)', async () => {
    getWorkItem.mockResolvedValue(null);
    const r = await one({ id: 'WI-404', checkpoint: 'z' }, noHarnessCtx);
    expect(setWorkItemCheckpoint).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.id).toBe('WI-404');
    expect(r.error).toContain('could not resolve a harness');
  });

  it('surfaces a store error cleanly via runBulk keyOf (batch survives)', async () => {
    setWorkItemCheckpoint.mockRejectedValue(new Error('pg down'));
    const r = await one({ id: 'WI-7', checkpoint: 'x' });
    expect(r).toEqual({ ok: false, id: 'WI-7', error: 'pg down' });
  });

  it('items:[…] checkpoints many; per-item harness overrides; one bad item fails only itself', async () => {
    // WI-A: ctx harness (papercup), writes. WI-B: per-item harness 'web'. WI-C: no harness anywhere → fails.
    setWorkItemCheckpoint.mockImplementation(async (key: { workItemId: string }) =>
      key.workItemId === 'WI-A' ? 'snap-a' : 'snap-b',
    );
    getWorkItem.mockResolvedValue(null); // WI-C lookup misses
    const out = await env(
      { items: [{ id: 'WI-A', checkpoint: 'a' }, { id: 'WI-B', checkpoint: 'b', harness: 'web' }, { id: 'WI-C', checkpoint: 'c' }] },
      noHarnessCtx, // no ctx harness → WI-A & WI-B rely on per-item/none, WI-C unresolvable
    );
    // WI-A has no per-item harness and noHarnessCtx → also unresolvable; WI-B resolves via 'web'.
    expect(out.ok).toBe(true);
    expect(out.results.map((r: { id: string; ok: boolean }) => [r.id, r.ok])).toEqual([
      ['WI-A', false],
      ['WI-B', true],
      ['WI-C', false],
    ]);
    expect(setWorkItemCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ harness: 'web', workItemId: 'WI-B' }), 'b');
    expect(out.counts).toEqual({ ok: 1, failed: 2 });
  });

  it('items:[…] with a batch harness default applies to items that omit one', async () => {
    setWorkItemCheckpoint.mockResolvedValue('s');
    const out = await env({ harness: 'def', items: [{ id: 'WI-1', checkpoint: 'a' }, { id: 'WI-2', checkpoint: 'b', harness: 'web' }] }, noHarnessCtx);
    expect(out.counts).toEqual({ ok: 2, failed: 0 });
    expect(setWorkItemCheckpoint).toHaveBeenNthCalledWith(1, expect.objectContaining({ harness: 'def', workItemId: 'WI-1' }), 'a');
    expect(setWorkItemCheckpoint).toHaveBeenNthCalledWith(2, expect.objectContaining({ harness: 'web', workItemId: 'WI-2' }), 'b');
  });
});
