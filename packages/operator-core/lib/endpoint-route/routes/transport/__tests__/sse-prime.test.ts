/**
 * primeSseResponse — the streamable-HTTP SSE header-flush priming seam.
 *
 * A blocking tools/call (chat:ask_choice awaiting a pick) opens an
 * event-stream and writes nothing until the tool resolves; proxies built on
 * node http-proxy (the :3055 Vite dev proxy) hold the response headers until
 * the first body byte. The wrapper prepends one spec-legal SSE comment so
 * headers traverse every hop immediately. Live pin:
 * lib/__tests__/ask-choice-e2e.integration.test.ts ("tool reachable" case).
 */
import { describe, it, expect } from 'vitest';
import { primeSseResponse } from '../_mcp-handler';

function sseResponse(body: ReadableStream<Uint8Array> | null): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
}

describe('primeSseResponse', () => {
  it('prepends an SSE comment as the FIRST chunk, then forwards the original chunks', async () => {
    const enc = new TextEncoder();
    const inner = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"ok":true}\n\n'));
        c.close();
      },
    });
    const primed = primeSseResponse(sseResponse(inner));
    expect(primed.status).toBe(200);
    expect(primed.headers.get('content-type')).toBe('text/event-stream');

    const chunks: string[] = [];
    const reader = primed.body!.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(dec.decode(value));
    }
    expect(chunks[0]).toBe(':stream-open\n\n');
    expect(chunks.slice(1).join('')).toBe('data: {"ok":true}\n\n');
  });

  it('emits the priming comment even when the inner stream NEVER produces (the blocking-tool shape)', async () => {
    // Inner stream stays open forever — like ask_choice awaiting a pick.
    const inner = new ReadableStream<Uint8Array>({ start() {/* never enqueues */} });
    const primed = primeSseResponse(sseResponse(inner));
    const reader = primed.body!.getReader();
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('priming byte never arrived')), 1000)),
    ]);
    expect(new TextDecoder().decode(first.value!)).toBe(':stream-open\n\n');
    await reader.cancel();
  });

  it('passes non-SSE responses through untouched (same object)', () => {
    const res = new Response('{"jsonrpc":"2.0"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    expect(primeSseResponse(res)).toBe(res);
  });

  // EI-12 regression. mcp-handler's createServerResponseAdapter exposes the
  // response body as a ReadableStream whose controller the library writes to
  // from a DETACHED pump (`res.write` → `controller.enqueue`). If the wrapper
  // force-cancels that stream on client disconnect, its controller closes and
  // the library's next write throws TypeError[ERR_INVALID_STATE] "Controller
  // is already closed" from a void-ed promise → unhandledRejection → the whole
  // operator host crash-loops under MCP load. The wrapper must therefore DRAIN
  // the inner stream on disconnect, never force-close it — mcp-handler's own
  // res.end() is the only safe closer of that controller.
  it('EI-12: a producer write AFTER client disconnect does not throw (no enqueue-after-close crash)', async () => {
    const enc = new TextEncoder();
    let innerController!: ReadableStreamDefaultController<Uint8Array>;
    const inner = new ReadableStream<Uint8Array>({
      start(c) {
        innerController = c;
        c.enqueue(enc.encode('data: 1\n\n'));
      },
    });
    const primed = primeSseResponse(sseResponse(inner));
    const reader = primed.body!.getReader();
    await reader.read(); // priming comment
    await reader.read(); // first data frame
    await reader.cancel('client-gone'); // client disconnects mid-stream

    // mcp-handler's pump writes one more frame after the disconnect. Pre-fix
    // (the wrapper propagated reader.cancel) this enqueue throws; the fix
    // drains instead, leaving the controller open so the producer is safe.
    let threw = false;
    try {
      innerController.enqueue(enc.encode('data: 2\n\n'));
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // mcp-handler eventually calls res.end() → the inner controller closes
    // cleanly (the only safe closer); the wrapper's drain ends with it.
    innerController.close();
  });

  it('drains the inner stream after client disconnect until the producer ends it', async () => {
    const enc = new TextEncoder();
    let innerController!: ReadableStreamDefaultController<Uint8Array>;
    let pulls = 0;
    const inner = new ReadableStream<Uint8Array>({
      start(c) {
        innerController = c;
      },
      pull() {
        pulls += 1;
      },
    });
    const primed = primeSseResponse(sseResponse(inner));
    const reader = primed.body!.getReader();
    await reader.read(); // priming comment
    await reader.cancel('client-gone');

    // After disconnect the wrapper keeps reading the inner stream so the
    // producer never backs up against an unread (or closed) controller.
    innerController.enqueue(enc.encode('data: a\n\n'));
    innerController.enqueue(enc.encode('data: b\n\n'));
    // Closing from the producer side (mcp-handler's res.end()) must not throw
    // and must let the background drain complete.
    expect(() => innerController.close()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(pulls).toBeGreaterThan(0); // the drain actually consumed the stream
  });
});
