/**
 * Live integration test for the Bug #34 replay-on-reconnect fix.
 *
 * Where `http-projection.test.ts` exercises `handleHttpToolRequestStreaming`
 * against a mock SseSink, this test goes one layer wider: it builds a real
 * `sseResponse()` from `@restart/sse`, parses the actual SSE wire bytes the
 * browser would receive, then makes a SECOND request with `Last-Event-ID`
 * to verify the replay path produces the correct wire-format events.
 *
 * Closes the "live SSE coverage gap" from round-13 (the unit tests use a
 * mock sink that bypasses the SSE protocol layer).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { sseResponse } from '@restart/sse';
import {
  handleHttpToolRequestStreaming,
  type HttpToolHostExtras,
  type HttpToolRequest,
} from './http-projection';
import {
  registerProjectedTool,
  _resetProjectionRegistryForTests,
  type ProjectedTool,
} from './tool-projection';
import { dispatchProjectedTool } from './dispatch-projected';

describe('Bug #34 — live replay flow via real sseResponse + SSE wire parsing', () => {
  beforeEach(() => _resetProjectionRegistryForTests());

  const makeTool = (replayBufferSize: number): ProjectedTool => ({
    pluginName: 'fix',
    description: 'streamer',
    inputSchema: { type: 'object' },
    capabilities: [],
    expose: { mcp: { name: 'fix.streamer' }, http: { path: '/api/plugins/fix/streamer' } },
    events: { delta: z.object({ text: z.string() }) },
    eventWireKinds: { delta: 'json' },
    replayBufferSize,
    fn: async (_input, ctx) => {
      for (let i = 1; i <= 5; i++) ctx.emit('delta', { text: `chunk ${i}` });
      return { content: [{ type: 'text', text: 'done' }] };
    },
  });

  const HOST_EXTRAS: HttpToolHostExtras = { deps: {} };

  const MAKE_REQ = (headers: Record<string, string> = {}): HttpToolRequest => ({
    method: 'POST',
    pathname: '/api/plugins/fix/streamer',
    searchParams: new URLSearchParams(),
    headers,
    body: { x: 1 },
  });

  async function consumeSseStream(resp: Response): Promise<Array<{ event: string; data: string; id?: string }>> {
    const text = await resp.text();
    const events: Array<{ event: string; data: string; id?: string }> = [];
    for (const block of text.split(/\n\n/)) {
      const lines = block.split('\n').filter(Boolean);
      const ev: { event: string; data: string[]; id?: string } = { event: 'message', data: [] };
      for (const line of lines) {
        const m = line.match(/^([^:]+):\s?(.*)$/);
        if (!m) continue;
        const [, key, val] = m;
        if (key === 'event') ev.event = val;
        else if (key === 'data') ev.data.push(val);
        else if (key === 'id') ev.id = val;
      }
      if (ev.data.length || lines.length > 0) {
        events.push({ event: ev.event, data: ev.data.join('\n'), id: ev.id });
      }
    }
    return events;
  }

  it('first connect: events stream with monotonic ids, then done', async () => {
    registerProjectedTool(makeTool(10));
    const ctrl = new AbortController();
    const resp = sseResponse({
      signal: ctrl.signal,
      heartbeatMs: 0, // disable heartbeat noise
      initialHeartbeat: false,
      setup: (sink) =>
        handleHttpToolRequestStreaming(MAKE_REQ({
          'x-papercusp-workspace': 'ws-1',
          'x-papercusp-run': 'run-live-1',
        }), HOST_EXTRAS, sink),
    });
    const events = await consumeSseStream(resp);
    const deltas = events.filter((e) => e.event === 'delta');
    expect(deltas.length).toBe(5);
    expect(deltas[0]?.id).toBe('1');
    expect(deltas[4]?.id).toBe('5');
    // The framework's auto-done lands as event:done.
    expect(events.find((e) => e.event === 'done')).toBeDefined();
  });

  it('reconnect with Last-Event-ID=2: serves only events 3-5, emits done with resumed:true', async () => {
    // First, populate the buffer by dispatching directly (bypasses sseResponse —
    // we just want events in the buffer keyed on the runId we're going to
    // reconnect with).
    const tool = makeTool(10);
    registerProjectedTool(tool);
    const ctx = {
      log: () => {}, emit: () => {}, progress: () => {},
      workspaceId: 'ws-1', role: 'operator' as never,
      runId: 'run-live-2', spawnId: 's',
    } as never;
    await dispatchProjectedTool(tool, 'fix.streamer', { x: 1 }, ctx, {});

    // Now reconnect with the SAME runId and Last-Event-ID=2 on the wire.
    const ctrl = new AbortController();
    registerProjectedTool(tool); // re-register since beforeEach reset would have wiped
    const resp = sseResponse({
      signal: ctrl.signal,
      heartbeatMs: 0,
      initialHeartbeat: false,
      // CRITICAL: pass lastEventId so the SSE id allocator starts at 3+.
      lastEventId: 2,
      setup: (sink) =>
        handleHttpToolRequestStreaming(MAKE_REQ({
          'x-papercusp-workspace': 'ws-1',
          'x-papercusp-run': 'run-live-2',
          'last-event-id': '2',
        }), HOST_EXTRAS, sink),
    });
    const events = await consumeSseStream(resp);
    const deltas = events.filter((e) => e.event === 'delta');
    // Buffer held events with ids 1-5; sinceId=2 means events 3-5 replay.
    expect(deltas.length).toBe(3);
    expect((deltas[0]?.data ?? '')).toContain('chunk 3');
    expect((deltas[2]?.data ?? '')).toContain('chunk 5');
    const done = events.find((e) => e.event === 'done');
    expect(done).toBeDefined();
    expect(done?.data).toContain('"resumed":true');
    expect(done?.data).toContain('"replayed":3');
  });

  it('reconnect with unknown runId: falls through to fresh dispatch (no replay short-circuit)', async () => {
    let runs = 0;
    registerProjectedTool({
      ...makeTool(10),
      fn: async (_input, ctx) => {
        runs++;
        ctx.emit('delta', { text: 'fresh' });
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    const ctrl = new AbortController();
    const resp = sseResponse({
      signal: ctrl.signal,
      heartbeatMs: 0,
      initialHeartbeat: false,
      setup: (sink) =>
        handleHttpToolRequestStreaming(MAKE_REQ({
          'x-papercusp-workspace': 'ws-1',
          'x-papercusp-run': 'never-existed',
          'last-event-id': '99',
        }), HOST_EXTRAS, sink),
    });
    const events = await consumeSseStream(resp);
    expect(runs).toBe(1);
    const delta = events.find((e) => e.event === 'delta');
    expect(delta?.data).toContain('fresh');
  });
});
