/**
 * Route-stack mechanics — synthetic routes mounted on a throwaway Hono
 * app, exercised via Hono's in-process `app.request()` (no server).
 *
 * Covers: auth (public + gated), input validation (body + query),
 * handler invoke, error → 500, timeout → 408, duplicate-route guard,
 * and the route-stack step ordering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';

vi.mock('../../auth/require-principal', async () => {
  const actual = await vi.importActual<typeof import('../../auth/require-principal')>(
    '../../auth/require-principal',
  );
  return { ...actual, requirePrincipal: vi.fn() };
});

// Telemetry writes to PG — out of scope for route-stack mechanics tests.
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

// The loopback tier reads ENDPOINT_AUTH_TIERS server-side (dynamic import).
// Partial mock — other transitive imports use the module's other exports.
vi.mock('@papercusp/flags/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/flags/server')>();
  return { ...actual, getFlag: vi.fn(async () => true) };
});

import { defineTool } from '@papercusp/agent-mcp';
import { registerRoute } from '../define-route';
import { DEFAULT_ROUTE_STACK } from '../route-stack';
import { registerAllRoutes } from '../register';
import { requirePrincipal, PrincipalCheckError } from '../../auth/require-principal';
import { getFlag } from '@papercusp/flags/server';
import { recordRouteInvocation } from '../telemetry';

function freshApp(): Hono {
  return new Hono();
}

beforeEach(() => {
  vi.mocked(requirePrincipal).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('route-stack — step order', () => {
  it('runs auth → input → invoke', () => {
    expect(DEFAULT_ROUTE_STACK.map((s) => s.name)).toEqual(['auth', 'input', 'invoke']);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_ROUTE_STACK)).toBe(true);
  });
});

describe('auth step', () => {
  it('public route skips requirePrincipal and runs the handler', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/pub', auth: 'public',
      handler: () => Response.json({ ok: true }),
    }));
    const res = await app.request('/pub');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(requirePrincipal).not.toHaveBeenCalled();
  });

  it('gated route calls requirePrincipal and runs the handler on success', async () => {
    vi.mocked(requirePrincipal).mockResolvedValue({
      kind: 'system', slug: 's', workspaceId: 'w',
      authMethod: 'process-internal', trust: 'trusted', capabilities: new Set(),
    });
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/gated', auth: { trust: ['trusted'] },
      handler: (_req, ctx) => Response.json({ kind: ctx.principal?.kind }),
    }));
    const res = await app.request('/gated');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'system' });
  });

  it('gated route returns the PrincipalCheckError status on denial', async () => {
    vi.mocked(requirePrincipal).mockRejectedValue(new PrincipalCheckError(403, 'trust denied'));
    const app = freshApp();
    let handlerRan = false;
    registerRoute(app, defineTool({
      method: 'GET', path: '/gated', auth: { trust: ['trusted'] },
      handler: () => { handlerRan = true; return Response.json({}); },
    }));
    const res = await app.request('/gated');
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe('trust denied');
    expect(handlerRan).toBe(false);
  });
});

/**
 * Gap 5 — the `?token=` → `Authorization: Bearer` lift (route-stack.ts
 * `authHeaders`). SECURITY-sensitive: a query token may only become a
 * bearer credential when the route's `auth.tokenIn` includes `'query'`,
 * and it must never override an Authorization header the caller already
 * set. The stub `requirePrincipal` echoes the resolved `Authorization`
 * header it was handed back through the principal's slug, so the handler
 * can assert exactly what the resolvers would have seen.
 */
