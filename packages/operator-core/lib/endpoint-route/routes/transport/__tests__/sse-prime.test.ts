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

  it('propagates cancel to the inner stream so blocking tools observe the abort', async () => {
    let cancelled: unknown = null;
    const inner = new ReadableStream<Uint8Array>({
      start() {/* never enqueues */},
      cancel(reason) {
        cancelled = reason ?? 'cancelled';
      },
    });
    const primed = primeSseResponse(sseResponse(inner));
    const reader = primed.body!.getReader();
    await reader.read(); // consume the priming comment
    await reader.cancel('client-gone');
    expect(cancelled).toBe('client-gone');
  });
});
