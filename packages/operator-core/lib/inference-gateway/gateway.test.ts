/** Tests for the inference gateway proxy + governor pacing (P-006/P-007/P-009). */
import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
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

test('load-shed: returns a retryable 429 when the admission backlog hits maxQueued — the wedge fix (2026-06-20)', async () => {
  // Under a sustained throttle every in-flight request squats its slot for the internal wait budget, so
  // the backlog would grow without bound until the gateway wedges (needing a manual restart). A bounded
  // queue sheds excess as fast retryable 429s instead. concurrency:1 + maxQueued:1 → of 3 simultaneous
  // requests, 1 runs, 1 queues, 1 is shed.
  await boot(
    (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }, 200);
    },
    { concurrency: 1, maxQueued: 1 },
  );
  const rs = await Promise.all([
    post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }),
    post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'y' }] }),
    post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'z' }] }),
  ]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 429], 'exactly one request shed with 429');
  const shed = rs.find((r) => r.status === 429)!;
  assert.equal((await shed.json() as { gateway?: boolean }).gateway, true, 'gateway-synthesized load-shed 429');
  assert.ok(shed.headers.get('retry-after'), 'retry-after set so the caller backs off + retries');
});

test('upstream HEADERS stall is aborted (502) and RELEASES the admission slot — the 2026-06-19 deadlock fix', async () => {
  // Reproduce the outage: an upstream that accepts the socket but never responds used to hang the proxy
  // task forever, leaking its admission slot until the pool deadlocked at maxConcurrent. With
  // concurrency:1, a leak would wedge the gateway permanently — so the 2nd request succeeding PROVES the
  // slot was freed.
  let calls = 0;
  await boot(
    (_req, res) => {
      calls++;
      if (calls === 1) return; // STALL: never write, never end (the deadlock trigger)
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
    { concurrency: 1, upstreamHeadersTimeoutMs: 120, upstreamBodyIdleTimeoutMs: 120 },
  );
  const r1 = await post({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r1.status, 502, 'stalled upstream is aborted, not hung');
  assert.equal((await r1.json() as { gateway?: boolean }).gateway, true, 'gateway-synthesized 502');
  const r2 = await post({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'y' }] });
  assert.equal(r2.status, 200, 'the single admission slot was released — no deadlock');
  assert.equal((await r2.json() as { ok: boolean }).ok, true);
});

