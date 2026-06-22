/**
 * gateway-openai-proxy.test.ts — the Codex / OpenAI-compatible proxy path
 * (`proxyOpenAi`, the `/v1/responses` route). gateway.test.ts has a SINGLE
 * codex test (429 rotation); this file exercises the path thoroughly because a
 * parallel-to-Claude code path is exactly where behavior silently drifts:
 *
 *   - no-codex-pool 503, and the bearer/header discipline (codex bearer injected,
 *     client x-api-key/authorization stripped, accept-encoding forced to identity,
 *     and — distinct from the Claude path — NO anthropic oauth beta injected);
 *   - the RESILIENCE-PARITY rotations the 2026-06-22 audit added: a 429, a
 *     token-read failure → rotate to another Codex account + retry (route around,
 *     don't surface), and the single-account cases that must FORWARD/ERROR rather
 *     than hang or loop;
 *   - route isolation: /v1/responses → the OpenAI upstream + codex creds, while
 *     /v1/messages → the Claude upstream + claude creds, on the same gateway.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import {
  createInferenceGateway,
  ACCOUNT_HEADER,
  ROUTED_ACCOUNT_HEADER,
  type ActiveAccount,
} from './gateway';
import { createFailoverPool } from './account-failover';
import { RateLimitGovernor } from '@papercusp/papercusp-shared/agent';

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

const codexAcct = (id: string, token?: () => Promise<string>): ActiveAccount => ({
  accountId: id,
  token: token ?? (async () => `${id}-tok`),
  invalidateToken: () => {},
});

let gw: ReturnType<typeof createInferenceGateway> | undefined;
let openaiUpstream: Upstream | undefined;
let claudeUpstream: Upstream | undefined;
let port = 0;

afterEach(async () => {
  await gw?.close();
  await openaiUpstream?.close();
  await claudeUpstream?.close();
  gw = undefined;
  openaiUpstream = undefined;
  claudeUpstream = undefined;
});

/** Boot a gateway with a Codex pool + OpenAI upstream. `codexAccounts` defaults to two;
 *  `gwOpts` overrides createInferenceGateway deps (e.g. the stall-timeout knobs). */
async function bootCodex(
  openaiReply: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
  codexAccounts: ActiveAccount[] = [codexAcct('cdx-1'), codexAcct('cdx-2')],
  gwOpts: Partial<Parameters<typeof createInferenceGateway>[0]> = {},
) {
  openaiUpstream = await startUpstream(openaiReply);
  const codexPool = createFailoverPool(codexAccounts);
  gw = createInferenceGateway({
    accountId: 'claude-acct',
    // The Claude side is never contacted in codex-only tests; point it at the same
    // loopback host so nothing escapes to a real upstream if a path is mis-routed.
    upstreamBase: openaiUpstream.base,
    openaiUpstreamBase: openaiUpstream.base,
    codexPool,
    token: async () => 'claude-tok',
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    maxQueueWaitMs: 80,
    selfHeal: { enabled: false },
    ...gwOpts,
  });
  port = await gw.listen(0);
}

const ask = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
const postResponses = (body: unknown, headers: Record<string, string> = {}) =>
  ask('/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const ok = (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'resp_1', ok: true }));
};

describe('proxyOpenAi — no pool / configuration', () => {
  it('/v1/responses returns a 503 gateway envelope when no Codex pool is configured', async () => {
    openaiUpstream = await startUpstream(ok);
    gw = createInferenceGateway({
      accountId: 'claude-acct',
      upstreamBase: openaiUpstream.base,
      token: async () => 'claude-tok',
      governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
      selfHeal: { enabled: false },
      // no codexPool
    });
    port = await gw.listen(0);
    const res = await postResponses({ model: 'gpt-x', input: 'hi' });
    expect(res.status).toBe(503);
    const b = (await res.json()) as { gateway?: boolean; error?: { message?: string } };
    expect(b.gateway).toBe(true);
    expect(b.error?.message).toMatch(/no Codex account pool/i);
  });
});

