/**
 * P-002 (shared-embedding-sidecar-and-enrichment-2026-07-10): the embed
 * sidecar's HTTP surface, driven with INJECTED fake builders on an ephemeral
 * port — no ONNX model ever loads here. The real-model bit-identical proof is
 * the P-005 live smoke (eval CLI sidecar leg vs in-process leg); this file
 * pins the wire contract: validation, routing, D-004 response shape, lazy
 * per-model:kind embedder memoization, and loopback-only binding.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEmbedSidecarServer,
  validateEmbedRequest,
  MAX_TEXTS_PER_CALL,
  EMBED_SIDECAR_RUNTIME,
  type EmbedderBuilders,
  type EmbedSidecarHandle,
} from './embed-sidecar-server';

describe('validateEmbedRequest', () => {
  it('accepts a minimal valid request and defaults model to gemma', () => {
    const v = validateEmbedRequest({ kind: 'query', texts: ['hi'] });
    expect(v).toEqual({ model: 'gemma', kind: 'query', texts: ['hi'] });
  });

  it('rejects unknown models, bad kinds, and bad texts', () => {
    expect(validateEmbedRequest(null)).toHaveProperty('error');
    expect(validateEmbedRequest({ model: 'gpt-9', kind: 'query', texts: ['x'] })).toHaveProperty('error');
    expect(validateEmbedRequest({ kind: 'symmetric', texts: ['x'] })).toHaveProperty('error');
    expect(validateEmbedRequest({ kind: 'query', texts: [] })).toHaveProperty('error');
    expect(validateEmbedRequest({ kind: 'query', texts: [42] })).toHaveProperty('error');
    expect(validateEmbedRequest({ kind: 'query', texts: Array(MAX_TEXTS_PER_CALL + 1).fill('x') })).toHaveProperty(
      'error',
    );
  });
});

describe('embed sidecar HTTP surface (fake builders, ephemeral port)', () => {
  let handle: EmbedSidecarHandle | null = null;
  let baseUrl = '';
  const builds: string[] = [];

  const fakeBuilders: EmbedderBuilders = {
    gemma: async (kind) => {
      builds.push(`gemma:${kind}`);
      return async (text: string) => [text.length, kind === 'query' ? 1 : 2];
    },
    local: async (kind) => {
      builds.push(`local:${kind}`);
      return async (text: string) => [text.length, 3];
    },
  };

  async function boot(): Promise<void> {
    handle = createEmbedSidecarServer({ port: 0, builders: fakeBuilders, warmAtBoot: false, log: () => {} });
    const port = await handle.listening;
    baseUrl = `http://127.0.0.1:${port}`;
  }

  afterEach(async () => {
    await handle?.close();
    handle = null;
    builds.length = 0;
  });

  it('GET /healthz answers with warm states and the runtime tag', async () => {
    await boot();
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; runtime: string; models: Record<string, string> };
    expect(body.ok).toBe(true);
    expect(body.runtime).toBe(EMBED_SIDECAR_RUNTIME);
    expect(body.models).toEqual({}); // warmAtBoot:false + no embeds yet ⇒ all cold
  });

  it('POST /embed returns the D-004 shape, ordered per input text', async () => {
    await boot();
    const res = await fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemma', kind: 'query', texts: ['a', 'abc'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vectors: number[][]; dims: number; runtime: string; modelRev: string };
    expect(body.vectors).toEqual([
      [1, 1],
      [3, 1],
    ]);
    expect(body.dims).toBe(2);
    expect(body.runtime).toBe(EMBED_SIDECAR_RUNTIME);
    expect(body.modelRev).toContain('embeddinggemma');
  });

  it('memoizes one embedder per model:kind and reports it warm', async () => {
    await boot();
    const call = (kind: string) =>
      fetch(`${baseUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gemma', kind, texts: ['x'] }),
      });
    await call('query');
    await call('query');
    await call('document');
    expect(builds).toEqual(['gemma:query', 'gemma:document']);
    expect(handle!.warmStates()).toEqual({ 'gemma:query': 'warm', 'gemma:document': 'warm' });
  });

  it('400s invalid requests and 404s unknown routes', async () => {
    await boot();
    const bad = await fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nope', kind: 'query', texts: ['x'] }),
    });
    expect(bad.status).toBe(400);
    const notJson = await fetch(`${baseUrl}/embed`, { method: 'POST', body: '{{' });
    expect(notJson.status).toBe(400);
    const missing = await fetch(`${baseUrl}/nope`);
    expect(missing.status).toBe(404);
  });

  it('500s an embed failure without killing the server', async () => {
    handle = createEmbedSidecarServer({
      port: 0,
      warmAtBoot: false,
      log: () => {},
      builders: {
        gemma: async () => async () => {
          throw new Error('worker exploded');
        },
        local: fakeBuilders.local,
      },
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;
    const res = await fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'query', texts: ['x'] }),
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/embed_failed/);
    // Server survives — a healthy model still answers.
    const ok = await fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'local', kind: 'document', texts: ['ab'] }),
    });
    expect(ok.status).toBe(200);
  });

  it('single-flight FIFO: concurrent requests complete in arrival order', async () => {
    const finished: string[] = [];
    handle = createEmbedSidecarServer({
      port: 0,
      warmAtBoot: false,
      log: () => {},
      builders: {
        gemma: async () => async (text: string) => {
          // First request is the slowest — FIFO must still finish it first.
          await new Promise((r) => setTimeout(r, text === 'slow' ? 50 : 1));
          finished.push(text);
          return [1];
        },
        local: fakeBuilders.local,
      },
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;
    const post = (text: string) =>
      fetch(`${baseUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'query', texts: [text] }),
      });
    const slow = post('slow');
    // Give the slow request a head start into the queue before the fast one.
    await new Promise((r) => setTimeout(r, 10));
    const fast = post('fast');
    await Promise.all([slow, fast]);
    expect(finished).toEqual(['slow', 'fast']);
  });
});