test('a STREAMING request aborts at the SHORT TTFB deadline, not the generous one — 2026-06-20 silent-wedge fix', async () => {
  // A stalled Anthropic socket (healthy accounts, no throttle) on a STREAMING request must abort at the
  // short stream-headers deadline, NOT squat its slot for the generous non-streaming deadline (which
  // presented as the silent multi-minute wedge, 4th outage tonight). Generous headers=5000ms but
  // stream=150ms → a stream:true stall must 502 in well under the generous window.
  let calls = 0;
  await boot(
    (_req, res) => {
      calls++;
      if (calls === 1) return; // STALL: accept the socket, never respond
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
    { concurrency: 1, upstreamHeadersTimeoutMs: 5000, upstreamStreamHeadersTimeoutMs: 150, upstreamBodyIdleTimeoutMs: 5000 },
  );
  const t0 = Date.now();
  const r1 = await post({ model: 'claude-opus-4', stream: true, messages: [{ role: 'user', content: 'x' }] });
  const elapsed = Date.now() - t0;
  assert.equal(r1.status, 502, 'streaming stall aborted');
  assert.ok(elapsed < 2000, `streaming aborted at the short TTFB (${elapsed}ms), not the 5000ms generous deadline`);
  const r2 = await post({ model: 'claude-opus-4', stream: true, messages: [{ role: 'user', content: 'y' }] });
  assert.equal(r2.status, 200, 'slot released after the fast streaming abort');
});

test('a mid-stream upstream stall is aborted (body-idle deadline) and releases the slot', async () => {
  // Headers + first chunk arrive, then the upstream stalls mid-stream. The per-chunk body-idle deadline
  // must trip (a leak here would also wedge concurrency:1).
  let calls = 0;
  await boot(
    (_req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        return; // then STALL — never send more, never end
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
    { concurrency: 1, upstreamHeadersTimeoutMs: 2000, upstreamBodyIdleTimeoutMs: 120 },
  );
  const r1 = await post({ model: 'claude-opus-4', stream: true, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r1.status, 200, 'headers + first chunk forwarded fine');
  await r1.text().catch(() => {}); // body aborts mid-stream → client read ends (truncated); tolerate the reset
  const r2 = await post({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'y' }] });
  assert.equal(r2.status, 200, 'mid-stream stall released the slot — no deadlock');
  assert.equal((await r2.json() as { ok: boolean }).ok, true);
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

test('a BARE upstream 429 (no rate-limit headers) fails over to the next account — the stuck-loop fix', async () => {
  const acct = (id: string): ActiveAccount => ({ accountId: id, token: async () => 't', invalidateToken: () => {} });
  const pool = createFailoverPool([acct('A'), acct('B')]);
  let attempt = 0;
  await boot(
    (_req, res) => {
      attempt++;
      if (attempt === 1) {
        // A hits transient burst-throttle: bare 429 with no rate-limit headers.
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }));
      } else {
        // B has capacity — the burst cleared or it's a different account.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, content: 'recovered' }));
      }
    },
    { pool },
  );
  const res = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.status, 200, 'gateway fails over off the throttled account on a bare 429 and retries → 200');
  // Upstream was hit twice: one bare-429 attempt + one internal-failover success on the other account.
  assert.equal(attempt, 2, 'one throttled attempt + one internal-failover success (no stuck-loop on the limited account)');
  // The fix's invariant under round-robin: the bare-429 account is ROTATED OUT (onExhausted marked it
  // out of rotation), so the account that SERVED the 200 is the survivor and the throttled one is
  // skipped. The routed-account header names the survivor; the throttled account must stay out of
  // rotation — over a full pass of active() it never reappears (round-robin only cycles live accounts).
  const survivor = res.headers.get('x-papercusp-routed-account');
  assert.ok(survivor === 'A' || survivor === 'B', `served by a pool account (got ${survivor})`);
  const throttled = survivor === 'A' ? 'B' : 'A';
  const seen = new Set([pool.active().accountId, pool.active().accountId, pool.active().accountId, pool.active().accountId]);
  assert.ok(!seen.has(throttled), `bare-429 account '${throttled}' is out of rotation (no stuck-loop on the limited account)`);
  assert.ok(seen.has(survivor), `the healthy account '${survivor}' still serves rotation`);
});

test('ALL accounts transiently throttled (bare 429) → gateway WAITS out the short penalty + retries, returns the recovered 200 (not a forwarded retryable 429)', async () => {
  // The owner-reported gap (2026-06-18): a transient burst-throttle (bare 429, x-should-retry:true —
  // capacity EXISTS) on EVERY pool account used to make the gateway give up + forward the retryable
  // 429, which an in-process caller (scout/gym, no CLI retry budget) can't absorb → $0 no-ideas.
  // The fix: when no fresh account remains, wait out the soonest account's SHORT penalty and retry.
  const acct = (id: string): ActiveAccount => ({ accountId: id, token: async () => 't', invalidateToken: () => {} });
  const pool = createFailoverPool([acct('A'), acct('B')]);
  let calls = 0;
  await boot(
    (_req, res) => {
      calls += 1;
      if (calls <= 2) {
        // Both A and B hit the transient burst (bare 429: rate_limit_error, NO window headers).
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }));
      } else {
        // The short burst cleared — capacity was there all along.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, content: 'recovered' }));
      }
    },
    { pool },
  );
  const res = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.status, 200, 'gateway waited out the all-accounts transient throttle + retried → 200, not a forwarded retryable 429');
  assert.equal(JSON.parse(await res.text()).ok, true, "forwarded body is the recovered 200, not the burst error");
}, 30_000);

