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
  resolveWarmModels,
  validateEmbedRequest,
  EMBED_SIDECAR_WARM_ENV,
  MAX_TEXTS_PER_CALL,
  EMBED_SIDECAR_RUNTIME,
  type EmbedderBuilders,
  type EmbedSidecarHandle,
} from './embed-sidecar-server';

describe('resolveWarmModels', () => {
  it('defaults to gemma when unset/blank', () => {
    expect(resolveWarmModels({})).toEqual(['gemma']);
    expect(resolveWarmModels({ [EMBED_SIDECAR_WARM_ENV]: '  ' })).toEqual(['gemma']);
  });

  it('parses a comma list, trims, dedupes, and drops unknown names', () => {
    expect(resolveWarmModels({ [EMBED_SIDECAR_WARM_ENV]: 'gemma, harrier' })).toEqual(['gemma', 'harrier']);
    expect(resolveWarmModels({ [EMBED_SIDECAR_WARM_ENV]: 'harrier,harrier,gpt-9' })).toEqual(['harrier']);
  });

  it('falls back to gemma when every name is unknown', () => {
    expect(resolveWarmModels({ [EMBED_SIDECAR_WARM_ENV]: 'gpt-9,nope' })).toEqual(['gemma']);
  });
});

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
    harrier: async (kind) => {
      builds.push(`harrier:${kind}`);
      return async (text: string) => [text.length, kind === 'query' ? 4 : 5];
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
        harrier: fakeBuilders.harrier,
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

  it('coalesces CONCURRENT identical texts into one inference (WI-4196)', async () => {
    // The mem0 per-scope fan-out case: N parallel requests, same query text.
    let embedCalls = 0;
    handle = createEmbedSidecarServer({
      port: 0,
      warmAtBoot: false,
      log: () => {},
      builders: {
        gemma: async () => async (text: string) => {
          embedCalls++;
          await new Promise((r) => setTimeout(r, 20)); // hold so the peers arrive mid-flight
          return [text.length, embedCalls];
        },
        local: fakeBuilders.local,
        harrier: fakeBuilders.harrier,
      },
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;
    const post = () =>
      fetch(`${baseUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'query', texts: ['same query'] }),
      }).then((r) => r.json() as Promise<{ vectors: number[][] }>);
    const [a, b, c] = await Promise.all([post(), post(), post()]);
    expect(embedCalls).toBe(1);
    expect(a.vectors).toEqual([[10, 1]]);
    expect(b.vectors).toEqual(a.vectors);
    expect(c.vectors).toEqual(a.vectors);
  });

  it('serves repeats from the LRU, keys per model:kind, and reports cache stats', async () => {
    let embedCalls = 0;
    handle = createEmbedSidecarServer({
      port: 0,
      warmAtBoot: false,
      log: () => {},
      builders: {
        gemma: async (kind) => async (text: string) => {
          embedCalls++;
          return [text.length, kind === 'query' ? 1 : 2];
        },
        local: fakeBuilders.local,
        harrier: fakeBuilders.harrier,
      },
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;
    const post = (kind: string) =>
      fetch(`${baseUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, texts: ['x'] }),
      });
    await post('query');
    await post('query'); // cache hit
    expect(embedCalls).toBe(1);
    await post('document'); // same text, different kind ⇒ its own inference
    expect(embedCalls).toBe(2);
    const health = (await (await fetch(`${baseUrl}/healthz`)).json()) as {
      cache: { hits: number; misses: number; size: number };
    };
    expect(health.cache).toEqual({ hits: 1, misses: 2, size: 2 });
  });

  it('evicts least-recently-used beyond cacheMax; cacheMax:0 disables caching', async () => {
    let embedCalls = 0;
    const boot1 = async (cacheMax: number) => {
      embedCalls = 0;
      handle = createEmbedSidecarServer({
        port: 0,
        warmAtBoot: false,
        log: () => {},
        cacheMax,
        builders: {
          gemma: async () => async (text: string) => {
            embedCalls++;
            return [text.length];
          },
          local: fakeBuilders.local,
          harrier: fakeBuilders.harrier,
        },
      });
      baseUrl = `http://127.0.0.1:${await handle.listening}`;
    };
    const post = (text: string) =>
      fetch(`${baseUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'query', texts: [text] }),
      });
    await boot1(1);
    await post('a');
    await post('b'); // evicts 'a'
    await post('a'); // re-infers
    expect(embedCalls).toBe(3);
    await handle!.close();
    await boot1(0);
    await post('a');
    await post('a'); // caching disabled ⇒ re-infers
    expect(embedCalls).toBe(2);
  });

  it('does not cache failures: a failed embed retries on the next request', async () => {
    let attempts = 0;
    handle = createEmbedSidecarServer({
      port: 0,
      warmAtBoot: false,
      log: () => {},
      builders: {
        gemma: async () => async (text: string) => {
          attempts++;
          if (attempts === 1) throw new Error('transient worker fault');
          return [text.length];
        },
        local: fakeBuilders.local,
        harrier: fakeBuilders.harrier,
      },
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;
    const post = () =>
      fetch(`${baseUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'query', texts: ['x'] }),
      });
    expect((await post()).status).toBe(500);
    expect((await post()).status).toBe(200); // in-flight entry cleaned up, retried
    expect(attempts).toBe(2);
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
        harrier: fakeBuilders.harrier,
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
