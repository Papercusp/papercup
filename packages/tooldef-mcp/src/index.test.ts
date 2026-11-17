/**
 * Standalone tests for the MCP bridge primitives — import ONLY @papercusp/tooldef
 * + this package (no agent-mcp, no operator, no mcp-handler).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool, lookupByMcpName, _resetProjectionRegistryForTests,
  type ProjectedTool, type UnifiedToolContext, type BatchResult } from '@papercusp/tooldef';
import {
  bearerFromExtra,
  urlFromExtra,
  headersFromExtra,
  dispatchProjectedToolToMcp,
  isDispatchValidationFailure,
} from './index';

const ctx = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  ...over,
});

const tool = (over: Partial<ProjectedTool> = {}): ProjectedTool => ({
  pluginName: 'fixture',
  description: 'fixture',
  inputSchema: { type: 'object' },
  capabilities: [],
  expose: { mcp: { name: 'fix.tool' } },
  fn: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  ...over,
});

afterEach(() => _resetProjectionRegistryForTests());

describe('RequestHandlerExtra extractors', () => {
  it('bearerFromExtra strips the Bearer prefix', () => {
    expect(bearerFromExtra({ requestInfo: { headers: { authorization: 'Bearer xyz' } } })).toBe('xyz');
    expect(bearerFromExtra({ requestInfo: { headers: { authorization: ['Bearer abc'] } } })).toBe('abc');
    expect(bearerFromExtra({})).toBe('');
  });
  it('urlFromExtra parses the request URL', () => {
    expect(urlFromExtra({ requestInfo: { url: 'http://h/p?role=worker' } })?.searchParams.get('role')).toBe('worker');
    expect(urlFromExtra({})).toBeNull();
    expect(urlFromExtra({ requestInfo: { url: 'not a url' } })).toBeNull();
  });
  it('headersFromExtra builds a Headers (arrays joined)', () => {
    const h = headersFromExtra({ requestInfo: { headers: { 'x-a': '1', 'x-b': ['2', '3'] } } });
    expect(h.get('x-a')).toBe('1');
    expect(h.get('x-b')).toBe('2, 3');
  });
});

describe('dispatchProjectedToolToMcp', () => {
  it('serves canonical singleton/array parity through tools/call metadata and preserves per-child gates', async () => {
    const effects: string[] = [];
    const authorize = vi.fn(async ({ input }) => (input as { value: string }).value === 'denied'
      ? { allow: false, reason: 'fixture denial' } : { allow: true });
    defineTool({ name: 'fix.batch', requirePrincipal: false, capability: 'test:write',
      args: z.strictObject({ value: z.string() }), authorize,
      handler: async args => { effects.push(args.value); return { data: args }; } });
    const registered = lookupByMcpName('fix.batch')!;
    const call = (args: unknown) => dispatchProjectedToolToMcp(registered, 'fix.batch', args,
      ctx({ requestedStructured: true }), { batchResponseVersion: 'operation-v0' },
      { 'papercusp/batchResponseVersion': 'batch-v1' });
    const singleton = await call({ value: 'one' });
    const marked = await call({ _batch: 1, items: [{ args: { value: 'one' } }] });
    expect((singleton.structuredContent as BatchResult).results)
      .toEqual((marked.structuredContent as BatchResult).results);
    const mixed = await call({ _batch: 1, items: [
      { itemId: 'denied', args: { value: 'denied' } },
      { itemId: 'bad', args: { value: 7 } },
      { itemId: 'ok', args: { value: 'last' } },
    ] });
    const data = mixed.structuredContent as BatchResult;
    expect(data.counts).toEqual({ ok: 1, failed: 2 });
    expect(data.results.map(item => [item.itemId, item.ok])).toEqual([['denied', false], ['bad', false], ['ok', true]]);
    expect(data.results[1].error).toMatchObject({ code: 'invalid_input' });
    expect(data.results[2].output?.structuredContent).toEqual({ value: 'last' });
    expect(effects).toEqual(['one', 'one', 'last']);
    expect(authorize).toHaveBeenCalledTimes(5);
  });

  it('rejects unsupported response versions before dispatch and never passes metadata into business args', async () => {
    const handler = vi.fn(async () => ({ content: [] }));
    const result = await dispatchProjectedToolToMcp(tool({ fn: handler }), 'fix.tool', {}, ctx(), {},
      { 'papercusp/batchResponseVersion': 'future' });
    expect(result.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('consumes MCP execution metadata without modifying tool arguments', async () => {
    const handler = vi.fn(async (args, context) => ({ content: [{ type: 'text' as const,
      text: JSON.stringify({ args, request: context.toolExecution }) }] }));
    const result = await dispatchProjectedToolToMcp(tool({ fn: handler }), 'fix.tool', { value: 7 }, ctx(), {}, {
      'papercusp/execution': { mode: 'sync', responseWindowMs: 1000 },
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      args: { value: 7 }, request: { mode: 'sync', responseWindowMs: 1000 },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it.each([{ mode: 'async' }, { mode: 'invalid' }, { mode: 'sync', responseWindowMs: 60001 },
    { mode: 'sync', executionDeadlineAtMs: Date.now() + 999999 }])(
    'rejects invalid or unsupported MCP execution metadata before admission: %j', async request => {
      const handler = vi.fn(async () => ({ content: [] }));
      const result = await dispatchProjectedToolToMcp(tool({ fn: handler }), 'fix.tool', {}, ctx(), {}, {
        'papercusp/execution': request,
      });
      expect(result.isError).toBe(true);
      expect(handler).not.toHaveBeenCalled();
    });
  it('maps a successful dispatch to { content }', async () => {
    const r = await dispatchProjectedToolToMcp(tool(), 'fix.tool', {}, ctx(), {});
    expect(r.isError).toBeUndefined();
    expect(r.content[0]).toEqual({ type: 'text', text: 'ok' });
  });
  it('maps a gate denial to { isError, content:"<code>: <msg>" }', async () => {
    const r = await dispatchProjectedToolToMcp(tool({ agentRoles: ['architect'] }), 'fix.tool', {}, ctx({ role: 'worker' }), {});
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/^role_not_allowed: /);
  });

  it('preserves a dispatcher late-write receipt on the MCP error result', async () => {
    const receipt = {
      status: 'recorded',
      msg_id: 'm-late',
      diagnostics: { coordSendPhaseTimingsMs: [{ itemIndex: 0, prePersistMs: 8, persistMs: 12, postPersistMs: 5 }] },
    };
    const error = Object.assign(new Error('tool timed out after its handler returned'), {
      dispatchMetadata: { abortCompletionReceipt: receipt },
    });
    const r = await dispatchProjectedToolToMcp(
      tool({ fn: async () => { throw error; } }),
      'fix.tool',
      {},
      ctx(),
      {},
    );

    expect(r.isError).toBe(true);
    expect(r._meta).toEqual({ abortCompletionReceipt: receipt });
  });

  // EI-21903050648079438: a code:run script's unwrapToolResult prefers
  // structuredContent over the text body, so a dispatch-level failure with no
  // structuredContent handed the script a raw STRING while a success handed it
  // an OBJECT — an asymmetry that makes `result.ok` read as undefined on the
  // exact path a script most needs to detect failure on.
  it('carries structuredContent:{ok:false,error} on a gate denial when codeMode is set', async () => {
    const r = await dispatchProjectedToolToMcp(
      tool({ agentRoles: ['architect'] }),
      'fix.tool',
      {},
      ctx({ role: 'worker', codeMode: true }),
      {},
    );
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({
      ok: false,
      error: { code: 'role_not_allowed', message: expect.any(String) },
    });
  });

  it('omits structuredContent on a gate denial when codeMode is not set (no extra wire cost)', async () => {
    const r = await dispatchProjectedToolToMcp(tool({ agentRoles: ['architect'] }), 'fix.tool', {}, ctx({ role: 'worker' }), {});
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
  });

  it('marks only mapper-produced validation refusals, without exposing the marker on the wire', async () => {
    const invalid = await dispatchProjectedToolToMcp(
      tool({
        fn: async () => {
          const error = new Error('invalid_args: value: expected string');
          Object.defineProperty(error, 'name', { value: 'InvalidInputError' });
          throw error;
        },
      }),
      'fix.tool',
      {},
      ctx(),
      {},
    );
    expect(isDispatchValidationFailure(invalid)).toBe(true);
    expect(isDispatchValidationFailure({ ...invalid })).toBe(true);
    expect(JSON.stringify(invalid)).not.toContain('dispatch-validation');

    const handlerError = await dispatchProjectedToolToMcp(
      tool({ fn: async () => ({ content: [{ type: 'text', text: 'business failure' }], isError: true }) }),
      'fix.tool',
      {},
      ctx(),
      {},
    );
    expect(handlerError.isError).toBe(true);
    expect(isDispatchValidationFailure(handlerError)).toBe(false);
  });

  it('still prefers the target-supplied structuredContent on success (unchanged)', async () => {
    const r = await dispatchProjectedToolToMcp(
      tool({ fn: async () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true, n: 1 } }) }),
      'fix.tool',
      {},
      ctx({ codeMode: true }),
      {},
    );
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toEqual({ ok: true, n: 1 });
  });
});