describe('proxyOpenAi — happy path + header discipline', () => {
  it('forwards a 200 with the codex bearer + identity encoding, names the routed account, and does NOT inject the anthropic oauth beta', async () => {
    await bootCodex(ok);
    const res = await postResponses(
      { model: 'gpt-x', input: 'hi' },
      { 'x-api-key': 'sk-strip-me', authorization: 'Bearer client-replace-me', 'anthropic-beta': 'fine-grained-2025' },
    );
    expect(res.status).toBe(200);
    expect((await res.json() as { ok?: boolean }).ok).toBe(true);

    const h = openaiUpstream!.last.headers;
    // codex OAuth bearer injected (NOT the client's), client api-key stripped
    expect(h['authorization']).toBe('Bearer cdx-1-tok');
    expect(h['x-api-key']).toBeUndefined();
    expect(h['accept-encoding']).toBe('identity');
    // CRITICAL: the codex path must NOT force the Claude-only oauth-2025-04-20 beta —
    // it would 400 against OpenAI. The client's anthropic-beta is passed through untouched
    // (no oauth- token merged in), unlike the Claude proxy which force-merges it.
    expect(String(h['anthropic-beta'] ?? '')).not.toContain('oauth-2025-04-20');
    // routed-account header names the codex account that served it
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('cdx-1');
  });

  it('forwards the method, path+query, and body verbatim to the OpenAI upstream', async () => {
    await bootCodex(ok);
    const res = await ask('/v1/responses?stream=false&trace=9', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-x', input: 'forward me' }),
    });
    expect(res.status).toBe(200);
    expect(openaiUpstream!.last.method).toBe('POST');
    expect(openaiUpstream!.last.url).toBe('/v1/responses?stream=false&trace=9');
    expect(JSON.parse(openaiUpstream!.last.body).input).toBe('forward me');
  });

  it('honors an x-papercusp-account pin to a specific codex account (cache affinity)', async () => {
    await bootCodex(ok);
    const res = await postResponses({ model: 'gpt-x', input: 'hi' }, { [ACCOUNT_HEADER]: 'cdx-2' });
    expect(res.status).toBe(200);
    expect(openaiUpstream!.last.headers['authorization']).toBe('Bearer cdx-2-tok');
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('cdx-2');
  });

  it('counts the request on the codex stats bucket', async () => {
    await bootCodex(ok);
    await postResponses({ model: 'gpt-x', input: 'hi' });
    const s = (await (await ask('/stats')).json()) as { codex: { requests: number } };
    expect(s.codex.requests).toBeGreaterThanOrEqual(1);
  });
});

describe('proxyOpenAi — resilience parity (rotate, do not surface)', () => {
  // Branch the upstream on the bearer token so cdx-1 is throttled but cdx-2 is healthy.
  const byBearer = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const auth = String(req.headers['authorization'] ?? '');
    if (auth.includes('cdx-1')) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'rate_limit', message: 'slow down' } }));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, served_by: 'cdx-2' }));
    }
  };

  it('a 429 on one codex account ROTATES to another + retries — the bee gets the 200, not the throttle', async () => {
    await bootCodex(byBearer);
    const res = await postResponses({ model: 'gpt-x', input: 'hi' });
    expect(res.status).toBe(200);
    expect((await res.json() as { served_by?: string }).served_by).toBe('cdx-2');
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('cdx-2');
    const s = (await (await ask('/stats')).json()) as { codex: { failovers: number; upstream429: number } };
    expect(s.codex.failovers).toBeGreaterThanOrEqual(1);
    expect(s.codex.upstream429).toBeGreaterThanOrEqual(1);
  });

  it('a SINGLE-account codex pool with a persistent 429 FORWARDS the 429 (no rotate target → no hang/loop)', async () => {
    await bootCodex(
      (_req, res) => {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
        res.end(JSON.stringify({ error: { type: 'rate_limit', message: 'over' } }));
      },
      [codexAcct('cdx-solo')],
    );
    const res = await postResponses({ model: 'gpt-x', input: 'hi' });
    expect(res.status).toBe(429);
    // it's the real upstream 429 forwarded (the bee's CLI then backs off), not a synthetic loop
    expect((await res.json() as { error?: { type?: string } }).error?.type).toBe('rate_limit');
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('cdx-solo');
  });

  it('a token-read failure on one codex account rotates to a healthy one + retries', async () => {
    let cdx1Calls = 0;
    await bootCodex(ok, [
      codexAcct('cdx-1', async () => {
        cdx1Calls++;
        throw new Error('token endpoint down');
      }),
      codexAcct('cdx-2'),
    ]);
    const res = await postResponses({ model: 'gpt-x', input: 'hi' });
    expect(res.status).toBe(200);
    expect(cdx1Calls).toBe(1); // tried cdx-1's token, it failed, rotated
    expect(openaiUpstream!.last.headers['authorization']).toBe('Bearer cdx-2-tok');
    expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('cdx-2');
  });

  it('a token-read failure on a SINGLE-account codex pool returns a retryable 503 (no rotate target)', async () => {
    await bootCodex(ok, [
      codexAcct('cdx-solo', async () => {
        throw new Error('token endpoint down');
      }),
    ]);
    const res = await postResponses({ model: 'gpt-x', input: 'hi' });
    expect(res.status).toBe(503);
    const b = (await res.json()) as { gateway?: boolean; error?: { type?: string } };
    expect(b.gateway).toBe(true);
    expect(b.error?.type).toBe('overloaded_error');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('proxyOpenAi — route isolation from the Claude proxy', () => {
  it('/v1/responses hits the OpenAI upstream with codex creds; /v1/messages hits the Claude upstream with claude creds', async () => {
    openaiUpstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ from: 'openai' }));
    });
    claudeUpstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ from: 'claude' }));
    });
    const codexPool = createFailoverPool([codexAcct('cdx-1')]);
    gw = createInferenceGateway({
      accountId: 'claude-acct',
      upstreamBase: claudeUpstream.base,
      openaiUpstreamBase: openaiUpstream.base,
      codexPool,
      token: async () => 'claude-tok',
      governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
      selfHeal: { enabled: false },
    });
    port = await gw.listen(0);

    const codexRes = await postResponses({ model: 'gpt-x', input: 'hi' });
    expect((await codexRes.json() as { from?: string }).from).toBe('openai');
    expect(openaiUpstream.last.headers['authorization']).toBe('Bearer cdx-1-tok');

    const claudeRes = await ask('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 4, messages: [] }),
    });
    expect((await claudeRes.json() as { from?: string }).from).toBe('claude');
    // the Claude path injects the claude bearer + the oauth beta (NOT a codex token)
    expect(claudeUpstream.last.headers['authorization']).toBe('Bearer claude-tok');
    expect(String(claudeUpstream.last.headers['anthropic-beta'])).toContain('oauth-2025-04-20');
  });
});