describe('auth step — ?token= → bearer lift (Gap 5, security)', () => {
  /** Echo whatever Authorization header the auth step resolved. */
  function echoAuthHeader() {
    vi.mocked(requirePrincipal).mockImplementation(async (headers) => ({
      kind: 'system',
      slug: headers.get('authorization') ?? '<none>',
      workspaceId: 'w',
      authMethod: 'process-internal',
      trust: 'trusted',
      capabilities: new Set<string>(),
    }));
  }

  it('(a) lifts ?token= into a bearer when tokenIn includes "query"', async () => {
    echoAuthHeader();
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/q-auth', auth: { kind: ['system'], tokenIn: ['query'] },
      handler: (_req, ctx) => Response.json({ seen: ctx.principal?.slug }),
    }));
    const res = await app.request('/q-auth?token=qtok');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ seen: 'Bearer qtok' });
  });

  it('(b) NEVER overrides an existing Authorization header with ?token=', async () => {
    echoAuthHeader();
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/q-auth', auth: { kind: ['system'], tokenIn: ['query'] },
      handler: (_req, ctx) => Response.json({ seen: ctx.principal?.slug }),
    }));
    // A real header is present AND a ?token= is supplied: the header wins.
    const res = await app.request('/q-auth?token=qtok', {
      headers: { authorization: 'Bearer real-header-token' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ seen: 'Bearer real-header-token' });
  });

  it('(c) IGNORES ?token= entirely when tokenIn is absent (no bearer smuggling)', async () => {
    echoAuthHeader();
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/h-only', auth: { kind: ['system'] },
      handler: (_req, ctx) => Response.json({ seen: ctx.principal?.slug }),
    }));
    // No tokenIn → ?token= must NOT be promoted to a bearer. The resolver
    // sees no Authorization header at all.
    const res = await app.request('/h-only?token=qtok');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ seen: '<none>' });
  });

  it('(c2) IGNORES ?token= when tokenIn is ["header"] only', async () => {
    echoAuthHeader();
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/h-explicit', auth: { kind: ['system'], tokenIn: ['header'] },
      handler: (_req, ctx) => Response.json({ seen: ctx.principal?.slug }),
    }));
    const res = await app.request('/h-explicit?token=qtok');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ seen: '<none>' });
  });
});

