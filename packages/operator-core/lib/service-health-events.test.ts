/**
 * service-health-events.test.ts — the service up/down transition signal, pure
 * (injected emit) (event-await-discoverability-and-coverage-2026-07-03 P-104).
 */
import { describe, expect, it, vi } from 'vitest';
import { emitServiceHealthTransitionEvent } from './service-health-events';

type EmitOpts = { key: string; summary?: string; payload?: unknown; to?: string[]; source?: string };
const typedEmit = () =>
  vi.fn(async (_opts: EmitOpts) => ({ ok: true as const, key: '', woken: 0, notified: [] as string[], msgId: null, waiters: 0 }));

describe('emitServiceHealthTransitionEvent (P-104)', () => {
  it('fires service:down:<name> with payload + detail in the summary', async () => {
    const emit = typedEmit();
    emitServiceHealthTransitionEvent('substrate-sidecar', 'down', 'healthz timeout', { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledTimes(1);
    const call = emit.mock.calls[0][0];
    expect(call.key).toBe('service:down:substrate-sidecar');
    expect(call.summary).toContain('DOWN');
    expect(call.summary).toContain('healthz timeout');
    expect(call).toMatchObject({
      source: 'service-health',
      payload: expect.objectContaining({ name: 'substrate-sidecar', to: 'down', detail: 'healthz timeout' }),
    });
  });

  it('fires service:up:<name> on recovery (no detail ⇒ clean summary + null payload detail)', async () => {
    const emit = typedEmit();
    emitServiceHealthTransitionEvent('operator', 'up', undefined, { emit });
    await new Promise((r) => setTimeout(r, 0));
    const call = emit.mock.calls[0][0];
    expect(call.key).toBe('service:up:operator');
    expect(call.summary).toBe('service "operator" recovered');
    expect(call).toMatchObject({ payload: expect.objectContaining({ name: 'operator', to: 'up', detail: null }) });
  });

  it('is an awaiter-only signal — no `to` push (audience is whoever awaited that service)', async () => {
    const emit = typedEmit();
    emitServiceHealthTransitionEvent('vite', 'down', undefined, { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit.mock.calls[0][0].to).toBeUndefined();
  });

  it('never rejects on an emit failure (warns; the health sweep must never break)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn(async () => {
      throw new Error('engine down');
    });
    expect(() => emitServiceHealthTransitionEvent('scout', 'down', undefined, { emit: emit as never })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('down-event for scout'));
    warn.mockRestore();
  });

  it('swallows expected teardown noise WITHOUT warning (CONNECTION_ENDED / partial schema)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn(async () => {
      throw Object.assign(new Error('write CONNECTION_ENDED'), { code: 'CONNECTION_ENDED' });
    });
    expect(() => emitServiceHealthTransitionEvent('operator', 'up', undefined, { emit: emit as never })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
