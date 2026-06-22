/**
 * gateway-thorough.test.ts — a defensive, edge-case suite for the inference
 * gateway, complementing gateway.test.ts (which exercises the load-bearing
 * proxy/failover/stall scenarios). This file pins:
 *
 *   1. The PURE parsers — estimateTokens / parseRateReset / parseUnifiedWindow —
 *      across their malformed / boundary / precedence inputs (the cross-process
 *      budget signals route by these, so a silent mis-parse mis-routes capacity).
 *   2. The PROXY SURFACE the happy-path tests skip: method passthrough, query-string
 *      forwarding, request/response header stripping completeness (STRIP_REQUEST /
 *      STRIP_RESPONSE), the routed-account response header, the non-/v1/messages /v1
 *      fall-through to the Claude proxy, and the 404 envelope.
 *   3. The ADMIN/OBSERVABILITY endpoints at the GATEWAY level (not just the launch
 *      service level): /healthz (200 vs 503-when-paused), /stats + /admin/stats,
 *      /admin/config (wired + unwired), /admin/reload (wired + unwired), /admin/stalls
 *      (+ the ?since watermark filter).
 *
 * Style mirrors gateway.test.ts: a real mock upstream + a real gateway over loopback
 * HTTP (no mocks of the transport), self-contained per-file helpers.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import {
  createInferenceGateway,
  estimateTokens,
  parseRateReset,
  parseUnifiedWindow,
  ACCOUNT_HEADER,
  OWNER_HEADER,
  ROUTED_ACCOUNT_HEADER,
} from './gateway';
import { RateLimitGovernor } from '@papercusp/papercusp-shared/agent';

/* ------------------------------------------------------------------ *
 * Part 1 — PURE PARSERS (no I/O; fast + deterministic)
 * ------------------------------------------------------------------ */

describe('estimateTokens', () => {
  it('non-object bodies estimate to zero (no admission weight)', () => {
    expect(estimateTokens(null)).toEqual({ inTok: 0, outTok: 0 });
    expect(estimateTokens(undefined)).toEqual({ inTok: 0, outTok: 0 });
    expect(estimateTokens('a string body')).toEqual({ inTok: 0, outTok: 0 });
    expect(estimateTokens(42)).toEqual({ inTok: 0, outTok: 0 });
  });

  it('an object with no max_tokens defaults outTok to 1024', () => {
    const e = estimateTokens({ messages: [{ role: 'user', content: 'hi' }] });
    expect(e.outTok).toBe(1024);
    expect(e.inTok).toBeGreaterThan(0);
  });

  it('a non-numeric max_tokens is ignored → 1024 default', () => {
    expect(estimateTokens({ max_tokens: '512', messages: [] }).outTok).toBe(1024);
    expect(estimateTokens({ max_tokens: null, messages: [] }).outTok).toBe(1024);
  });

  it('a numeric max_tokens drives outTok verbatim (incl. 0)', () => {
    expect(estimateTokens({ max_tokens: 256, messages: [] }).outTok).toBe(256);
    expect(estimateTokens({ max_tokens: 0, messages: [] }).outTok).toBe(0);
  });

  it('inTok is ~chars/4 over the serialized system+messages and scales with input', () => {
    const small = estimateTokens({ system: 'hi', messages: [{ role: 'user', content: 'hello' }] });
    const big = estimateTokens({
      system: 'hi',
      messages: [{ role: 'user', content: 'x'.repeat(4000) }],
    });
    expect(big.inTok).toBeGreaterThan(small.inTok);
    // ~4 chars/token: a 4000-char message contributes ~1000 tokens (± framing).
    expect(big.inTok).toBeGreaterThanOrEqual(1000);
    expect(big.inTok).toBeLessThan(1100);
  });

  it('an empty object still counts the {"system":"","messages":[]} framing (small, non-zero)', () => {
    const e = estimateTokens({});
    expect(e.inTok).toBeGreaterThan(0);
    expect(e.inTok).toBeLessThan(15);
    expect(e.outTok).toBe(1024);
  });
});

