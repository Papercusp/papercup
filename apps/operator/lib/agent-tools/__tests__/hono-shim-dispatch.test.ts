/**
 * Hono-shim dispatch-loop integration test.
 *
 * Round-2 found that architect/brainstorm's Hono shims silently
 * dropped ev.kind === 'error' from the dispatch stream — role gate
 * denials / quota / timeouts surfaced as an empty response with no
 * error event. The fix (round-2 + round-6 helper extraction) is now
 * load-bearing for the chat-panel UX; this test locks it in.
 *
 * Approach: run dispatchProjectedToolStream against a recording
 * sink + emitToSseSink + the same forwarder loop shape the Hono
 * shims use. Verify:
 *   - event forwarding goes through emitToSseSink (so wire kinds are
 *     honored — z.string() goes via eventRaw, etc.)
 *   - dispatch-level errors land as raw-text `error` events (the
 *     submodule consumer at libs/agent-chat reads accum += data,
 *     so JSON envelopes would render literally in the chat UI).
 *   - `done` is intentionally not emitted (consumer parity).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import {
  dispatchProjectedToolStream,
  emitToSseSink,
  lookupByMcpName,
  registerProjectedTool,
  _resetProjectionRegistryForTests,
  type ProjectedTool,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';

type Recorded = { kind: 'event' | 'raw'; name: string; data: unknown };

function recSink() {
  const events: Recorded[] = [];
  return {
    events,
    sink: {
      event(name: string, value: unknown): void { events.push({ kind: 'event', name, data: value }); },
      eventRaw(name: string, value: string): void { events.push({ kind: 'raw', name, data: value }); },
    },
  };
}

/**
 * Mirror of the architect/brainstorm Hono shim's for-await loop —
 * the exact pattern in apps/operator/app/api/_hono/harness.ts after
 * round 6+7 fixes. If this loop drifts from the real shim's loop,
 * one of the two has a bug.
 */
async function forwardDispatch(
  iter: AsyncIterable<{ kind: string; name?: string; data?: unknown; error?: { message: string } }>,
  tool: Pick<ProjectedTool, 'eventWireKinds'>,
  sink: ReturnType<typeof recSink>['sink'],
): Promise<void> {
  for await (const ev of iter) {
    if (ev.kind === 'event' && ev.name !== undefined) {
      emitToSseSink(sink, tool, ev.name, ev.data);
    } else if (ev.kind === 'error' && ev.error) {
      sink.eventRaw('error', ev.error.message);
    }
    // ev.kind === 'done' intentionally skipped (consumer parity).
  }
}

function makeTool(over: Partial<ProjectedTool>): ProjectedTool {
  return {
    pluginName: 'fixture',
    description: 'hono shim test tool',
    inputSchema: { type: 'object' },
    capabilities: [],
    requiresPrincipal: false,
    args: z.object({}),
    expose: { mcp: { name: 'fix:shim' } },
    fn: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    ...over,
  };
}

function makeCtx(over: Partial<UnifiedToolContext> = {}): UnifiedToolContext {
  return {
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    emit: vi.fn(),
    workspaceId: 'default',
    role: 'operator',
    runId: 'r',
    spawnId: 's',
    ...over,
  } as UnifiedToolContext;
}

beforeEach(() => {
  _resetProjectionRegistryForTests();
});

afterEach(() => {
  _resetProjectionRegistryForTests();
});

