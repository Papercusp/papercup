/**
 * host-request-deadline.test.ts — the B2/P-006 handler-deadline middleware
 * (infra-fail-fast-build-integrity-2026-06-19). Pure exclusion + env readers +
 * applyServerTimeouts + the middleware race behavior, against a real Hono app.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  isDeadlineExcluded,
  requestDeadlineEnabled,
  requestDeadlineMs,
  deadlineTimeoutResponse,
  applyServerTimeouts,
  requestDeadlineMiddleware,
} from './host-request-deadline';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  delete process.env.PAPERCUSP_HTTP_HANDLER_DEADLINE;
  delete process.env.PAPERCUSP_HTTP_HANDLER_DEADLINE_MS;
  delete process.env.PAPERCUSP_HTTP_HANDLER_DEADLINE_RETRY_SEC;
  delete process.env.PAPERCUSP_HTTP_REQUEST_TIMEOUT_MS;
  delete process.env.PAPERCUSP_HTTP_HEADERS_TIMEOUT_MS;
  vi.restoreAllMocks();
});

describe('isDeadlineExcluded (pure)', () => {
  const base = { path: '/api/plans', accept: 'application/json', upgrade: null };

  it('does NOT exclude an ordinary non-streaming API path', () => {
    expect(isDeadlineExcluded(base)).toBe(false);
  });

  it('excludes MCP (long tool calls + own transport cap)', () => {
    expect(isDeadlineExcluded({ ...base, path: '/api/mcp' })).toBe(true);
    expect(isDeadlineExcluded({ ...base, path: '/api/mcp?superuser=1' })).toBe(true);
  });

  it('excludes health/liveness (must always answer; has its own deadline)', () => {
    expect(isDeadlineExcluded({ ...base, path: '/api/health' })).toBe(true);
    expect(isDeadlineExcluded({ ...base, path: '/api/health/deep' })).toBe(true);
  });

  it('excludes any SSE client by Accept: text/event-stream (covers EventSource)', () => {
    expect(isDeadlineExcluded({ ...base, accept: 'text/event-stream' })).toBe(true);
    expect(isDeadlineExcluded({ ...base, accept: 'application/json, text/event-stream' })).toBe(true);
  });

  it('excludes WebSocket upgrades', () => {
    expect(isDeadlineExcluded({ ...base, upgrade: 'websocket' })).toBe(true);
    expect(isDeadlineExcluded({ ...base, upgrade: 'WebSocket' })).toBe(true);
  });

  it('excludes known streaming paths by suffix even without the Accept header', () => {
    for (const path of [
      '/api/coord/inbox/sse',
      '/api/zero-harness/sse',
      '/api/flags/stream',
      '/api/harness/demo/clobber-stream',
      '/api/operator/state-snapshot',
      '/api/deploy/abc/frame-view',
    ]) {
      expect(isDeadlineExcluded({ path, accept: null, upgrade: null })).toBe(true);
    }
  });
});

describe('env readers', () => {
  it('requestDeadlineEnabled honors 1/true only', () => {
    expect(requestDeadlineEnabled()).toBe(false);
    process.env.PAPERCUSP_HTTP_HANDLER_DEADLINE = '1';
    expect(requestDeadlineEnabled()).toBe(true);
    process.env.PAPERCUSP_HTTP_HANDLER_DEADLINE = 'true';
    expect(requestDeadlineEnabled()).toBe(true);
    process.env.PAPERCUSP_HTTP_HANDLER_DEADLINE = '0';
    expect(requestDeadlineEnabled()).toBe(false);
  });

  it('requestDeadlineMs defaults to 30s, env-overridable, rejects junk', () => {
    expect(requestDeadlineMs()).toBe(30_000);
    process.env.PAPERCUSP_HTTP_HANDLER_DEADLINE_MS = '500';
    expect(requestDeadlineMs()).toBe(500);
    process.env.PAPERCUSP_HTTP_HANDLER_DEADLINE_MS = 'nope';
    expect(requestDeadlineMs()).toBe(30_000);
    process.env.PAPERCUSP_HTTP_HANDLER_DEADLINE_MS = '-5';
    expect(requestDeadlineMs()).toBe(30_000);
  });
});

describe('applyServerTimeouts (keep-alive-race fix + opt-in body/header ceilings)', () => {
  // WI-1711: Node's 5s keepAliveTimeout default is the between-call keep-alive
  // race that reset MCP client POSTs ("Error POSTing to endpoint"). Keep-alive is
  // now DEFAULT-ON at 61s, with headersTimeout lifted above it, so the CLIENT
  // always closes an idle socket first. requestTimeout stays opt-in.
  it('defaults keep-alive to 61s (headers derived above it) when the env is unset', () => {
    const server = { requestTimeout: 300_000, headersTimeout: 60_000, keepAliveTimeout: 5_000 };
    const applied = applyServerTimeouts(server, {});
    expect(applied).toEqual({ keepAliveTimeout: 61_000, headersTimeout: 65_000 });
    // requestTimeout is opt-in → untouched; keep-alive raised off Node's racy 5s.
    expect(server).toEqual({ requestTimeout: 300_000, headersTimeout: 65_000, keepAliveTimeout: 61_000 });
    // The Node invariant the race fix depends on.
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });

  it('honors an explicit keep-alive override and derives headers above it', () => {
    const server = { requestTimeout: 300_000, headersTimeout: 60_000, keepAliveTimeout: 5_000 };
    const applied = applyServerTimeouts(server, { PAPERCUSP_HTTP_KEEPALIVE_TIMEOUT_MS: '90000' });
    expect(applied).toEqual({ keepAliveTimeout: 90_000, headersTimeout: 94_000 });
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });

  it('kill-switch: keep-alive=0 restores Node default (leaves keepAliveTimeout untouched)', () => {
    const server = { requestTimeout: 300_000, headersTimeout: 60_000, keepAliveTimeout: 5_000 };
    const applied = applyServerTimeouts(server, { PAPERCUSP_HTTP_KEEPALIVE_TIMEOUT_MS: '0' });
    expect(applied.keepAliveTimeout).toBeUndefined();
    expect(server.keepAliveTimeout).toBe(5_000);
  });

  it('an explicit (lower) headers ceiling wins and clamps keep-alive under it', () => {
    const server = { requestTimeout: 300_000, headersTimeout: 60_000, keepAliveTimeout: 5_000 };
    const applied = applyServerTimeouts(server, {
      PAPERCUSP_HTTP_REQUEST_TIMEOUT_MS: '0',
      PAPERCUSP_HTTP_HEADERS_TIMEOUT_MS: '45000',
    });
    // headers honored at 45s; keep-alive clamped to 41s so headers > keep-alive.
    expect(applied).toEqual({ requestTimeout: 0, headersTimeout: 45_000, keepAliveTimeout: 41_000 });
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });

  it('ignores junk values (keep-alive still defaults on)', () => {
    const server = { requestTimeout: 300_000, headersTimeout: 60_000, keepAliveTimeout: 5_000 };
    applyServerTimeouts(server, { PAPERCUSP_HTTP_REQUEST_TIMEOUT_MS: 'abc', PAPERCUSP_HTTP_KEEPALIVE_TIMEOUT_MS: 'xyz' });
    expect(server.requestTimeout).toBe(300_000);
    expect(server.keepAliveTimeout).toBe(61_000);
  });
});

describe('deadlineTimeoutResponse', () => {
  it('is a standalone 503 JSON with Retry-After', async () => {
    const res = deadlineTimeoutResponse(1234, 7);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('7');
    const body = await res.json();
    expect(body).toMatchObject({ error: 'handler_timeout', deadlineMs: 1234, retryAfterSec: 7 });
  });
});

describe('requestDeadlineMiddleware (against a real Hono app)', () => {
  function app() {
    const a = new Hono();
    a.use('/api/*', requestDeadlineMiddleware);
    a.get('/api/fast', (c) => c.json({ ok: true }));
    a.get('/api/wedge', async () => {
      await new Promise(() => {}); // never resolves — the silent hang
      return new Response('unreachable');
    });
    a.get('/api/late-reject', async () => {
      await sleep(120);
      throw new Error('late handler failure after the deadline already fired');
    });
    a.get('/api/pre-reject', async () => {
      throw new Error('boom'); // fails BEFORE the deadline
    });
    // an excluded (MCP) path whose handler is slow-but-valid: must NOT be 503'd.
    a.get('/api/mcp/slow', async (c) => {
      await sleep(120);
      return c.json({ ok: true, mcp: true });
    });
    return a;
  }

  it('passes through untouched when disabled (no deadline applied)', async () => {
    // disabled + a slow handler resolves normally (would 503 if the deadline ran).
    const a = new Hono();
    a.use('/api/*', requestDeadlineMiddleware);
    a.get('/api/slow', async (c) => {
      await sleep(40);
      return c.json({ ok: true });
    });
    const res = await a.request('/api/slow');
    expect(res.status).toBe(200);
  });

  it('a fast handler returns its real response', async () => {
    process.env.PAPERCUSP_HTTP_HANDLER_DEADLINE = '1';
    process.env.PAPERCUSP_HTTP_HANDLER_DEADLINE_MS = '200';
    const res = await app().request('/api/fast');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('a WEDGED handler fast-503s with a handler_timeout body', async () => {
    process.env.PAPERCUSP_HTTP_HANDLER_DEADLINE = '1';
    process.env.PAPERCUSP_HTTP_HANDLER_DEADLINE_MS = '40';
    const t0 = Date.now();
    const res = await app().request('/api/wedge');
    expect(res.status).toBe(503);
    expect(Date.now() - t0).toBeLessThan(1000); // fast-failed, did not hang
    expect(await res.json()).toMatchObject({ error: 'handler_timeout' });
  });

  it('a pre-deadline handler error propagates normally (not swallowed)', async () => {
    process.env.PAPERCUSP_HTTP_HANDLER_DEADLINE = '1';
    process.env.PAPERCUSP_HTTP_HANDLER_DEADLINE_MS = '500';
    // The middleware re-throws a pre-deadline error so Hono handles it normally:
    // Hono logs it via console.error and surfaces a 500 (expected — mock the log).
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await app().request('/api/pre-reject');
      expect(res.status).toBe(500);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('a LATE handler error (after the 503) is non-fatal — no unhandledRejection, host alive', async () => {
    process.env.PAPERCUSP_HTTP_HANDLER_DEADLINE = '1';
    process.env.PAPERCUSP_HTTP_HANDLER_DEADLINE_MS = '30';
    // Hono catches a handler throw internally and logs it via console.error before
    // building an (ignored) 500 — we already returned the 503 at the deadline. The
    // late log is expected + harmless; the INVARIANT is that nothing escapes as an
    // unhandledRejection that would exit the multi-tenant host. Mock the expected log.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const res = await app().request('/api/late-reject');
      expect(res.status).toBe(503);
      await sleep(160); // let the leaked handler fail AFTER we already responded
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      errSpy.mockRestore();
    }
  });

  it('an excluded (MCP) path is NOT deadlined even when slow', async () => {
    process.env.PAPERCUSP_HTTP_HANDLER_DEADLINE = '1';
    process.env.PAPERCUSP_HTTP_HANDLER_DEADLINE_MS = '40';
    const res = await app().request('/api/mcp/slow');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mcp: true });
  });
});
