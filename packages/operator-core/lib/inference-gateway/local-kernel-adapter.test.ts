/**
 * local-kernel-adapter.test.ts — P-007.
 *
 * These drive the adapter through the REAL `executeGatewayRequestKernel`, with no
 * gateway wiring, exactly as the P-002/P-004/P-005/P-006 adapter suites do. The
 * point is to prove `proxyLocal`'s ladder is expressible by the kernel BEFORE
 * `gateway.ts` is rewired onto it, so a failure here is a design answer rather
 * than a regression in a live handler.
 *
 * The end-to-end behaviour these must agree with is pinned separately by the
 * characterization goldens in `local-backend-gateway.test.ts` (32 cases, green
 * pre-migration).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createLocalKernelAdapter,
  type LocalKernelAdapterDeps,
  type LocalChunk,
  type LocalFetchResponse,
  type LocalResponseMetadata,
  type LocalRouteValue,
} from './local-kernel-adapter';
import { executeGatewayRequestKernel, GatewayRequestKernelError } from './request-kernel';
import { makeGatewayLaneRegistry } from './provider-adapters';
import { GatewayRequestTelemetry } from './request-stage-telemetry';
import type { AccountPool } from './provider-contracts';
import type { LocalBackend } from './local-backend-pool';

const unusedPool = {
  active: () => null,
  onExhausted: () => null,
  healthyCount: () => 1,
} as unknown as AccountPool;

const lane = makeGatewayLaneRegistry({
  claudePool: unusedPool,
  codexPool: null,
  codexCliAccountCount: () => 1,
  anthropicUpstreamBase: 'https://anthropic.test',
  openaiUpstreamBase: 'https://openai.test',
}).localOpenAiChat;

const MODEL = 'qwen3-coder';

function backend(id: string, extra: Partial<LocalBackend> = {}): LocalBackend {
  return {
    id,
    kind: 'llama-server' as LocalBackend['kind'],
    baseUrl: `http://${id}.test`,
    models: [MODEL],
    maxConcurrent: 4,
    enabled: true,
    ...extra,
  };
}

/** An on-demand backend the gateway is allowed to START (lifecycle + unit both
 *  required — `startableOnDemand`'s real predicate). */
function onDemand(id: string): LocalBackend {
  return backend(id, { lifecycle: 'on-demand', unitName: `llama-${id}.service` });
}

/**
 * A least-loaded pool with the real exclude/affinity signature. Deliberately not
 * a stub returning a scripted queue: the cold-start rescue's whole subtlety is
 * that it RE-ENTERS selection with the started backend no longer excluded, so a
 * fake that ignores `exclude` could not tell re-attempt from failover.
 */
function fakePool(backends: LocalBackend[], preload: Record<string, number> = {}) {
  const inflight = new Map<string, number>(backends.map((b) => [b.id, preload[b.id] ?? 0]));
  const selectCalls: { model: string; exclude: string[]; ownerId: string | undefined }[] = [];
  const outcomes: { id: string; ok: boolean; error?: string | null }[] = [];
  const starts: string[] = [];
  const ends: string[] = [];
  return {
    inflight,
    selectCalls,
    outcomes,
    starts,
    ends,
    select(model: string, exclude?: ReadonlySet<string>, ownerId?: string): LocalBackend | null {
      selectCalls.push({ model, exclude: [...(exclude ?? [])], ownerId });
      const eligible = backends.filter(
        (b) => b.enabled && b.models.includes(model) && !exclude?.has(b.id) && (inflight.get(b.id) ?? 0) < b.maxConcurrent,
      );
      if (!eligible.length) return null;
      return eligible.reduce((best, b) => ((inflight.get(b.id) ?? 0) < (inflight.get(best.id) ?? 0) ? b : best));
    },
    recordStart(id: string) {
      starts.push(id);
      inflight.set(id, (inflight.get(id) ?? 0) + 1);
    },
    recordEnd(id: string) {
      ends.push(id);
      inflight.set(id, Math.max(0, (inflight.get(id) ?? 0) - 1));
    },
    recordOutcome(id: string, ok: boolean, error?: string | null) {
      outcomes.push({ id, ok, error });
    },
  };
}

/** A response body that records whether the socket was released. */
function fakeBody(chunks: string[] = ['hi']) {
  const cancel = vi.fn(async () => undefined);
  return {
    cancel,
    stream: Object.assign(
      (async function* () {
        for (const c of chunks) yield new TextEncoder().encode(c);
      })(),
      { cancel },
    ) as unknown as NonNullable<LocalFetchResponse['body']>,
  };
}

