/**
 * session-compacted-events.test — the completed-/compact signal, pure (injected emit)
 * (event-await-discoverability-and-coverage-2026-07-03 P-103).
 */
import { describe, expect, it, vi } from 'vitest';
import { emitSessionCompactedEvent } from './session-compacted-events';

type EmitOpts = { key: string; summary?: string; payload?: unknown; to?: string[]; source?: string };
const typedEmit = () =>
  vi.fn(async (_opts: EmitOpts) => ({ ok: true as const, key: '', woken: 0, notified: [] as string[], msgId: null }));

describe('emitSessionCompactedEvent (P-103)', () => {
  it('fires session:compacted:<owner> with the owner in both key and payload', async () => {
    const emit = typedEmit();
    emitSessionCompactedEvent('su-94b69', undefined, { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledTimes(1);
    const call = emit.mock.calls[0][0];
    expect(call.key).toBe('session:compacted:su-94b69');
    expect(call).toMatchObject({ source: 'session', payload: { owner: 'su-94b69', detail: null } });
    expect(call.summary).toContain('su-94b69');
  });

  it('rides the focus in the summary + payload when supplied', async () => {
    const emit = typedEmit();
    emitSessionCompactedEvent('su-cd47dc54', 'keep identity + plan Now', { emit });
    await new Promise((r) => setTimeout(r, 0));
    const call = emit.mock.calls[0][0];
    expect(call.summary).toContain('keep identity + plan Now');
    expect(call).toMatchObject({ payload: { owner: 'su-cd47dc54', detail: 'keep identity + plan Now' } });
  });

  it('is an awaiter-only signal — no `to` push', async () => {
    const emit = typedEmit();
    emitSessionCompactedEvent('su-1', undefined, { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit.mock.calls[0][0].to).toBeUndefined();
  });

  it('never rejects on an emit failure (warns; the resume turn must never break)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn(async () => {
      throw new Error('engine down');
    });
    expect(() => emitSessionCompactedEvent('su-2', undefined, { emit: emit as never })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('compacted-event for su-2'));
    warn.mockRestore();
  });

  it('swallows expected teardown noise WITHOUT warning (CONNECTION_ENDED / partial schema)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn(async () => {
      throw Object.assign(new Error('write CONNECTION_ENDED'), { code: 'CONNECTION_ENDED' });
    });
    expect(() => emitSessionCompactedEvent('su-3', undefined, { emit: emit as never })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