test('a usage/session CAP (429 body names the limit) is INTERNALLY failed over — bee gets B\'s success, not A\'s wall', async () => {
  const acct = (id: string): ActiveAccount => ({ accountId: id, token: async () => 't', invalidateToken: () => {} });
  const pool = createFailoverPool([acct('A'), acct('B')]);
  let calls = 0;
  await boot(
    (_req, res) => {
      calls += 1;
      if (calls === 1) {
        // Account A is session-capped: a 429 whose BODY names the cap. No rate-limit headers (util can be
        // 0 on a capped account — the cap is a DIFFERENT meter than the rolling window), so only the body
        // reveals it. The bee treats usage_limit as a no-retry WALL, so the gateway must route past it.
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: "You've hit your session limit · resets 10:50am" } }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, content: 'hi from B' }));
      }
    },
    { pool },
  );
  const res = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.status, 200, 'gateway internally failed over the cap → returns the other account\'s success, not a 429 wall');
  const body = JSON.parse(await res.text());
  assert.equal(body.ok, true, 'the forwarded body is the healthy account\'s success, not the session-limit error');
  assert.equal(calls, 2, 'one capped attempt + one internal-failover success on a healthy account');
  // The capped account is rotated OUT of rotation (penalize + onExhausted). The routed-account header
  // names the survivor that served the 200; the session-capped account must stay skipped — over a full
  // pass of active() it never reappears (round-robin only cycles accounts that still have budget).
  const survivor = res.headers.get('x-papercusp-routed-account');
  assert.ok(survivor === 'A' || survivor === 'B', `served by a pool account (got ${survivor})`);
  const capped = survivor === 'A' ? 'B' : 'A';
  const seen = new Set([pool.active().accountId, pool.active().accountId, pool.active().accountId, pool.active().accountId]);
  assert.ok(!seen.has(capped), `rotated off the session-capped account '${capped}' (it stays out of rotation)`);
  assert.ok(seen.has(survivor), `the healthy account '${survivor}' still serves rotation`);
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
  // The account-keyed bucket the observer watches is now paused by recordResponse's bounded
  // re-probe pause on the unified rejection (D-003: a rolling-window rejection no longer penalizes
  // to the full multi-hour reset — but it DOES still pause, so the observer still sees the account).
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

  // Under round-robin active(), the gateway egresses each unpinned request through the next account in
  // the pool — so within a single pass it WILL route a request onto A, which returns the real
  // 5h-rejected 429. The resilient behavior under test: whenever a request lands on the 5h-exhausted
  // account, the gateway INTERNALLY fails over to B and returns B's 200 — the caller NEVER sees A's 429.
  // Send a full pass + 1 so A is certainly exercised, and assert the invariants that hold regardless of
  // which account each round-robin hop picked.
  for (let i = 0; i < 3; i++) {
    const r = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 200, "every request → 200 (A's 5h-rejected 429 is internally failed over to B, never surfaced)");
    assert.equal(r.headers.get('x-papercusp-routed-account'), 'B', 'every served request egressed on the healthy account B');
    assert.equal(JSON.parse(await r.text()).ok, true);
  }
  // The 5h-rejected account A is now OUT of rotation (onExhausted marked it until its reset), so active()
  // only ever yields B — A no longer takes a round-robin slot. The /stats headline account is therefore B
  // and at least one internal failover (A→B) was recorded.
  assert.equal(upstream.last.headers['authorization'], 'Bearer B-tok', 'egress settled on B');
  const seen = new Set([pool.active().accountId, pool.active().accountId, pool.active().accountId, pool.active().accountId]);
  assert.ok(!seen.has('A'), 'A is out of rotation after its 5h rejection');
  assert.deepEqual([...seen], ['B'], 'only B serves rotation now');
  const s = (await (await ask('/stats')).json()) as { accountId: string; failovers: number };
  assert.equal(s.accountId, 'B', '/stats reflects the surviving active account');
  assert.ok(s.failovers >= 1, 'at least one A→B internal failover was recorded');
  resetGovernorRegistry();
});

