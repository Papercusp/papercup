/**
 * Post-deploy health-probe semantics — the release-manager reads `probeHealth`'s
 * verdict to declare a deploy good or trigger rollback, so the healthy/unhealthy
 * decision is load-bearing. Cover the three contract branches (explicit
 * {ok:false}, non-JSON 2xx, eventual-up retry) + the timeout floor. fetch is
 * stubbed; tiny intervals keep it fast + deterministic (no fake timers needed —
 * the only real time is the short interval sleep).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { probeHealth, probeMemoryCanaryCheck } from './health-probe';

function jsonRes(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('probeHealth', () => {
  it('treats a 200 {ok:false} body as UNHEALTHY (explicit contract wins over 2xx)', async () => {
    const fetchMock = vi.fn(async () => jsonRes(200, { ok: false }));
    vi.stubGlobal('fetch', fetchMock);

    const r = await probeHealth('http://x/health', { timeoutMs: 30, intervalMs: 1, requestTimeoutMs: 50 });

    expect(r.healthy).toBe(false);
    // the loop keeps retrying a not-ok 2xx until the timeout elapses
    expect(r.attempts).toBeGreaterThanOrEqual(1);
    expect(r.error).toMatch(/2xx but body not ok/);
  });

  it('treats a 200 NON-JSON body as healthy (any 2xx counts when there is no {ok} contract)', async () => {
    const fetchMock = vi.fn(async () => new Response('OK', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const r = await probeHealth('http://x/health', { timeoutMs: 5_000, intervalMs: 1, requestTimeoutMs: 50 });

    expect(r.healthy).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toBe('OK');
    expect(r.attempts).toBe(1);
  });

  it('rides over a server that is DOWN until attempt N, then reports healthy with attempts≈N', async () => {
    const upAt = 3;
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      if (n < upAt) {
        // undici-style connection-refused TypeError
        const err = new TypeError('fetch failed');
        (err as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
        throw err;
      }
      return jsonRes(200, { ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await probeHealth('http://x/health', { timeoutMs: 5_000, intervalMs: 1, requestTimeoutMs: 50 });

    expect(r.healthy).toBe(true);
    expect(r.attempts).toBe(upAt); // came up exactly on the Nth probe
    expect(fetchMock).toHaveBeenCalledTimes(upAt);
  });

  it('returns healthy:false when it never comes up before the timeout', async () => {
    const fetchMock = vi.fn(async () => {
      const err = new TypeError('fetch failed');
      (err as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
      throw err;
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await probeHealth('http://x/health', { timeoutMs: 20, intervalMs: 1, requestTimeoutMs: 50 });

    expect(r.healthy).toBe(false);
    expect(r.attempts).toBeGreaterThanOrEqual(1);
    expect(r.error).toBeTruthy(); // last error is carried out
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('fails when probeMcp:true and MCP returns non-200', async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      callCount++;
      if (url.includes('/health')) {
        return jsonRes(200, { ok: true });
      } else if (url.includes('/mcp')) {
        return jsonRes(426, 'Upgrade Required');
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await probeHealth('http://x/api/health', {
      timeoutMs: 50,
      intervalMs: 1,
      requestTimeoutMs: 50,
      probeMcp: true,
    });

    expect(r.healthy).toBe(false);
    expect(r.error).toMatch(/MCP initialization failed.*426/);
    // Should have tried both health and mcp endpoints at least once
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/health'),
      expect.any(Object),
    );
  });

  it('fails when probeMcp:true and MCP returns 200 but wrong content-type', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/health')) {
        return jsonRes(200, { ok: true });
      } else if (url.includes('/mcp')) {
        return new Response('plain text', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await probeHealth('http://x/api/health', {
      timeoutMs: 50,
      intervalMs: 1,
      requestTimeoutMs: 50,
      probeMcp: true,
    });

    expect(r.healthy).toBe(false);
    expect(r.error).toMatch(/MCP initialization failed.*expected text\/event-stream/);
  });

  it('succeeds when probeMcp:true and both health and MCP respond correctly', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/health')) {
        return jsonRes(200, { ok: true });
      } else if (url.includes('/mcp')) {
        return new Response(':stream-open\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await probeHealth('http://x/api/health', {
      timeoutMs: 5_000,
      intervalMs: 1,
      requestTimeoutMs: 50,
      probeMcp: true,
    });

    expect(r.healthy).toBe(true);
    expect(r.status).toBe(200);
    expect(r.attempts).toBe(1);
  });

  it('sends Accept: application/json + text/event-stream on the MCP probe (regression — the missing header 406d every deploy → auto-rollback)', async () => {
    let mcpHeaders: Record<string, string> | undefined;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/health')) return jsonRes(200, { ok: true });
      if (url.includes('/mcp')) {
        mcpHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response(':stream-open\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await probeHealth('http://x/api/health', { timeoutMs: 5_000, intervalMs: 1, requestTimeoutMs: 50, probeMcp: true });

    expect(r.healthy).toBe(true);
    const accept = String(mcpHeaders?.accept ?? mcpHeaders?.Accept ?? '');
    expect(accept).toContain('application/json');
    expect(accept).toContain('text/event-stream');
  });
});

// EI-10361: deploy-triggered memory recall canary probe.
describe('probeMemoryCanaryCheck', () => {
  it('reports reachable + the verdict on a normal 200 response', async () => {
    const fetchMock = vi.fn(async () =>
      jsonRes(200, { ok: true, ran: true, status: 'ok', rAt10: 0.92, delta: -0.01, zeroHitRate: 0 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const r = await probeMemoryCanaryCheck('http://x/api/internal/memory-canary');

    expect(r.reachable).toBe(true);
    expect(r.ran).toBe(true);
    expect(r.status).toBe('ok');
  });

  it('reports reachable:false (never throws) on a transport failure — PASS-WITH-NOTE', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await probeMemoryCanaryCheck('http://x/api/internal/memory-canary');

    expect(r.reachable).toBe(false);
    expect(r.error).toMatch(/fetch failed/);
  });
});

describe('probeHealth + probeMemoryCanary (EI-10361)', () => {
  function stubHealthAndCanary(canaryBody: unknown, canaryStatus = 200): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/health')) return jsonRes(200, { ok: true });
      if (url.includes('/memory-canary')) return jsonRes(canaryStatus, canaryBody);
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it("'report' policy (default): a DEGRADED canary is attached to the result but never fails the probe", async () => {
    stubHealthAndCanary({ ok: true, ran: true, status: 'degraded', rAt10: 0.2, delta: -0.3, zeroHitRate: 0.6 });

    const r = await probeHealth('http://x/api/health', {
      timeoutMs: 5_000,
      intervalMs: 1,
      requestTimeoutMs: 50,
      probeMemoryCanary: true,
      memoryCanaryPolicy: 'report',
    });

    expect(r.healthy).toBe(true);
    expect(r.memoryCanary?.status).toBe('degraded');
  });

  it("'block' policy: a DEGRADED canary FAILS the probe (→ deploy rollback)", async () => {
    stubHealthAndCanary({ ok: true, ran: true, status: 'degraded', rAt10: 0.2, delta: -0.3, zeroHitRate: 0.6 });

    const r = await probeHealth('http://x/api/health', {
      timeoutMs: 5_000,
      intervalMs: 1,
      requestTimeoutMs: 50,
      probeMemoryCanary: true,
      memoryCanaryPolicy: 'block',
    });

    expect(r.healthy).toBe(false);
    expect(r.error).toMatch(/memory recall canary degraded/);
  });

  it("'block' policy: a SEEDED/OK canary never fails the probe (only a reached+ran 'degraded' verdict blocks)", async () => {
    stubHealthAndCanary({ ok: true, ran: true, status: 'seeded', rAt10: null, delta: 0, zeroHitRate: null });

    const r = await probeHealth('http://x/api/health', {
      timeoutMs: 5_000,
      intervalMs: 1,
      requestTimeoutMs: 50,
      probeMemoryCanary: true,
      memoryCanaryPolicy: 'block',
    });

    expect(r.healthy).toBe(true);
    expect(r.memoryCanary?.status).toBe('seeded');
  });

  it("'block' policy: an UNREACHABLE canary (route down/erroring) never fails the probe — PASS-WITH-NOTE", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/health')) return jsonRes(200, { ok: true });
      if (url.includes('/memory-canary')) throw new TypeError('fetch failed');
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await probeHealth('http://x/api/health', {
      timeoutMs: 5_000,
      intervalMs: 1,
      requestTimeoutMs: 50,
      probeMemoryCanary: true,
      memoryCanaryPolicy: 'block',
    });

    expect(r.healthy).toBe(true);
    expect(r.memoryCanary?.reachable).toBe(false);
  });

  it('probeMemoryCanary defaults OFF — no canary call, no memoryCanary field', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/health')) return jsonRes(200, { ok: true });
      throw new Error(`unexpected URL (canary should not be called): ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await probeHealth('http://x/api/health', { timeoutMs: 5_000, intervalMs: 1, requestTimeoutMs: 50 });

    expect(r.healthy).toBe(true);
    expect(r.memoryCanary).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