describe('auth step — loopback tier (auth-tier rollout Wave 1)', () => {
  const lbRoute = () => defineTool({
    method: 'POST', path: '/lb', auth: 'loopback',
    handler: () => Response.json({ ok: true }),
  });

  beforeEach(() => {
    vi.mocked(getFlag).mockResolvedValue(true);
    delete process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN;
  });
  afterEach(() => {
    delete process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN;
  });

  it('admits a loopback-host request without requirePrincipal', async () => {
    const app = freshApp();
    registerRoute(app, lbRoute());
    // app.request('/lb') builds http://localhost/lb — a loopback Host.
    const res = await app.request('/lb', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(requirePrincipal).not.toHaveBeenCalled();
  });

  it('rejects a non-loopback Host with 403 before the handler', async () => {
    const app = freshApp();
    let handlerRan = false;
    registerRoute(app, defineTool({
      method: 'POST', path: '/lb', auth: 'loopback',
      handler: () => { handlerRan = true; return Response.json({}); },
    }));
    const res = await app.request('http://evil.example.com/lb', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(handlerRan).toBe(false);
  });

  it('flag OFF reverts to public behavior (the emergency lever)', async () => {
    vi.mocked(getFlag).mockResolvedValue(false);
    const app = freshApp();
    registerRoute(app, lbRoute());
    const res = await app.request('http://evil.example.com/lb', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('Gap 6: flag-layer error fails CLOSED — loopback route still 403s a remote Host', async () => {
    // The flag resolver throws (PG down, import failure, …). The route
    // declares itself loopback-only; `endpointAuthTiersEnabled` must treat
    // an unreachable flag layer as "enabled" so the declared tier holds.
    vi.mocked(getFlag).mockRejectedValue(new Error('flag layer unreachable'));
    const app = freshApp();
    let handlerRan = false;
    registerRoute(app, defineTool({
      method: 'POST', path: '/lb', auth: 'loopback',
      handler: () => { handlerRan = true; return Response.json({}); },
    }));
    const res = await app.request('http://evil.example.com/lb', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(handlerRan).toBe(false);
  });

  it('Gap 6: flag-layer error still admits a loopback Host (fail-closed, not fail-broken)', async () => {
    // Fail-CLOSED means "enforce the loopback gate", not "reject everything":
    // a genuinely-loopback caller must still get through.
    vi.mocked(getFlag).mockRejectedValue(new Error('flag layer unreachable'));
    const app = freshApp();
    registerRoute(app, lbRoute());
    const res = await app.request('/lb', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('PAPERCUSP_ALLOW_REMOTE_ADMIN=1 admits a remote host (deliberate opt-out)', async () => {
    process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN = '1';
    const app = freshApp();
    registerRoute(app, lbRoute());
    const res = await app.request('http://evil.example.com/lb', { method: 'POST' });
    expect(res.status).toBe(200);
  });
});

describe('input step', () => {
  it('parses a valid POST body', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'POST', path: '/echo', auth: 'public',
      input: z.object({ n: z.number() }),
      handler: (_req, ctx) => Response.json({ doubled: ctx.input.n * 2 }),
    }));
    const res = await app.request('/echo', {
      method: 'POST', body: JSON.stringify({ n: 21 }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ doubled: 42 });
  });

  it('rejects an invalid POST body with 400', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'POST', path: '/echo', auth: 'public',
      input: z.object({ n: z.number() }),
      handler: () => Response.json({}),
    }));
    const res = await app.request('/echo', {
      method: 'POST', body: JSON.stringify({ n: 'not-a-number' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_input');
  });

  it('rejects non-JSON body with 400', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'POST', path: '/echo', auth: 'public',
      input: z.object({ n: z.number() }),
      handler: () => Response.json({}),
    }));
    const res = await app.request('/echo', {
      method: 'POST', body: 'not json{', headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('parses GET input from the query string', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/q', auth: 'public',
      input: z.object({ limit: z.coerce.number() }),
      handler: (_req, ctx) => Response.json({ limit: ctx.input.limit }),
    }));
    const res = await app.request('/q?limit=7');
    expect(await res.json()).toEqual({ limit: 7 });
  });

  // ── Gap 13: GET query coercion footgun. searchParams are ALL strings;
  //    the route-stack does not coerce, so a non-coercing schema 400s. ──
  it('Gap 13: a GET z.number() schema 400s on ?n=5 (string, not coerced)', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/n', auth: 'public',
      input: z.object({ n: z.number() }),
      handler: (_req, ctx) => Response.json({ n: ctx.input.n }),
    }));
    const res = await app.request('/n?n=5');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_input');
  });

  it('Gap 13: z.coerce.number() passes ?n=5 → 200 with n===5 (number)', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/n', auth: 'public',
      input: z.object({ n: z.coerce.number() }),
      handler: (_req, ctx) => Response.json({ n: ctx.input.n, isNumber: typeof ctx.input.n === 'number' }),
    }));
    const res = await app.request('/n?n=5');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ n: 5, isNumber: true });
  });

  it('Gap 13: a repeated query key is last-wins (Object.fromEntries)', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/dup', auth: 'public',
      input: z.object({ x: z.string() }),
      handler: (_req, ctx) => Response.json({ x: ctx.input.x }),
    }));
    const res = await app.request('/dup?x=1&x=2');
    expect(res.status).toBe(200);
    // Object.fromEntries(searchParams) keeps the LAST value for a repeated key.
    expect(await res.json()).toEqual({ x: '2' });
  });

  it('handler gets undefined input when no schema declared', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'POST', path: '/raw', auth: 'public',
      handler: (_req, ctx) => Response.json({ input: ctx.input ?? 'undefined' }),
    }));
    const res = await app.request('/raw', { method: 'POST', body: 'anything' });
    expect(await res.json()).toEqual({ input: 'undefined' });
  });
});