test('a 403 org/subscription-disallowed account pauses + fails over to a healthy one (avi-storewolf fix)', async () => {
  resetGovernorRegistry();
  // Upstream: 403 "OAuth not allowed for this organization" for account A; 200 for B.
  upstream = await startUpstream((req, res) => {
    if (req.headers['authorization'] === 'Bearer A-tok') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization."}}');
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

  // A's 403 is an org-level disqualification → pause A out of rotation + fail over to B, returning B's
  // 200 (NOT forwarding the 403, which would hard-fail the bee / 403-block the fleet). Under round-robin
  // active(), a request lands on A within one pass; whenever it does, the gateway must internally fail
  // over to B and return 200 — never surface A's 403. Drive a full pass + 1 so A is certainly exercised.
  for (let i = 0; i < 3; i++) {
    const r = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 200, "403 org-disallowed → internal failover to B → 200, A's 403 never surfaced");
    assert.equal(r.headers.get('x-papercusp-routed-account'), 'B', 'served on the healthy account B');
  }
  assert.equal(upstream.last.headers['authorization'], 'Bearer B-tok', 'egressed on B');
  // A is paused OUT of rotation (penalize + onExhausted on the org-disallow), so active() only yields B.
  const seen = new Set([pool.active().accountId, pool.active().accountId, pool.active().accountId, pool.active().accountId]);
  assert.ok(!seen.has('A'), 'A paused out of rotation on the org-disallow 403');
  assert.deepEqual([...seen], ['B'], 'B is the only account serving rotation');
  resetGovernorRegistry();
});

test('the spawned-claude-code disallow ("subscription disabled for Claude Code") also fails over', async () => {
  resetGovernorRegistry();
  upstream = await startUpstream((req, res) => {
    if (req.headers['authorization'] === 'Bearer A-tok') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"permission_error","message":"Claude subscription disabled for Claude Code"}}');
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
  const r = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 200, 'subscription-disabled 403 → failover A→B');
  assert.equal(upstream.last.headers['authorization'], 'Bearer B-tok');
  resetGovernorRegistry();
});

