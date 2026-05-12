/**
 * Tests for the HTTP transport adapter.
 * Run with: npx vitest run packages/agent-mcp/src/http-projection.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleHttpToolRequest,
  handleHttpToolRequestStreaming,
  buildHttpSpawnContext,
  type HttpToolHostExtras,
  type HttpToolRequest,
} from './http-projection';
import {
  registerProjectedTool,
  _resetProjectionRegistryForTests,
  type ProjectedTool,
} from './tool-projection';

const makeTool = (over: Partial<ProjectedTool> = {}): ProjectedTool => ({
  pluginName: 'fixture',
  description: 'fixture tool',
  inputSchema: { type: 'object' },
  capabilities: [],
  expose: {
    mcp: { name: 'fix.tool' },
    http: { path: '/api/plugins/fixture/tool' },
  },
  fn: async (input) => ({ content: [{ type: 'text', text: `echo:${JSON.stringify(input)}` }] }),
  ...over,
});

const MAKE_REQ = (over: Partial<HttpToolRequest> = {}): HttpToolRequest => ({
  method: 'POST',
  pathname: '/api/plugins/fixture/tool',
  searchParams: new URLSearchParams(),
  headers: {},
  body: { x: 1 },
  ...over,
});

const MAKE_EXTRAS = (over: Partial<HttpToolHostExtras> = {}): HttpToolHostExtras => ({
  deps: {},
  ...over,
});

afterEach(() => _resetProjectionRegistryForTests());

describe('buildHttpSpawnContext', () => {
  it('reads X-Papercusp-* headers (lowercased)', () => {
    const ctx = buildHttpSpawnContext({
      headers: {
        'x-papercusp-workspace': 'default',
        'x-papercusp-harness': 'sheets',
        'x-papercusp-role': 'worker',
        'x-papercusp-feature': 'F-A',
        'x-papercusp-chunk': 'ck_X',
        'x-papercusp-run': 'run_X',
        'x-papercusp-spawn': 'spw_X',
      },
      searchParams: new URLSearchParams(),
    });
    expect(ctx).toMatchObject({
      workspaceId: 'default',
      harnessSlug: 'sheets',
      role: 'worker',
      featureId: 'F-A',
      chunkId: 'ck_X',
      runId: 'run_X',
      spawnId: 'spw_X',
    });
  });

  it('falls back to URL search params when headers absent', () => {
    const ctx = buildHttpSpawnContext({
      headers: {},
      searchParams: new URLSearchParams('workspace=default&harness=sheets&role=architect&run=run_X&spawn=spw_X'),
    });
    expect(ctx).toMatchObject({
      workspaceId: 'default',
      harnessSlug: 'sheets',
      role: 'architect',
      runId: 'run_X',
      spawnId: 'spw_X',
    });
  });

  it('headers take precedence over query params', () => {
    const ctx = buildHttpSpawnContext({
      headers: { 'x-papercusp-role': 'architect' },
      searchParams: new URLSearchParams('role=worker'),
    });
    expect(ctx.role).toBe('architect');
  });

  it('returns null/undefined fields when nothing is supplied', () => {
    const ctx = buildHttpSpawnContext({ headers: {}, searchParams: new URLSearchParams() });
    expect(ctx.workspaceId).toBeUndefined();
    expect(ctx.featureId).toBeNull();
    expect(ctx.chunkId).toBeNull();
  });
});

describe('handleHttpToolRequest', () => {
  it('returns 404 for unknown path', async () => {
    const res = await handleHttpToolRequest(
      MAKE_REQ({ pathname: '/api/plugins/missing/tool' }),
      MAKE_EXTRAS(),
    );
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('unknown_tool');
  });

  it('returns 405 for wrong method', async () => {
    registerProjectedTool(makeTool());
    const res = await handleHttpToolRequest(MAKE_REQ({ method: 'DELETE' }), MAKE_EXTRAS());
    expect(res.status).toBe(405);
  });

  it('returns 200 + content for a successful invocation', async () => {
    registerProjectedTool(makeTool());
    const res = await handleHttpToolRequest(MAKE_REQ({ body: { hello: 'world' } }), MAKE_EXTRAS());
    expect(res.status).toBe(200);
    expect((res.body as { content: Array<{ type: string; text: string }> }).content[0]?.text).toContain('echo');
  });

  it('returns 403 for role_not_allowed', async () => {
    registerProjectedTool(makeTool({ roles: ['architect'] }));
    const res = await handleHttpToolRequest(
      MAKE_REQ({ headers: { 'x-papercusp-role': 'worker' } }),
      MAKE_EXTRAS(),
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('role_not_allowed');
  });

  it('returns 429 for quota_exceeded', async () => {
    registerProjectedTool(makeTool({ rolesQuota: { worker: { perChunk: 1 } } }));
    const res = await handleHttpToolRequest(
      MAKE_REQ({
        headers: {
          'x-papercusp-role': 'worker',
          'x-papercusp-chunk': 'ck_X',
          'x-papercusp-run': 'run_X',
          'x-papercusp-spawn': 'spw_X',
        },
      }),
      MAKE_EXTRAS({
        deps: {
          readQuotaState: vi.fn(async () => ({ count: 1 })),
        },
      }),
    );
    expect(res.status).toBe(429);
    expect((res.body as { error: { code: string } }).error.code).toBe('quota_exceeded');
  });

  it('returns 504 for timeout', async () => {
    registerProjectedTool(makeTool({
      timeoutSec: 0.05,
      fn: async (_input, ctx) =>
        new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    }));
    const res = await handleHttpToolRequest(MAKE_REQ(), MAKE_EXTRAS());
    expect(res.status).toBe(504);
  });

  it('returns 500 for handler error', async () => {
    registerProjectedTool(makeTool({ fn: async () => { throw new Error('boom'); } }));
    const res = await handleHttpToolRequest(MAKE_REQ(), MAKE_EXTRAS());
    expect(res.status).toBe(500);
  });

  it('attaches principal + tx when bearer resolves', async () => {
    let captured: { hasPrincipal: boolean; hasTx: boolean } = { hasPrincipal: false, hasTx: false };
    registerProjectedTool(makeTool({
      fn: async (_input, ctx) => {
        captured = { hasPrincipal: !!ctx.principal, hasTx: !!ctx.tx };
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    }));
    await handleHttpToolRequest(
      MAKE_REQ({ headers: { authorization: 'Bearer test-token' } }),
      MAKE_EXTRAS({
        resolvePrincipalAndTx: vi.fn(async () => ({
          principal: { slug: 'test', workspaceId: 'default', capabilities: new Set() },
          tx: { fake: 'tx' },
        })),
      }),
    );
    expect(captured).toEqual({ hasPrincipal: true, hasTx: true });
  });

  it('proceeds without principal when bearer absent', async () => {
    registerProjectedTool(makeTool());
    const res = await handleHttpToolRequest(MAKE_REQ(), MAKE_EXTRAS());
    expect(res.status).toBe(200);
  });
});

/* ─── Streaming variant ──────────────────────────────────────────────── */