describe('Hono shim dispatch-loop wire format', () => {
  it('forwards z.string() events as raw text and object events as JSON', async () => {
    registerProjectedTool(makeTool({
      events: {
        delta: z.string(),
        tool_call: z.object({ name: z.string(), input: z.unknown() }),
      },
      eventWireKinds: { delta: 'string', tool_call: 'json' },
      fn: async (_input, ctx) => {
        ctx.emit?.('delta', 'Hello ');
        ctx.emit?.('tool_call', { name: 'ask_choice', input: { options: ['a', 'b'] } });
        ctx.emit?.('delta', 'world');
        return { content: [{ type: 'text', text: 'Hello world' }] };
      },
    }));
    const tool = lookupByMcpName('fix:shim')!;
    const { sink, events } = recSink();
    await forwardDispatch(
      dispatchProjectedToolStream(tool, 'fix:shim', {}, makeCtx(), {}),
      tool,
      sink,
    );
    // 2 raw delta + 1 JSON tool_call. No done frame surfaced.
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ kind: 'raw', name: 'delta', data: 'Hello ' });
    expect(events[1]).toEqual({
      kind: 'event',
      name: 'tool_call',
      data: { name: 'ask_choice', input: { options: ['a', 'b'] } },
    });
    expect(events[2]).toEqual({ kind: 'raw', name: 'delta', data: 'world' });
    // Critical: NO 'done' event in the recording. Consumer closes on
    // stream-end; surfacing done would change wire semantics.
    expect(events.find((e) => e.name === 'done')).toBeUndefined();
  });

  it('round-2 regression: dispatch-level error surfaces as raw-text error', async () => {
    // Tool denies the role gate — dispatcher returns
    // { ok: false, error: { code: 'role_not_allowed', ... } }
    // and dispatchProjectedToolStream yields { kind: 'error', error }.
    registerProjectedTool(makeTool({
      events: { delta: z.string(), error: z.string() },
      eventWireKinds: { delta: 'string', error: 'string' },
      roles: ['architect'], // ctx.role === 'operator' → denied
      fn: async () => ({ content: [{ type: 'text', text: '' }] }),
    }));
    const tool = lookupByMcpName('fix:shim')!;
    const { sink, events } = recSink();
    await forwardDispatch(
      dispatchProjectedToolStream(tool, 'fix:shim', {}, makeCtx(), {}),
      tool,
      sink,
    );
    // The error MUST be raw text (the submodule consumer does
    // `accum += data`). A JSON envelope would render the curly
    // braces literally in the chat panel.
    const errorEvent = events.find((e) => e.name === 'error');
    expect(errorEvent).toBeTruthy();
    expect(errorEvent!.kind).toBe('raw');
    expect(typeof errorEvent!.data).toBe('string');
    expect(errorEvent!.data).toContain('Role');
    expect(errorEvent!.data).toContain('cannot call');
  });

  it('handler-emitted error events stay raw text (no double-encoding)', async () => {
    // runAgentChat sometimes yields a non-fatal error mid-stream; the
    // tool re-emits via ctx.emit('error', text). Verify the
    // forwarder treats it identically to the dispatch-error case.
    registerProjectedTool(makeTool({
      events: { delta: z.string(), error: z.string() },
      eventWireKinds: { delta: 'string', error: 'string' },
      fn: async (_input, ctx) => {
        ctx.emit?.('delta', 'before-error ');
        ctx.emit?.('error', 'mid-stream error from runAgentChat');
        ctx.emit?.('delta', 'after-error');
        return { content: [{ type: 'text', text: 'partial' }] };
      },
    }));
    const tool = lookupByMcpName('fix:shim')!;
    const { sink, events } = recSink();
    await forwardDispatch(
      dispatchProjectedToolStream(tool, 'fix:shim', {}, makeCtx(), {}),
      tool,
      sink,
    );
    const errorEvents = events.filter((e) => e.name === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toEqual({
      kind: 'raw',
      name: 'error',
      data: 'mid-stream error from runAgentChat',
    });
    // Deltas around the error still flow.
    const deltas = events.filter((e) => e.name === 'delta');
    expect(deltas.map((e) => e.data)).toEqual(['before-error ', 'after-error']);
  });

  it('handler throw surfaces as a single raw-text error and stops the stream', async () => {
    registerProjectedTool(makeTool({
      events: { delta: z.string(), error: z.string() },
      eventWireKinds: { delta: 'string', error: 'string' },
      fn: async (_input, ctx) => {
        ctx.emit?.('delta', 'partial ');
        throw new Error('handler exploded');
      },
    }));
    const tool = lookupByMcpName('fix:shim')!;
    const { sink, events } = recSink();
    await forwardDispatch(
      dispatchProjectedToolStream(tool, 'fix:shim', {}, makeCtx(), {}),
      tool,
      sink,
    );
    const deltas = events.filter((e) => e.name === 'delta');
    expect(deltas).toEqual([{ kind: 'raw', name: 'delta', data: 'partial ' }]);
    const errorEvents = events.filter((e) => e.name === 'error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].kind).toBe('raw');
    expect(errorEvents[0].data).toContain('handler exploded');
  });
});