describe('proxyOpenAi — stream-stall guards (parity with the Claude proxy)', () => {
  // A server that accepts the request but NEVER responds (headers never arrive).
  const hangHeaders = () => {
    /* never write/end — the upstream stalls before sending response headers */
  };
  // A single-account codex pool so a stall makes exactly ONE attempt (no rotate) → deterministic timing.
  const solo = () => [codexAcct('cdx-solo')];

  it('a stream:true request aborts at the SHORT TTFB deadline, not the generous one (no slot squat)', async () => {
    await bootCodex(hangHeaders, solo(), {
      upstreamHeadersTimeoutMs: 1000, // generous (non-stream)
      upstreamStreamHeadersTimeoutMs: 150, // short TTFB for streams
    });
    const start = Date.now();
    const res = await postResponses({ model: 'gpt-x', input: 'hi', stream: true });
    const elapsed = Date.now() - start;
    expect(res.status).toBe(502); // single-account stall → forwarded as 502
    // It must abort at ~150ms (stream TTFB), well under the 1000ms generous deadline.
    expect(elapsed).toBeLessThan(700);
  });

  it('a NON-stream request keeps the GENEROUS headers deadline (regression guard — streams must not shorten it)', async () => {
    await bootCodex(hangHeaders, solo(), {
      upstreamHeadersTimeoutMs: 1000,
      upstreamStreamHeadersTimeoutMs: 150,
    });
    const start = Date.now();
    const res = await postResponses({ model: 'gpt-x', input: 'hi' }); // no stream
    const elapsed = Date.now() - start;
    expect(res.status).toBe(502);
    // It must wait the generous ~1000ms, NOT the 150ms stream TTFB.
    expect(elapsed).toBeGreaterThan(700);
  });

  it('a mid-stream upstream BODY stall is aborted by the body-idle guard (not left to the slow downstream-idle backstop)', async () => {
    // Upstream: send 200 + headers + ONE chunk, then hang forever (never end, never send more).
    await bootCodex(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"type":"response.created"}\n\n');
        // ...then stall mid-stream (no more bytes, no end).
      },
      solo(),
      {
        upstreamHeadersTimeoutMs: 2000,
        upstreamStreamHeadersTimeoutMs: 2000, // headers arrive instantly — not the limiting factor here
        upstreamBodyIdleTimeoutMs: 200, // the guard under test
        downstreamIdleMs: 3000, // the OLD-path backstop — high, so only a real body-idle guard is fast
      },
    );
    const start = Date.now();
    const res = await postResponses({ model: 'gpt-x', input: 'hi', stream: true });
    expect(res.status).toBe(200); // headers forwarded, then upstream stalls
    let settled = 0;
    try {
      await res.text(); // the body read terminates when the gateway tears the stalled stream down
    } catch {
      /* a destroyed mid-stream connection rejects the body read — expected */
    } finally {
      settled = Date.now() - start;
    }
    // body-idle (200ms) must fire FAR before the 3000ms downstream-idle backstop.
    expect(settled).toBeLessThan(1500);
  });
});
