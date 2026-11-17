import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { _resetProjectionRegistryForTests, defineTool, lookupByMcpName,
  type BatchResult, type UnifiedToolContext } from '@papercusp/tooldef';
import { dispatchProjectedTool, dispatchProjectedToolStream } from './index';

const context = (): UnifiedToolContext => ({ log: vi.fn(), signal: new AbortController().signal,
  emit: vi.fn(), progress: vi.fn(), role: 'worker', workspaceId: 'fixture', runId: 'compat' });

afterEach(() => _resetProjectionRegistryForTests());

describe('agent-mcp response compatibility adapter', () => {
  it('preserves the negotiated child payload and metadata for either singleton request form', async () => {
    const output = { content: [{ type: 'text' as const, text: 'raw bytes\n' }],
      _meta: { nextCursor: 'page-2' }, isError: true };
    const handler = vi.fn(async () => output);
    defineTool({ name: 'compat:raw', requirePrincipal: false, capability: 'test:read',
      args: z.strictObject({ key: z.string() }), handler });
    const tool = lookupByMcpName('compat:raw')!;
    for (const input of [{ key: 'a' }, { _batch: 1, items: [{ args: { key: 'a' } }] }]) {
      expect(await dispatchProjectedTool(tool, 'compat:raw', input, context(), {}))
        .toEqual({ ok: true, result: output });
    }
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('honors explicit canonical negotiation and retains every keyed sibling', async () => {
    const handler = vi.fn(async () => ({ content: [] }));
    defineTool({ name: 'compat:batch', requirePrincipal: false, capability: 'test:read',
      args: z.strictObject({ key: z.string() }), handler });
    const input = { _batch: 1, items: [
      { itemId: 'a', args: { key: 'same' } }, { itemId: 'b', args: { key: 'same' } },
    ] };
    const tool = lookupByMcpName('compat:batch')!;
    const refused = await dispatchProjectedTool(tool, 'compat:batch', input, context(), {});
    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(handler).not.toHaveBeenCalled();
    const result = await dispatchProjectedTool(tool, 'compat:batch', input, context(), { batchResponseVersion: 'batch-v1' });
    const data = result.result!.structuredContent as unknown as BatchResult;
    expect(data.counts).toEqual({ ok: 2, failed: 0 });
    expect(data.results.map(item => item.itemId)).toEqual(['a', 'b']);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('keeps legacy gate errors intact while canonical errors remain per item', async () => {
    const handler = vi.fn(async () => ({ content: [] }));
    defineTool({ name: 'compat:role', requirePrincipal: false, capability: 'test:read',
      agentRoles: ['operator'], args: z.object({}), handler });
    const tool = lookupByMcpName('compat:role')!;
    expect(await dispatchProjectedTool(tool, 'compat:role', {}, context(), {}))
      .toMatchObject({ ok: false, error: { code: 'role_not_allowed' } });
    const canonical = await dispatchProjectedTool(tool, 'compat:role', {}, context(), { batchResponseVersion: 'batch-v1' });
    expect((canonical.result!.structuredContent as unknown as BatchResult).results[0])
      .toMatchObject({ itemId: 'item-1', ok: false, error: { code: 'role_not_allowed' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('preserves the operation result through the existing streaming adapter', async () => {
    const output = { content: [{ type: 'text' as const, text: 'complete' }] };
    defineTool({ name: 'compat:stream', requirePrincipal: false, capability: 'test:read', args: z.object({}),
      handler: async (_args, ctx) => { ctx.emit('fixture', { value: 1 }); return output; } });
    const events = [];
    for await (const event of dispatchProjectedToolStream(lookupByMcpName('compat:stream')!, 'compat:stream', {}, context(), {}))
      events.push(event);
    expect(events).toEqual([{ kind: 'event', name: 'fixture', data: { value: 1 } }, { kind: 'done', result: output }]);
  });
});