describe('parseRateReset', () => {
  const now = 1_000_000_000_000; // fixed clock

  it('prefers the unified-5h reset (unix seconds → epoch ms)', () => {
    const r = parseRateReset({ 'anthropic-ratelimit-unified-5h-reset': '1700000000' }, now);
    expect(r.resetAt).toBe(1_700_000_000 * 1000);
  });

  it('falls back to the non-5h unified-reset alias', () => {
    const r = parseRateReset({ 'anthropic-ratelimit-unified-reset': '1700000000' }, now);
    expect(r.resetAt).toBe(1_700_000_000 * 1000);
  });

  it('falls back to the ISO requests-reset when no unified header is present', () => {
    const iso = new Date(now + 60_000).toISOString();
    const r = parseRateReset({ 'anthropic-ratelimit-requests-reset': iso }, now);
    expect(r.resetAt).toBe(Date.parse(iso));
  });

  it('keeps a retry-after that is consistent with the reset', () => {
    const resetSec = Math.round(now / 1000) + 600; // ~10 min out
    const r = parseRateReset(
      { 'anthropic-ratelimit-unified-5h-reset': String(resetSec), 'retry-after': '120' },
      now,
    );
    expect(r.retryAfterMs).toBe(120_000);
  });

  it('drops a retry-after that wildly exceeds the reset window (bad-upstream guard)', () => {
    const resetSec = Math.round(now / 1000) + 600;
    const r = parseRateReset(
      { 'anthropic-ratelimit-unified-5h-reset': String(resetSec), 'retry-after': '15210' },
      now,
    );
    expect(r.retryAfterMs).toBeUndefined();
  });

  it('keeps retry-after when the reset is already in the PAST (guard only fires for a future reset)', () => {
    const pastSec = Math.round(now / 1000) - 600; // reset 10 min ago
    const r = parseRateReset(
      { 'anthropic-ratelimit-unified-5h-reset': String(pastSec), 'retry-after': '15210' },
      now,
    );
    expect(r.retryAfterMs).toBe(15210 * 1000);
  });

  it('keeps retry-after when no reset header is present at all', () => {
    const r = parseRateReset({ 'retry-after': '30' }, now);
    expect(r.resetAt).toBeUndefined();
    expect(r.retryAfterMs).toBe(30_000);
  });

  it('ignores malformed values and returns empty for empty input', () => {
    expect(parseRateReset({}, now)).toEqual({});
    expect(parseRateReset({ 'anthropic-ratelimit-unified-5h-reset': 'soon' }, now)).toEqual({});
    expect(parseRateReset({ 'retry-after': 'later' }, now)).toEqual({});
  });
});