function reply(status: number, body: NonNullable<LocalFetchResponse['body']> | null = null): LocalFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/json' : null) },
    body,
  };
}

function makeAdapter(overrides: Partial<LocalKernelAdapterDeps> & { backends?: LocalBackend[]; preload?: Record<string, number> } = {}) {
  const backends = overrides.backends ?? [backend('a'), backend('b')];
  const pool = overrides.pool ? (overrides.pool as ReturnType<typeof fakePool>) : fakePool(backends, overrides.preload);
  const ensure = vi.fn(async () => null as string | null);
  const deps: LocalKernelAdapterDeps = {
    pool,
    model: MODEL,
    ownerId: 'owner-1',
    url: '/v1/chat/completions',
    body: new TextEncoder().encode('{"model":"qwen3-coder"}'),
    streaming: false,
    attemptTimeoutMs: 60_000,
    fetchImpl: async () => reply(200, fakeBody().stream),
    isUpstreamUnreachable: (s) => s === 502 || s === 503 || s === 504,
    startableOnDemand: (b) => b.enabled && b.lifecycle === 'on-demand' && !!b.unitName,
    ensureOnDemandBackend: ensure,
    initialColdStartError: null,
    log: () => undefined,
    ...overrides,
  };
  return { adapter: createLocalKernelAdapter(deps), pool, ensure, deps, backends };
}

/** Run one request through the real kernel, wired the way the gateway will. */
async function runKernel(
  adapter: ReturnType<typeof makeAdapter>['adapter'],
  opts: { maxAttempts?: number } = {},
) {
  const routes: { attempt: number; key: string; accountId: string | null; delayMs: number | undefined }[] = [];
  const started: { status: number; metadata: LocalResponseMetadata }[] = [];
  const written: string[] = [];

  const result = await executeGatewayRequestKernel<LocalRouteValue, LocalRouteValue, LocalChunk, LocalResponseMetadata>({
    request: {
      lane,
      body: (async function* () {
        yield Buffer.from('{"model":"qwen3-coder"}');
      })(),
      ownerId: 'owner-1',
      pin: null,
    },
    policy: {
      maxBodyBytes: 1024 * 1024,
      bodyReadTimeoutMs: 5_000,
      requestCeilingMs: 60_000,
      ttfbTimeoutMs: 60_000,
      bodyIdleTimeoutMs: 60_000,
      downstreamIdleTimeoutMs: 60_000,
      maxAttempts: opts.maxAttempts ?? 3,
    },
    telemetry: new GatewayRequestTelemetry(),
    admission: {
      run: (_context, task) => task(),
      observeAttempt: ({ context }) => {
        routes.push({
          attempt: context.attempt,
          key: context.route.key,
          accountId: context.route.accountId ?? null,
          delayMs: context.route.delayMs,
        });
      },
    },
    adapter,
    inFlight: { register: () => ({ unregister: () => undefined }) },
    downstream: {
      start: (response) => {
        started.push({ status: response.status, metadata: response.metadata });
      },
      write: (chunk) => {
        written.push(new TextDecoder().decode(chunk));
      },
      end: () => undefined,
    },
  });

  return { result, routes, started, written };
}