test('a NON-org 403 is forwarded unchanged (not treated as account-disqualifying)', async () => {
  resetGovernorRegistry();
  upstream = await startUpstream((_req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end('{"type":"error","error":{"type":"permission_error","message":"some other forbidden reason"}}');
  });
  const pool = createFailoverPool([
    { accountId: 'A', token: async () => 'A-tok', invalidateToken: () => {} },
    { accountId: 'B', token: async () => 'B-tok', invalidateToken: () => {} },
  ]);
  gw = createInferenceGateway({ pool, upstreamBase: upstream.base, maxQueueWaitMs: 200 });
  port = await gw.listen(0);
  const r = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 403, 'a non-org 403 is forwarded as-is (no failover loop)');
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

test('Fault #3 — a header-pinned request whose account is paced fails over to active() (no $0 hang)', async () => {
  resetGovernorRegistry();
  upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const paced: ActiveAccount = { accountId: 'paced-acct', token: async () => 'paced-tok' };
  const healthy: ActiveAccount = { accountId: 'healthy-acct', token: async () => 'healthy-tok' };
  const pool: AccountPool = {
    active: () => healthy, // failover-walked to a healthy account
    onExhausted: () => null,
    select: (id) => (id === 'paced-acct' ? paced : id === 'healthy-acct' ? healthy : null),
  };
  gw = createInferenceGateway({ pool, upstreamBase: upstream.base, maxQueueWaitMs: 50 });
  port = await gw.listen(0);
  // The pinned account is being LIVE-paced (a long governor pause the cross-process drain projection
  // can't see) — the gateway must not strict-honor the pin into a hang.
  getGovernor('anthropic', 'opus', undefined, 'paced-acct').penalize({ retryAfterMs: 60 * 60_000 });
  await ask('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-account': 'paced-acct' },
    body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(upstream.last.headers['authorization'], 'Bearer healthy-tok', 'paced pin → served via active()');
  resetGovernorRegistry();
});

test('a header-pinned request whose account is HEALTHY is still strict-honored (cache affinity preserved)', async () => {
  resetGovernorRegistry();
  upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const pinnedAcct: ActiveAccount = { accountId: 'pin-acct', token: async () => 'pin-tok' };
  const activeAcct: ActiveAccount = { accountId: 'active-acct', token: async () => 'active-tok' };
  const pool: AccountPool = {
    active: () => activeAcct,
    onExhausted: () => null,
    select: (id) => (id === 'pin-acct' ? pinnedAcct : id === 'active-acct' ? activeAcct : null),
  };
  gw = createInferenceGateway({ pool, upstreamBase: upstream.base, maxQueueWaitMs: 50 });
  port = await gw.listen(0);
  // pin-acct is NOT paced → the pin holds (no failover), preserving its per-credential cache.
  await ask('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-account': 'pin-acct' },
    body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(upstream.last.headers['authorization'], 'Bearer pin-tok', 'healthy pin is honored, not failed over');
  resetGovernorRegistry();
});

test('every account is Claude Max OAuth — a bee-sent x-api-key is stripped + replaced with Bearer (D-003)', async () => {
  await boot((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await ask('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-api03-bee-sent' },
    body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(upstream.last.headers['x-api-key'], undefined, 'no static API key reaches upstream (channel removed)');
  assert.equal(upstream.last.headers['authorization'], 'Bearer test-token', 'subscription OAuth Bearer injected');
  assert.ok(String(upstream.last.headers['anthropic-beta']).includes('oauth-2025-04-20'), 'oauth beta always present');
});

test('a per-account egress builds a dispatcher passed to the upstream fetch (per-account IP routing, D-003)', async () => {
  let captured: { dispatcher?: unknown } | undefined;
  const fetchImpl = (async (_url: string, init: { dispatcher?: unknown }) => {
    captured = init;
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const egAcct: ActiveAccount = { accountId: 'eg', token: async () => 'T', egress: { proxyUrl: 'http://127.0.0.1:3128' } };
  const pool: AccountPool = { active: () => egAcct, onExhausted: () => null };
  gw = createInferenceGateway({ pool, upstreamBase: 'http://upstream.invalid', fetchImpl, governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }), maxQueueWaitMs: 80 });
  port = await gw.listen(0);
  await ask('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }) });
  assert.ok(captured?.dispatcher, 'egress account passes an undici dispatcher to fetch');
});

test('no per-account egress → no dispatcher (default shared egress)', async () => {
  let captured: { dispatcher?: unknown } | undefined;
  const fetchImpl = (async (_url: string, init: { dispatcher?: unknown }) => {
    captured = init;
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const plain: ActiveAccount = { accountId: 'plain', token: async () => 'T' };
  const pool: AccountPool = { active: () => plain, onExhausted: () => null };
  gw = createInferenceGateway({ pool, upstreamBase: 'http://upstream.invalid', fetchImpl, governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }), maxQueueWaitMs: 80 });
  port = await gw.listen(0);
  await ask('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }) });
  assert.equal(captured?.dispatcher, undefined, 'no egress → fetch gets no dispatcher');
});

test('a STALLED OAuth token refresh fails FAST with a retryable 503 + releases the slot (2026-06-20 token-hang wedge)', async () => {
  // active.token() does a deadline-less network refresh that runs BEFORE the upstream stall-guard, so a
  // stalled OAuth endpoint used to pin every admission slot forever (counters frozen, multi-minute log
  // silence, manual-restart-only recovery). With a bounded tokenTimeoutMs it must reject fast → 503 +
  // slot release, never reaching upstream and never wedging the pool.
  let upstreamHits = 0;
  await boot(
    (_req, res) => {
      upstreamHits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
    { token: () => new Promise<string>(() => {}) /* never resolves */, tokenTimeoutMs: 50 },
  );
  const t0 = Date.now();
  const res = await post({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] });
  const elapsed = Date.now() - t0;
  assert.equal(res.status, 503, 'a stalled token refresh returns a retryable 503, not a hang');
  assert.ok(elapsed < 2000, `failed fast (${elapsed}ms) instead of pinning the admission slot`);
  assert.equal(upstreamHits, 0, 'never reached upstream — the hang was before the fetch');
  const stats = (await (await ask('/stats')).json()) as { inFlight: number };
  assert.equal(stats.inFlight, 0, 'admission slot released after the token timeout (wedge signature is inFlight stuck at max)');
});

test('a NON-DRAINING client cannot pin a slot — the downstream-idle guard tears it down (2026-06-20 wedge #2)', async () => {
  // Reproduce the wedge: upstream COMPLETES a large streamed body, but the client never reads it.
  // Pre-fix, res could never 'finish' (backpressured — can't flush) nor 'close' (half-open), and
  // upstream already ended (no 'error'), so the proxy await hung forever and pinned the admission slot.
  // The downstream-idle guard (res.setTimeout → res.destroy) must release the slot anyway.
  const BIG = Buffer.alloc(16 * 1024 * 1024, 0x61); // 16 MB — far exceeds socket buffers → backpressure
  await boot(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(BIG); // upstream completes immediately
    },
    { downstreamIdleMs: 300 },
  );
  // Raw client: send a valid /v1/messages request, then NEVER read the response (pause the socket).
  const sock = net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', () => resolve());
    sock.once('error', reject);
  });
  const reqBody = JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  sock.write(
    `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\ncontent-type: application/json\r\n` +
      `content-length: ${Buffer.byteLength(reqBody)}\r\nconnection: close\r\n\r\n${reqBody}`,
  );
  sock.pause(); // the hung client: never drains the 16 MB body

  // The slot must release within a bound (downstreamIdleMs + slack), proving no wedge. Pre-fix it
  // stays 1 forever.
  let inFlight = 1;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    inFlight = ((await (await ask('/stats')).json()) as { inFlight: number }).inFlight;
    if (inFlight === 0) break;
  }
  sock.destroy();
  assert.equal(inFlight, 0, 'downstream-idle guard released the slot a hung client would otherwise pin forever');
});

test('the HARD per-request ceiling force-terminates a stuck request → slot released (universal backstop)', async () => {
  // An upstream that accepts the connection and NEVER responds. Set the activity stall-guards LONG and the
  // ceiling SHORT so the CEILING is what fires — proving the universal backstop releases the slot no matter
  // which await a request is stuck in (not just the specific ones the activity timers cover).
  const hanging = http.createServer(() => { /* never responds, never closes */ });
  await new Promise<void>((r) => hanging.listen(0, '127.0.0.1', () => r()));
  const hangPort = (hanging.address() as { port: number }).port;
  await boot(
    (_req, res) => { res.writeHead(200); res.end('{}'); }, // boot's own upstream — unused (overridden below)
    {
      upstreamBase: `http://127.0.0.1:${hangPort}`,
      upstreamHeadersTimeoutMs: 60_000, // long — would NOT fire inside the test window
      upstreamStreamHeadersTimeoutMs: 60_000,
      requestCeilingMs: 250, // the hard ceiling is what fires
    },
  );
  const t0 = Date.now();
  // The ceiling destroys the socket, so the client sees a reset (fetch rejects) rather than an HTTP status —
  // either way it must SETTLE fast, not hang for 60s.
  await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }).catch(() => undefined);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 3000, `hard ceiling force-terminated in ${elapsed}ms, not a 60s hang`);
  await new Promise((r) => setTimeout(r, 150)); // let the finally release the slot
  const stats = (await (await ask('/stats')).json()) as { inFlight: number };
  assert.equal(stats.inFlight, 0, 'hard ceiling released the admission slot');
  await new Promise<void>((r) => hanging.close(() => r()));
});
