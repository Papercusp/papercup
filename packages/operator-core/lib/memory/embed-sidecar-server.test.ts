/**
 * P-002 (shared-embedding-sidecar-and-enrichment-2026-07-10): the embed
 * sidecar's HTTP surface, driven with INJECTED fake builders on an ephemeral
 * port — no ONNX model ever loads here. The real-model bit-identical proof is
 * the P-005 live smoke (eval CLI sidecar leg vs in-process leg); this file
 * pins the wire contract: validation, routing, D-004 response shape, lazy
 * per-model:kind embedder memoization, and loopback-only binding.
 */
import { getRerankWorkerState, isCoherentTarget } from '@papercusp/rerank';
import { getWorkerState as getMemoryWorkerState } from '@papercusp/memory';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEmbedSidecarServer,
  defaultWorkerStates,
  resolveWarmModels,
  resolveWarmRerankers,
  validateEmbedRequest,
  validateRerankRequest,
  EMBED_SIDECAR_WARM_ENV,
  MAX_TEXTS_PER_CALL,
  EMBED_SIDECAR_CAP_EMBED,
  EMBED_SIDECAR_CAP_HEALTHZ,
  EMBED_SIDECAR_CAP_RERANK,
  EMBED_SIDECAR_RUNTIME,
  type EmbedderBuilders,
  type EmbedSidecarHandle,
  type RerankerBuilders,
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

  it('GET /healthz reports the ACTIVE rerank (device, dtype) pair, and it is always coherent (P-009 D-006)', async () => {
    await boot();
    const body = (await (await fetch(`${baseUrl}/healthz`)).json()) as {
      rerankExecution: { device: string; dtype: string };
    };
    // The pair is what makes this reportable at all: a GPU host whose provider
    // failed to load is demoted to cpu/q8, and search cannot tell you that
    // happened (the engine is fail-safe by design), so /healthz must.
    expect(body.rerankExecution).toBeDefined();
    expect(isCoherentTarget(body.rerankExecution)).toBe(true);
    // Default host, no PAPERCUSP_RERANK_DEVICE ⇒ the CPU pair, both halves.
    expect(body.rerankExecution).toMatchObject({ device: 'cpu', dtype: 'q8' });
  });

  // WI-37696. Both worker modules fall back to INLINE main-thread work when their
  // thread is unavailable, and each has a `disabled` latch that is permanent once
  // tripped. Because the fallback returns identical values, tripping it produces no
  // error, no log and no exit code — the sidecar keeps answering 200 while the one
  // thing it exists for (a warm model OFF the request thread) is silently gone. This
  // is the only place that state is observable, so a missing `workers` block is a
  // real regression, not a cosmetic one.
  it('GET /healthz reports the embedder + reranker worker breakers (the only runtime signal a tripped latch has)', async () => {
    await boot();
    const body = (await (await fetch(`${baseUrl}/healthz`)).json()) as {
      workers: { embedder: Record<string, unknown>; reranker: Record<string, unknown> };
    };

    // Both halves must be present. Reporting one and not the other is the silent
    // half of the defect: whichever is missing can latch off unnoticed.
    for (const state of [body.workers.embedder, body.workers.reranker]) {
      expect(state).toMatchObject({
        alive: expect.any(Boolean),
        // The field to alert on — cold-but-healthy must read `false`, never absent,
        // so a monitor can tell "not tripped" from "not reported".
        disabled: false,
        pendingCount: expect.any(Number),
        keepAlive: expect.any(Boolean),
      });
    }
  });

  // The mis-mapping guard. Both real getters return the SAME SHAPE and both read
  // cold under fake builders, so `reranker: getEmbedderWorkerState()` — an easy
  // copy-paste — passes every assertion written against the real ones (measured:
  // that mutant survived this suite before the `workerStates` seam existed).
  // Injecting distinguishable readings is the only thing that separates them.
  //
  // It also pins the half that actually matters operationally: a TRIPPED latch
  // has to reach the wire. `disabled: true` here is a permanently degraded
  // sidecar — inline forward passes blocking the request loop — on a process
  // that still answers 200, so if this value did not propagate there would be
  // no signal anywhere.
  it('maps each worker breaker to its OWN module, and propagates a tripped latch to the wire', async () => {
    handle = createEmbedSidecarServer({
      port: 0,
      builders: fakeBuilders,
      warmAtBoot: false,
      log: () => {},
      workerStates: {
        embedder: () => ({ alive: true, disabled: false, pendingCount: 11, keepAlive: true }),
        reranker: () => ({ alive: false, disabled: true, pendingCount: 22, keepAlive: false }),
      },
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;

    const body = (await (await fetch(`${baseUrl}/healthz`)).json()) as {
      workers: { embedder: Record<string, unknown>; reranker: Record<string, unknown> };
    };

    expect(body.workers.embedder).toEqual({
      alive: true,
      disabled: false,
      pendingCount: 11,
      keepAlive: true,
    });
    expect(body.workers.reranker).toEqual({
      alive: false,
      disabled: true,
      pendingCount: 22,
      keepAlive: false,
    });
  });

  // ...and the companion the test above CANNOT provide. Injecting readers proves
  // the mapping given readers, so it is blind to a DEFAULT pointed at the wrong
  // module — which is the production path. Pinning each default by identity is
  // what closes that: measured, `reranker: getEmbedderWorkerState` survived the
  // injected-reader test and fails here.
  it('wires each DEFAULT reader to its own package (the production path the injected test cannot see)', () => {
    expect(defaultWorkerStates.embedder).toBe(getMemoryWorkerState);
    expect(defaultWorkerStates.reranker).toBe(getRerankWorkerState);
  });

  // EI-21341585960652821. The guard for an outage class this endpoint was
  // STRUCTURALLY unable to report. On 2026-08-24 the sidecar sat 100% slot-
  // saturated for hours — novel query embeds queueing ~11.4s median (max 67.8s)
  // against 1200ms/4000ms caller budgets, i.e. semantic retrieval dead fleet-
  // wide — while /healthz answered 200 in 0.6ms with every model `warm`. Five
  // separate work-items were filed for that single cause because no surface
  // could see the shared queue.
  //
  // `workers.embedder.pendingCount` looked like the backlog signal but is
  // `_pending.size` (units already handed to the worker), so it is capped at
  // `concurrency` and CANNOT EXCEED it — pinned at the cap, a 2-deep backlog and
  // a 2000-deep one are the same reading. This test therefore asserts the thing
  // that gauge could never say: a backlog LARGER than the concurrency limit.
  it('GET /healthz reports the FIFO backlog — the state `pendingCount` structurally cannot express', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started = 0;
    const gatedBuilders: EmbedderBuilders = {
      ...fakeBuilders,
      gemma: async (kind) => async (text: string) => {
        started++;
        await gate;
        return [text.length, kind === 'query' ? 1 : 2];
      },
    };
    handle = createEmbedSidecarServer({
      port: 0,
      builders: gatedBuilders,
      warmAtBoot: false,
      log: () => {},
      concurrency: 1,
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;

    // THREE DISTINCT texts: per-text coalescing would collapse identical ones
    // into a single unit and there would be no queue to observe. With
    // concurrency 1 this is 1 in flight and 2 genuinely waiting.
    const inFlight = ['alpha', 'bravo', 'charlie'].map((t) =>
      fetch(`${baseUrl}/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'query', texts: [t] }),
      }),
    );
    while (started < 1) await new Promise((r) => setTimeout(r, 5));

    type Health = {
      concurrency: number;
      queue: { depth: number; active: number; saturated: boolean };
    };
    // Poll rather than sampling once: the three requests race to arrive, so a
    // single read can legitimately catch only the first two.
    let body!: Health;
    const deadline = Date.now() + 2000;
    for (;;) {
      body = (await (await fetch(`${baseUrl}/healthz`)).json()) as Health;
      if (body.queue.depth >= 2 || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 5));
    }

    // depth 2 > concurrency 1 — a value the old gauge could not have produced.
    expect(body.queue.depth).toBe(2);
    expect(body.queue.active).toBe(body.concurrency);
    expect(body.queue.saturated).toBe(true);

    release();
    await Promise.all(inFlight);
  });

  it('GET /healthz ADVERTISES every route it serves (EI-19314150478401738)', async () => {
    await boot();
    const body = (await (await fetch(`${baseUrl}/healthz`)).json()) as { capabilities: string[] };
    // A sidecar outlives the code that talks to it, so it must be able to say
    // what it can do — otherwise a route added after the running bundle was
    // built 404s forever and every caller's fail-safe swallows it.
    expect(body.capabilities).toEqual(
      expect.arrayContaining([EMBED_SIDECAR_CAP_HEALTHZ, EMBED_SIDECAR_CAP_EMBED, EMBED_SIDECAR_CAP_RERANK]),
    );
  });

  it('the advertised capabilities are exactly the DISPATCHABLE routes — they cannot drift', async () => {
    await boot();
    const body = (await (await fetch(`${baseUrl}/healthz`)).json()) as { capabilities: string[] };
    // Every advertised route must actually dispatch (i.e. not 404). This is
    // the anti-drift assertion: advertisement is derived from the route table,
    // so adding a route without advertising it is impossible, and this proves
    // the converse — nothing is advertised that isn't served.
    for (const cap of body.capabilities) {
      const [method, path] = cap.split(' ');
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        ...(method === 'POST'
          ? { headers: { 'Content-Type': 'application/json' }, body: '{}' }
          : {}),
      });
      // 400 (bad body) is fine — it proves the route EXISTS. 404 would mean
      // the sidecar advertised something it cannot serve.
      expect(res.status, `advertised ${cap} must dispatch`).not.toBe(404);
    }
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

describe('bounded concurrency (P-004 memory-public-release-hardening-2026-07-11)', () => {
  let handle: EmbedSidecarHandle | null = null;
  let baseUrl = '';

  afterEach(async () => {
    await handle?.close();
    handle = null;
  });

  /** Gated fake: every embed records its start and blocks until released. */
  const makeGated = () => {
    const started: string[] = [];
    const release = new Map<string, () => void>();
    const embed = (text: string) =>
      new Promise<number[]>((res) => {
        started.push(text);
        release.set(text, () => res([1]));
      });
    const builders: EmbedderBuilders = {
      gemma: async () => embed,
      local: async () => embed,
      harrier: async () => embed,
    };
    return { started, release, builders };
  };
  let gated: ReturnType<typeof makeGated>;

  const waitFor = async (cond: () => boolean): Promise<void> => {
    const deadline = Date.now() + 1_000;
    while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(cond()).toBe(true);
  };

  const boot = async (concurrency?: number): Promise<void> => {
    handle = createEmbedSidecarServer({
      port: 0,
      warmAtBoot: false,
      log: () => {},
      builders: gated.builders,
      concurrency,
    });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;
  };

  const post = (texts: string[]) =>
    fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'query', texts }),
    });

  it('concurrency 2: two units run in flight, the third starts only when a slot frees', async () => {
    gated = makeGated();
    await boot(2);
    const req = post(['a', 'b', 'c']);
    await waitFor(() => gated.started.length === 2);
    expect(gated.started).toEqual(['a', 'b']); // c queued — both slots busy
    gated.release.get('a')!();
    await waitFor(() => gated.started.length === 3);
    expect(gated.started).toEqual(['a', 'b', 'c']); // freed slot starts c, arrival order
    gated.release.get('b')!();
    gated.release.get('c')!();
    expect((await req).status).toBe(200);
  });

  it('concurrency 1 (the default contract): strictly serial starts', async () => {
    gated = makeGated();
    await boot(1);
    const req = post(['a', 'b']);
    await waitFor(() => gated.started.length === 1);
    expect(gated.started).toEqual(['a']);
    gated.release.get('a')!();
    await waitFor(() => gated.started.length === 2);
    gated.release.get('b')!();
    expect((await req).status).toBe(200);
  });

  it('an aborted request removes its queued work before it starts', async () => {
    gated = makeGated();
    await boot(1);
    const controller = new AbortController();
    // The request must carry the signal so the server observes the client
    // disconnect while the first unit is holding the only slot.
    const abortedReq = fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'query', texts: ['active', 'abandoned'] }),
      signal: controller.signal,
    });
    await waitFor(() => gated.started.length === 1);
    expect(gated.started).toEqual(['active']);
    controller.abort();
    await expect(abortedReq).rejects.toThrow();
    gated.release.get('active')!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gated.started).toEqual(['active']);
  });

  it('an aborted coalesced caller does not cancel work still needed by a peer', async () => {
    gated = makeGated();
    await boot(1);
    const controller = new AbortController();
    const first = fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'query', texts: ['shared'] }),
      signal: controller.signal,
    });
    await waitFor(() => gated.started.length === 1);
    const second = post(['shared']);
    controller.abort();
    await expect(first).rejects.toThrow();
    gated.release.get('shared')!();
    expect((await second).status).toBe(200);
    expect(gated.started).toEqual(['shared']);
  });

  it('a failed unit frees its slot for the next waiter', async () => {
    gated = makeGated();
    const inner = gated.builders.gemma;
    gated.builders.gemma = async (kind) => {
      const embed = await inner(kind);
      return (text: string) =>
        text === 'boom' ? Promise.reject(new Error('synthetic embed failure')) : embed(text);
    };
    await boot(1);
    const req = post(['boom', 'after']); // Promise.all rejects the request…
    await waitFor(() => gated.started.includes('after')); // …but the slot freed
    gated.release.get('after')!();
    expect((await req).status).toBe(500);
  });

  it('healthz reports the configured concurrency', async () => {
    gated = makeGated();
    await boot(3);
    const body = (await (await fetch(`${baseUrl}/healthz`)).json()) as { concurrency: number };
    expect(body.concurrency).toBe(3);
  });
});

/**
 * P-005 (local-reranker-gte-modernbert-2026-08-02): the /rerank surface.
 *
 * Same discipline as the embed tests above — INJECTED fake rerankers, no ONNX
 * model ever loads here. The real-model proof is the live verification item;
 * this file pins the wire contract: validation, index-aligned scores, the
 * SHARED warm registry, lazy build with non-memoized failures, and the
 * caching/coalescing the reranker inherits from the embed path.
 */
describe('validateRerankRequest', () => {
  it('accepts a minimal valid request and defaults model to rerank', () => {
    expect(validateRerankRequest({ query: 'q', texts: ['a'] })).toEqual({
      model: 'rerank',
      query: 'q',
      texts: ['a'],
    });
  });

  it('requires a real query — a reranker scores a PAIR, so a blank query is meaningless', () => {
    expect(validateRerankRequest({ texts: ['a'] })).toHaveProperty('error');
    expect(validateRerankRequest({ query: '   ', texts: ['a'] })).toHaveProperty('error');
    expect(validateRerankRequest({ query: 42, texts: ['a'] })).toHaveProperty('error');
  });

  it('rejects unknown models and bad texts, and enforces the batch cap', () => {
    expect(validateRerankRequest(null)).toHaveProperty('error');
    expect(validateRerankRequest({ model: 'zerank-2', query: 'q', texts: ['a'] })).toHaveProperty('error');
    expect(validateRerankRequest({ query: 'q', texts: [] })).toHaveProperty('error');
    expect(validateRerankRequest({ query: 'q', texts: [42] })).toHaveProperty('error');
    expect(validateRerankRequest({ query: 'q', texts: Array(MAX_TEXTS_PER_CALL + 1).fill('x') })).toHaveProperty(
      'error',
    );
  });

  it('accepts the fast tier', () => {
    expect(validateRerankRequest({ model: 'rerank-fast', query: 'q', texts: ['a'] })).toEqual({
      model: 'rerank-fast',
      query: 'q',
      texts: ['a'],
    });
  });
});

describe('warm-env split between embedders and rerankers', () => {
  it('reads reranker ids out of the same env, defaulting to none', () => {
    expect(resolveWarmRerankers({})).toEqual([]);
    expect(resolveWarmRerankers({ [EMBED_SIDECAR_WARM_ENV]: 'gemma,harrier' })).toEqual([]);
    expect(resolveWarmRerankers({ [EMBED_SIDECAR_WARM_ENV]: 'gemma,rerank' })).toEqual(['rerank']);
    expect(resolveWarmRerankers({ [EMBED_SIDECAR_WARM_ENV]: 'rerank,rerank,rerank-fast' })).toEqual([
      'rerank',
      'rerank-fast',
    ]);
  });

  it('a reranker-only list warms NO embedder — not a surprise gemma load', () => {
    expect(resolveWarmModels({ [EMBED_SIDECAR_WARM_ENV]: 'rerank' })).toEqual([]);
    expect(resolveWarmRerankers({ [EMBED_SIDECAR_WARM_ENV]: 'rerank' })).toEqual(['rerank']);
  });

  it('still defaults to gemma when nothing is recognized (the unconfigured case is unchanged)', () => {
    expect(resolveWarmModels({ [EMBED_SIDECAR_WARM_ENV]: 'gpt-9,nope' })).toEqual(['gemma']);
    expect(resolveWarmModels({ [EMBED_SIDECAR_WARM_ENV]: 'gemma,rerank' })).toEqual(['gemma']);
  });
});

describe('rerank sidecar HTTP surface (fake rerankers, ephemeral port)', () => {
  let handle: EmbedSidecarHandle | null = null;
  let baseUrl = '';
  const rerankBuilds: string[] = [];
  const scored: Array<{ query: string; texts: string[] }> = [];

  /** Scores by text length so ordering is assertable without a model. */
  const fakeRerankBuilders: RerankerBuilders = {
    rerank: async () => {
      rerankBuilds.push('rerank');
      return async (query: string, texts: string[]) => {
        scored.push({ query, texts });
        return texts.map((t) => t.length);
      };
    },
    'rerank-fast': async () => {
      rerankBuilds.push('rerank-fast');
      return async (_query: string, texts: string[]) => texts.map((t) => -t.length);
    },
  };

  async function bootRerank(rerankBuilders: RerankerBuilders = fakeRerankBuilders): Promise<void> {
    handle = createEmbedSidecarServer({ port: 0, rerankBuilders, warmAtBoot: false, log: () => {} });
    baseUrl = `http://127.0.0.1:${await handle.listening}`;
  }

  const rerank = (body: unknown) =>
    fetch(`${baseUrl}/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  afterEach(async () => {
    await handle?.close();
    handle = null;
    rerankBuilds.length = 0;
    scored.length = 0;
  });

  it('returns scores INDEX-ALIGNED with the request texts, never reordered', async () => {
    await bootRerank();
    // Deliberately not in score order: the server must NOT sort. Ordering is
    // the client's job, so a server that "helpfully" sorted would silently
    // misalign every caller that zips scores back onto its own candidates.
    const res = await rerank({ query: 'q', texts: ['aaa', 'a', 'aa'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scores: number[]; runtime: string; modelRev: string };
    expect(body.scores).toEqual([3, 1, 2]);
    expect(body.runtime).toBe(EMBED_SIDECAR_RUNTIME);
    expect(body.modelRev).toContain('gte-reranker-modernbert');
  });

  it('serves the fast tier under its own model rev', async () => {
    await bootRerank();
    const body = (await (await rerank({ model: 'rerank-fast', query: 'q', texts: ['ab'] })).json()) as {
      scores: number[];
      modelRev: string;
    };
    expect(body.scores).toEqual([-2]);
    expect(body.modelRev).toContain('ms-marco');
  });

  it('builds each reranker once and reports it in the SHARED warm registry', async () => {
    await bootRerank();
    await rerank({ query: 'q', texts: ['a'] });
    await rerank({ query: 'q2', texts: ['b'] });
    await rerank({ model: 'rerank-fast', query: 'q', texts: ['c'] });
    expect(rerankBuilds).toEqual(['rerank', 'rerank-fast']);
    expect(handle!.warmStates()).toEqual({ rerank: 'warm', 'rerank-fast': 'warm' });

    // /healthz shows embedders and rerankers in one picture of the host.
    const health = (await (await fetch(`${baseUrl}/healthz`)).json()) as { models: Record<string, string> };
    expect(health.models).toEqual({ rerank: 'warm', 'rerank-fast': 'warm' });
  });

  it('caches and coalesces per (model, query, text) pair', async () => {
    await bootRerank();
    await rerank({ query: 'q', texts: ['a', 'b'] });
    await rerank({ query: 'q', texts: ['a', 'c'] }); // 'a' is a cache hit
    // One scoring call per UNIQUE pair: a,b,c — not 4.
    expect(scored.map((s) => s.texts[0])).toEqual(['a', 'b', 'c']);

    const health = (await (await fetch(`${baseUrl}/healthz`)).json()) as {
      cache: { hits: number; misses: number };
    };
    expect(health.cache.misses).toBe(3);
    expect(health.cache.hits).toBe(1);
  });

  it('a different query is a different pair — scores are never reused across queries', async () => {
    await bootRerank();
    await rerank({ query: 'q1', texts: ['a'] });
    await rerank({ query: 'q2', texts: ['a'] });
    expect(scored.map((s) => s.query)).toEqual(['q1', 'q2']);
  });

  it('400s invalid requests and 500s a reranker failure without killing the server', async () => {
    await bootRerank();
    expect((await rerank({ model: 'nope', query: 'q', texts: ['a'] })).status).toBe(400);
    expect((await rerank({ query: '', texts: ['a'] })).status).toBe(400);
    expect((await fetch(`${baseUrl}/rerank`, { method: 'POST', body: '{{' })).status).toBe(400);

    await handle!.close();
    let attempts = 0;
    await bootRerank({
      ...fakeRerankBuilders,
      rerank: async () => {
        attempts++;
        throw new Error('model download failed');
      },
    });
    const failed = await rerank({ query: 'q', texts: ['a'] });
    expect(failed.status).toBe(500);
    expect(((await failed.json()) as { error: string }).error).toContain('rerank_failed');
    expect(handle!.warmStates()).toEqual({ rerank: 'failed' });

    // A failed build must NOT be memoized — a transient download fault cannot
    // brick the slot for the process lifetime.
    expect((await rerank({ query: 'q2', texts: ['a'] })).status).toBe(500);
    expect(attempts).toBe(2);

    // …and the server is still serving.
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
  });

  it('GET /rerank is not a route (POST only)', async () => {
    await bootRerank();
    expect((await fetch(`${baseUrl}/rerank`)).status).toBe(404);
  });
});