describe('local-backend kernel adapter', () => {
  it('forwards a 200 from the least-loaded backend without retrying', async () => {
    const body = fakeBody(['served']);
    const { adapter, pool } = makeAdapter({ fetchImpl: async () => reply(200, body.stream) });

    const { result, started, written } = await runKernel(adapter);

    expect(result.status).toBe(200);
    expect(result.attempts).toBe(1);
    expect(result.failovers).toBe(0);
    expect(started[0].metadata.backendId).toBe('a');
    expect(started[0].metadata.contentType).toBe('application/json');
    expect(written.join('')).toBe('served');
    // recordStart/recordEnd pair exactly once for the one attempt.
    expect(pool.starts).toEqual(['a']);
    expect(pool.ends).toEqual(['a']);
    expect(pool.outcomes).toEqual([{ id: 'a', ok: true, error: undefined }]);
  });

  it('threads owner affinity and the exclude set into every pool.select', async () => {
    // A D-015-shaped check at the CALL level: an affinity argument that is
    // accepted and never forwarded would leave every session re-prefilling, and
    // nothing else in this suite would notice.
    const { adapter, pool } = makeAdapter();
    await runKernel(adapter);
    expect(pool.selectCalls[0]).toEqual({ model: MODEL, exclude: [], ownerId: 'owner-1' });
  });

  it('RELAYS a non-2xx from a backend it may not start, instead of retrying it', async () => {
    // The property that separates this lane from the four cloud lanes: the
    // ladder retried only on a thrown TRANSPORT failure. A 500 that arrives as a
    // response is the backend's real answer and is forwarded untouched.
    const fetchImpl = vi.fn(async () => reply(500, fakeBody(['boom']).stream));
    const { adapter } = makeAdapter({ fetchImpl });

    const { result, started } = await runKernel(adapter);

    expect(result.status).toBe(500);
    expect(result.attempts).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(started[0].status).toBe(500);
  });

  it('records a 4xx as a HEALTHY outcome and a transport failure as unhealthy', async () => {
    const a = makeAdapter({ fetchImpl: async () => reply(404, fakeBody().stream) });
    await runKernel(a.adapter);
    expect(a.pool.outcomes).toEqual([{ id: 'a', ok: true, error: undefined }]);

    const b = makeAdapter({
      backends: [backend('a')],
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(runKernel(b.adapter)).rejects.toBeInstanceOf(GatewayRequestKernelError);
    expect(b.pool.outcomes).toEqual([{ id: 'a', ok: false, error: 'ECONNREFUSED' }]);
    // recordEnd still owed exactly once when the fetch never settled.
    expect(b.pool.ends).toEqual(['a']);
  });

  it('fails over to a different backend on a transport failure', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith('http://a.test')) throw new Error('ECONNREFUSED');
      return reply(200, fakeBody(['from-b']).stream);
    });
    const { adapter, pool } = makeAdapter({ fetchImpl });

    const { result, started, written } = await runKernel(adapter);

    expect(result.status).toBe(200);
    expect(result.attempts).toBe(2);
    expect(result.failovers).toBe(1);
    expect(started[0].metadata.backendId).toBe('b');
    expect(written.join('')).toBe('from-b');
    // The failed backend stays EXCLUDED on the retry — the ladder's `tried` set.
    expect(pool.selectCalls[1].exclude).toEqual(['a']);
  });

  it('cold-starts an on-demand backend that answers 502 and retries it as a RE-ATTEMPT, not a failover', async () => {
    // The single-backend case that motivates the whole rescue: a stopped unit
    // behind a sanitizing proxy returns a well-formed 502, so `catch` never
    // fires and the pool health signal lags the stop.
    const body = fakeBody();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? reply(502, body.stream) : reply(200, fakeBody(['after-start']).stream);
    });
    const { adapter, ensure, pool } = makeAdapter({ backends: [onDemand('a')], fetchImpl });

    const { result, routes, written } = await runKernel(adapter);

    expect(result.status).toBe(200);
    expect(result.attempts).toBe(2);
    // The backend did not CHANGE, so the ladder recorded no failover here.
    expect(result.failovers).toBe(0);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(written.join('')).toBe('after-start');
    // The un-relayed 502 body was released rather than left to GC.
    expect(body.cancel).toHaveBeenCalledTimes(1);
    // Re-selection saw the started backend ELIGIBLE again (exclude no longer names it).
    expect(pool.selectCalls[1].exclude).toEqual([]);
    // Same account, distinct route key — the kernel's same-account + cycle guards.
    expect(routes.map((r) => r.accountId)).toEqual(['a', 'a']);
    expect(new Set(routes.map((r) => r.key)).size).toBe(2);
  });

  it('counts the cold-start retry as a FAILOVER when re-selection lands on a different backend', async () => {
    // `tried.delete(id); continue;` re-enters least-loaded selection, so the
    // rescue may legitimately move to a less-loaded peer. The ladder recorded a
    // failover on the backend CHANGING, and so must the kernel wiring.
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? reply(503, fakeBody().stream) : reply(200, fakeBody(['from-b']).stream);
    });
    const { adapter, ensure } = makeAdapter({
      backends: [onDemand('a'), backend('b')],
      // `a` carries a concurrent request, so once it is eligible again `b` is
      // strictly less loaded and least-loaded selection prefers it.
      preload: { a: 2 },
      fetchImpl,
    });

    const { result, started } = await runKernel(adapter);

    expect(result.status).toBe(200);
    expect(result.attempts).toBe(2);
    expect(result.failovers).toBe(1);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(started[0].metadata.backendId).toBe('b');
  });

  it('cold-starts AT MOST once per request even if the backend keeps answering 502', async () => {
    const fetchImpl = vi.fn(async () => reply(502, fakeBody().stream));
    const { adapter, ensure } = makeAdapter({ backends: [onDemand('a')], fetchImpl });

    // Second pass relays the 502 (the rescue is spent), so this resolves.
    const { result } = await runKernel(adapter);

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(result.attempts).toBe(2);
    expect(result.status).toBe(502);
  });

  it('treats a FAILED cold start as terminal and surfaces it for the 502 message', async () => {
    const ensure = vi.fn(async () => 'cold start of a failed: unit not found');
    const { adapter } = makeAdapter({
      backends: [onDemand('a')],
      fetchImpl: async () => reply(502, fakeBody().stream),
      ensureOnDemandBackend: ensure,
    });

    await expect(runKernel(adapter)).rejects.toThrow('cold start of a failed: unit not found');
    expect(ensure).toHaveBeenCalledTimes(1);
    // A failed cold start OUTRANKS both generic readings in the terminal 502.
    expect(adapter.state().coldStartError).toBe('cold start of a failed: unit not found');
  });

  it('still cold-starts on the FINAL attempt, when no retry remains', async () => {
    // The started unit outlives the request and serves the NEXT one, so the
    // ladder started it on its last pass too. The kernel skips route selection
    // once `attempt === maxAttempts`, which is exactly why the start lives in
    // `executeAttempt` rather than in a selection hook.
    const ensure = vi.fn(async () => null as string | null);
    const { adapter } = makeAdapter({
      backends: [onDemand('a')],
      fetchImpl: async () => reply(502, fakeBody().stream),
      ensureOnDemandBackend: ensure,
    });

    await expect(runKernel(adapter, { maxAttempts: 1 })).rejects.toBeInstanceOf(GatewayRequestKernelError);
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it('does not cold-start a backend that is not startable-on-demand', async () => {
    const ensure = vi.fn(async () => null as string | null);
    const { adapter } = makeAdapter({
      // `always-on` lifecycle and no unit name: nothing this gateway may start.
      backends: [backend('a')],
      fetchImpl: async () => reply(502, fakeBody().stream),
      ensureOnDemandBackend: ensure,
    });

    const { result } = await runKernel(adapter);

    expect(ensure).not.toHaveBeenCalled();
    // Relayed, not rescued and not retried.
    expect(result.status).toBe(502);
    expect(result.attempts).toBe(1);
  });

  it('reports triedCount 0 when selection never yielded a backend, so the caller may render saturation', async () => {
    const { adapter } = makeAdapter({ backends: [] });

    await expect(runKernel(adapter)).rejects.toBeInstanceOf(GatewayRequestKernelError);
    // The ONLY shape permitted to render retryable 429 backpressure.
    expect(adapter.state()).toEqual({ triedCount: 0, lastError: null, coldStartError: null });
  });

  it('reports lastError once a real backend failed, which forces 502 over saturation', async () => {
    const { adapter } = makeAdapter({
      backends: [backend('a')],
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    await expect(runKernel(adapter)).rejects.toBeInstanceOf(GatewayRequestKernelError);
    const state = adapter.state();
    expect(state.triedCount).toBe(1);
    expect(state.lastError).toBe('ECONNREFUSED');
  });

  it('seeds the pre-flight cold-start error so the caller keeps no parallel copy', async () => {
    const { adapter } = makeAdapter({
      backends: [],
      initialColdStartError: 'cold start of ornith failed: unit masked',
    });

    await expect(runKernel(adapter)).rejects.toBeInstanceOf(GatewayRequestKernelError);
    expect(adapter.state().coldStartError).toBe('cold start of ornith failed: unit masked');
  });

  it('D-018: carries NO inter-attempt pace on any route, because the ladder had none', async () => {
    // Measured over the deleted region: no sleep/backoff/setTimeout existed.
    // Asserted rather than assumed, because a delay that should NOT be there is
    // as invisible as one that should.
    let calls = 0;
    const { adapter } = makeAdapter({
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw new Error('ECONNREFUSED');
        return reply(200, fakeBody().stream);
      },
    });

    const { routes } = await runKernel(adapter);

    expect(routes.length).toBeGreaterThan(1);
    expect(routes.every((r) => r.delayMs === undefined)).toBe(true);
  });
});
