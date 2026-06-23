/**
 * _compound-dispatch.test.ts — pins inProcessCall, the in-process re-dispatch a
 * compound tool's composition fn uses (code-execution-tool-orchestration B-CX-1B).
 * Untested before this. What it guards:
 *
 *  - GATE INTEGRITY: every sub-call is routed through dispatchProjectedTool with the
 *    caller's exact ctx + the host PROJECTED_DEPS — a compound can only compose tools
 *    the agent could call directly. A regression that dropped ctx/deps would bypass
 *    role/capability/quota gates.
 *  - FAILURE SURFACING: an unregistered tool, or a dispatch that returns !ok, THROWS
 *    (so the compound's caller sees it) — with the error code/message, and the
 *    `?? 'error'` / `?? 'unknown error'` fallbacks when the gate gives no detail.
 *  - UNWRAP precedence: structuredContent (even null) wins; else the first text item,
 *    JSON-parsed; else the raw text on parse failure; else the whole result; undefined
 *    result → undefined. This is exactly what the composition reads (`result.workItem`),
 *    so a wrong unwrap silently feeds the composition garbage.
 *
 * Pure: the only I/O (lookupByMcpName, dispatchProjectedTool, PROJECTED_DEPS) is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';

const mocks = vi.hoisted(() => ({
  lookupByMcpName: vi.fn(),
  dispatchProjectedTool: vi.fn(),
}));

vi.mock('@papercusp/agent-mcp', () => ({
  lookupByMcpName: mocks.lookupByMcpName,
  dispatchProjectedTool: mocks.dispatchProjectedTool,
}));
vi.mock('../projected-tool-deps', () => ({ PROJECTED_DEPS: { __sentinel: 'projected-deps' } }));

import { inProcessCall } from './_compound-dispatch';

const FAKE_TOOL = { name: 'fake-tool' };
const ctx = { who: 'caller' } as unknown as UnifiedToolContext;

beforeEach(() => {
  // default: every lookup resolves to a registered tool unless a test overrides.
  mocks.lookupByMcpName.mockReturnValue(FAKE_TOOL);
});

afterEach(() => {
  vi.restoreAllMocks();
  mocks.lookupByMcpName.mockReset();
  mocks.dispatchProjectedTool.mockReset();
});

describe('inProcessCall — registration + gate routing', () => {
  it('throws for an unregistered tool and never dispatches', async () => {
    mocks.lookupByMcpName.mockReturnValue(undefined);
    const call = inProcessCall(ctx);
    await expect(call('ghost:verb', { a: 1 })).rejects.toThrow(
      'compound: tool "ghost:verb" is not registered',
    );
    expect(mocks.dispatchProjectedTool).not.toHaveBeenCalled();
  });

  it('routes the sub-call through dispatchProjectedTool with the caller ctx + PROJECTED_DEPS', async () => {
    mocks.dispatchProjectedTool.mockResolvedValue({ ok: true, result: { structuredContent: { ok: true } } });
    const call = inProcessCall(ctx);
    await call('work_items:get', { id: 'WI-1' });
    expect(mocks.lookupByMcpName).toHaveBeenCalledWith('work_items:get');
    expect(mocks.dispatchProjectedTool).toHaveBeenCalledTimes(1);
    const args = mocks.dispatchProjectedTool.mock.calls[0]!;
    expect(args[0]).toBe(FAKE_TOOL); // the looked-up tool
    expect(args[1]).toBe('work_items:get'); // name
    expect(args[2]).toEqual({ id: 'WI-1' }); // args
    expect(args[3]).toBe(ctx); // SAME ctx — gates run against the caller
    expect(args[4]).toEqual({ __sentinel: 'projected-deps' }); // host deps threaded
  });
});

describe('inProcessCall — failure surfacing (throws)', () => {
  it('throws with code + message when the gate returns !ok', async () => {
    mocks.dispatchProjectedTool.mockResolvedValue({
      ok: false,
      error: { code: 'forbidden', message: 'role may not call this' },
    });
    const call = inProcessCall(ctx);
    await expect(call('admin:nuke', {})).rejects.toThrow(
      'admin:nuke failed [forbidden]: role may not call this',
    );
  });

  it('falls back to [error]: unknown error when !ok carries no error object', async () => {
    mocks.dispatchProjectedTool.mockResolvedValue({ ok: false });
    const call = inProcessCall(ctx);
    await expect(call('x:y', {})).rejects.toThrow('x:y failed [error]: unknown error');
  });

  it('uses the partial error fields that are present', async () => {
    mocks.dispatchProjectedTool.mockResolvedValue({ ok: false, error: { code: 'timeout' } });
    const call = inProcessCall(ctx);
    await expect(call('slow:op', {})).rejects.toThrow('slow:op failed [timeout]: unknown error');
  });
});

describe('inProcessCall — unwrap precedence on success', () => {
  const callOk = async (result: unknown) => {
    mocks.dispatchProjectedTool.mockResolvedValue({ ok: true, result });
    return inProcessCall(ctx)('t', {});
  };

  it('returns structuredContent when present (wins over content)', async () => {
    const out = await callOk({ structuredContent: { workItem: 'WI-9' }, content: [{ text: '"ignored"' }] });
    expect(out).toEqual({ workItem: 'WI-9' });
  });

  it('treats a defined-but-null structuredContent as the value (not a fall-through)', async () => {
    const out = await callOk({ structuredContent: null, content: [{ text: '"should-not-win"' }] });
    expect(out).toBeNull();
  });

  it('JSON-parses the first text content item when no structuredContent', async () => {
    const out = await callOk({ content: [{ text: '{"count":3,"ok":true}' }] });
    expect(out).toEqual({ count: 3, ok: true });
  });

  it('returns the raw text when the text item is not valid JSON', async () => {
    const out = await callOk({ content: [{ text: 'plain summary' }] });
    expect(out).toBe('plain summary');
  });

  it('finds the FIRST text item past non-text content (e.g. an image part)', async () => {
    const out = await callOk({ content: [{ type: 'image', data: 'xxx' }, { text: '42' }] });
    expect(out).toBe(42); // 42 parses as JSON number
  });

  it('returns the whole result object when there is no text content item', async () => {
    const result = { content: [{ type: 'image', data: 'xxx' }] };
    const out = await callOk(result);
    expect(out).toBe(result);
  });

  it('returns undefined when the gate result is undefined', async () => {
    const out = await callOk(undefined);
    expect(out).toBeUndefined();
  });
});