describe('parseUnifiedWindow', () => {
  it('parses the 5h utilization + reset (reset → epoch ms)', () => {
    const out = parseUnifiedWindow({
      'anthropic-ratelimit-unified-5h-utilization': '0.73',
      'anthropic-ratelimit-unified-5h-reset': '1700000000',
    });
    expect(out.utilization).toBe(0.73);
    expect(out.windowResetAt).toBe(1_700_000_000 * 1000);
  });

  it('the 5h header WINS over the legacy non-5h alias', () => {
    const out = parseUnifiedWindow({
      'anthropic-ratelimit-unified-5h-utilization': '0.9',
      'anthropic-ratelimit-unified-utilization': '0.1',
    });
    expect(out.utilization).toBe(0.9);
  });

  it('falls back to the legacy alias when the 5h header is absent', () => {
    const out = parseUnifiedWindow({ 'anthropic-ratelimit-unified-utilization': '0.25' });
    expect(out.utilization).toBe(0.25);
  });

  it('accepts a zero utilization and an over-budget (>1) utilization', () => {
    expect(parseUnifiedWindow({ 'anthropic-ratelimit-unified-5h-utilization': '0' }).utilization).toBe(0);
    expect(parseUnifiedWindow({ 'anthropic-ratelimit-unified-5h-utilization': '1.01' }).utilization).toBe(1.01);
  });

  it('rejects a negative or NaN utilization and a malformed reset', () => {
    expect(parseUnifiedWindow({ 'anthropic-ratelimit-unified-5h-utilization': '-0.5' })).toEqual({});
    expect(parseUnifiedWindow({ 'anthropic-ratelimit-unified-5h-utilization': 'NaN' })).toEqual({});
    expect(parseUnifiedWindow({ 'anthropic-ratelimit-unified-5h-reset': 'abc' })).toEqual({});
    expect(parseUnifiedWindow({})).toEqual({});
  });

  it('parses utilization even when the reset is malformed (independent fields)', () => {
    const out = parseUnifiedWindow({
      'anthropic-ratelimit-unified-5h-utilization': '0.5',
      'anthropic-ratelimit-unified-5h-reset': 'not-a-number',
    });
    expect(out.utilization).toBe(0.5);
    expect(out.windowResetAt).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Part 2 + 3 — PROXY SURFACE + ADMIN ENDPOINTS (real loopback HTTP)
 * ------------------------------------------------------------------ */

interface Upstream {
  server: http.Server;
  base: string;
  last: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string };
  close: () => Promise<void>;
}

async function startUpstream(
  reply: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<Upstream> {
  const state: Upstream['last'] = { headers: {}, body: '' };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      state.method = req.method;
      state.url = req.url;
      state.headers = req.headers;
      state.body = Buffer.concat(chunks).toString('utf8');
      reply(req, res, state.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  return {
    server,
    base: `http://127.0.0.1:${addr.port}`,
    last: state,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

let upstream: Upstream | undefined;
let gw: ReturnType<typeof createInferenceGateway> | undefined;
let port = 0;

afterEach(async () => {
  await gw?.close();
  await upstream?.close();
  gw = undefined;
  upstream = undefined;
});

async function boot(
  reply: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
  opts: Partial<Parameters<typeof createInferenceGateway>[0]> = {},
  gov?: RateLimitGovernor,
) {
  upstream = await startUpstream(reply);
  const governor = gov ?? new RateLimitGovernor({ maxConcurrent: 20 });
  gw = createInferenceGateway({
    accountId: 'acct-A',
    upstreamBase: upstream.base,
    token: async () => 'tok-A',
    governorFor: () => governor,
    maxQueueWaitMs: 80,
    // Disable the background self-heal timer in unit tests — these don't wedge.
    selfHeal: { enabled: false },
    ...opts,
  });
  port = await gw.listen(0);
  return governor;
}

const ask = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
const ok200 = (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
};
const postMsg = (body: unknown, headers: Record<string, string> = {}) =>
  ask('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('proxy surface — method + query + path fall-through', () => {
  it('forwards the query string verbatim to the upstream', async () => {
    await boot(ok200);
    const res = await postMsg({ model: 'claude-opus-4', max_tokens: 4, messages: [] });
    expect(res.status).toBe(200);
    // (sanity) baseline path with no query
    expect(upstream!.last.url).toBe('/v1/messages');

    const res2 = await ask('/v1/messages?beta=true&trace=42', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 4, messages: [] }),
    });
    expect(res2.status).toBe(200);
    expect(upstream!.last.url).toBe('/v1/messages?beta=true&trace=42');
  });

  it('a non-/v1/messages /v1/* path (e.g. GET /v1/models) falls through to the Claude proxy with the method + auth injected', async () => {
    await boot((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, url: req.url }));
    });
    const res = await ask('/v1/models', { method: 'GET' });
    expect(res.status).toBe(200);
    // method + path forwarded untouched (NOT 404'd, NOT rewritten to POST)
    expect(upstream!.last.method).toBe('GET');
    expect(upstream!.last.url).toBe('/v1/models');
    // OAuth bearer injected even on a non-messages route
    expect(upstream!.last.headers['authorization']).toBe('Bearer tok-A');
  });

  it('a non-/v1 path 404s with the gateway error envelope', async () => {
    await boot(ok200);
    const res = await ask('/nope', { method: 'GET' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { type?: string; error?: { type?: string }; gateway?: boolean };
    expect(body.gateway).toBe(true);
    expect(body.type).toBe('error');
    expect(body.error?.type).toBe('not_found_error');
  });
});

describe('proxy surface — request/response header discipline', () => {
  it('strips client auth/hop-by-hop request headers and injects OAuth + the oauth beta + identity encoding', async () => {
    await boot(ok200);
    const res = await postMsg(
      { model: 'claude-opus-4', max_tokens: 4, messages: [] },
      {
        // these MUST NOT reach upstream (STRIP_REQUEST)
        'x-api-key': 'sk-should-be-stripped',
        authorization: 'Bearer client-should-be-replaced',
        [ACCOUNT_HEADER]: 'acct-A',
        [OWNER_HEADER]: 'bee-123',
        'accept-encoding': 'gzip, br',
        // a custom header MUST pass through untouched
        'anthropic-version': '2023-06-01',
      },
    );
    expect(res.status).toBe(200);
    const h = upstream!.last.headers;
    expect(h['x-api-key']).toBeUndefined();
    expect(h[ACCOUNT_HEADER]).toBeUndefined();
    expect(h[OWNER_HEADER]).toBeUndefined();
    // client Authorization replaced by the gateway's OAuth bearer (not the client's)
    expect(h['authorization']).toBe('Bearer tok-A');
    // OAuth beta is force-merged; accept-encoding forced to identity (gateway decodes upstream)
    expect(String(h['anthropic-beta'])).toContain('oauth-2025-04-20');
    expect(h['accept-encoding']).toBe('identity');
    // a benign custom client header is preserved
    expect(h['anthropic-version']).toBe('2023-06-01');
  });

  it('strips hop-by-hop response headers but forwards custom upstream headers + names the routed account', async () => {
    await boot((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        // hop-by-hop → must be stripped from the client-facing response
        'transfer-encoding': 'chunked',
        // a custom anthropic header → must be forwarded
        'anthropic-organization-id': 'org-xyz',
        'request-id': 'req_abc',
      });
      res.end(JSON.stringify({ ok: true }));
    });
    const res = await postMsg({ model: 'claude-opus-4', max_tokens: 4, messages: [] });
    expect(res.status).toBe(200);
    expect(res.headers.get('anthropic-organization-id')).toBe('org-xyz');
    expect(res.headers.get('request-id')).toBe('req_abc');
    // the gateway always names the account it egressed on
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('acct-A');
  });
});

