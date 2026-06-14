/**
 * EI-127 regression guard — mcp-handler's stateless POST path must CLOSE the
 * per-request McpServer + transport it creates.
 *
 * The `:3070` operator host leaked retained heap ~0.2 GB/min under fleet load
 * (memory-watchdog.ts docstring, 2026-06-07) → RSS hit the 3.2 GB watchdog
 * threshold → "recycles every ~12 min". Root cause: every spawned agent's every
 * MCP call is an HTTP POST to `/api/mcp`, and mcp-handler@1.1.0's POST branch
 * (dist/index.mjs ~L302) does `new McpServer()` + `new transport()` +
 * `server.connect()` per request but — unlike its SSE branch (which calls
 * `server.server.close()` + `transport.close()`) — NEVER closes them. Nothing
 * reclaims them (the 30s sweeper only walks the SSE `servers[]` array, which the
 * POST branch never populates, and SSE is disabled here), so the per-request
 * McpServer object graph (6 handler closures over the tool catalog + the SDK
 * Protocol's response/progress/abort Maps + the transport) is retained until the
 * process recycles.
 *
 * The fix is a patch-package patch adding a `finally` that closes server +
 * transport on the POST path (patches/mcp-handler+1.1.0.patch). This test PROVES
 * it: it drives N POSTs through a handler built exactly as the operator builds
 * it and asserts the per-request server is closed once per request. Without the
 * patch, `closed` is 0 (the leak); with it, `closed === N`.
 */
import { describe, it, expect } from 'vitest';
import { createMcpHandler } from 'mcp-handler';

describe('mcp-handler POST path — per-request server lifecycle (EI-127)', () => {
  it('closes the per-request McpServer once per POST (no leak)', async () => {
    let created = 0;
    let closed = 0;

    // Mirror the operator: pass an initializeServer callback. It runs once per
    // POST with the freshly-created McpServer — the same hook the real handler
    // uses to register tools — so we can observe the per-request server and wrap
    // its close() to count teardowns.
    const handler = createMcpHandler(
      (server: { server: { close: () => Promise<void> } }) => {
        created += 1;
        const orig = server.server.close.bind(server.server);
        server.server.close = async () => {
          closed += 1;
          return orig();
        };
      },
      {},
      // Stateless streamable-HTTP, SSE disabled — exactly the operator's config
      // (_mcp-handler.ts: disableSse: true).
      { disableSse: true },
    );

    const N = 20;
    for (let i = 0; i < N; i++) {
      // Default streamableHttpEndpoint is "/mcp" (no basePath configured here).
      // Accept: application/json (without text/event-stream) makes the transport
      // return a single finite JSON response (a 406 "must accept both") rather
      // than open a never-ending SSE stream — so the request completes (res.end)
      // and the per-request server lifecycle (create → handle → close) runs to
      // completion, which is exactly what we're asserting. The server is created
      // BEFORE handleRequest regardless of the 406, so this faithfully exercises
      // the leak: created==N always; closed==N only once the POST path closes.
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: i,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'leak-guard', version: '1.0.0' },
          },
        }),
      });
      // The SDK auto-handles `initialize`; even an error response still creates
      // (and, once patched, closes) the server, so swallow per-request rejects.
      try {
        const res = await (handler as (r: Request) => Promise<Response>)(req);
        // Drain the (finite, 406) body so the per-request response fully settles.
        await res.text().catch(() => {});
      } catch {
        /* request-handling errors are irrelevant — we assert the lifecycle */
      }
    }

    expect(created).toBe(N);
    // The guard: every per-request server is torn down. Pre-patch this is 0.
    expect(closed).toBe(N);
  });
});