import type { SseSink } from '@restart/sse';

interface RecordedEvent { event: string; data: unknown }

function recordingSink(): { sink: SseSink; events: RecordedEvent[]; closed: () => boolean } {
  const events: RecordedEvent[] = [];
  let isClosed = false;
  const closeHandlers: Array<() => void> = [];
  const sink: SseSink = {
    event(name, data) { if (!isClosed) events.push({ event: name, data }); },
    eventRaw(name, data) { if (!isClosed) events.push({ event: name, data }); },
    comment() { /* ignored in tests */ },
    heartbeat() { if (!isClosed) events.push({ event: 'heartbeat', data: { tsMs: Date.now() } }); },
    done(payload) {
      if (isClosed) return;
      events.push({ event: 'done', data: payload ?? null });
      isClosed = true;
      for (const fn of closeHandlers) try { fn(); } catch { /* ignore */ }
    },
    close() {
      if (isClosed) return;
      isClosed = true;
      for (const fn of closeHandlers) try { fn(); } catch { /* ignore */ }
    },
    onClose(fn) {
      if (isClosed) { try { fn(); } catch { /* ignore */ } return; }
      closeHandlers.push(fn);
    },
    get closed() { return isClosed; },
  };
  return { sink, events, closed: () => isClosed };
}

describe('handleHttpToolRequestStreaming', () => {
  it('emits a single done event for non-streaming tools', async () => {
    registerProjectedTool(makeTool());
    const { sink, events, closed } = recordingSink();
    await handleHttpToolRequestStreaming(MAKE_REQ({ body: { x: 1 } }), MAKE_EXTRAS(), sink);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('done');
    expect(events[0]?.data).toEqual(expect.any(Array));
    expect(closed()).toBe(true);
  });

  it('emits progress events when the function calls ctx.progress(), then a final done', async () => {
    registerProjectedTool(makeTool({
      fn: async (_input, ctx) => {
        ctx.progress(0, 'starting');
        ctx.progress(50, 'halfway');
        ctx.progress(100, 'done');
        return { content: [{ type: 'text', text: 'finished' }] };
      },
    }));
    const { sink, events } = recordingSink();
    await handleHttpToolRequestStreaming(MAKE_REQ(), MAKE_EXTRAS(), sink);
    const progressEvents = events.filter((e) => e.event === 'progress');
    const doneEvents = events.filter((e) => e.event === 'done');
    expect(progressEvents).toHaveLength(3);
    expect(doneEvents).toHaveLength(1);
    expect(progressEvents[0]?.data).toMatchObject({ progress: 0, message: 'starting' });
    expect(progressEvents[2]?.data).toMatchObject({ progress: 100, message: 'done' });
    expect(doneEvents[0]?.data).toEqual([{ type: 'text', text: 'finished' }]);
  });

  it('emits each ctx.emit call as a wire event, then done with result.content', async () => {
    registerProjectedTool(makeTool({
      fn: async (_input, ctx) => {
        ctx.emit('delta', { text: 'hello' });
        ctx.emit('delta', { text: ' world' });
        ctx.emit('cost', { usd: 0.0012 });
        return { content: [{ type: 'text', text: 'hello world' }] };
      },
    }));
    const { sink, events } = recordingSink();
    await handleHttpToolRequestStreaming(MAKE_REQ(), MAKE_EXTRAS(), sink);
    const order = events.map((e) => e.event);
    expect(order).toEqual(['delta', 'delta', 'cost', 'done']);
    expect(events[0]?.data).toEqual({ text: 'hello' });
    expect(events[2]?.data).toEqual({ usd: 0.0012 });
    expect(events[3]?.data).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('emits z.string() events as raw text via sink.eventRaw', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { z } = require('zod') as typeof import('zod');
    registerProjectedTool(makeTool({
      events: { delta: z.string() },
      fn: async (_input, ctx) => {
        ctx.emit('delta', 'hello');
        ctx.emit('delta', 'world');
        return { content: [{ type: 'text', text: 'hello world' }] };
      },
    }));
    const { sink, events } = recordingSink();
    await handleHttpToolRequestStreaming(MAKE_REQ(), MAKE_EXTRAS(), sink);
    expect(events[0]).toEqual({ event: 'delta', data: 'hello' });
    expect(events[1]).toEqual({ event: 'delta', data: 'world' });
    expect(events[2]).toMatchObject({ event: 'done' });
  });

  it('emits object-schema events JSON-stringified via sink.event', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { z } = require('zod') as typeof import('zod');
    registerProjectedTool(makeTool({
      events: { cost: z.object({ usd: z.number() }) },
      fn: async (_input, ctx) => {
        ctx.emit('cost', { usd: 0.5 });
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    }));
    const { sink, events } = recordingSink();
    await handleHttpToolRequestStreaming(MAKE_REQ(), MAKE_EXTRAS(), sink);
    expect(events[0]).toEqual({ event: 'cost', data: { usd: 0.5 } });
  });

  it('emits an error event when the tool fails (404 / 405 / handler error)', async () => {
    const { sink, events } = recordingSink();
    await handleHttpToolRequestStreaming(
      MAKE_REQ({ pathname: '/api/plugins/missing/tool' }),
      MAKE_EXTRAS(),
      sink,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('error');
    expect(events[0]?.data).toMatchObject({ code: 'unknown_tool' });
  });

  it('emits an error event for handler error during dispatch', async () => {
    registerProjectedTool(makeTool({ fn: async () => { throw new Error('boom'); } }));
    const { sink, events } = recordingSink();
    await handleHttpToolRequestStreaming(MAKE_REQ(), MAKE_EXTRAS(), sink);
    const error = events.find((e) => e.event === 'error');
    expect(error).toBeDefined();
    expect((error!.data as { code: string }).code).toBe('handler_error');
  });
});
