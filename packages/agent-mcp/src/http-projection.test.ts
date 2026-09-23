/**
 * Tests for the HTTP transport adapter.
 * Run with: npx vitest run packages/agent-mcp/src/http-projection.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  handleHttpToolRequest,
  handleHttpToolRequestStreaming,
  buildHttpSpawnContext,
  type HttpToolHostExtras,
  type HttpToolRequest,
} from '@papercusp/tooldef-http';
import {
  registerProjectedTool,
  _resetProjectionRegistryForTests,
  type ProjectedTool,
} from '@papercusp/tooldef';
import { papercuspComputeQuotaWindow } from './quota-policy';

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
        'x-papercusp-client': 'su-abc',
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
      uiClientId: 'su-abc',
    });
  });

  it('falls back to URL search params when headers absent', () => {
    const ctx = buildHttpSpawnContext({
      headers: {},
      searchParams: new URLSearchParams('workspace=default&harness=sheets&role=architect&run=run_X&spawn=spw_X&client=cli_X'),
    });
    expect(ctx).toMatchObject({
      workspaceId: 'default',
      harnessSlug: 'sheets',
      role: 'architect',
      runId: 'run_X',
      spawnId: 'spw_X',
      uiClientId: 'cli_X',
    });
  });

  it('headers take precedence over query params', () => {
    const ctx = buildHttpSpawnContext({
      headers: { 'x-papercusp-role': 'architect' },
      searchParams: new URLSearchParams('role=worker'),
    });
    expect(ctx.role).toBe('architect');
  });

  it('the x-papercusp-client header overrides a static ?client= (OMP per-session id)', () => {
    // OMP can't env-interpolate its mcp.json url, so its `?client=` stays
    // the static machine id; but OMP DOES resolve header values at connect
    // time, so the per-launch SID rides x-papercusp-client and — header-first
    // — wins. (Claude/Codex put the SID in ?client= directly.)
    const ctx = buildHttpSpawnContext({
      headers: {
        'x-papercusp-client': 'su-per-session',
        'mcp-session-id': 'transport-session',
      },
      searchParams: new URLSearchParams('superuser=1&client=28dbf719-machine-id'),
    });
    expect(ctx.uiClientId).toBe('su-per-session');
  });

  it('uses Mcp-Session-Id before a static client query for superuser requests only', () => {
    const superuserCtx = buildHttpSpawnContext({
      headers: { 'mcp-session-id': 'su-live-session' },
      searchParams: new URLSearchParams('superuser=1&client=28dbf719-machine-id'),
    });
    const ordinaryCtx = buildHttpSpawnContext({
      headers: { 'mcp-session-id': 'transport-only' },
      searchParams: new URLSearchParams(),
    });

    expect(superuserCtx.uiClientId).toBe('su-live-session');
    expect(ordinaryCtx.uiClientId).toBeUndefined();
  });

  it('returns null/undefined fields when nothing is supplied', () => {
    const ctx = buildHttpSpawnContext({ headers: {}, searchParams: new URLSearchParams() });
    expect(ctx.workspaceId).toBeUndefined();
    expect(ctx.featureId).toBeNull();
    expect(ctx.chunkId).toBeNull();
    expect(ctx.uiClientId).toBeUndefined();
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

  it('JSON path defaults a runId when caller did not supply one (askUser/publishState gate)', async () => {
    // Pre-fix: bearer-auth JSON callers got ctx.runId === undefined, so
    // ctx.askUser and ctx.publishState were never installed by the
    // dispatcher (both gated on workspaceId + runId). chat:ask_choice
    // returned "no_chat_surface"; state-shaped tools returned
    // "no_state_channel". Found during pass-9 E2E audit.
    let seenRunId: string | undefined;
    registerProjectedTool(makeTool({
      fn: async (_input, ctx) => {
        seenRunId = ctx.runId;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    }));
    const res = await handleHttpToolRequest(
      MAKE_REQ({ headers: { 'x-papercusp-workspace': 'default' } }),
      MAKE_EXTRAS(),
    );
    expect(res.status).toBe(200);
    expect(seenRunId).toBeTruthy();
    // Should be a fresh UUID-shaped string, not 'standalone' or undefined.
    expect(seenRunId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^run-/);
  });

  it('JSON path respects explicitly-supplied runId (resume / cross-tool correlation)', async () => {
    let seenRunId: string | undefined;
    registerProjectedTool(makeTool({
      fn: async (_input, ctx) => {
        seenRunId = ctx.runId;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    }));
    const res = await handleHttpToolRequest(
      MAKE_REQ({ headers: { 'x-papercusp-run': 'caller-supplied-run-id-1234' } }),
      MAKE_EXTRAS(),
    );
    expect(res.status).toBe(200);
    expect(seenRunId).toBe('caller-supplied-run-id-1234');
  });

  it('returns 403 for role_not_allowed', async () => {
    registerProjectedTool(makeTool({ agentRoles: ['architect'] }));
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
          // Real Papercusp policy: worker → chunk:<id> window, perChunk cap.
          computeQuotaWindow: papercuspComputeQuotaWindow,
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
      needsWorkspaceTx: true,
      fn: async (_input, ctx) => {
        captured = { hasPrincipal: !!ctx.principal, hasTx: !!ctx.tx };
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    }));
    await handleHttpToolRequest(
      MAKE_REQ({ headers: { authorization: 'Bearer test-token' } }),
      MAKE_EXTRAS({
        resolvePrincipalAndTx: vi.fn(async () => ({
          principal: {
            kind: 'system',
            slug: 'test',
            workspaceId: 'default',
            capabilities: new Set(),
            authMethod: 'process-internal',
            trust: 'trusted',
          },
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

import type { SseSink } from '@papercusp/sse';

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

  it('emits binary events as base64 over SSE (HTTP transport)', async () => {
    // Regression: ctx.emit(name, Uint8Array) used to fall into the
    // generic else branch → sink.event() → JSON.stringify(Uint8Array)
    // which produces {"0":222,"1":173,...} — useless to any consumer.
    // The HTTP path now base64-encodes binary events to match the
    // tools/list discoverability hint (contentEncoding: 'base64'). The
    // IPC path stays raw via EVENT_BIN frames; same emit, different
    // wire per transport.
    registerProjectedTool(makeTool({
      events: { bin: z.instanceof(Uint8Array) },
      eventWireKinds: { bin: 'binary' },
      fn: async (_input, ctx) => {
        ctx.emit('bin', new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    }));
    const { sink, events } = recordingSink();
    await handleHttpToolRequestStreaming(MAKE_REQ(), MAKE_EXTRAS(), sink);
    const bin = events.find((e) => e.event === 'bin');
    expect(bin).toBeDefined();
    // PR F unification (audit item 14): HTTP and MCP transports both
    // emit the same self-describing PapercuspBinaryEnvelope shape so
    // consumers can normalize without out-of-band schema info.
    // 3q2+7w== is hex deadbeef.
    expect(bin!.data).toEqual({
      $papercuspBinary: true,
      encoding: 'base64',
      data: '3q2+7w==',
    });
  });

  it('Phase 4 T2.2 — replays the buffered tail when client reconnects with X-Papercusp-Run + Last-Event-ID', async () => {
    // Setup: register a streaming tool with replayBufferSize.
    // First connect emits 5 events into the buffer; we capture them
    // via dispatchProjectedTool which the streaming entrypoint wraps.
    const { dispatchProjectedTool: dispatch } = await import('@papercusp/tooldef');
    const tool = makeTool({
      events: { delta: z.object({ text: z.string() }) },
      replayBufferSize: 10,
      fn: async (_input, ctx) => {
        for (let i = 1; i <= 5; i++) ctx.emit('delta', { text: `chunk ${i}` });
        return { content: [{ type: 'text', text: 'done' }] };
      },
    });
    registerProjectedTool(tool);
    // First connect — populate the buffer via direct dispatch.
    const firstCtx = {
      log: () => {}, emit: () => {}, progress: () => {},
      workspaceId: 'ws-1', role: 'operator',
      runId: 'run-abc', spawnId: 'spawn-1',
    } as never;
    await dispatch(tool, 'fix.tool', { x: 1 }, firstCtx, {});

    // Reconnect: same runId, Last-Event-ID = 2 → expect events 3,4,5 + done(resumed).
    registerProjectedTool(tool); // re-register so dispatcher accessible
    const { sink, events } = recordingSink();
    await handleHttpToolRequestStreaming(
      MAKE_REQ({
        headers: {
          'x-papercusp-workspace': 'ws-1',
          'x-papercusp-run': 'run-abc',
          'last-event-id': '2',
        },
      }),
      MAKE_EXTRAS(),
      sink,
    );
    const deltas = events.filter((e) => e.event === 'delta');
    expect(deltas).toHaveLength(3);
    expect(deltas[0]?.data).toEqual({ text: 'chunk 3' });
    expect(deltas[2]?.data).toEqual({ text: 'chunk 5' });
    const done = events.find((e) => e.event === 'done');
    expect(done?.data).toMatchObject({ resumed: true, replayed: 3 });
  });

  it('Phase 4 T2.2 — first connect (no Last-Event-ID) skips replay, runs the tool normally', async () => {
    let runCount = 0;
    registerProjectedTool(makeTool({
      events: { delta: z.object({ text: z.string() }) },
      replayBufferSize: 10,
      fn: async (_input, ctx) => {
        runCount++;
        ctx.emit('delta', { text: 'fresh' });
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    }));
    const { sink, events } = recordingSink();
    await handleHttpToolRequestStreaming(
      MAKE_REQ({
        headers: { 'x-papercusp-workspace': 'ws-1', 'x-papercusp-run': 'never-seen' },
        // NO last-event-id header
      }),
      MAKE_EXTRAS(),
      sink,
    );
    expect(runCount).toBe(1);
    const delta = events.find((e) => e.event === 'delta');
    expect(delta?.data).toEqual({ text: 'fresh' });
  });

  it('audit5: superuser path generates a UNIQUE runId per request (not shared "standalone" sentinel)', async () => {
    // Pre-fix: http-projection defaulted runId to "standalone" when no
    // ?run= param was provided. claude-code spawned via mcp-remote
    // reuses ONE URL for many tool calls → all calls share runId →
    // first-finishing tool's cancelPendingCardsForRun wipes others'
    // pending askUser cards. Cross-cancellation hazard.
    //
    // Post-fix: per-request UUID. Each tool invocation under the same
    // claude-code subprocess gets its own runId.
    const seenRunIds: string[] = [];
    registerProjectedTool(makeTool({
      requirePrincipal: false,
      fn: async (_input, ctx) => {
        seenRunIds.push(ctx.runId ?? 'MISSING');
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    }));
    const reqA = MAKE_REQ({
      searchParams: new URLSearchParams('superuser=1'),
    });
    const reqB = MAKE_REQ({
      searchParams: new URLSearchParams('superuser=1'),
    });
    const extras = MAKE_EXTRAS({ validateSuperuser: () => true });
    await handleHttpToolRequest(reqA, extras);
    await handleHttpToolRequest(reqB, extras);
    expect(seenRunIds).toHaveLength(2);
    // Both UUIDs, distinct.
    expect(seenRunIds[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(seenRunIds[1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(seenRunIds[0]).not.toBe(seenRunIds[1]);
    // Confirm we're NOT defaulting to the old 'standalone' sentinel.
    expect(seenRunIds).not.toContain('standalone');
  });

  describe('?superuser=1 must be validated — reject, never fall through to anonymous dispatch', () => {
    it('rejects with 401 and does NOT run the tool when validateSuperuser returns false', async () => {
      const fn = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ran' }] }));
      registerProjectedTool(makeTool({ requirePrincipal: false, fn }));
      const res = await handleHttpToolRequest(
        MAKE_REQ({ searchParams: new URLSearchParams('superuser=1') }),
        MAKE_EXTRAS({ validateSuperuser: () => false }),
      );
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: { code: 'unauthorized' } });
      expect(fn).not.toHaveBeenCalled();
    });

    it('rejects with 401 when ?superuser=1 but NO validateSuperuser is provided (absent validator ⇒ deny)', async () => {
      const fn = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ran' }] }));
      registerProjectedTool(makeTool({ requirePrincipal: false, fn }));
      const res = await handleHttpToolRequest(
        MAKE_REQ({ searchParams: new URLSearchParams('superuser=1') }),
        MAKE_EXTRAS(), // host did not wire a superuser validator at all
      );
      expect(res.status).toBe(401);
      expect(fn).not.toHaveBeenCalled();
    });

    it('admits and runs the tool when validateSuperuser returns true', async () => {
      const fn = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ran' }] }));
      registerProjectedTool(makeTool({ requirePrincipal: false, fn }));
      const res = await handleHttpToolRequest(
        MAKE_REQ({ searchParams: new URLSearchParams('superuser=1') }),
        MAKE_EXTRAS({ validateSuperuser: () => true }),
      );
      expect(res.status).toBe(200);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('defaults a client-less admitted superuser to the stable su-http-loopback identity (EI-334)', async () => {
      // Pre-fix: no `?client=` / x-papercusp-client ⇒ ctx.uiClientId=null ⇒
      // resolveAgentIdentity THROWS for superuser callers, so the advertised
      // curl-able admin triggers (cup:spawn et al.) failed deterministically
      // and fired the structural tool-error watchdog key.
      const seen: Array<string | null | undefined> = [];
      registerProjectedTool(makeTool({
        requirePrincipal: false,
        fn: async (_input, ctx) => {
          seen.push(ctx.uiClientId);
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      }));
      const res = await handleHttpToolRequest(
        MAKE_REQ({ searchParams: new URLSearchParams('superuser=1') }),
        MAKE_EXTRAS({ validateSuperuser: () => true }),
      );
      expect(res.status).toBe(200);
      expect(seen).toEqual(['su-http-loopback']);
    });

    it('an explicit client id still wins over the superuser default', async () => {
      const seen: Array<string | null | undefined> = [];
      registerProjectedTool(makeTool({
        requirePrincipal: false,
        fn: async (_input, ctx) => {
          seen.push(ctx.uiClientId);
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      }));
      await handleHttpToolRequest(
        MAKE_REQ({ searchParams: new URLSearchParams('superuser=1&client=su-real-session') }),
        MAKE_EXTRAS({ validateSuperuser: () => true }),
      );
      expect(seen).toEqual(['su-real-session']);
    });

    it('uses the authenticated MCP session id before a static client fallback', async () => {
      const seen: Array<string | null | undefined> = [];
      registerProjectedTool(makeTool({
        requirePrincipal: false,
        fn: async (_input, ctx) => {
          seen.push(ctx.uiClientId);
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      }));
      const res = await handleHttpToolRequest(
        MAKE_REQ({
          headers: { 'mcp-session-id': 'su-live-session' },
          searchParams: new URLSearchParams('superuser=1&client=28dbf719-machine-id'),
        }),
        MAKE_EXTRAS({ validateSuperuser: () => true }),
      );

      expect(res.status).toBe(200);
      expect(seen).toEqual(['su-live-session']);
    });

    it('a NON-superuser call gets no identity default (unattributable stays rejected downstream)', async () => {
      const seen: Array<string | null | undefined> = [];
      registerProjectedTool(makeTool({
        requirePrincipal: false,
        fn: async (_input, ctx) => {
          seen.push(ctx.uiClientId);
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      }));
      await handleHttpToolRequest(MAKE_REQ(), MAKE_EXTRAS());
      expect(seen).toEqual([undefined]);
    });
  });

  it('auto-error honors schema-inferred wire kind (raw text for z.string())', async () => {
    // Regression: tools declaring `error: z.string()` (architect/brainstorm)
    // expect raw text on the wire so the submodule consumer can do
    // accum += data. The framework's auto-error path was always emitting
    // JSON envelope until round-3 audit. Verify the eventWireKinds.error
    // === 'string' branch produces a raw-string sink event.
    registerProjectedTool(makeTool({
      events: { error: z.string() },
      eventWireKinds: { error: 'string' },
      fn: async () => { throw new Error('raw-text-message'); },
    }));
    const { sink, events } = recordingSink();
    await handleHttpToolRequestStreaming(MAKE_REQ(), MAKE_EXTRAS(), sink);
    const error = events.find((e) => e.event === 'error');
    expect(error).toBeDefined();
    // Data is the raw message text, not a {code, message} envelope.
    expect(typeof error!.data).toBe('string');
    expect(error!.data).toContain('raw-text-message');
  });
});