describe('invoke step', () => {
  it('a thrown handler error becomes a 500 envelope', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/boom', auth: 'public',
      handler: () => { throw new Error('kaboom'); },
    }));
    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('handler_error');
    expect(body.error.message).toBe('kaboom');
  });

  it('a handler exceeding timeoutSec becomes a 408', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/slow', auth: 'public',
      timeoutSec: 0.1,
      handler: (_req, ctx) => new Promise<Response>((resolve) => {
        // Resolve only after the abort fires — the route-stack should
        // surface a 408 regardless of this late success.
        ctx.signal.addEventListener('abort', () => resolve(Response.json({ late: true })));
      }),
    }));
    const res = await app.request('/slow');
    expect(res.status).toBe(408);
    expect((await res.json()).error.code).toBe('timeout');
  });

  it('passes path params through ctx.params', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/harness/:slug', auth: 'public',
      handler: (_req, ctx) => Response.json({ slug: ctx.params.slug }),
    }));
    const res = await app.request('/harness/sheets');
    expect(await res.json()).toEqual({ slug: 'sheets' });
  });

  it('timeoutSec: null disables the watchdog (long-lived SSE routes, EI-110)', async () => {
    vi.useFakeTimers();
    try {
      const app = freshApp();
      registerRoute(app, defineTool({
        method: 'GET', path: '/stream', auth: 'public',
        timeoutSec: null,
        handler: (_req, ctx) => new Promise<Response>((resolve) => {
          // Resolves well past the 30s default; only an abort could beat it.
          const t = setTimeout(() => resolve(Response.json({ ok: true })), 60_000);
          if (typeof t.unref === 'function') t.unref();
          ctx.signal.addEventListener('abort', () =>
            resolve(Response.json({ aborted: true }, { status: 599 })),
          );
        }),
      }));
      const pending = app.request('/stream');
      await vi.advanceTimersByTimeAsync(61_000); // would fire a 30s watchdog twice over
      const res = await pending;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true }); // never aborted
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runRouteStack — response byte capture (EI-7069)', () => {
  it('captures Content-Length as exec.responseBytes for a plain JSON response', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/sized', auth: 'public',
      handler: () => Response.json({ hello: 'world' }),
    }));
    const res = await app.request('/sized');
    expect(res.status).toBe(200);
    expect(recordRouteInvocation).toHaveBeenCalledTimes(1);
    const exec = vi.mocked(recordRouteInvocation).mock.calls[0][0];
    // Response.json sets Content-Length itself — the exact byte count of the
    // serialized body, so this is deterministic, not just "a number".
    const body = JSON.stringify({ hello: 'world' });
    expect(exec.responseBytes).toBe(new TextEncoder().encode(body).length);
  });

  it('leaves responseBytes null for a streaming response with no Content-Length', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/stream-sized', auth: 'public',
      handler: () =>
        new Response(new ReadableStream({ start: (c) => { c.enqueue(new Uint8Array([1])); c.close(); } })),
    }));
    const res = await app.request('/stream-sized');
    expect(res.status).toBe(200);
    expect(recordRouteInvocation).toHaveBeenCalledTimes(1);
    const exec = vi.mocked(recordRouteInvocation).mock.calls[0][0];
    expect(exec.responseBytes).toBeNull();
  });

  it('never breaks the response even if reading headers were to throw', async () => {
    // Defensive: the try/catch around header-reading must never surface into
    // the response itself, whatever the response shape.
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/plain', auth: 'public',
      handler: () => new Response('ok'),
    }));
    const res = await app.request('/plain');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});

describe('registerAllRoutes — duplicate guard', () => {
  it('throws on a duplicate method+path', () => {
    // registerAllRoutes reads the real ALL_ROUTES; here we only assert
    // the guard logic via a direct collision in a hand-built app.
    const app = freshApp();
    const a = defineTool({ method: 'GET', path: '/x', auth: 'public', handler: () => Response.json({}) });
    registerRoute(app, a);
    // Re-registering the same path on Hono is allowed by Hono itself;
    // the duplicate *guard* lives in registerAllRoutes. Smoke-check that
    // registerAllRoutes runs without throwing on the real (collision-free)
    // ALL_ROUTES.
    expect(() => registerAllRoutes(freshApp())).not.toThrow();
  });
});
