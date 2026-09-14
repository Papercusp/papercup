/**
 * tools:invoke must forward an outer `payloadTier` into the target's args.
 *
 * `tools:invoke` re-dispatches with `args.args` alone, so a framework-reserved
 * control left on the OUTER call never reaches the target tool. `projection` is
 * already rescued from that by forwardToolsInvokeProjection; `payloadTier` was
 * not, so the same outer position behaved oppositely for the two controls and a
 * caller asking for full detail silently got a trimmed read with ok:true.
 * EI-21245922047633177.
 *
 * The negative cases matter as much as the positive one: this helper runs on the
 * path of every MCP tool call, so "does nothing unless it is a tools:invoke
 * carrying an outer tier" is the property that keeps its blast radius at zero.
 */
import { describe, it, expect } from 'vitest';

import { forwardToolsInvokePayloadTier } from './_mcp-host';

describe('forwardToolsInvokePayloadTier', () => {
  it('forwards an outer payloadTier into the target args', () => {
    const out = forwardToolsInvokePayloadTier('tools:invoke', {
      name: 'work_items:get',
      args: { id: 'EI-1', harness: 'papercusp' },
      payloadTier: 'full',
    }) as Record<string, unknown>;

    expect(out.args).toEqual({ id: 'EI-1', harness: 'papercusp', payloadTier: 'full' });
  });

  it('keeps the outer copy in place (it shapes the wrapper result and is read downstream)', () => {
    const out = forwardToolsInvokePayloadTier('tools:invoke', {
      name: 'work_items:get',
      args: { id: 'EI-1' },
      payloadTier: 'full',
    }) as Record<string, unknown>;

    expect(out.payloadTier).toBe('full');
  });

  it('materialises args when the caller omitted them entirely', () => {
    const out = forwardToolsInvokePayloadTier('tools:invoke', {
      name: 'coord:orient',
      payloadTier: 'full',
    }) as Record<string, unknown>;

    expect(out.args).toEqual({ payloadTier: 'full' });
  });

  it('forwards into JSON-stringified target args at the pre-validation boundary', () => {
    const out = forwardToolsInvokePayloadTier('tools:invoke', {
      name: 'work_items:get',
      args: JSON.stringify({ id: 'EI-1', harness: 'papercusp' }),
      payloadTier: 'full',
    }) as Record<string, unknown>;

    expect(out.args).toEqual({ id: 'EI-1', harness: 'papercusp', payloadTier: 'full' });
  });

  it('does NOT overwrite an explicitly nested payloadTier — the caller was specific about the target', () => {
    const input = {
      name: 'work_items:get',
      args: { id: 'EI-1', payloadTier: 'summary' },
      payloadTier: 'full',
    };
    const out = forwardToolsInvokePayloadTier('tools:invoke', input) as Record<string, unknown>;

    expect(out.args).toEqual({ id: 'EI-1', payloadTier: 'summary' });
    expect(out).toBe(input); // untouched, not a rebuilt copy
  });

  // --- guards: the helper sits on every MCP call, so it must be inert elsewhere ---

  it('is inert for a tool that is not tools:invoke', () => {
    const input = { id: 'EI-1', payloadTier: 'full' };
    const out = forwardToolsInvokePayloadTier('work_items:get', input);

    expect(out).toBe(input);
  });

  it('is inert when no outer payloadTier was supplied', () => {
    const input = { name: 'work_items:get', args: { id: 'EI-1' } };
    const out = forwardToolsInvokePayloadTier('tools:invoke', input);

    expect(out).toBe(input);
  });

  it('is inert for a non-object args value rather than clobbering it', () => {
    const input = { name: 'work_items:get', args: 'not-an-object', payloadTier: 'full' };
    const out = forwardToolsInvokePayloadTier('tools:invoke', input);

    expect(out).toBe(input);
  });

  it('is inert for a null or non-object dispatchArgs', () => {
    expect(forwardToolsInvokePayloadTier('tools:invoke', null)).toBeNull();
    expect(forwardToolsInvokePayloadTier('tools:invoke', 'nope')).toBe('nope');
  });

  it('does not mutate the caller-supplied object when it does forward', () => {
    const input = {
      name: 'work_items:get',
      args: { id: 'EI-1' },
      payloadTier: 'full',
    };
    forwardToolsInvokePayloadTier('tools:invoke', input);

    expect(input.args).toEqual({ id: 'EI-1' });
  });
});
