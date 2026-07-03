/**
 * plan-item-events.test.ts — the plan-item done signal, pure (injected emit)
 * (event-await-discoverability-and-coverage-2026-07-03 P-105).
 */
import { describe, expect, it, vi } from 'vitest';
import { emitPlanItemDoneEvent } from './plan-item-events';

type EmitOpts = { key: string; summary?: string; payload?: unknown; to?: string[]; source?: string };
const typedEmit = () =>
  vi.fn(async (_opts: EmitOpts) => ({ ok: true as const, key: '', woken: 0, notified: [] as string[], msgId: null }));

describe('emitPlanItemDoneEvent (P-105)', () => {
  it('fires plan-item:done:<slug>:<id> with the (slug,id) in both key and payload', async () => {
    const emit = typedEmit();
    emitPlanItemDoneEvent('my-plan', 'P-014', { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledTimes(1);
    const call = emit.mock.calls[0][0];
    expect(call.key).toBe('plan-item:done:my-plan:P-014');
    expect(call).toMatchObject({ source: 'plans', payload: { slug: 'my-plan', itemId: 'P-014' } });
    expect(call.summary).toContain('P-014');
  });

  it('is an awaiter-only signal — no `to` push', async () => {
    const emit = typedEmit();
    emitPlanItemDoneEvent('p', 'P-001', { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit.mock.calls[0][0].to).toBeUndefined();
  });

  it('never rejects on an emit failure (warns; the status flip must never break)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn(async () => {
      throw new Error('engine down');
    });
    expect(() => emitPlanItemDoneEvent('p', 'P-002', { emit: emit as never })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('done-event for p#P-002'));
    warn.mockRestore();
  });

  it('swallows expected teardown noise WITHOUT warning (CONNECTION_ENDED / partial schema)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn(async () => {
      throw Object.assign(new Error('write CONNECTION_ENDED'), { code: 'CONNECTION_ENDED' });
    });
    expect(() => emitPlanItemDoneEvent('p', 'P-003', { emit: emit as never })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
