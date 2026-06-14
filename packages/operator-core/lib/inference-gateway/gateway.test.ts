/** Tests for the inference gateway proxy + governor pacing (P-006/P-007/P-009). */
import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createInferenceGateway, estimateTokens, parseRateReset, type ActiveAccount, type AccountPool } from './gateway';
import { createFailoverPool } from './account-failover';
import { RateLimitGovernor, getGovernor, resetGovernorRegistry } from '@papercusp/papercup-shared/agent';

interface Upstream {
  server: http.Server;
  base: string;
  last: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string };
  reply: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;
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
    reply,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

let upstream: Upstream;
let gw: ReturnType<typeof createInferenceGateway>;
let port = 0;
let invalidated = 0;

afterEach(async () => {
  await gw?.close();
  await upstream?.close();
  invalidated = 0;
});

async function boot(
  reply: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
  opts: Partial<Parameters<typeof createInferenceGateway>[0]> = {},
  gov?: RateLimitGovernor,
) {
  upstream = await startUpstream(reply);
  const governor = gov ?? new RateLimitGovernor({ maxConcurrent: 20 });
  gw = createInferenceGateway({
    accountId: 'test-acct',
    upstreamBase: upstream.base,
    token: async () => 'test-token',
    invalidateToken: () => {
      invalidated++;
    },
    governorFor: () => governor,
    maxQueueWaitMs: 80,
    ...opts,
  });
  port = await gw.listen(0);
  return governor;
}

const ask = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
const post = (body: unknown) =>
  ask('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-beta': 'fine-grained-2025' }, body: JSON.stringify(body) });

test('estimateTokens — uses max_tokens for output, ~chars/4 for input', () => {
  const e = estimateTokens({ system: 'hi', messages: [{ role: 'user', content: 'hello world' }], max_tokens: 256 });
  assert.equal(e.outTok, 256);
  assert.ok(e.inTok > 0);
});

test('parseRateReset — prefers unified unix-seconds reset; drops a retry-after that disagrees', () => {
  const now = 1_000_000;
  const r = parseRateReset(
    { 'anthropic-ratelimit-unified-5h-reset': String(Math.round(now / 1000) + 600), 'retry-after': '15210' },
    now,
  );
  assert.equal(r.resetAt, (Math.round(now / 1000) + 600) * 1000);
  assert.equal(r.retryAfterMs, undefined, 'retry-after 15210s discarded vs a ~600s reset');
});

test('transparent proxy — injects OAuth bearer + merges anthropic-beta, forwards body + status', async () => {
  await boot((_req, res, _body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, echoModel: 'seen' }));
  });
  const res = await post({ model: 'claude-opus-4-99', max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 200);
  const j = (await res.json()) as { ok: boolean };
  assert.equal(j.ok, true);
  // upstream saw the injected auth (bee sent none) + the merged beta + forwarded body
  assert.equal(upstream.last.headers['authorization'], 'Bearer test-token');
  assert.ok(String(upstream.last.headers['anthropic-beta']).includes('oauth-2025-04-20'));
  assert.ok(String(upstream.last.headers['anthropic-beta']).includes('fine-grained-2025'), 'preserves the client beta flags');
  assert.equal(upstream.last.headers['accept-encoding'], 'identity');
  assert.equal(JSON.parse(upstream.last.body).model, 'claude-opus-4-99');
});

