/**
 * _compound-dispatch.test.ts — pins inProcessCall, the in-process re-dispatch a
 * compound tool's composition fn uses (code-execution-tool-orchestration B-CX-1B).
 * Untested before this. What it guards:
 *
 *  - GATE INTEGRITY: every sub-call is routed through dispatchProjectedTool with the
 *    caller's ctx (transport stamped to 'in_process', all other fields preserved) +
 *    the host PROJECTED_DEPS — a compound can only compose tools the agent could call
 *    directly. A regression that dropped ctx/deps would bypass role/capability/quota
 *    gates.
 *  - TRANSPORT STAMP: the re-dispatch is IN-PROCESS, so ctx.transport becomes
 *    'in_process' (never the caller's 'mcp') — that keeps the sub-result lossless JSON
 *    instead of the agent-facing TOON that unwrap can't JSON.parse (the
 *    templates:new-app 422-on-success regression, owner-hit 2026-07-08).
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
// REAL (not mocked) — the unwrap TOON-hardening decodes with this exact codec.
import { encode } from '@papercusp/result-encoding';

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
    // The re-dispatch ctx is the caller's ctx with transport stamped to 'in_process'
    // (so the sub-result stays lossless JSON, not the agent-facing TOON) — every OTHER
    // field is spread through unchanged, so gates still run against the caller.
    expect(args[3]).toEqual({ ...ctx, transport: 'in_process' });
    expect(args[4]).toEqual({ __sentinel: 'projected-deps' }); // host deps threaded
  });

  it('stamps transport:in_process on the re-dispatch even when the caller is on the MCP transport', async () => {
    // The regression this pins (owner-hit 2026-07-08): inheriting the caller's
    // transport:'mcp' made the dispatcher TOON-encode the SUB result, so unwrap
    // (JSON.parse) fell back to a raw string and the composition misread .ok/.slug
    // — templates:new-app returned a bogus 422 on a SUCCESSFUL harness:create.
    mocks.dispatchProjectedTool.mockResolvedValue({ ok: true, result: { structuredContent: { ok: true } } });
    const mcpCtx = { who: 'caller', transport: 'mcp', principal: { id: 'p1' } } as unknown as UnifiedToolContext;
    await inProcessCall(mcpCtx)('harness:create', { slug: 'x' });
    const passedCtx = mocks.dispatchProjectedTool.mock.calls[0]![3] as {
      transport?: string;
      who?: string;
      principal?: unknown;
    };
    expect(passedCtx.transport).toBe('in_process'); // NOT 'mcp' → no compact re-encode
    expect(passedCtx.who).toBe('caller'); // caller identity preserved
    expect(passedCtx.principal).toEqual({ id: 'p1' }); // gates still run against the caller
  });

  // orient-recall-quality-2026-07-12 P-001: the opt-in telemetrySurface stamp — a
  // compound (coord:orient) labels its folded memory:search recall so telemetry
  // records per-entry-point ('orient') instead of blending into generic 'search'.
  it('stamps opts.telemetrySurface onto the re-dispatch ctx; absent when not passed', async () => {
    mocks.dispatchProjectedTool.mockResolvedValue({ ok: true, result: { structuredContent: { ok: true } } });
    await inProcessCall(ctx, { telemetrySurface: 'orient' })('memory:search', { query: 'q' });
    const stamped = mocks.dispatchProjectedTool.mock.calls[0]![3] as { telemetrySurface?: string };
    expect(stamped.telemetrySurface).toBe('orient');

    mocks.dispatchProjectedTool.mockClear();
    mocks.dispatchProjectedTool.mockResolvedValue({ ok: true, result: { structuredContent: { ok: true } } });
    await inProcessCall(ctx)('memory:search', { query: 'q' });
    const unstamped = mocks.dispatchProjectedTool.mock.calls[0]![3] as { telemetrySurface?: string };
    expect('telemetrySurface' in unstamped).toBe(false); // no opts → field ABSENT, not undefined
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

  it('DECODES a self-identifying TOON body to the structured value (defense-in-depth for the 422 class)', async () => {
    // A compact inner body carries a `format: toon\n…` marker. Before the fix,
    // unwrap only JSON.parse'd → this threw → it returned the raw TOON STRING, and
    // the composition read undefined off .ok/.slug/.path. Now it decodes losslessly.
    const payload = { ok: true, slug: 'my-app', path: '/home/x/my-app', filesCopied: ['GUIDE.md', 'template.yaml'] };
    const toonText = `format: toon\n${encode(payload, 'toon')}`;
    const out = await callOk({ content: [{ text: toonText }] });
    expect(out).toEqual(payload);
  });

  it('does NOT decode a type-lossy CSV/TSV body (falls through to raw text — only lossless TOON is decoded)', async () => {
    // CSV is type-lossy (numbers/booleans → strings) and never arises in-process,
    // so unwrap deliberately leaves a `format: csv\n…` body as raw text rather than
    // hand the composition string-typed cells it would misread.
    const csvText = `format: csv\n${encode([{ id: 'A', n: 1 }], 'csv')}`;
    const out = await callOk({ content: [{ text: csvText }] });
    expect(typeof out).toBe('string');
  });

  it('falls back to the raw text when a compact body cannot be decoded', async () => {
    // A `format: toon\n` marker over a corrupt body must not throw — fall back to raw.
    const out = await callOk({ content: [{ text: 'format: toon\n<<<not valid toon>>>' }] });
    expect(typeof out).toBe('string');
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