describe('admin + observability endpoints', () => {
  it('/healthz reports 200 + ok:true while healthy', async () => {
    await boot(ok200);
    const res = await ask('/healthz', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; accountId?: string; pausedUntil?: number };
    expect(body.ok).toBe(true);
    expect(body.accountId).toBe('acct-A');
  });

  it('/healthz flips to 503 once the bound governor is paused by an upstream unified-429', async () => {
    const gov = new RateLimitGovernor({ maxConcurrent: 20 });
    const resetSec = Math.round(Date.now() / 1000) + 3600;
    await boot(
      (_req, res) => {
        res.writeHead(429, {
          'content-type': 'application/json',
          'anthropic-ratelimit-unified-5h-status': 'rejected',
          'anthropic-ratelimit-unified-5h-utilization': '1.01',
          'anthropic-ratelimit-unified-5h-reset': String(resetSec),
        });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'over' } }));
      },
      {},
      gov,
    );
    // first request trips the unified-429 → governor paused
    const first = await postMsg({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
    expect(first.status).toBe(429);
    // healthz now signals NOT-ready (load balancers / watchdog read this)
    const health = await ask('/healthz', { method: 'GET' });
    expect(health.status).toBe(503);
    const hb = (await health.json()) as { pausedUntil?: number };
    expect(hb.pausedUntil).toBeGreaterThan(Date.now());
  });

  it('/stats and /admin/stats both return the snapshot with the expected shape', async () => {
    await boot(ok200);
    for (const path of ['/stats', '/admin/stats']) {
      const res = await ask(path, { method: 'GET' });
      expect(res.status, path).toBe(200);
      const s = (await res.json()) as Record<string, unknown>;
      expect(s.accountId).toBe('acct-A');
      expect(typeof s.totalRequests).toBe('number');
      expect(typeof s.concurrencyCap).toBe('number');
      expect(typeof s.maxQueued).toBe('number');
      expect(s.cache).toMatchObject({ read: 0, create: 0, hits: 0, misses: 0 });
      expect(s.aimd).toBeTruthy();
    }
  });

  it('/admin/config reports hotReload:false + the live admission snapshot when no adminConfig dep is wired', async () => {
    await boot(ok200);
    const res = await ask('/admin/config', { method: 'GET' });
    expect(res.status).toBe(200);
    const c = (await res.json()) as Record<string, unknown>;
    expect(c.hotReload).toBe(false);
    expect(c.admission).toBeTruthy();
    expect(typeof c.concurrencyCap).toBe('number');
    expect(c.aimd).toBeTruthy();
    expect(typeof c.upstreamBase).toBe('string');
    expect(c.providers).toEqual([
      expect.objectContaining({ id: 'claude', configured: true, protocol: 'anthropic' }),
      expect.objectContaining({ id: 'codex', configured: false, protocol: 'openai-compatible' }),
      expect.objectContaining({ id: 'omp', configured: false, protocol: 'unsupported' }),
    ]);
  });

  it('/admin/config merges the wired adminConfig (version + accounts)', async () => {
    await boot(ok200, {
      adminConfig: () => ({ version: 7, accounts: ['acct-A', 'acct-B'] }),
    });
    const res = await ask('/admin/config', { method: 'GET' });
    const c = (await res.json()) as { version?: number; accounts?: string[]; admission?: unknown };
    expect(c.version).toBe(7);
    expect(c.accounts).toEqual(['acct-A', 'acct-B']);
    expect(c.admission).toBeTruthy();
  });

  it('/admin/reload returns 503 (not hot-reloadable) when onAdminReload is unwired', async () => {
    await boot(ok200);
    const res = await ask('/admin/reload', { method: 'POST' });
    expect(res.status).toBe(503);
    const b = (await res.json()) as { gateway?: boolean };
    expect(b.gateway).toBe(true);
  });

  it('/admin/reload invokes the wired hot-reload and returns its result', async () => {
    let called = 0;
    await boot(ok200, {
      onAdminReload: async () => {
        called++;
        return { changed: true, version: 9, accounts: ['acct-A'] };
      },
    });
    const res = await ask('/admin/reload', { method: 'POST' });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { ok?: boolean; changed?: boolean; version?: number };
    expect(b.ok).toBe(true);
    expect(b.changed).toBe(true);
    expect(b.version).toBe(9);
    expect(called).toBe(1);
  });

  it('/admin/stalls returns an envelope with a now watermark and honors the ?since filter', async () => {
    await boot(ok200);
    const res = await ask('/admin/stalls', { method: 'GET' });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { ok?: boolean; now?: number; stalls?: unknown[] };
    expect(b.ok).toBe(true);
    expect(typeof b.now).toBe('number');
    expect(Array.isArray(b.stalls)).toBe(true);
    // a future watermark filters everything out (no stalls recorded in this fresh gateway anyway)
    const res2 = await ask(`/admin/stalls?since=${Date.now() + 60_000}`, { method: 'GET' });
    const b2 = (await res2.json()) as { stalls?: unknown[] };
    expect(b2.stalls).toEqual([]);
  });
});