test('transparent proxy — streams an SSE body through untouched, drops content-length', async () => {
  await boot((_req, res) => {
    // Real SSE is chunked (no content-length); the gateway must re-stream it chunked too.
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    res.write('event: content_block_delta\ndata: {"delta":{"text":"hi"}}\n\n');
    res.end();
  });
  const res = await post({ model: 'claude-opus-4', stream: true, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  assert.equal(res.headers.get('content-length'), null, 'content-length stripped (we re-stream)');
  const text = await res.text();
  assert.ok(text.includes('message_start') && text.includes('"text":"hi"'));
});

test('backpressure — an upstream unified-429 pauses the governor; the next request gets a synthetic 429+retry-after', async () => {
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
  // first request propagates the real upstream 429
  const first = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(first.status, 429);
  assert.equal((await first.json() as { gateway?: boolean }).gateway, undefined, 'real upstream 429, not synthetic');
  // governor is now paused → the next request times out admission (maxQueueWaitMs 80ms) → synthetic 429
  const second = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(second.status, 429);
  const body = (await second.json()) as { gateway?: boolean };
  assert.equal(body.gateway, true, 'synthetic gateway 429 (queued behind the pause)');
  assert.ok(Number(second.headers.get('retry-after')) > 0);
});

test('401 from upstream invalidates the cached token', async () => {
  await boot((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
  });
  await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(invalidated, 1);
});

test('healthz + stats endpoints report account + counters', async () => {
  await boot((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const health = await ask('/healthz');
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { accountId: string }).accountId, 'test-acct');
  await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  const stats = await (await ask('/stats')).json() as { totalRequests: number };
  assert.ok(stats.totalRequests >= 1);
});

test('non-/v1 paths 404', async () => {
  await boot((_req, res) => res.end('{}'));
  const res = await ask('/nope');
  assert.equal(res.status, 404);
});

test('default governor is ACCOUNT-KEYED so a gateway 429 feeds the account-pool observer (P-017)', async () => {
  // No injected governorFor → the gateway must resolve the SAME per-account bucket
  // (anthropic:<class>@<accountId>) that initAccountScaleObserver listens on, so an upstream
  // 429 records against THIS account's pool projection (and only sustained exhaustion scales out).
  resetGovernorRegistry();
  const resetSec = Math.round(Date.now() / 1000) + 1800;
  upstream = await startUpstream((_req, res) => {
    res.writeHead(429, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-reset': String(resetSec),
    });
    res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
  });
  gw = createInferenceGateway({
    accountId: 'acct-keyed',
    upstreamBase: upstream.base,
    token: async () => 'tok',
    maxQueueWaitMs: 50,
    // NOTE: no governorFor — exercise the real account-keyed resolution path.
  });
  port = await gw.listen(0);
  await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  // The account-keyed bucket the observer watches is now paused by the gateway's penalize().
  const acctBucket = getGovernor('anthropic', 'opus', undefined, 'acct-keyed');
  assert.ok(acctBucket.state.pausedUntil > Date.now(), 'gateway 429 paused the per-account governor bucket');
  resetGovernorRegistry();
});

test('priority queue bounds forwarded concurrency (P-011 wiring)', async () => {
  let cur = 0;
  let peak = 0;
  await boot(
    (_req, res) => {
      cur++;
      peak = Math.max(peak, cur);
      setTimeout(() => {
        cur--;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }, 25);
    },
    { concurrency: 2 },
  );
  await Promise.all(
    Array.from({ length: 6 }, () => post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] })),
  );
  assert.ok(peak <= 2, `upstream peak concurrency ${peak} must be ≤ the queue cap (2)`);
});

test('fails over to a second account when the active one hits its 5h budget (EI-535)', async () => {
  resetGovernorRegistry();
  const resetSec = Math.round(Date.now() / 1000) + 3600;
  // Upstream: 429-with-unified-rejected for account A's token; 200 for account B's token.
  upstream = await startUpstream((req, res) => {
    if (req.headers['authorization'] === 'Bearer A-tok') {
      res.writeHead(429, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-reset': String(resetSec),
      });
      res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }
  });
  const pool = createFailoverPool([
    { accountId: 'A', token: async () => 'A-tok', invalidateToken: () => {} },
    { accountId: 'B', token: async () => 'B-tok', invalidateToken: () => {} },
  ]);
  gw = createInferenceGateway({ pool, upstreamBase: upstream.base, maxQueueWaitMs: 200 });
  port = await gw.listen(0);

  // First request → account A → real 5h-rejected 429 → triggers failover to B.
  const first = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(first.status, 429, 'A returns its real 5h-rejected 429');
  assert.equal(pool.active().accountId, 'B', 'gateway failed over to B');

  // Next request → account B (fresh bucket) → 200, egressing on B's token.
  const second = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(second.status, 200, 'B has budget → 200');
  assert.equal(upstream.last.headers['authorization'], 'Bearer B-tok', 'now egressing on B');

  const s = (await (await ask('/stats')).json()) as { accountId: string; failovers: number };
  assert.equal(s.accountId, 'B', '/stats reflects the new active account');
  assert.equal(s.failovers, 1);
  resetGovernorRegistry();
});

test('per-request x-papercusp-account header routes to the named pool account (P-002/P-003)', async () => {
  const acctA: ActiveAccount = { accountId: 'acctA', token: async () => 'tokA' };
  const acctB: ActiveAccount = { accountId: 'acctB', token: async () => 'tokB' };
  const pool: AccountPool = {
    active: () => acctA,
    onExhausted: () => null,
    select: (id) => (id === 'acctA' ? acctA : id === 'acctB' ? acctB : null),
  };
  await boot((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, { pool });
  // no header → the active account (acctA)
  await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(upstream.last.headers['authorization'], 'Bearer tokA');
  // header pins to acctB
  await ask('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-account': 'acctB' },
    body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(upstream.last.headers['authorization'], 'Bearer tokB');
  // the internal routing header is stripped before the upstream forward
  assert.equal(upstream.last.headers['x-papercusp-account'], undefined);
});

test('a key-kind account authenticates with x-api-key and no OAuth beta (P-002)', async () => {
  const billed: ActiveAccount = { accountId: 'billed', kind: 'key', token: async () => 'sk-ant-api03-K' };
  const pool: AccountPool = { active: () => billed, onExhausted: () => null };
  await boot((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, { pool });
  await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(upstream.last.headers['x-api-key'], 'sk-ant-api03-K');
  assert.equal(upstream.last.headers['authorization'], undefined, 'no Bearer for an API key');
  assert.ok(
    !String(upstream.last.headers['anthropic-beta'] ?? '').includes('oauth-2025-04-20'),
    'no oauth beta for an API key',
  );
});
