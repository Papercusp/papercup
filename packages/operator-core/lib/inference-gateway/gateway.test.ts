/** Tests for the inference gateway proxy + governor pacing (P-006/P-007/P-009). */
import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createInferenceGateway, estimateTokens, parseRateReset, classify429Shape, classifyColdRest429, classifyProxyHandlerError, effectivePriorityLabel, MODEL_DOWNGRADED_HEADER, type ActiveAccount, type AccountPool } from './gateway';
import { createFailoverPool } from './account-failover';
import { RateLimitGovernor, getGovernor, resetGovernorRegistry } from '@papercusp/papercusp-shared/agent';

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

/**
 * A minimal, real SOCKS5 relay (no-auth, CONNECT only) for END-TO-END WI-284 coverage — proves the
 * request genuinely tunnels through a SOCKS5 hop to the real upstream, not just that the right
 * dispatcher CLASS gets constructed. Implements just enough of RFC 1928: the no-auth handshake, a
 * CONNECT request (IPv4 or domain-name address type), then a raw bidirectional byte pipe to the
 * real target — exactly what undici's Socks5ProxyAgent expects a SOCKS5 proxy to do.
 */
interface Socks5Relay {
  port: number;
  getConnections: () => number;
  close: () => Promise<void>;
}

async function startSocks5Relay(): Promise<Socks5Relay> {
  let connections = 0;
  const server = net.createServer((client) => {
    connections++;
    let stage: 'greeting' | 'request' = 'greeting';
    let buf = Buffer.alloc(0);

    const handleRequest = () => {
      if (buf.length < 4) return; // need VER,CMD,RSV,ATYP before we can even see the address length
      const atyp = buf[3];
      let addr: string;
      let offset = 4;
      if (atyp === 0x01) {
        if (buf.length < offset + 4 + 2) return;
        addr = `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
        offset += 4;
      } else if (atyp === 0x03) {
        if (buf.length < offset + 1) return;
        const len = buf[offset];
        offset += 1;
        if (buf.length < offset + len + 2) return;
        addr = buf.subarray(offset, offset + len).toString('ascii');
        offset += len;
      } else {
        client.end();
        return;
      }
      const targetPort = buf.readUInt16BE(offset);
      offset += 2;
      buf = Buffer.alloc(0);
      client.removeAllListeners('data');

      const target = net.connect(targetPort, addr, () => {
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // success, bound addr/port unused
        client.pipe(target);
        target.pipe(client);
      });
      target.on('error', () => {
        try {
          client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // general SOCKS server failure
        } catch {
          /* client already gone */
        }
        client.end();
      });
    };

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2) return; // VER, NMETHODS
        const nMethods = buf[1];
        if (buf.length < 2 + nMethods) return;
        buf = buf.subarray(2 + nMethods);
        client.write(Buffer.from([0x05, 0x00])); // select NO_AUTH (0x00)
        stage = 'request';
        if (buf.length) handleRequest();
        return;
      }
      handleRequest();
    };
    client.on('data', onData);
    client.on('error', () => {}); // a torn-down tunnel is expected at test teardown — never crash the relay
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  return {
    port: addr.port,
    getConnections: () => connections,
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

test('parseRateReset — a 7d-CAPPED account pauses until the 7d reset, not the fresh 5h reset (WI-1083)', () => {
  const now = 1_000_000_000_000;
  const fiveHReset = Math.round(now / 1000) + 600; // fresh 5h window: resets in 10 min
  const sevenDReset = Math.round(now / 1000) + 3 * 3600; // 7d window: resets in 3h (inside the 6h cap)
  const r = parseRateReset(
    {
      'anthropic-ratelimit-unified-5h-reset': String(fiveHReset),
      'anthropic-ratelimit-unified-7d-utilization': '1',
      'anthropic-ratelimit-unified-7d-reset': String(sevenDReset),
    },
    now,
  );
  assert.equal(r.resetAt, sevenDReset * 1000, 'weekly-capped → pause to the 7d reset, not the minutes-away 5h reset');
  assert.equal(r.retryAfterMs, undefined);
});

test('parseRateReset — a huge 7d reset is capped to WEEKLY_CAP_MAX_PAUSE_MS (6h default) to bound a bad header (WI-1083)', () => {
  const now = 1_000_000_000_000;
  const r = parseRateReset(
    {
      'anthropic-ratelimit-unified-5h-reset': String(Math.round(now / 1000) + 600),
      'anthropic-ratelimit-unified-7d-utilization': '1.01',
      'anthropic-ratelimit-unified-7d-reset': String(Math.round(now / 1000) + 59 * 3600), // 59h away
    },
    now,
  );
  assert.equal(r.resetAt, now + 6 * 60 * 60 * 1000, 'capped at the 6h max so a wrong header cannot strand the account for days');
});

test('parseRateReset — a NOT-weekly-capped account keeps the 5h reset (no-regression, WI-1083)', () => {
  const now = 1_000_000_000_000;
  const fiveHReset = Math.round(now / 1000) + 600;
  const r = parseRateReset(
    {
      'anthropic-ratelimit-unified-5h-reset': String(fiveHReset),
      'anthropic-ratelimit-unified-7d-utilization': '0.4', // plenty of weekly headroom
      'anthropic-ratelimit-unified-7d-reset': String(Math.round(now / 1000) + 99999),
    },
    now,
  );
  assert.equal(r.resetAt, fiveHReset * 1000, 'weekly has headroom → keep the 5h reset');
});

// classify429Shape — the hard-evidence "is this real capacity?" distinction, made loggable. A bare-burst
// 429 means CAPACITY EXISTS (transient throttle); usage-cap is a real per-account wall. The precedence
// (usage-cap > bare > rate-window > unified-rejected) mirrors the gateway's own 429-handling order.
test('classify429Shape — bare-burst: 429 with x-should-retry, no window headers → capacity exists (not a wall)', () => {
  assert.equal(
    classify429Shape({ status: 429, isUsageCap: false, bare: true, hasWindowReset: false, unifiedRejected: false }),
    'bare-burst',
  );
});
test('classify429Shape — usage-cap (the body named a session/usage limit) takes precedence over every other shape', () => {
  assert.equal(
    classify429Shape({ status: 429, isUsageCap: true, bare: true, hasWindowReset: true, unifiedRejected: true }),
    'usage-cap',
  );
});
test('classify429Shape — rate-window when a retry-after/reset is present (and not bare/usage-cap)', () => {
  assert.equal(
    classify429Shape({ status: 429, isUsageCap: false, bare: false, hasWindowReset: true, unifiedRejected: false }),
    'rate-window',
  );
});
test('classify429Shape — unified-5h-rejected when only the rolling-window latch is set', () => {
  assert.equal(
    classify429Shape({ status: 429, isUsageCap: false, bare: false, hasWindowReset: false, unifiedRejected: true }),
    'unified-5h-rejected',
  );
});
test('classify429Shape — a non-429 (e.g. 529) is unclassified', () => {
  assert.equal(
    classify429Shape({ status: 529, isUsageCap: false, bare: true, hasWindowReset: false, unifiedRejected: false }),
    'unclassified',
  );
});

// classifyColdRest429 (WI-3151) — the cold-rest CAUSATION probe: a 429 moments after an account rejoined
// rotation from a cold rest. A bare-burst at low util here means resting the account did NOT clear the
// throttle AND it has budget ⇒ a shared edge/IP cause, not the account's own quota. A real per-account
// shape (usage-cap/rate-window/unified) means the account itself is still walled (premature readmit).
const COLD = { windowMs: 120_000, highUtil: 0.8 };
test('classifyColdRest429 — not-cold-rest when the account was never rested (msSinceReadmit undefined)', () => {
  assert.equal(
    classifyColdRest429({ shape: 'bare-burst', msSinceReadmit: undefined, utilization5h: 0.1, ...COLD }),
    'not-cold-rest',
  );
});
test('classifyColdRest429 — not-cold-rest when the 429 is outside the cold-rest window', () => {
  assert.equal(
    classifyColdRest429({ shape: 'bare-burst', msSinceReadmit: 200_000, utilization5h: 0.1, ...COLD }),
    'not-cold-rest',
  );
});
test('classifyColdRest429 — edge-not-account: a bare-burst moments after a cold rest, at low util → shared-edge cause', () => {
  assert.equal(
    classifyColdRest429({ shape: 'bare-burst', msSinceReadmit: 3_000, utilization5h: 0.12, ...COLD }),
    'edge-not-account',
  );
});
test('classifyColdRest429 — edge-not-account when util is unknown (header absent) — a rested account still has budget by assumption', () => {
  assert.equal(
    classifyColdRest429({ shape: 'bare-burst', msSinceReadmit: 3_000, utilization5h: undefined, ...COLD }),
    'edge-not-account',
  );
});
test('classifyColdRest429 — inconclusive: a bare-burst just after a rest but the account itself is near budget (high util)', () => {
  assert.equal(
    classifyColdRest429({ shape: 'bare-burst', msSinceReadmit: 3_000, utilization5h: 0.95, ...COLD }),
    'inconclusive',
  );
});
test('classifyColdRest429 — account-still-latched: a usage-cap within the window is a real per-account wall', () => {
  assert.equal(
    classifyColdRest429({ shape: 'usage-cap', msSinceReadmit: 3_000, utilization5h: 0.0, ...COLD }),
    'account-still-latched',
  );
});
test('classifyColdRest429 — account-still-latched: a unified-5h-rejected within the window (the rest was premature)', () => {
  assert.equal(
    classifyColdRest429({ shape: 'unified-5h-rejected', msSinceReadmit: 50_000, utilization5h: 0.99, ...COLD }),
    'account-still-latched',
  );
});
test('classifyColdRest429 — inconclusive for an unclassified shape within the window', () => {
  assert.equal(
    classifyColdRest429({ shape: 'unclassified', msSinceReadmit: 3_000, utilization5h: 0.1, ...COLD }),
    'inconclusive',
  );
});

// classifyProxyHandlerError — a benign DOWNSTREAM client abort vs a real handler crash. The
// distinguishing signal is that the response object went away (res.destroyed || res.writableEnded);
// a client abort is benign WHETHER OR NOT headers were sent. The regression this locks: a caller
// that aborted while still QUEUED (pre-headers) must NOT be misread as a crash (→ upstreamErrors++
// + HTTP 500 "inference-gateway internal error" — the "gateway fails at a few agents" storm).
test('classifyProxyHandlerError — PRE-headers client abort (queued caller gave up) is a benign client-abort, not a crash', () => {
  // res.destroyed=true (client tore down the socket), res.writableEnded=false, and headers were
  // never sent — the exact shape the old `&& res.headersSent` gate misclassified as a crash.
  assert.equal(classifyProxyHandlerError('The operation was aborted', { destroyed: true, writableEnded: false }), 'client-abort');
});
test('classifyProxyHandlerError — POST-headers client abort (stream torn down mid-response) is a client-abort', () => {
  assert.equal(classifyProxyHandlerError('ERR_STREAM_PREMATURE_CLOSE', { destroyed: false, writableEnded: true }), 'client-abort');
});
test('classifyProxyHandlerError — ECONNRESET with a destroyed downstream is a client-abort', () => {
  assert.equal(classifyProxyHandlerError('socket hang up ECONNRESET', { destroyed: true, writableEnded: false }), 'client-abort');
});
test('classifyProxyHandlerError — an abort-shaped message but the downstream is INTACT (upstream/internal abort) is a crash', () => {
  // A stall-waker / internal-timeout abort throws an abort-shaped error while the CLIENT is still
  // connected (res not destroyed/ended) — that is a real gateway fault, keep the loud 500 path.
  assert.equal(classifyProxyHandlerError('upstream fetch aborted', { destroyed: false, writableEnded: false }), 'crash');
});
test('classifyProxyHandlerError — a non-abort error with a destroyed downstream is still a crash (message must match)', () => {
  assert.equal(classifyProxyHandlerError('TypeError: cannot read properties of undefined', { destroyed: true, writableEnded: false }), 'crash');
});

test('WI-3150: the internal-retry 429 log names the THROTTLED account with ITS util headers, not the rotated-to account', async () => {
  // A 2-account pool where account A throws a rate-window 429 (util7d=0.95) and the gateway fails over to B.
  // The retry log line is built from A's response headers (shape429Suffix) but is emitted AFTER the rotate
  // branch has reassigned `active` to B — so it MUST name A (throttled429AccountId), or A's util headers get
  // attributed to B (the shuffle that made a bare/quota 429 on one account read as exhaustion on another).
  const acct = (id: string): ActiveAccount => ({ accountId: id, token: async () => `${id}-tok`, invalidateToken: () => {} });
  const pool = createFailoverPool([acct('acctA'), acct('acctB')]);
  const logs: string[] = [];
  const now = Date.now();
  await boot(
    (req, res, _body) => {
      const auth = String(req.headers['authorization'] ?? '');
      if (auth.includes('acctA-tok')) {
        // Rate-window 429 (has a reset → not bare) carrying A's OWN weekly-utilization header.
        res.writeHead(429, {
          'content-type': 'application/json',
          'anthropic-ratelimit-unified-5h-reset': String(Math.round(now / 1000) + 60),
          'anthropic-ratelimit-unified-7d-utilization': '0.95',
        });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }));
        return;
      }
      // acctB (rotated-to) succeeds, so the request resolves after exactly one failover.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
    { pool, log: (_level, msg) => logs.push(msg) },
  );
  const res = await post({ model: 'claude-sonnet-5', max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 200, `failover A→B ultimately succeeds; status=${res.status}\nLOGS:\n${logs.join('\n')}`);

  const retryLine = logs.find((m) => m.includes('internal retry') && m.includes('util7d='));
  assert.ok(retryLine, `expected an internal-retry log line carrying util headers; got:\n${logs.join('\n')}`);
  // A's util header (0.95) must be paired with A's NAME — the whole point of the fix.
  assert.ok(retryLine!.includes('util7d=0.95'), `suffix should carry A's util7d; got: ${retryLine}`);
  assert.ok(retryLine!.includes("on 'acctA'"), `log must name the THROTTLED account acctA; got: ${retryLine}`);
  // The rotated-to account must NOT be the one the util header is attributed to (the pre-fix bug).
  assert.ok(!retryLine!.includes("on 'acctB'"), `log must NOT attribute A's util to the rotated-to acctB; got: ${retryLine}`);
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

test('BARE-429 PERSISTENCE CIRCUIT: a sustained bare-429 streak on one account ESCALATES its pause so the pool auto-routes around a per-IP-throttled egress IP (auto-route-around 2026-06-29)', async () => {
  // The bug: a 429 means "the proxy worked", so the TRANSPORT egress circuit never trips on a per-IP edge
  // 429-throttle — the account was paced only the base backoff, rejoined, and got re-throttled forever (the
  // pool never auto-routed around the bad IP → owner-reported "constant api errors on the pinned account
  // though it has quota"). Fix: consecutive bare-429s ESCALATE the pause (×2 past the threshold), so the
  // pool's pin-yield / soft-pin-failover / health-pick route AROUND the throttled IP.
  resetGovernorRegistry();
  upstream = await startUpstream((_req, res) => {
    // This account's egress IP is persistently edge-throttled: ALWAYS a bare 429 (no rate-limit headers).
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }));
  });
  const onlyA: ActiveAccount = { accountId: 'A', token: async () => 't', invalidateToken: () => {} };
  const pool: AccountPool = { active: () => onlyA, onExhausted: () => null, select: (id) => (id === 'A' ? onlyA : null) };
  gw = createInferenceGateway({ pool, upstreamBase: upstream.base, maxQueueWaitMs: 50, requestAbsorbMs: 0, internalRetryDeadlineMs: 2000, bare429FailoverBackoffMs: 50 });
  port = await gw.listen(0);
  const gov = getGovernor('anthropic', 'opus', undefined, 'A');
  // One request drives the consecutive-bare-429 retry ladder past the streak threshold (default 4).
  await ask('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }) });
  const pausedForMs = gov.state.pausedUntil - Date.now();
  // Base backoff is 50ms; the circuit escalates it (×2 per step past the threshold), so the surviving pause
  // is well beyond a single 50ms pace — which is what makes the pool durably route AROUND this IP.
  assert.ok(pausedForMs > 100, `bare-429 circuit escalated A's pause to ${pausedForMs}ms (>> the 50ms base) so the pool routes around the throttled IP`);
  resetGovernorRegistry();
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

// CREDENTIAL-HEALTH (#5 PART A): a DEAD credential (consecutive 401s despite the drop+refresh) fires the
// loud `onCredentialDead` side-channel ONCE per episode, and a successful auth (2xx) resets the streak so a
// later episode re-arms. The 401 request semantics are UNCHANGED — only the alert counter is added.
test('credential-health — consecutive 401s past the threshold fire onCredentialDead exactly ONCE per episode', async () => {
  const dead: { accountId: string; consecutive401s: number }[] = [];
  // Upstream: a credential that 401s forever (the dead-credential signature — the refresh keeps yielding
  // the same invalid token, so the 401 never clears).
  await boot(
    (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Invalid authentication credentials' } }));
    },
    {
      credential401DeadThreshold: 3,
      onCredentialDead: (info) => dead.push(info),
    },
  );
  // 5 consecutive 401 requests; the alert fires only at the 3rd (the crossing), then stays quiet.
  for (let i = 0; i < 5; i++) {
    await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  }
  assert.equal(dead.length, 1, 'alerts exactly once across a sustained dead-credential 401 streak');
  assert.equal(dead[0].accountId, 'test-acct');
  assert.equal(dead[0].consecutive401s, 3, 'fires at the crossing tick (streak === threshold)');
  // The token was still dropped+refreshed on EVERY 401 — request semantics unchanged.
  assert.equal(invalidated, 5, 'invalidateToken still fires on every 401 (no semantics change)');
});

test('credential-health — a successful 2xx resets the streak, re-arming the alert for a later episode', async () => {
  const dead: { accountId: string; consecutive401s: number }[] = [];
  let mode: '401' | '200' = '401';
  await boot(
    (_req, res) => {
      if (mode === '200') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      } else {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
      }
    },
    {
      credential401DeadThreshold: 2,
      onCredentialDead: (info) => dead.push(info),
    },
  );
  // Episode 1: two 401s → one alert at the crossing.
  await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(dead.length, 1, 'episode 1 alerts once');
  // A successful auth clears the streak.
  mode = '200';
  await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(dead.length, 1, 'a 2xx does not alert');
  // Episode 2: the credential dies again → the reset streak crosses afresh → a SECOND alert.
  mode = '401';
  await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(dead.length, 2, 'the reset re-armed the alert for the second dead episode');
});

test('credential-health — a throwing onCredentialDead never breaks the request hot path (fire-and-forget)', async () => {
  await boot(
    (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
    },
    {
      credential401DeadThreshold: 1,
      onCredentialDead: () => {
        throw new Error('alert side-channel blew up');
      },
    },
  );
  // The 401 still forwards to the caller unchanged despite the alert callback throwing.
  const r = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 401, 'the 401 is still forwarded — the throwing alert never wedges the request');
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

// PERSISTENT deactivation (2026-07-01): the 6h org-disallow pause lives ONLY in the gateway's in-memory
// governor, so it resets on every gateway/bg-host restart → a genuinely org-disabled account (aviynw) kept
// re-entering rotation and failing the next bee with "subscription disabled". onOrgDisallowed fires on the
// first definitive 403 so the launch layer can PERSISTENTLY remove it from the pool (survives restarts).
test('org-disallowed — the FIRST org/subscription-disqualified 403 fires onOrgDisallowed (persistent deactivate)', async () => {
  resetGovernorRegistry();
  const disallowed: { accountId: string; consecutive: number }[] = [];
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
  gw = createInferenceGateway({ pool, upstreamBase: upstream.base, maxQueueWaitMs: 200, onOrgDisallowed: (info) => disallowed.push(info) });
  port = await gw.listen(0);
  // A is hit once (then paused → B serves), and that FIRST org-disallow fires the persistent-deactivate hook.
  for (let i = 0; i < 3; i++) {
    const r = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 200, 'org-disallow still fails over to B → 200 (unchanged)');
  }
  assert.equal(disallowed.length, 1, 'onOrgDisallowed fires EXACTLY once (A deactivated on its first definitive 403)');
  assert.equal(disallowed[0].accountId, 'A');
  assert.equal(disallowed[0].consecutive, 1, 'fires on the first hit — a resettable in-memory pause alone let A re-leak on every restart');
  resetGovernorRegistry();
});

test('org-disallowed — a throwing onOrgDisallowed never breaks the request hot path (fire-and-forget)', async () => {
  resetGovernorRegistry();
  upstream = await startUpstream((req, res) => {
    if (req.headers['authorization'] === 'Bearer A-tok') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"permission_error","message":"not allowed for this organization"}}');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }
  });
  const pool = createFailoverPool([
    { accountId: 'A', token: async () => 'A-tok', invalidateToken: () => {} },
    { accountId: 'B', token: async () => 'B-tok', invalidateToken: () => {} },
  ]);
  gw = createInferenceGateway({ pool, upstreamBase: upstream.base, maxQueueWaitMs: 200, onOrgDisallowed: () => { throw new Error('deactivate side-channel blew up'); } });
  port = await gw.listen(0);
  const r = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 200, 'the request still fails over to B → 200 despite the throwing deactivate callback');
  resetGovernorRegistry();
});

test('LAST-RESORT opus→sonnet downgrade when opus is walled pool-wide on every account (WI-1073)', async () => {
  resetGovernorRegistry();
  // Both A and B are org/subscription-disallowed for OPUS specifically (a real shape: an opus-specific
  // cap/disallow that still leaves sonnet room) — every opus attempt 403s, every sonnet attempt 200s.
  // With no healthy opus account left to rotate/wait onto, the gateway must rewrite the request to the
  // fleet sonnet id and retry rather than hard-failing the caller.
  upstream = await startUpstream((req, res, body) => {
    const reqModel = (JSON.parse(body) as { model?: string }).model ?? '';
    if (reqModel.includes('opus')) {
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

  const r = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 200, 'opus walled on every account → last-resort sonnet retry succeeds, never hard-fails the caller');
  assert.equal(r.headers.get(MODEL_DOWNGRADED_HEADER), 'opus->sonnet', 'the silent substitution is surfaced to the caller via the downgrade header');
  assert.equal(JSON.parse(upstream.last.body).model, 'claude-sonnet-4-6', 'the forwarded request was rewritten to the fleet-canonical sonnet id');

  const s = (await (await ask('/stats')).json()) as { opusToSonnetDowngrades: number };
  assert.equal(s.opusToSonnetDowngrades, 1, '/stats records the last-resort downgrade for observability');
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

test('COLD-START rate hint disqualifies a projection-known-exhausted account even when its live governor is blank (account-cold-start-seed-2026-06-29)', async () => {
  // After a gateway restart the live governors are blank, so without the durable hint the selector treats a
  // weekly-capped / 403 / 429 account as "healthy" (util 0) and bounces requests onto it. The hint (loaded
  // from the account-pool projection at startup) lets keyOf disqualify it immediately → traffic goes to the
  // one account with real room (the owner-reported "the fleet can't use aviynw6's headroom after a restart").
  resetGovernorRegistry();
  upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const dead: ActiveAccount = { accountId: 'dead', token: async () => 'tdead', invalidateToken: () => {} };
  const healthy: ActiveAccount = { accountId: 'healthy', token: async () => 'thealthy', invalidateToken: () => {} };
  const ring = [dead, healthy]; // round-robin hands back 'dead' FIRST — the cold-start trap
  let i = 0;
  const pool: AccountPool = {
    active: () => ring[i++ % ring.length]!,
    onExhausted: () => null,
    select: (id) => (id === 'dead' ? dead : id === 'healthy' ? healthy : null),
  };
  gw = createInferenceGateway({ pool, upstreamBase: upstream.base, maxQueueWaitMs: 50 });
  port = await gw.listen(0);
  // Governors are BLANK (fresh registry) — the LIVE state cannot know 'dead' is exhausted yet. Seed the
  // durable hint: 'dead' is weekly-capped (util7d=1.0, window still open); 'healthy' has room.
  gw.setAccountRateHints([
    { accountId: 'dead', utilization7d: 1.0, windowResetAt7d: Date.now() + 7 * 24 * 3_600_000 },
    { accountId: 'healthy', utilization7d: 0.05, windowResetAt7d: Date.now() + 7 * 24 * 3_600_000 },
  ]);
  await ask('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }) });
  assert.equal(upstream.last.headers['authorization'], 'Bearer thealthy', 'cold-start: routed to the account with room; the projection-known-exhausted account was disqualified despite a blank live governor');
  resetGovernorRegistry();
});

test('DYNAMIC owner pin (POST /admin/owner-pin) routes an owner to the pinned account, overrides the static header, and unpin reverts (account-dynamic-pin-2026-06-29)', async () => {
  const acct = (id: string, tok: string): ActiveAccount => ({ accountId: id, token: async () => tok, invalidateToken: () => {} });
  const acctA = acct('A', 'tA');
  const acctB = acct('B', 'tB');
  const pool: AccountPool = {
    active: () => acctA,
    onExhausted: () => null,
    select: (id) => (id === 'A' ? acctA : id === 'B' ? acctB : null),
  };
  await boot((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, { pool });
  // pin owner 'spawn-7' → account B (runtime, via the admin endpoint accounts:pin wraps)
  const pinRes = await ask('/admin/owner-pin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ownerId: 'spawn-7', account: 'B' }) });
  assert.equal(pinRes.status, 200, 'owner-pin set ok');
  // a request from spawn-7 with NO account header → the dynamic pin routes it to B (not the active default A)
  await ask('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-papercusp-owner': 'spawn-7' }, body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }) });
  assert.equal(upstream.last.headers['authorization'], 'Bearer tB', 'dynamic owner pin routed spawn-7 → B');
  // it OVERRIDES a conflicting static x-papercusp-account header (the dynamic pin wins by owner id)
  await ask('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-papercusp-owner': 'spawn-7', 'x-papercusp-account': 'A' }, body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }) });
  assert.equal(upstream.last.headers['authorization'], 'Bearer tB', 'dynamic owner pin overrides the static x-papercusp-account header');
  // unpin → reverts to the static header (A)
  await ask('/admin/owner-pin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ownerId: 'spawn-7', clear: true }) });
  await ask('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-papercusp-owner': 'spawn-7', 'x-papercusp-account': 'A' }, body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }) });
  assert.equal(upstream.last.headers['authorization'], 'Bearer tA', 'after unpin, spawn-7 reverts to its static header account A');
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

test('HARD pin (x-papercusp-account-pin: hard) NEVER fails over off its account — paced pin 429s ON the pin, healthy sibling untouched (account-hard-pin-2026-06-29)', async () => {
  // The SOFT-pin twin of this is "Fault #3" above: a paced pin yields to a healthy active() → 200 Bearer
  // healthy-tok. A HARD (operator/PSU) pin must do the OPPOSITE: never touch the healthy sibling — it waits
  // / 429s ON its own account. Same setup as Fault #3; the ONLY difference is the x-papercusp-account-pin
  // header. Proves all the cache-affinity-yields-to-liveness branches are suppressed for a hard pin.
  resetGovernorRegistry();
  upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const paced: ActiveAccount = { accountId: 'paced-acct', token: async () => 'paced-tok' };
  const healthy: ActiveAccount = { accountId: 'healthy-acct', token: async () => 'healthy-tok' };
  const pool: AccountPool = {
    active: () => healthy, // a healthy alternative IS available (a soft pin WOULD take it)...
    onExhausted: () => healthy, // ...and rotation would hand it back
    select: (id) => (id === 'paced-acct' ? paced : id === 'healthy-acct' ? healthy : null),
  };
  gw = createInferenceGateway({ pool, upstreamBase: upstream.base, maxQueueWaitMs: 50 });
  port = await gw.listen(0);
  getGovernor('anthropic', 'opus', undefined, 'paced-acct').penalize({ retryAfterMs: 60 * 60_000 });
  const r = await ask('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-account': 'paced-acct', 'x-papercusp-account-pin': 'hard' },
    body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(r.status, 429, 'hard pin on a paced account 429s ON the pin (pause >> maxQueueWaitMs) — never fails over');
  assert.equal(r.headers.get('x-papercusp-routed-account'), 'paced-acct', 'routed-account stays the pinned account, never the healthy sibling');
  resetGovernorRegistry();
});

test('a HEALTHY-but-BUSY pinned account is NOT soft-pin-failed-over onto a 7d-EXHAUSTED sibling whose reprobe-pause aged out (owner: aviynw6 has weekly room but pinned consoles 429d)', async () => {
  // ROOT CAUSE: keyOf scored a 7d-exhausted account as merely `util` (≈1.0), so a BUSY-but-healthy pinned
  // account (low util + the soft-pin `load` term ⇒ key ≈ 1.08) ranked WORSE than an IDLE exhausted sibling
  // (key ≈ 1.0) — and the soft-pin-failover bounced the pinned request ONTO the exhausted account → 429.
  resetGovernorRegistry();
  upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const healthy: ActiveAccount = { accountId: 'healthy', token: async () => 'th', invalidateToken: () => {} };
  const exhausted: ActiveAccount = { accountId: 'exhausted', token: async () => 'te', invalidateToken: () => {} };
  const ring = [healthy, exhausted];
  let i = 0;
  const pool: AccountPool = {
    active: () => ring[i++ % ring.length]!,
    onExhausted: () => null,
    select: (id) => (id === 'healthy' ? healthy : id === 'exhausted' ? exhausted : null),
  };
  gw = createInferenceGateway({ pool, upstreamBase: upstream.base, maxQueueWaitMs: 200 });
  port = await gw.listen(0);
  // healthy = weekly headroom but BUSY (inflight ≥ PIN_YIELD_INFLIGHT ⇒ the soft-pin-failover walk fires) + a little 5h util.
  const hg = getGovernor('anthropic', 'opus', undefined, 'healthy');
  hg.state.unified = { window: '5h', utilization: 0.08, rejected: false, resetAt: Date.now() + 3_600_000 };
  hg.state.inFlight = 2;
  // exhausted = its 7-DAY window is REJECTING (util 1.0) but the predictive reprobe-pause has AGED OUT
  // (pausedUntil in the past) — the real-world window where it looks "selectable" again and re-lures requests.
  const eg = getGovernor('anthropic', 'opus', undefined, 'exhausted');
  eg.state.unified = { window: '7d', utilization: 1.0, rejected: true, resetAt: Date.now() + 7 * 24 * 3_600_000 };
  eg.state.pausedUntil = 0;
  await ask('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-account': 'healthy' },
    body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(upstream.last.headers['authorization'], 'Bearer th', 'pinned request STAYED on the weekly-healthy account; it was NOT bounced to the 7d-exhausted sibling');
  resetGovernorRegistry();
});

test('Fault #3b — pinned account is paused AND pool.active() hands it back → still walks to a healthy account, NOT a "paced/paused" 429 (owner 2026-06-21)', async () => {
  // The real-world miss: a bee pinned to a 97%-7d account that is PREDICTIVELY paused (governor pause, no
  // 429). The failover pool's exhaustedUntil can't see that, so pool.active() returns the paused pin itself
  // → the old canFailover==(poolActive!=pin) guard was false → the bee was 429'd with the pin's pause
  // forwarded ("account X paced/paused; retry after Ns") instead of yielding. Now the walk (gated on the
  // GOVERNOR pause) routes it to a healthy account regardless of what active() handed back.
  resetGovernorRegistry();
  upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const paced: ActiveAccount = { accountId: 'paced-acct', token: async () => 'paced-tok' };
  const healthy: ActiveAccount = { accountId: 'healthy-acct', token: async () => 'healthy-tok' };
  // Round-robin active(): FIRST hop returns the paused pin itself (the bug trigger), the walk's next hop a
  // healthy account.
  const ring = [paced, healthy];
  let i = 0;
  const pool: AccountPool = {
    active: () => ring[i++ % ring.length]!,
    onExhausted: () => null,
    select: (id) => (id === 'paced-acct' ? paced : id === 'healthy-acct' ? healthy : null),
  };
  gw = createInferenceGateway({ pool, upstreamBase: upstream.base, maxQueueWaitMs: 50 });
  port = await gw.listen(0);
  getGovernor('anthropic', 'opus', undefined, 'paced-acct').penalize({ retryAfterMs: 30 * 60_000 }); // long predictive-style pause
  const r = await ask('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-account': 'paced-acct' },
    body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(r.status, 200, 'served (yielded to liveness), NOT a paced/paused 429');
  assert.equal(upstream.last.headers['authorization'], 'Bearer healthy-tok', 'walked to the healthy account despite active() returning the paused pin');
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

test('UNPINNED request steers to the least-utilized healthy account up front, not the round-robin first pick (no-pin-hang fix, 2026-06-23)', async () => {
  // Repro of the owner-reported "500 on every no-pin launch": pool.active() round-robin handed an unpinned
  // request to a near-cap (but NOT governor-paused) account, which then 429/stall-looped through the internal-
  // retry + stall-absorb ladder (~90s) before shedding — surfacing to the caller as an opaque 500 — while the
  // SAME request PINNED to a healthy account returned 200 in <25s. The proactive health pick must route the
  // unpinned request to the account with the MOST residual budget BEFORE forwarding. The reactive paused-walk
  // does NOT cover this: 'hot' is at 0.85 unified utilization (> 0.8 pace watermark, < 0.95 predictive-pause
  // watermark), so it PACES but its governor.pausedUntil stays <= now — only the proactive pick routes around it.
  resetGovernorRegistry();
  upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const hot: ActiveAccount = { accountId: 'hot', token: async () => 'hot-tok' };   // near-cap, still allowed
  const cool: ActiveAccount = { accountId: 'cool', token: async () => 'cool-tok' }; // fresh budget
  // Round-robin active() can hand back the HOT account (the pre-fix trap); the proactive pick must still land cool.
  const ring = [hot, cool];
  let i = 0;
  const pool: AccountPool = {
    active: () => ring[i++ % ring.length]!,
    onExhausted: () => null,
    select: (id) => (id === 'hot' ? hot : id === 'cool' ? cool : null),
  };
  gw = createInferenceGateway({ pool, upstreamBase: upstream.base, maxQueueWaitMs: 80 });
  port = await gw.listen(0);
  // Seed 'hot' to 0.85 unified 5h utilization with a FUTURE reset + allowed status → it PACES but is NOT paused.
  const futureResetSec = Math.round(Date.now() / 1000) + 3600;
  getGovernor('anthropic', 'opus', undefined, 'hot').recordResponse({
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.85',
    'anthropic-ratelimit-unified-5h-reset': String(futureResetSec),
  });
  const r = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 200, 'served 200 (routed to the cool account, no stall-absorb)');
  assert.equal(r.headers.get('x-papercusp-routed-account'), 'cool', 'unpinned request steered to the least-utilized healthy account');
  assert.equal(upstream.last.headers['authorization'], 'Bearer cool-tok', 'egressed on the cool account, not the round-robin-first hot one');
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

test('stats().smoothing surfaces per-account EFFECTIVE pace when smoothRpm is engaged (P-005 — is pacing working, as data)', () => {
  // The gateway runs its OWN per-account governor registry (invisible to dev:rate_governor_status), so
  // /stats is the only window into whether the burst-dodging smoothing pace is actually engaged.
  const acct: ActiveAccount = { accountId: 'sm-acct', token: async () => 'T' };
  const pool: AccountPool = { active: () => acct, peek: () => acct, onExhausted: () => null };
  const governor = new RateLimitGovernor({ maxConcurrent: 20, rpm: 60 }); // 60rpm → 1000ms smoothed
  gw = createInferenceGateway({
    pool,
    upstreamBase: 'http://upstream.invalid',
    fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    governorFor: () => governor,
    smoothRpm: true,
  });
  const s = gw.stats();
  assert.equal(s.smoothing?.engaged, true, 'smoothing engaged gateway-wide');
  const entry = s.smoothing?.byAccount?.['sm-acct'];
  assert.ok(entry, 'the bound account appears in smoothing.byAccount');
  assert.equal(entry?.smoothRpm, true, 'the per-account governor has smoothRpm on');
  assert.equal(entry?.effRpm, 60, 'effRpm = floor(rpm × factor) = 60');
  assert.equal(entry?.effectivePaceMs, 1000, '60rpm smoothed → 1000ms ENFORCED inter-request pace (pacing is live)');
});

test('stats().smoothing reports engaged:false when smoothRpm is OFF (config visible, pace floor not applied) (P-005)', () => {
  const acct: ActiveAccount = { accountId: 'off-acct', token: async () => 'T' };
  const pool: AccountPool = { active: () => acct, peek: () => acct, onExhausted: () => null };
  gw = createInferenceGateway({
    pool,
    upstreamBase: 'http://upstream.invalid',
    fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20, rpm: 60 }),
    // smoothRpm omitted → defaults OFF
  });
  const s = gw.stats();
  assert.equal(s.smoothing?.engaged, false, 'gateway-wide smoothing off');
  const entry = s.smoothing?.byAccount?.['off-acct'];
  assert.equal(entry?.smoothRpm, false, 'per-account smoothRpm off');
  assert.equal(entry?.effectivePaceMs, 0, 'no smoothing floor → no enforced pace (free burst, the pre-fix behavior)');
});

test('per-account egress isolation: each pinned account routes via its OWN dispatcher; cached per-account; localAddress builds an Agent (B-GW-3 / per-account IP routing, D-003)', async () => {
  // The capacity win: each Max subscription egresses from its OWN IP, so Anthropic's per-IP opus
  // throttle becomes per-ACCOUNT (rotation works + ~8× aggregate RPM). Proof, in one request flow:
  //   (1) a request pinned to A builds A's dispatcher and B's builds a DISTINCT one (different egress
  //       IP — the isolation that makes rotation real);
  //   (2) the SAME account reuses its cached dispatcher (one stable egress IP across that account's
  //       requests — keyed `<accountId>|<proxyUrl>|<localAddress>`);
  //   (3) a bound-source-IP (`localAddress`) account also builds a dispatcher, not just the proxyUrl
  //       form; and
  //   (4) an account with no egress still falls back to the default shared egress (no dispatcher).
  const captured: { auth?: string; dispatcher?: unknown }[] = [];
  const fetchImpl = (async (_url: string, init: { headers: Record<string, string>; dispatcher?: unknown }) => {
    captured.push({ auth: init.headers.authorization, dispatcher: init.dispatcher });
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  // Each account's token getter returns a distinct token → the captured Authorization header names
  // WHICH account actually egressed (ground truth, immune to any internal failover).
  const A: ActiveAccount = { accountId: 'A', token: async () => 'A-tok', egress: { proxyUrl: 'http://127.0.0.1:3128' } };
  const B: ActiveAccount = { accountId: 'B', token: async () => 'B-tok', egress: { proxyUrl: 'http://127.0.0.1:3129' } };
  const C: ActiveAccount = { accountId: 'C', token: async () => 'C-tok', egress: { localAddress: '127.0.0.1' } };
  const P: ActiveAccount = { accountId: 'P', token: async () => 'P-tok' }; // no egress → shared default
  const byId: Record<string, ActiveAccount> = { A, B, C, P };
  const pool: AccountPool = { active: () => A, onExhausted: () => null, select: (id: string) => byId[id] ?? null };

  gw = createInferenceGateway({ pool, upstreamBase: 'http://upstream.invalid', fetchImpl, governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }), maxQueueWaitMs: 80 });
  port = await gw.listen(0);

  const pin = (acct: string) =>
    ask('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-papercusp-account': acct },
      body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }),
    });

  // Sequential so each request's fetchImpl capture completes before the next (the cache assertion
  // needs both A requests recorded in order).
  await pin('A');
  await pin('B');
  await pin('A'); // again → must reuse A's cached dispatcher
  await pin('C');
  await pin('P');

  const dispFor = (tok: string) => captured.filter((c) => c.auth === `Bearer ${tok}`).map((c) => c.dispatcher);
  const [dA1, dA2] = dispFor('A-tok');
  const [dB] = dispFor('B-tok');
  const [dC] = dispFor('C-tok');
  const [dP] = dispFor('P-tok');

  assert.ok(dA1, "account A's request egresses via A's dispatcher");
  assert.ok(dB, "account B's request egresses via B's dispatcher");
  assert.notEqual(dA1, dB, 'A and B egress via DISTINCT dispatchers (per-account IP isolation — the rotation win)');
  assert.equal(dA1, dA2, "A's dispatcher is cached per-account (one stable egress IP across A's requests)");
  assert.ok(dC, 'a bound-source-IP (localAddress) account also builds an egress dispatcher (not just proxyUrl)');
  assert.equal(dP, undefined, 'an account with no egress falls back to the default shared egress (no dispatcher)');
});

test('per-account egress IP POOL: ONE account ROUND-ROBINS its upstream across BOTH egress IPs — proxy + box-direct (gateway-per-account-egress-ip-pool-2026-06-30 P-006 / WI-1141)', async () => {
  // The aviynw8 config (P-006 "zero-cost immediate relief"): egressPool = [its Rayobyte HTTP proxy, the
  // box-direct IP]. A bare `{}` entry is the box-default outbound IP — a VALID, distinct second egress
  // (how an account gets a second free IP). The gateway must ROTATE successive requests across BOTH
  // entries (pickEgress round-robin), so a per-IP Cloudflare edge throttle on ONE IP takes only THAT IP
  // out of rotation while the SAME account keeps serving on its sibling IP (and a hard pin rides the
  // pool). Ground truth: the undici `dispatcher` handed to fetch — a ProxyAgent for the proxy IP, and NO
  // dispatcher (undefined = default shared egress) for the box-direct `{}` IP. Over 4 sequential requests
  // the dispatcher must ALTERNATE proxy <-> box-direct (BOTH IPs used), and the proxy IP must reuse ONE
  // cached dispatcher (a stable egress IP across its turns).
  const captured: { dispatcher?: unknown }[] = [];
  const fetchImpl = (async (_url: string, init: { headers: Record<string, string>; dispatcher?: unknown }) => {
    captured.push({ dispatcher: init.dispatcher });
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  // ONE account, pooled across its proxy IP + the box-direct IP ({} = box-default outbound).
  const A: ActiveAccount = {
    accountId: 'aviynw8',
    token: async () => 'A-tok',
    egressPool: [{ proxyUrl: 'http://127.0.0.1:3128' }, {}],
  };
  const pool: AccountPool = { active: () => A, onExhausted: () => null, select: (id: string) => (id === 'aviynw8' ? A : null) };

  gw = createInferenceGateway({ pool, upstreamBase: 'http://upstream.invalid', fetchImpl, governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }), maxQueueWaitMs: 80 });
  port = await gw.listen(0);

  // Pin to the account so `active()` is deterministic; the egress-IP rotation is WITHIN the pinned account.
  const hit = () =>
    ask('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-papercusp-account': 'aviynw8' },
      body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }),
    });

  // Sequential so the per-account round-robin cursor advances one egress-pick per request (deterministic).
  await hit();
  await hit();
  await hit();
  await hit();

  const dispatchers = captured.map((c) => c.dispatcher);
  assert.equal(dispatchers.length, 4, 'all four requests reached the egress dial');
  const viaProxy = dispatchers.filter((d) => d !== undefined); // the proxy IP built a ProxyAgent dispatcher
  const viaDirect = dispatchers.filter((d) => d === undefined); // the box-direct {} IP -> default egress (no dispatcher)
  assert.equal(viaProxy.length, 2, 'the proxy egress IP served 2 of 4 requests (rotation used it)');
  assert.equal(viaDirect.length, 2, 'the box-direct egress IP ({}) served 2 of 4 requests — BOTH IPs are in rotation');
  // Round-robin ALTERNATION: each request egresses through the OTHER IP than the one before it.
  for (let i = 1; i < dispatchers.length; i++) {
    assert.notEqual(
      dispatchers[i] === undefined,
      dispatchers[i - 1] === undefined,
      `request ${i} rotated to the other egress IP than request ${i - 1} (round-robin across the pool)`,
    );
  }
  // The proxy IP reuses ONE cached dispatcher each time it's picked (a stable egress IP per pool entry).
  assert.equal(new Set(viaProxy).size, 1, 'the proxy egress IP reuses a single cached dispatcher across its turns');
});

test('per-account egress IP POOL: ONE account ROUND-ROBINS its upstream across BOTH egress IPs — proxy + box-direct (gateway-per-account-egress-ip-pool-2026-06-30 P-006 / WI-1141)', async () => {
  // The aviynw8 config (P-006 "zero-cost immediate relief"): egressPool = [its Rayobyte HTTP proxy, the
  // box-direct IP]. A bare `{}` entry is the box-default outbound IP — a VALID, distinct second egress
  // (how an account gets a second free IP). The gateway must ROTATE successive requests across BOTH
  // entries (pickEgress round-robin), so a per-IP Cloudflare edge throttle on ONE IP takes only THAT IP
  // out of rotation while the SAME account keeps serving on its sibling IP (and a hard pin rides the
  // pool). Ground truth: the undici `dispatcher` handed to fetch — a ProxyAgent for the proxy IP, and NO
  // dispatcher (undefined = default shared egress) for the box-direct `{}` IP. Over 4 sequential requests
  // the dispatcher must ALTERNATE proxy <-> box-direct (BOTH IPs used), and the proxy IP must reuse ONE
  // cached dispatcher (a stable egress IP across its turns).
  const captured: { dispatcher?: unknown }[] = [];
  const fetchImpl = (async (_url: string, init: { headers: Record<string, string>; dispatcher?: unknown }) => {
    captured.push({ dispatcher: init.dispatcher });
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  // ONE account, pooled across its proxy IP + the box-direct IP ({} = box-default outbound).
  const A: ActiveAccount = {
    accountId: 'aviynw8',
    token: async () => 'A-tok',
    egressPool: [{ proxyUrl: 'http://127.0.0.1:3128' }, {}],
  };
  const pool: AccountPool = { active: () => A, onExhausted: () => null, select: (id: string) => (id === 'aviynw8' ? A : null) };

  gw = createInferenceGateway({ pool, upstreamBase: 'http://upstream.invalid', fetchImpl, governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }), maxQueueWaitMs: 80 });
  port = await gw.listen(0);

  // Pin to the account so `active()` is deterministic; the egress-IP rotation is WITHIN the pinned account.
  const hit = () =>
    ask('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-papercusp-account': 'aviynw8' },
      body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }),
    });

  // Sequential so the per-account round-robin cursor advances one egress-pick per request (deterministic).
  await hit();
  await hit();
  await hit();
  await hit();

  const dispatchers = captured.map((c) => c.dispatcher);
  assert.equal(dispatchers.length, 4, 'all four requests reached the egress dial');
  const viaProxy = dispatchers.filter((d) => d !== undefined); // the proxy IP built a ProxyAgent dispatcher
  const viaDirect = dispatchers.filter((d) => d === undefined); // the box-direct {} IP -> default egress (no dispatcher)
  assert.equal(viaProxy.length, 2, 'the proxy egress IP served 2 of 4 requests (rotation used it)');
  assert.equal(viaDirect.length, 2, 'the box-direct egress IP ({}) served 2 of 4 requests — BOTH IPs are in rotation');
  // Round-robin ALTERNATION: each request egresses through the OTHER IP than the one before it.
  for (let i = 1; i < dispatchers.length; i++) {
    assert.notEqual(
      dispatchers[i] === undefined,
      dispatchers[i - 1] === undefined,
      `request ${i} rotated to the other egress IP than request ${i - 1} (round-robin across the pool)`,
    );
  }
  // The proxy IP reuses ONE cached dispatcher each time it's picked (a stable egress IP per pool entry).
  assert.equal(new Set(viaProxy).size, 1, 'the proxy egress IP reuses a single cached dispatcher across its turns');
});

// The cache is keyed `<accountId>|<httpProxy>|<localAddress>` — so it must MISS (rebuild) when an account's
// egress binding changes, not keep handing back the stale dispatcher (a re-pointed proxy IP / re-bound source
// IP, e.g. after a pool hot-reload). The isolation test above proves the HIT side (same binding → same
// dispatcher); these prove the MISS side per binding field.
test('egress cache key includes proxyUrl — a re-pointed egress proxy on the SAME account rebuilds the dispatcher (no stale IP)', async () => {
  const captured: unknown[] = [];
  const fetchImpl = (async (_url: string, init: { dispatcher?: unknown }) => {
    captured.push(init.dispatcher);
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const A: ActiveAccount = { accountId: 'A', token: async () => 'A-tok', egress: { proxyUrl: 'http://127.0.0.1:3128' } };
  const pool: AccountPool = { active: () => A, onExhausted: () => null, select: (id: string) => (id === 'A' ? A : null) };
  gw = createInferenceGateway({ pool, upstreamBase: 'http://upstream.invalid', fetchImpl, governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }), maxQueueWaitMs: 80 });
  port = await gw.listen(0);
  const pin = () =>
    ask('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-papercusp-account': 'A' }, body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }) });
  await pin(); // builds + caches A's dispatcher for proxy :3128
  A.egress = { proxyUrl: 'http://127.0.0.1:3129' }; // account egress re-pointed to a new proxy
  await pin(); // key changed → MUST build a fresh dispatcher, not reuse the :3128 one
  const [d1, d2] = captured;
  assert.ok(d1 && d2, 'both requests egress via a dispatcher');
  assert.notEqual(d1, d2, 'a changed proxyUrl rebuilds the dispatcher (cache key includes the proxy, not just accountId)');
});

test('egress cache key includes localAddress — a re-bound source IP on the SAME account rebuilds the dispatcher', async () => {
  const captured: unknown[] = [];
  const fetchImpl = (async (_url: string, init: { dispatcher?: unknown }) => {
    captured.push(init.dispatcher);
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const A: ActiveAccount = { accountId: 'A', token: async () => 'A-tok', egress: { localAddress: '127.0.0.1' } };
  const pool: AccountPool = { active: () => A, onExhausted: () => null, select: (id: string) => (id === 'A' ? A : null) };
  gw = createInferenceGateway({ pool, upstreamBase: 'http://upstream.invalid', fetchImpl, governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }), maxQueueWaitMs: 80 });
  port = await gw.listen(0);
  const pin = () =>
    ask('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-papercusp-account': 'A' }, body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }) });
  await pin();
  A.egress = { localAddress: '127.0.0.2' }; // re-bound to a different loopback source IP
  await pin();
  const [d1, d2] = captured;
  assert.ok(d1 && d2);
  assert.notEqual(d1, d2, 'a changed localAddress rebuilds the dispatcher (cache key includes the bound IP)');
});

test('close() tears down every cached egress dispatcher (no leaked connection pool on gateway shutdown)', async () => {
  let captured: { close?: () => unknown; closed?: boolean; destroyed?: boolean } | undefined;
  const fetchImpl = (async (_url: string, init: { dispatcher?: unknown }) => {
    captured = init.dispatcher as { close?: () => unknown; closed?: boolean; destroyed?: boolean };
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const A: ActiveAccount = { accountId: 'A', token: async () => 'A-tok', egress: { localAddress: '127.0.0.1' } };
  const pool: AccountPool = { active: () => A, onExhausted: () => null, select: (id: string) => (id === 'A' ? A : null) };
  gw = createInferenceGateway({ pool, upstreamBase: 'http://upstream.invalid', fetchImpl, governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }), maxQueueWaitMs: 80 });
  port = await gw.listen(0);
  await ask('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-papercusp-account': 'A' }, body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }) });
  assert.ok(captured, 'A built an egress dispatcher');
  assert.notEqual(captured!.closed, true, 'the dispatcher is open while the gateway is serving');
  await gw.close();
  // The gateway iterates the dispatcher cache and calls close() on each before clearing it — so the
  // captured (real undici) dispatcher reports closed; nothing is left holding a socket pool open.
  assert.equal(captured!.closed, true, 'gateway.close() closed the cached egress dispatcher (no leaked connection pool)');
});

// 529 = SERVER overload (Anthropic is momentarily over capacity), NOT account-budget exhaustion. It must be
// handled DISTINCTLY from a 429: back off + retry the SAME account (the overload is transient + global, so a
// different account won't help and rotating would burn the rotation budget), WITHOUT penalizing/pausing the
// account or shrinking AIMD concurrency — and still bounded so a persistent 529 can't retry forever.
test('[529 overload] a 529 backs off + retries the SAME account (no rotation) → the bee gets the recovered 200, not the 529', async () => {
  let calls = 0;
  const bearers: string[] = [];
  const A: ActiveAccount = { accountId: 'A', token: async () => 'A-tok' };
  const B: ActiveAccount = { accountId: 'B', token: async () => 'B-tok' };
  await boot(
    (req, res) => {
      bearers.push(String(req.headers['authorization'] ?? ''));
      calls++;
      if (calls === 1) {
        res.writeHead(529, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    },
    { pool: createFailoverPool([A, B]) },
  );
  const res = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.status, 200, 'the 529 was retried into a 200, not forwarded to the bee');
  assert.equal((await res.json() as { ok: boolean }).ok, true);
  assert.equal(calls, 2, 'exactly one backoff-retry (529 then 200)');
  // CRITICAL distinction from a 429: a 529 retries the SAME account, never rotating to the other one.
  // (Which account the round-robin started on is irrelevant — both attempts must hit the SAME bearer.)
  assert.equal(bearers.length, 2, 'two upstream attempts');
  assert.equal(bearers[0], bearers[1], 'the 529 retried the SAME account (no rotation, unlike a 429)');
  assert.ok(bearers[0] === 'Bearer A-tok' || bearers[0] === 'Bearer B-tok', 'egressed on a pool account');
}, 15_000);

test('[529 overload] a 529 does NOT penalize/pause the account governor (server overload ≠ account budget) — /healthz stays ready', async () => {
  let calls = 0;
  await boot((_req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }
  });
  const res = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.status, 200);
  // A 429 budget-exhaustion would pause the governor (→ /healthz 503, the gateway-thorough backpressure case);
  // a 529 must leave it READY.
  const health = await ask('/healthz');
  assert.equal(health.status, 200, 'a 529 did not pause the account governor (healthz ready)');
  assert.ok(gw.stats().pausedUntil <= Date.now(), 'governor not paused after a 529');
}, 15_000);

test('[529 overload] a PERSISTENT 529 is BOUNDED — the request settles with a server error fast (slot freed), never an infinite backoff loop', async () => {
  // Under the production 60s internal-retry deadline a persistent 529 forwards a clean 529 after the
  // 6-attempt cap (~5s of 1s backoffs). Here we use a tiny deadline to assert the wedge-prevention BOUND
  // cheaply: the request must terminate FAST with a 5xx and free its slot, not retry forever. (The tiny
  // deadline clamps the attempt's headers wait, so the shed surfaces as a 502 abort rather than a forwarded
  // 529 — both are "bounded + slot freed", which is the property under test.)
  await boot(
    (_req, res) => {
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
    },
    { internalRetryDeadlineMs: 1 },
  );
  const start = Date.now();
  const res = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  const elapsed = Date.now() - start;
  assert.ok(res.status >= 500 && res.status < 600, `a persistent 529 settles with a bounded 5xx (got ${res.status}), not an infinite retry`);
  assert.ok(elapsed < 3_000, `terminated fast (${elapsed}ms), slot freed — no unbounded backoff loop`);
}, 15_000);

test('a genuinely unsupported (non-http(s)/non-socks) egress proxyUrl fails SAFE → default shared egress, never a silent break (B-GW-3)', async () => {
  // undici's ProxyAgent is HTTP-CONNECT only and does not understand an ftp:// URL — it would CONSTRUCT
  // without error but 502 EVERY request for this account at request time. The gateway must IGNORE it
  // and fall back to default egress (no dispatcher), not hand fetch a broken one.
  let captured: { dispatcher?: unknown } | undefined;
  const fetchImpl = (async (_url: string, init: { dispatcher?: unknown }) => {
    captured = init;
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const unsupportedAcct: ActiveAccount = { accountId: 'sx', token: async () => 'T', egress: { proxyUrl: 'ftp://127.0.0.1:1080' } };
  const pool: AccountPool = { active: () => unsupportedAcct, onExhausted: () => null };
  gw = createInferenceGateway({ pool, upstreamBase: 'http://upstream.invalid', fetchImpl, governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }), maxQueueWaitMs: 80 });
  port = await gw.listen(0);
  await ask('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }) });
  assert.equal(captured?.dispatcher, undefined, 'an ftp:// proxyUrl is ignored → default shared egress (no dispatcher)');
});

test('an unsupported-scheme proxyUrl + a bound localAddress → still binds the source IP (proxy ignored, IP binding applied) (B-GW-3)', async () => {
  let captured: { dispatcher?: unknown } | undefined;
  const fetchImpl = (async (_url: string, init: { dispatcher?: unknown }) => {
    captured = init;
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const acct: ActiveAccount = { accountId: 'mix', token: async () => 'T', egress: { proxyUrl: 'ftp://127.0.0.1:1080', localAddress: '127.0.0.1' } };
  const pool: AccountPool = { active: () => acct, onExhausted: () => null };
  gw = createInferenceGateway({ pool, upstreamBase: 'http://upstream.invalid', fetchImpl, governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }), maxQueueWaitMs: 80 });
  port = await gw.listen(0);
  await ask('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }) });
  assert.ok(captured?.dispatcher, 'falls through to the bound-source-IP dispatcher when the proxy scheme is unusable');
});

test('a socks5:// egress proxyUrl builds a real Socks5ProxyAgent dispatcher — native SOCKS5 egress (WI-284)', async () => {
  let captured: { dispatcher?: unknown } | undefined;
  const fetchImpl = (async (_url: string, init: { dispatcher?: unknown }) => {
    captured = init;
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const socksAcct: ActiveAccount = { accountId: 'sx', token: async () => 'T', egress: { proxyUrl: 'socks5://127.0.0.1:1080' } };
  const pool: AccountPool = { active: () => socksAcct, onExhausted: () => null };
  gw = createInferenceGateway({ pool, upstreamBase: 'http://upstream.invalid', fetchImpl, governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }), maxQueueWaitMs: 80 });
  port = await gw.listen(0);
  await ask('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }) });
  assert.ok(captured?.dispatcher, 'a socks5:// proxyUrl is HONORED — a real dispatcher is built, not ignored');
  assert.equal((captured!.dispatcher as { constructor: { name: string } }).constructor.name, 'Socks5ProxyAgent');
});

test('a socks5:// proxyUrl WINS over a bound localAddress (proxy takes precedence, matching http(s) proxy precedence) (WI-284)', async () => {
  let captured: { dispatcher?: unknown } | undefined;
  const fetchImpl = (async (_url: string, init: { dispatcher?: unknown }) => {
    captured = init;
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const acct: ActiveAccount = { accountId: 'mix2', token: async () => 'T', egress: { proxyUrl: 'socks5://127.0.0.1:1080', localAddress: '127.0.0.1' } };
  const pool: AccountPool = { active: () => acct, onExhausted: () => null };
  gw = createInferenceGateway({ pool, upstreamBase: 'http://upstream.invalid', fetchImpl, governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }), maxQueueWaitMs: 80 });
  port = await gw.listen(0);
  await ask('/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }) });
  assert.equal((captured!.dispatcher as { constructor: { name: string } }).constructor.name, 'Socks5ProxyAgent');
});

test('END-TO-END: a request through a socks5:// egress proxy genuinely tunnels to the real upstream via a real SOCKS5 relay (WI-284)', async () => {
  // No fetchImpl override — the REAL global fetch (undici) is used, so the dispatcher option is
  // genuinely honored end-to-end: gateway → dispatcherFor → Socks5ProxyAgent → the SOCKS5 relay
  // below → the real upstream HTTP server. This is the correctness proof beyond "the right class
  // gets constructed" (already covered above) — the bytes actually flow through the SOCKS5 hop.
  const socks = await startSocks5Relay();
  try {
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, via: 'socks5-relay' }));
    });
    const socksAcct: ActiveAccount = { accountId: 'e2e-socks', token: async () => 'T', egress: { proxyUrl: `socks5://127.0.0.1:${socks.port}` } };
    const pool: AccountPool = { active: () => socksAcct, onExhausted: () => null };
    gw = createInferenceGateway({ pool, upstreamBase: upstream.base, governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }), maxQueueWaitMs: 80 });
    port = await gw.listen(0);
    const res = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(res.status, 200, 'the request tunneled through SOCKS5 and reached the real upstream');
    const json = (await res.json()) as { ok: boolean; via: string };
    assert.equal(json.via, 'socks5-relay', 'the response body genuinely came from the real upstream server');
    assert.equal(upstream.last.method, 'POST', 'the upstream actually received the forwarded request');
    assert.ok(socks.getConnections() >= 1, 'the SOCKS5 relay handled at least one real CONNECT tunnel');
  } finally {
    await socks.close();
  }
}, 15_000);

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

test('a STALLED OAuth token refresh penalizes as TRANSPORT, not a real rate-limit penalty (2026-07-01 root-cause fix)', async () => {
  // Root cause of "API errors across all accounts, penaltyCount inflating on a genuinely QUIET account":
  // a token-refresh TIMEOUT (a flaky egress proxy / transient network blip on the OAuth round-trip) used to
  // call gov.penalize() with the DEFAULT (non-transport) source, so account-pool-store.ts's
  // `if (ev.source === 'transport') return` exemption — built for exactly this class of false signal after
  // the 2026-06-22 aviynw incident — never caught it. It counted toward sustainedPenaltyThreshold and could
  // park a healthy, 0%-utilization account for tens of minutes. Assert the pause this call site raises is
  // tagged 'transport' so the exemption actually applies.
  const pauses: Array<{ pausedUntil: number; source: string }> = [];
  const governor = new RateLimitGovernor({ maxConcurrent: 20 }, { onPause: (ev) => pauses.push(ev) });
  await boot(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
    { token: () => new Promise<string>(() => {}) /* never resolves */, tokenTimeoutMs: 50 },
    governor,
  );
  const res = await post({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.status, 503);
  assert.ok(pauses.length > 0, 'the token-refresh timeout must raise a pause');
  assert.ok(
    pauses.every((p) => p.source === 'transport'),
    `every pause from a token-refresh TIMEOUT must be tagged 'transport', got: ${JSON.stringify(pauses)}`,
  );
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

test('[self-heal integration] the sweeper reclaims the oldest stuck slot when saturated + nothing drains — frees the wedge, bumps selfHealReclaims, admits the queued waiter', async () => {
  // The pure decider (evaluateSelfHeal/isSaturated/pickReclaimTarget) is unit-tested in gateway-self-heal.test;
  // this drives the SWEEPER end-to-end: saturate ONE slot with a request the valve must reclaim, and prove the
  // freed slot is handed to a queued waiter (the wedge actually drains) — not just that the counter moves.
  //
  // Upstream answers only AFTER a delay LONGER than the freeze window, so the slot-holder is still pending when
  // the valve fires. on('close') cancels the pending response when the valve aborts the connection (a reclaimed
  // request leaves nothing dangling → clean teardown).
  await boot(
    (_req, res) => {
      const t = setTimeout(() => {
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        }
      }, 800);
      t.unref?.();
      res.on('close', () => clearTimeout(t));
    },
    {
      concurrency: 1, // ONE admission slot → trivially saturable
      aimd: { floor: 1 }, // floor == cap → AIMD disabled, maxConcurrent stays 1
      maxQueueWaitMs: 5_000, // the 2nd request STAYS queued (queueDepth=1 → saturated), never load-sheds
      selfHeal: { enabled: true, freezeMs: 200, pollMs: 40 }, // tiny → the valve fires fast in-test
      // Generous per-request guards so ONLY the self-heal valve can free the held slot in the test window.
      upstreamHeadersTimeoutMs: 60_000,
      upstreamStreamHeadersTimeoutMs: 60_000,
      upstreamBodyIdleTimeoutMs: 60_000,
      requestCeilingMs: 60_000,
      downstreamIdleMs: 60_000,
      tokenTimeoutMs: 60_000,
    },
  );
  const fire = () =>
    ask('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }),
    }).then((r) => ({ status: r.status }), () => ({ status: 0 })); // the valve destroys the socket → fetch may reject

  const start = Date.now();
  const p1 = fire(); // acquires the only slot; the upstream won't answer for 800ms
  await new Promise((r) => setTimeout(r, 60)); // let request 1 take the slot before request 2 queues behind it
  const p2 = fire(); // QUEUES behind the held slot → queueDepth=1 → saturated

  const r1 = await p1; // the valve reclaims this at ~freezeMs (200ms), force-freeing its slot
  const elapsed1 = Date.now() - start;
  assert.ok(elapsed1 < 3_000, `request 1 force-freed by self-heal in ${elapsed1}ms (not held to the 60s guards)`);
  assert.notEqual(r1.status, 200, 'the RECLAIMED request did not get a clean 200 (its slot was force-reclaimed)');

  assert.ok(gw.stats().selfHealReclaims >= 1, `the self-heal valve recorded a reclaim (got ${gw.stats().selfHealReclaims})`);

  const r2 = await p2; // the freed slot was handed to the queued waiter, which then completes for real
  assert.equal(r2.status, 200, 'the queued waiter was admitted to the freed slot and completed (the wedge actually drained)');
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// B-GW-2 — chaos / failure load harness.
//
// The three single-request regression tests above (token-hang 503, hung-client downstream-idle,
// hard-ceiling backstop) each prove one wedge mode releases ONE slot. These extend them into a LOAD
// harness: each pathology is driven under HIGH CONCURRENCY (N ≫ the admission cap) and asserts the two
// universal invariants the production wedges all violated —
//   (1) NO slot pinned   — gw.stats().inFlight drains back to 0 (the wedge signature is inFlight stuck
//                          at maxConcurrent with totalRequests frozen; see the
//                          inference-gateway-wedge-admission-slot-squat insight), and
//   (2) bounded recovery — once the fault clears the gateway serves a fresh request fast, never a
//                          multi-minute / manual-restart-only hang.
// Goal (brief B-GW-2): catch the NEXT wedge before production. Pure-in-process (mock upstream + mock
// token), so it runs under `npm run test:affected` / CI alongside the rest of this file — no .mjs script.
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** Poll the gateway's OWN /stats counter until inFlight drains to 0 (no admission slot leaked), or
 *  give up at the deadline. inFlight stuck > 0 is the universal wedge signature — every chaos test
 *  below asserts this returns 0. Reads gw.stats() directly (no HTTP round-trip). */
async function drainToZeroInFlight(deadlineMs = 8000): Promise<number> {
  const end = Date.now() + deadlineMs;
  let inFlight = gw.stats().inFlight;
  while (inFlight > 0 && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 25));
    inFlight = gw.stats().inFlight;
  }
  return inFlight;
}

test('[B-GW-2 chaos] extreme concurrency vs a HEALTHY upstream — all settle 200, upstream peak ≤ the cap, inFlight drains to 0', async () => {
  // 120 simultaneous requests against a healthy upstream with the admission queue capped at 8. The
  // gateway must (a) bound upstream concurrency to the cap (no thundering herd onto Anthropic),
  // (b) settle ALL of them (none dropped/hung — a healthy burst is PACED, never shed), and (c) drain
  // every admission slot back to 0.
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
      }, 6);
    },
    { concurrency: 8, maxQueued: 0 /* unbounded queue → prove a healthy burst is paced, never shed */ },
  );
  const N = 120;
  const before = gw.stats().totalRequests;
  const rs = await Promise.all(
    Array.from({ length: N }, () => post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] })),
  );
  assert.equal(rs.filter((r) => r.status === 200).length, N, 'every one of the 120 concurrent requests settled 200 (none dropped/shed/hung)');
  assert.ok(peak <= 8, `upstream peak concurrency ${peak} stayed within the queue cap (8) — no thundering herd`);
  assert.equal(gw.stats().totalRequests - before, N, 'every request was counted (counters never froze)');
  const inFlight = await drainToZeroInFlight();
  assert.equal(inFlight, 0, 'all 120 admission slots drained back to 0 — no slot leak');
}, 90_000);

test('[B-GW-2 chaos] pool-wide throttle storm (slow upstream squats slots) under high concurrency — graceful load-shed (429+retry-after), inFlight bounded + drains, fast recovery', async () => {
  // The PRIMARY production wedge (insight inference-gateway-wedge-admission-slot-squat): under a
  // sustained pool-wide throttle, every in-flight request squats its admission slot for the internal
  // wait budget, so the backlog grows WITHOUT BOUND until the gateway wedges (counters frozen, manual
  // restart). Modeled as a SLOW upstream — each call squats its slot ~400ms (comfortably longer than the
  // burst's dispatch spread even on a heavily-loaded box, so the backlog reliably builds regardless of
  // arrival timing — not flaky). With concurrency:4 + maxQueued:8, of 40 simultaneous requests only 12
  // fit (4 running + 8 waiting); the rest MUST be shed as fast retryable 429s, keeping the gateway
  // responsive + self-recovering instead of growing an unbounded backlog.
  let mode: 'storm' | 'healthy' = 'storm';
  let cur = 0;
  let peak = 0;
  await boot(
    (_req, res) => {
      cur++;
      peak = Math.max(peak, cur);
      const delay = mode === 'storm' ? 400 : 0; // storm: squat the slot; healthy: instant
      setTimeout(() => {
        cur--;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }, delay);
    },
    { concurrency: 4, maxQueued: 8 },
  );
  const N = 40;
  const shedBefore = gw.stats().shed429;
  const rs = await Promise.all(
    Array.from({ length: N }, () => post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] })),
  );
  const shed = rs.filter((r) => r.status === 429);
  const ok = rs.filter((r) => r.status === 200);
  assert.equal(shed.length + ok.length, N, 'every request SETTLED (200 admitted or 429 shed) — none lost or hung');
  assert.ok(shed.length >= 12, `excess load was shed as 429 (${shed.length}/${N}, expected ~28) — the backlog stayed BOUNDED, not unbounded`);
  assert.ok(ok.length >= 1, 'the admitted requests (within the concurrency+queue budget) still succeeded');
  const shedBody = (await shed[0].json()) as { gateway?: boolean };
  assert.equal(shedBody.gateway, true, 'shed responses are gateway-synthesized retryable 429s, not crashes');
  assert.ok(shed[0].headers.get('retry-after'), 'shed 429 carries retry-after so the caller backs off + retries');
  assert.ok(gw.stats().shed429 - shedBefore >= shed.length, 'the shed429 counter advanced — graceful load-shed is observable in /stats');
  assert.ok(peak <= 4, `upstream peak concurrency ${peak} never exceeded the cap (4) even under the storm`);
  const inFlight = await drainToZeroInFlight();
  assert.equal(inFlight, 0, 'all admission slots drained — the storm pinned no slot');
  // Bounded recovery: the moment the throttle clears, a fresh request succeeds FAST (no lingering wedge).
  mode = 'healthy';
  const t0 = Date.now();
  const recovered = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'recover' }] });
  assert.equal(recovered.status, 200, 'gateway recovered — a fresh request succeeds once the throttle clears');
  assert.ok(Date.now() - t0 < 6000, 'recovery was prompt, not a multi-second wedge');
}, 90_000);

test('[B-GW-2 chaos] upstream 429 storm under high concurrency — every request sheds FAST (no slot squat), counters keep moving, inFlight drains to 0', async () => {
  // The SECONDARY throttle path: the upstream ITSELF returns rate-limit 429s pool-wide (unified-rejected).
  // The governor pauses, and every queued request must fail admission FAST (synthetic gateway 429) rather
  // than squatting its slot waiting out the pause. Under a 40-wide burst: all settle quickly as 429s, the
  // request counter keeps advancing (never frozen — the wedge signature), and inFlight drains to 0.
  const resetSec = Math.round(Date.now() / 1000) + 3600;
  await boot(
    (_req, res) => {
      res.writeHead(429, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-utilization': '1.01',
        'anthropic-ratelimit-unified-5h-reset': String(resetSec),
      });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'pool throttled' } }));
    },
    { concurrency: 12, maxQueueWaitMs: 60 },
  );
  const N = 40;
  const before = gw.stats().totalRequests;
  const t0 = Date.now();
  const rs = await Promise.all(
    Array.from({ length: N }, () => post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] })),
  );
  const elapsed = Date.now() - t0;
  assert.ok(rs.every((r) => r.status === 429), 'every request under the storm settled as a 429 (real or synthetic) — none hung');
  assert.ok(elapsed < 12_000, `the whole 40-wide storm settled in bounded time (${elapsed}ms) — no slot squatting on the pause`);
  // Anti-wedge: the wedge signature is totalRequests FROZEN. Assert it ADVANCED (not exactly N): a queue-
  // level shed (e.g. B-GW-1's AIMD far-reset whole-pool shed) settles a 429 WITHOUT reaching proxy's
  // totalRequests++, so the principled invariant is "counters moved", not "every request reached proxy".
  assert.ok(gw.stats().totalRequests > before, 'totalRequests advanced — the gateway processed the burst (counters never froze)');
  const inFlight = await drainToZeroInFlight();
  assert.equal(inFlight, 0, 'no admission slot left pinned after the 429 storm');
  // Bounded recovery / responsiveness: the control plane still answers and the gateway keeps shedding
  // fast — it never wedged (a wedged gateway returns /healthz in <1ms but freezes /v1 forever).
  const health = await ask('/healthz');
  assert.ok(health.status === 200 || health.status === 503, 'control plane still responds after the storm');
  const again = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'again' }] });
  assert.equal(again.status, 429, 'a post-storm request still sheds fast (responsive), not a wedge');
}, 90_000);

test('[B-GW-2 chaos] internal-retry DEADLINE bounds slot-hold: a perpetual TRANSIENT 429 sheds + frees its slot at the deadline, never to the self-heal/watchdog threshold (wedge-prevention ladder)', async () => {
  // The slow-burn wedge this guards: a TRANSIENT/bare upstream 429 (x-should-retry, capacity exists) makes
  // the gateway ABSORB it internally — rotating + waiting while HOLDING the admission slot. With an account
  // that never recovers, the OLD code squatted the slot for the full ~30s transient wait budget (and, under
  // a SLOW upstream, the per-attempt fetch time ON TOP — pushing total slot-hold past the 75s self-heal /
  // 120s watchdog thresholds → a full restart = fleet-wide connection-refused). INTERNAL_RETRY_DEADLINE_MS
  // (here injected tiny) caps total slot-hold so the request SHEDS + frees its slot well before any reclaim.
  await boot(
    (_req, res) => {
      // A bare/transient 429: NO anthropic-ratelimit-* / retry-after headers → capacity-exists semantics, so
      // the gateway tries to absorb it internally (the slot-squat path my fix bounds) rather than shed at admission.
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'transient burst' } }));
    },
    // requestAbsorbMs: 0 PINS absorb OFF so this isolates the legacy SHED-at-deadline ladder. Absorb (default-on,
    // 60s) would otherwise HOLD this perpetual transient 429 for the full absorb budget instead of shedding —
    // its own (wedge-safe: slot RELEASED during the wait) path is covered by the EXTENDED ABSORB test. The shed
    // ladder still runs in production once the absorb budget is spent; here we exercise it directly.
    { concurrency: 4, internalRetryDeadlineMs: 200, requestAbsorbMs: 0 },
  );
  const t0 = Date.now();
  const r = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  const elapsed = Date.now() - t0;
  // The deadline shed manifests as a RETRYABLE error — 429 via the internal-retry guard, or 502/503 when a
  // near-deadline retry's headers-wait is deadline-capped and the fetch is aborted first. Both are retryable
  // and both FREE the slot; the durable invariant is "sheds fast + slot freed (no wedge)", not the code.
  assert.ok([429, 502, 503].includes(r.status), `sheds a RETRYABLE error at the deadline (got ${r.status}) — not absorbed forever`);
  assert.ok(elapsed < 5_000, `slot-hold bounded by the ~200ms deadline (${elapsed}ms) — NOT the full ~30s transient wait budget (the squat the wedge needs)`);
  const inFlight = await drainToZeroInFlight();
  assert.equal(inFlight, 0, 'the admission slot was freed at the deadline — no squat, so the frozen-while-saturated wedge signature never forms');
}, 30_000);

test('[B-GW-2 chaos] a STORM of upstream HEADER-stalls under high concurrency — all abort (502) fast, every slot drains, recovers', async () => {
  // The 2026-06-19 deadlock under LOAD: many concurrent requests to an upstream that accepts the socket
  // but never sends headers. Each must abort at the headers stall-guard (502) and RELEASE its slot — a
  // single leaked slot under a 30-wide stall storm would deadlock the pool at maxConcurrent. Then a
  // healthy request proves recovery.
  let mode: 'stall' | 'healthy' = 'stall';
  await boot(
    (_req, res) => {
      if (mode === 'stall') return; // accept the socket, never respond
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
    { concurrency: 6, upstreamHeadersTimeoutMs: 120, upstreamBodyIdleTimeoutMs: 120 },
  );
  const N = 30;
  const t0 = Date.now();
  const rs = await Promise.all(
    Array.from({ length: N }, () => post({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] })),
  );
  const elapsed = Date.now() - t0;
  assert.ok(rs.every((r) => r.status === 502), 'every stalled request aborted with a gateway 502 — none hung');
  assert.equal((await rs[0].json() as { gateway?: boolean }).gateway, true, 'gateway-synthesized 502');
  assert.ok(elapsed < 15_000, `the 30-wide stall storm aborted in bounded time (${elapsed}ms), not a multi-minute hang`);
  const inFlight = await drainToZeroInFlight();
  assert.equal(inFlight, 0, 'every admission slot released after the stall aborts — no deadlock under load');
  mode = 'healthy';
  const recovered = await post({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'y' }] });
  assert.equal(recovered.status, 200, 'gateway recovered after the stall storm cleared');
}, 90_000);

test('[B-GW-2 chaos] a STORM of mid-stream BODY-stalls under high concurrency — the body-idle guard drains every slot, recovers', async () => {
  // Headers + first chunk arrive, then the upstream stalls mid-stream. The per-chunk body-idle deadline
  // must trip under load and release every slot — a leak here wedges the pool exactly like a header stall.
  let mode: 'stall' | 'healthy' = 'stall';
  await boot(
    (_req, res) => {
      if (mode === 'stall') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        return; // then STALL — never send more, never end
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
    { concurrency: 6, upstreamHeadersTimeoutMs: 2000, upstreamBodyIdleTimeoutMs: 120 },
  );
  const N = 18;
  const rs = await Promise.all(
    Array.from({ length: N }, () => post({ model: 'claude-opus-4', stream: true, messages: [{ role: 'user', content: 'x' }] })),
  );
  assert.ok(rs.every((r) => r.status === 200), 'all streams opened (headers + first chunk forwarded)');
  // Drain the truncated/reset bodies, bounded so a lingering read can't blow the test budget. The slot
  // is freed by the UPSTREAM body-idle abort regardless of when the client read settles.
  await Promise.all(rs.map((r) => Promise.race([r.text().catch(() => ''), new Promise((res) => setTimeout(res, 1500))])));
  const inFlight = await drainToZeroInFlight();
  assert.equal(inFlight, 0, 'the body-idle guard released every slot mid-stream — no leak under load');
  mode = 'healthy';
  const recovered = await post({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'y' }] });
  assert.equal(recovered.status, 200, 'recovered after the mid-stream stall storm');
}, 90_000);

test('[B-GW-2 chaos] a hung OAuth-TOKEN endpoint under high concurrency — every request fails fast (503), never reaches upstream, all slots drain, recovers', async () => {
  // The 2026-06-20 token-hang wedge under LOAD: active.token() does a deadline-bounded refresh BEFORE the
  // upstream fetch, so a stalled token endpoint used to pin every admission slot forever (counters frozen,
  // multi-minute silence, restart-only). With a bounded tokenTimeoutMs every concurrent request must
  // reject fast (503 + slot release) and never reach upstream. Then a working token proves recovery.
  let tokenHangs = true;
  let upstreamHits = 0;
  await boot(
    (_req, res) => {
      upstreamHits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
    // concurrency 50 > N so every request gets an admission slot and deterministically hits the token
    // timeout (503) — the overflow case (admission 429) is already covered by the throttle-storm tests.
    { token: () => (tokenHangs ? new Promise<string>(() => {}) : Promise.resolve('tok')), tokenTimeoutMs: 80, concurrency: 50 },
  );
  const N = 30;
  const t0 = Date.now();
  const rs = await Promise.all(
    Array.from({ length: N }, () => post({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] })),
  );
  const elapsed = Date.now() - t0;
  assert.ok(rs.every((r) => r.status === 503), 'every request fails fast with a retryable 503, not a hang');
  assert.equal(upstreamHits, 0, 'no request reached upstream — the hang is BEFORE the fetch');
  assert.ok(elapsed < 15_000, `the 30-wide token-hang storm settled fast (${elapsed}ms), not a multi-minute wedge`);
  const inFlight = await drainToZeroInFlight();
  assert.equal(inFlight, 0, 'every admission slot released after the token timeout — wedge signature (inFlight stuck) absent');
  // Bounded recovery: a token-refresh timeout penalizes the stalled credential OUT of rotation
  // (gov.penalize) and releases every slot, so the gateway stays RESPONSIVE. With a SINGLE account there
  // is nothing healthy to fail over to, so a post-storm request settles FAST as a retryable error (429
  // governor-paused / 503 token-stalled) rather than hanging — the correct defensive outcome, and proof
  // it never wedged. (Failover around a bad credential → a healthy account's 200 is covered by the
  // session-cap / 403 / 5h-budget failover tests above.)
  tokenHangs = false;
  const t1 = Date.now();
  const after = await post({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'y' }] });
  assert.ok([200, 429, 503].includes(after.status), `post-storm request settles fast (got ${after.status}), not a hang`);
  assert.ok(Date.now() - t1 < 2000, 'gateway stayed responsive after the token-hang storm — no wedge');
}, 20_000);

// ---------------------------------------------------------------------------------------------------
// B-GW-1 — AIMD adaptive admission concurrency (inference-gateway-robustness-audit-2026-06-20 P1).
// The controller's algorithm is unit-tested in libs/papercusp-shared/.../aimd-concurrency.test.ts; these
// assert the GATEWAY WIRING: a sustained upstream-429 storm drives the admission queue's effective
// maxConcurrent DOWN (then a clean 200 stream recovers it), and the all-pool-throttled fail-fast shed.
// ---------------------------------------------------------------------------------------------------

test('[B-GW-1 AIMD] a routed-around per-account 429 does NOT shrink global admission concurrency (budget-aware routing)', async () => {
  // THE FIX (2026-06-21 budget-aware routing): a per-account quota/throttle 429 that successfully fails
  // over to a HEALTHY account is a ROUTING event, NOT gateway-over-drive — it must NOT shrink the global
  // admission concurrency. (The bug it replaces: EVERY 429 recordThrottle'd, so hitting one of the
  // 98-99%-maxed accounts collapsed effective→AIMD-floor even though other accounts had 55-91% headroom →
  // requests queued behind a tiny gate and timed out → the owner-reported bee "API errors".) Pool of 3 with
  // per-account governors; account A 429s once (a bare transient burst) then 200s; request 1 routes A→B and
  // succeeds. AIMD must stay pinned at the cap — the healthy accounts are never choked by A's quota hit.
  resetGovernorRegistry(); // fresh per-account governors (the pool's accounts are registry-keyed)
  const acct = (id: string): ActiveAccount => ({ accountId: id, token: async () => 't', invalidateToken: () => {} });
  const pool = createFailoverPool([acct('A'), acct('B'), acct('C')]);
  let calls = 0;
  await boot(
    (_req, res) => {
      calls += 1;
      if (calls === 1) {
        // BARE 429: rate_limit_error, NO window headers → a short transient burst-throttle on account A
        // that the gateway routes around to a healthy account.
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    },
    { pool, governorFor: undefined, concurrency: 8, aimd: { floor: 1, decreaseThreshold: 1, increaseEvery: 2 } },
  );

  const r1 = await post({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r1.status, 200, 'request recovered via failover off the throttled account');
  await r1.text();
  const s = (await (await ask('/stats')).json()) as { admission: { maxConcurrent: number }; concurrencyCap: number; aimd: { effective: number; cap: number; decreases: number } };
  assert.equal(s.concurrencyCap, 8, 'the cap is the configured concurrency');
  assert.equal(s.aimd.decreases, 0, `a routed-around 429 must NOT trip an AIMD decrease (got ${s.aimd.decreases})`);
  assert.equal(s.admission.maxConcurrent, 8, `global admission stayed at the cap — the healthy accounts are not choked (got ${s.admission.maxConcurrent}/8)`);
  assert.equal(s.aimd.effective, 8, 'effective concurrency unchanged: one account 429ing does not throttle the whole pool');
  assert.equal(((await (await ask('/stats')).json()) as { inFlight: number }).inFlight, 0, 'no admission slot leaked');
}, 20_000);

test('[B-GW-1 AIMD] an UN-ROUTABLE pool-wide 429 (no healthy account) DOES shrink global concurrency — the safety net still fires', async () => {
  // 6 accounts, ALL usage-cap-429: a request rotates through all 6, finds NO healthy account, and is
  // forwarded the 429 — THAT un-routable 429 is genuine pool-wide saturation, so it records a throttle and
  // shrinks the effective concurrency below the cap. (Contrast the routed-around test above: a 429 that
  // finds a healthy account does NOT shrink it — that is the whole budget-aware fix.) The hard floor-clamp,
  // additive recovery, and cap ceiling are covered exhaustively by the AIMD unit test (aimd-concurrency.test.ts).
  resetGovernorRegistry(); // fresh per-account governors (the pool's accounts are registry-keyed)
  const acct = (id: string): ActiveAccount => ({ accountId: id, token: async () => 't', invalidateToken: () => {} });
  const pool = createFailoverPool(['A', 'B', 'C', 'D', 'E', 'F'].map(acct));
  await boot(
    (_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: "You've hit your session limit · resets 10:50am" } }));
    },
    { pool, concurrency: 16, aimd: { floor: 3, decreaseThreshold: 1 } },
  );
  const r = await post({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 429, 'pool exhausted → the usage-cap 429 is forwarded after rotation');
  await r.text();
  const s = (await (await ask('/stats')).json()) as { admission: { maxConcurrent: number }; aimd: { effective: number; floor: number; decreases: number } };
  assert.ok(s.aimd.decreases >= 1, 'the un-routable pool-wide-saturation 429 DID trip an AIMD decrease');
  assert.ok(s.aimd.effective < 16 && s.aimd.effective >= 3, `effective shrank below the cap but never below the floor (got ${s.aimd.effective})`);
}, 20_000);

test('[B-GW-1 budget-aware] high concurrency, MAXED + HEALTHY accounts mixed: per-account 429s do NOT choke the global gate — everything routes to capacity (the owner "API errors despite headroom")', async () => {
  // The owner's EXACT scenario (2026-06-21): some accounts are maxed (429 every request) while others have
  // headroom (200). Under fleet concurrency the round-robin transiently hits the maxed ones → per-account
  // quota-429s that route around to a healthy account. PRE-FIX every such 429 recordThrottle'd → the GLOBAL
  // admission gate collapsed to the AIMD floor → requests queued behind it and timed out → bee "API errors".
  // POST-FIX the routed-around 429s are invisible to AIMD: the gate stays at the cap, every request reaches a
  // healthy account, nothing is shed.
  resetGovernorRegistry();
  const acct = (id: string): ActiveAccount => ({ accountId: id, token: async () => `${id}-tok`, invalidateToken: () => {} });
  const maxed = new Set(['A', 'B']); // 2 maxed, 6 with headroom
  const pool = createFailoverPool(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(acct));
  let calls429 = 0;
  await boot(
    (req, res) => {
      const id = String(req.headers['authorization'] ?? '').replace(/^Bearer\s+/, '').replace(/-tok$/, '');
      if (maxed.has(id)) {
        calls429 += 1;
        res.writeHead(429, { 'content-type': 'application/json' }); // bare transient → the gateway routes around
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    },
    { pool, governorFor: undefined, concurrency: 24, aimd: { floor: 4 } },
  );

  const N = 40;
  const statuses = await Promise.all(
    Array.from({ length: N }, () =>
      post({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }).then(async (r) => {
        await r.text();
        return r.status;
      }),
    ),
  );
  const ok = statuses.filter((st) => st === 200).length;
  const s = (await (await ask('/stats')).json()) as { aimd: { effective: number; floor: number; cap: number; decreases: number }; inFlight: number };
  assert.ok(calls429 > 0, 'the maxed accounts WERE hit under concurrency (the scenario is actually exercised)');
  assert.equal(ok, N, `every request routed around the maxed accounts to a healthy one (got ${ok}/${N} 200)`);
  assert.equal(s.aimd.decreases, 0, `the maxed-account quota-429s did NOT trip a single global AIMD decrease (got ${s.aimd.decreases})`);
  assert.equal(s.aimd.effective, s.aimd.cap, `global admission stayed at the cap, never choked by per-account quotas (effective=${s.aimd.effective}/${s.aimd.cap})`);
  assert.equal(s.inFlight, 0, 'no admission slot leaked');
}, 90_000);

test('[B-GW-1 G1] FLEET-WIDE bare-burst → rotate-retry SUPPRESSED (no cross-account amplification): ≈1 upstream call, ZERO failover', async () => {
  // WI-649: under a FLEET-WIDE bare-burst the limit is a SHARED edge throttle bursting most of the pool at
  // once (G2/WI-650 D-001: the bare-burst limit is shared/aggregate, NOT per-account), so rotating A→B→C
  // finds NO capacity and just multiplies upstream load — the observed self-sustaining storm (/stats:
  // upstream429=152 vs totalRequests=63 ⇒ 2.4× + failovers=108). The fix detects ≥half the pool already
  // OUT OF ROTATION and SUPPRESSES the rotate-retry: the request falls through to the bounded transient-WAIT
  // (it absorbs + recovers when the shared burst clears) instead of fanning out a fresh upstream call per
  // account. CONTRAST: the "few accounts maxed → rotate to healthy" path is preserved — the bare-429 failover
  // test + the budget-aware MAXED+HEALTHY test above still rotate, because there <half the pool is penalized.
  resetGovernorRegistry(); // fresh per-account governors (the pool's accounts are registry-keyed)
  const acct = (id: string): ActiveAccount => ({ accountId: id, token: async () => 't', invalidateToken: () => {} });
  const pool = createFailoverPool([acct('A'), acct('B'), acct('C'), acct('D')]);
  let calls = 0;
  await boot(
    (_req, res) => {
      calls += 1;
      if (calls === 1) {
        // The reachable account hits the shared transient burst: bare 429 (rate_limit_error, NO window headers).
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }));
      } else {
        // The short shared burst cleared — capacity returns on the SAME account (no rotation needed).
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, content: 'recovered' }));
      }
    },
    { pool, governorFor: undefined, concurrency: 8, aimd: { floor: 2 } },
  );
  // SIMULATE the fleet-wide state that concurrent in-flight requests create under the shared edge throttle:
  // HALF the 4-account pool (A, B) is already out of rotation. With ≥half penalized, rotating this bare-429
  // onto "another" account is futile (the same shared throttle), so the gateway must NOT rotate.
  pool.onExhausted('A', Date.now() + 60_000);
  pool.onExhausted('B', Date.now() + 60_000);

  const r = await post({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 200, 'the request ABSORBED the fleet-wide bare-burst (bounded wait + retry on the SAME account) and recovered — not a forwarded error');
  assert.equal(JSON.parse(await r.text()).content, 'recovered', 'the forwarded body is the recovered 200, not the burst error');
  const s = (await (await ask('/stats')).json()) as { failovers: number; bareBurstRotateSuppressed: number; inFlight: number };
  // THE FIX: no cross-account rotation happened. The OLD loop would have rotated C→D (a fresh upstream call on
  // each) before giving up — exactly the 2.4× / 108-failover amplification that sustained the storm.
  assert.equal(s.failovers, 0, `ZERO cross-account rotation under fleet-wide bare-burst (got ${s.failovers}; the pre-fix loop would rotate C→D here)`);
  assert.ok(s.bareBurstRotateSuppressed >= 1, `the storm-suppressor engaged at least once (got ${s.bareBurstRotateSuppressed})`);
  assert.equal(calls, 2, `≈1 upstream call/request: one bare-burst + one recover-on-the-same-account, NOT a per-account fan-out (got ${calls})`);
  assert.equal(s.inFlight, 0, 'no admission slot leaked');
}, 30_000);

test('[B-GW-1 G6] fleet-CONCURRENCY bare-burst regression rig: N real concurrent client requests hit a MOCK upstream enforcing a bare-burst limit → cluster-suppress engages, ~1 upstream call/request after absorb, ZERO bee-facing errors (WI-654)', async () => {
  // WI-654 (BRIEF G6): the [B-GW-1 G1] test above proves the suppression MECHANISM on a single request with
  // the pool's exhaustion state manually poisoned (pool.onExhausted called by hand). This test is the load-test
  // REGRESSION RIG G6 asked for: fire a genuine fleet-CONCURRENCY burst (N real, simultaneous client requests,
  // no manual pool-state poisoning) against a mock upstream that enforces the G2-measured shared/aggregate
  // bare-burst limit (WI-650 D-001) — every account's FIRST hit during the burst bare-429s (x-should-retry-shaped:
  // no rate-limit window headers, a bare `rate_limit_error`), capacity returns on the second hit. It measures
  // exactly the three signals G6 named: upstream429 (internal 429s absorbed), bee-facing forwarded errors (the
  // client-visible status codes — must be ZERO, the storm must be invisible to the bee), and upstream-calls-per-
  // client-request (must stay ≈2, i.e. bounded — NOT the ~2.4×+ multi-hop rotation cascade the pre-G1 code
  // produced under fleet-wide saturation). A future regression that reintroduces rotate-under-fleet-wide-burst
  // would blow up calls-per-request and/or start forwarding 429s to the bee — this test would go red.
  resetGovernorRegistry();
  const ACCOUNTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const acct = (id: string): ActiveAccount => ({ accountId: id, token: async () => `${id}-tok`, invalidateToken: () => {} });
  const pool = createFailoverPool(ACCOUNTS.map(acct));
  let totalCalls = 0;
  const callsByAccount = new Map<string, number>();
  await boot(
    (req, res) => {
      totalCalls += 1;
      const id = String(req.headers['authorization'] ?? '').replace(/^Bearer\s+/, '').replace(/-tok$/, '');
      const seen = (callsByAccount.get(id) ?? 0) + 1;
      callsByAccount.set(id, seen);
      if (seen === 1) {
        // Every account's FIRST hit during the burst is bare-429'd — WI-650 D-001: the limit is a SHARED
        // edge throttle bursting most of the pool at once, not a per-account wall (no window headers).
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }));
      } else {
        // The shared burst has cleared for this account by the time it's retried.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, content: 'served' }));
      }
    },
    { pool, governorFor: undefined, concurrency: ACCOUNTS.length * 2, aimd: { floor: 2 } },
  );

  const N = ACCOUNTS.length;
  const statuses = await Promise.all(
    Array.from({ length: N }, () =>
      post({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }).then(async (r) => {
        await r.text();
        return r.status;
      }),
    ),
  );

  const s = (await (await ask('/stats')).json()) as {
    upstream429: number;
    failovers: number;
    bareBurstRotateSuppressed: number;
    inFlight: number;
  };

  // Bee-facing: the entire fleet-wide burst must be ABSORBED — zero forwarded errors reach the client.
  const beeFacingErrors = statuses.filter((st) => st !== 200);
  assert.deepEqual(beeFacingErrors, [], `every one of ${N} concurrent requests recovered to 200 — the burst must be invisible to the bee (got statuses ${JSON.stringify(statuses)})`);

  // upstream429: the mock genuinely bare-429'd (the burst was really exercised, not a no-op scenario).
  assert.ok(s.upstream429 >= N - 1, `at least ${N - 1} accounts hit their first-round bare-429 (got upstream429=${s.upstream429})`);

  // The suppressor engaged repeatedly — this is a genuine multi-account fleet-wide event, not the
  // already-covered single-request/manually-poisoned scenario.
  assert.ok(s.bareBurstRotateSuppressed >= N - 2, `cluster-suppress engaged for most of the burst (got ${s.bareBurstRotateSuppressed}, wanted >= ${N - 2})`);

  // ZERO or at most ONE cross-account rotation (the very first bare-429 processed, before 2 distinct accounts
  // have clustered — see BAREBURST_CLUSTER_MIN_ACCOUNTS). NOT the cascading multi-hop rotation the pre-G1 code
  // would do under fleet-wide saturation.
  assert.ok(s.failovers <= 1, `at most one early cross-account rotation before cluster-suppress engaged (got failovers=${s.failovers})`);

  // upstream-calls-per-client-request stays ≈2 (one bare-429 + one absorbed retry), not a multi-hop blowup.
  const callsPerRequest = totalCalls / N;
  assert.ok(callsPerRequest <= 2.5, `upstream-calls-per-client-request stayed bounded (got ${callsPerRequest.toFixed(2)}, wanted <= 2.5 — the pre-G1 code observed ~2.4x+ from cross-account rotation cascades)`);

  assert.equal(s.inFlight, 0, 'no admission slot leaked');
}, 30_000);

test('[soft-pin] a PINNED request whose account is BUSY-but-serviceable STAYS pinned (dedicated-pin redesign 2026-07-01)', async () => {
  // Supersedes the 2026-06-23 pinned-concentration yield: load alone must NEVER divert a pin. Diverting a
  // pinned session off its warm per-credential cache costs a cold-cache first turn (observed live on
  // su-98731/aviynw7: 97%-cache-hit sessions bounced at inflight=1). Concurrency on a pin queues + paces on
  // the pin's own governor; only an UNSERVICEABLE pin (paused/exhausted/all-IPs-cooled) yields — see below.
  resetGovernorRegistry();
  const acct = (id: string): ActiveAccount => ({ accountId: id, token: async () => `${id}-tok`, invalidateToken: () => {} });
  const pool = createFailoverPool([acct('A'), acct('B'), acct('C')]);
  await boot(
    (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); },
    { pool, governorFor: undefined, concurrency: 24 },
  );
  // Concurrent pinned sessions already forwarding through A (the load that used to trigger the yield).
  getGovernor('anthropic', 'opus', undefined, 'A').state.inFlight = 2;
  const r = await ask('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-account': 'A' },
    body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(r.status, 200);
  await r.text();
  assert.equal(r.headers.get('x-papercusp-routed-account'), 'A', 'a busy-but-serviceable pin is preserved (cache affinity is a commitment, not a tiebreak)');
}, 20_000);

test('[soft-pin] a PINNED request whose account is UNSERVICEABLE (governor-paused) yields to a serviceable sibling', async () => {
  // The one case a soft pin breaks: the pin cannot serve at all (paused/exhausted/all IPs cooled). The
  // request routes to the least-loaded serviceable sibling instead of erroring on the dead pin; per-request
  // re-evaluation returns traffic to the pin when the pause lifts.
  resetGovernorRegistry();
  const acct = (id: string): ActiveAccount => ({ accountId: id, token: async () => `${id}-tok`, invalidateToken: () => {} });
  const pool = createFailoverPool([acct('A'), acct('B'), acct('C')]);
  await boot(
    (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); },
    { pool, governorFor: undefined, concurrency: 24 },
  );
  getGovernor('anthropic', 'opus', undefined, 'A').penalize({ resetAt: Date.now() + 60_000 });
  const r = await ask('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-account': 'A' },
    body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(r.status, 200, 'the pinned request still succeeds (served by a serviceable sibling)');
  await r.text();
  const routed = r.headers.get('x-papercusp-routed-account');
  assert.ok(routed === 'B' || routed === 'C', `unserviceable pin yielded (routed=${routed})`);
  assert.equal(
    r.headers.get('x-papercusp-pin-yielded'),
    `A->${routed}`,
    'the yield is a STRUCTURED signal to the pinned owner (P-003), not a silent divert',
  );
}, 20_000);

test('[soft-pin] a PINNED request to a HEALTHY idle account STAYS on its pin (cache affinity preserved)', async () => {
  // The dual: a pin must NOT thrash when its account is fine — sequential/single-session use keeps its warm
  // per-credential cache. With A healthy + idle (in-flight 0), a pinned-to-A request stays on A.
  resetGovernorRegistry();
  const acct = (id: string): ActiveAccount => ({ accountId: id, token: async () => `${id}-tok`, invalidateToken: () => {} });
  const pool = createFailoverPool([acct('A'), acct('B'), acct('C')]);
  await boot(
    (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); },
    { pool, governorFor: undefined, concurrency: 24 },
  );
  const r = await ask('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-account': 'A' },
    body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(r.status, 200);
  await r.text();
  assert.equal(r.headers.get('x-papercusp-routed-account'), 'A', 'a healthy idle pin is preserved (cache affinity)');
}, 20_000);

test('[B-GW-1] fail-fast SHED when the whole pool is throttled with a far-off reset (slot freed, not squatted)', async () => {
  // Pre-pause the single account far beyond maxQueueWaitMs (boot uses 80ms). The next request finds no
  // account with headroom at admission and the reset is far → it sheds IMMEDIATELY with a pool-wide
  // retry-after instead of taking the acquire/retry path (which would just 429 anyway). Distinct counter.
  const gov = new RateLimitGovernor({ maxConcurrent: 20 });
  await boot((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }, {}, gov);
  gov.penalize({ resetAt: Date.now() + 60_000 }); // pause ~60s ≫ maxQueueWaitMs (80ms)

  const t0 = Date.now();
  const res = await post({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] });
  const elapsed = Date.now() - t0;
  assert.equal(res.status, 429, 'all-throttled → shed 429');
  const body = (await res.json()) as { gateway?: boolean };
  assert.equal(body.gateway, true, 'synthetic gateway fail-fast shed (not a forwarded upstream 429)');
  assert.ok(Number(res.headers.get('retry-after')) > 0, 'carries a retry-after');
  assert.ok(elapsed < 1000, `shed FAST (${elapsed}ms), did not squat the slot on the acquire wait`);
  const s = (await (await ask('/stats')).json()) as { shedAllThrottled: number; inFlight: number };
  assert.equal(s.shedAllThrottled, 1, 'the fail-fast shed is counted on its own metric');
  assert.equal(s.inFlight, 0, 'the admission slot was freed immediately, not held');
});

test('[serviceable fallback] a near-cap-but-ALLOWED account is SERVED (residual budget), NOT an all-throttled shed (owner 2026-06-21)', async () => {
  // The owner-reported bug: 2 agents pinned to a 0.98-7d/0.05-5h account — the 2nd got "all accounts
  // throttled" though the account was still ALLOWED (serviceable). Predictive pause routes AROUND a near-cap
  // account when a healthier one exists, but with none it must SERVE the residual, not shed.
  const gov = new RateLimitGovernor({ maxConcurrent: 20 });
  await boot((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }, {}, gov);
  gov.recordResponse({
    'anthropic-ratelimit-unified-5h-status': 'allowed', // still ALLOWED by Anthropic
    'anthropic-ratelimit-unified-5h-utilization': '0.97', // ≥ predict-pause watermark → predictively paused
    'anthropic-ratelimit-unified-5h-reset': String(Math.round((Date.now() + 5 * 60 * 60_000) / 1000)),
  });
  assert.ok(gov.softPaused(Date.now()), 'precondition: the account is SOFT-paused (serviceable, not rejected)');
  assert.ok(gov.state.pausedUntil - Date.now() > 80, 'precondition: pause is far beyond maxQueueWaitMs (would shed pre-fix)');
  const res = await post({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(res.status, 200, 'a serviceable near-cap account SERVES its residual — NOT a 429 all-throttled shed');
  await res.text();
  const s = (await (await ask('/stats')).json()) as { shedAllThrottled: number };
  assert.equal(s.shedAllThrottled, 0, 'no shed — the account was serviceable');
});

test('[codex parity] a 429 on one Codex account ROTATES to another + retries — routed around, not forwarded (2026-06-22 audit)', async () => {
  // The Codex path (/v1/responses) must have the same per-account-429 failover the Claude path got — surface
  // a throttle to the bee only when there is genuinely nowhere to route.
  const A: ActiveAccount = { accountId: 'cdxA', token: async () => 'tokA' };
  const B: ActiveAccount = { accountId: 'cdxB', token: async () => 'tokB' };
  const calls: string[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const id = ((init?.headers as Record<string, string> | undefined)?.authorization ?? '').replace(/^Bearer\s+/i, '');
    calls.push(id);
    if (id === 'tokA') return new Response('{"error":"rate_limit"}', { status: 429, headers: { 'content-type': 'application/json' } });
    return new Response('{"ok":true,"servedBy":"cdxB"}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  gw = createInferenceGateway({
    pool: createFailoverPool([{ accountId: 'claude1', token: async () => 'c1' }]),
    codexPool: createFailoverPool([A, B]),
    fetchImpl,
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    selfHeal: { enabled: false },
  });
  port = await gw.listen(0);
  const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5' }),
  });
  assert.equal(res.status, 200, 'Codex 429 on cdxA failed over to cdxB → 200 (NOT a forwarded 429)');
  const body = (await res.json()) as { servedBy: string };
  assert.equal(body.servedBy, 'cdxB', 'the second Codex account actually served it');
  assert.ok(calls.includes('tokA') && calls.includes('tokB'), 'attempted cdxA first, then rotated to cdxB');
});

test('[#0 cache] the passive observer tallies prompt-cache READ/WRITE per account from message_start (a HIT)', async () => {
  resetGovernorRegistry();
  await boot((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":7,"cache_read_input_tokens":29000,"cache_creation_input_tokens":100,"output_tokens":1}}}\n\n',
    );
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    res.end();
  });
  const r = await post({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 200);
  await r.text();
  const s = (await (await ask('/stats')).json()) as { cache: { read: number; create: number; hits: number; misses: number; hitRate: number } };
  assert.equal(s.cache.read, 29000, 'cache_read tokens tallied from message_start');
  assert.equal(s.cache.create, 100, 'cache_creation tokens tallied');
  assert.equal(s.cache.hits, 1, 'a cache_read>0 request is a HIT');
  assert.equal(s.cache.misses, 0, 'a hit is not a miss');
  assert.ok(s.cache.hitRate > 0.9, `hit rate reflects the big cache read (got ${s.cache.hitRate})`);
});

test('[#0 cache] a cold prefix (cache_read=0, large input) counts as a MISS', async () => {
  resetGovernorRegistry();
  await boot((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":5000,"cache_read_input_tokens":0,"cache_creation_input_tokens":4000,"output_tokens":1}}}\n\n',
    );
    res.end();
  });
  const r = await post({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] });
  await r.text();
  const s = (await (await ask('/stats')).json()) as { cache: { hits: number; misses: number; read: number; create: number } };
  assert.equal(s.cache.hits, 0, 'no cache_read → not a hit');
  assert.equal(s.cache.misses, 1, 'read=0 with a large cold prefix is a miss');
  assert.equal(s.cache.create, 4000, 'the cold cache-creation is still tallied');
});

test('[stall-autowake P-002] an all-throttled shed to an IDENTIFIED bee records a stall event on /admin/stalls', async () => {
  const gov = new RateLimitGovernor({ maxConcurrent: 20 });
  await boot((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }, {}, gov);
  gov.penalize({ resetAt: Date.now() + 600_000 }); // whole pool out of budget ~10min ≫ maxQueueWaitMs (80ms)

  const r = await ask('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-owner': 'spawn-test-1' },
    body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(r.status, 429, 'all-throttled → shed 429');
  await r.text();

  const stalls = (await (await ask('/admin/stalls')).json()) as { stalls: { ownerId: string; accountId: string; soonestResetAt: number }[] };
  assert.equal(stalls.stalls.length, 1, 'one stall recorded');
  assert.equal(stalls.stalls[0].ownerId, 'spawn-test-1', 'tagged with the bee owner id (== spawnId)');
  assert.equal(stalls.stalls[0].accountId, 'test-acct', 'tagged with the account that was out of budget');
  assert.ok(stalls.stalls[0].soonestResetAt > Date.now(), 'carries the soonest-reset (recovery) time for the waker');
  assert.equal(((await (await ask('/stats')).json()) as { stallsRecorded: number }).stallsRecorded, 1);
});

test('[stall-autowake P-002] an UN-identified bee (no x-papercusp-owner) records NO stall (not wake-able)', async () => {
  const gov = new RateLimitGovernor({ maxConcurrent: 20 });
  await boot((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }, {}, gov);
  gov.penalize({ resetAt: Date.now() + 600_000 });
  const r = await post({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 429, 'still sheds (the shed is unchanged — only the recording is owner-gated)');
  await r.text();
  assert.equal(((await (await ask('/stats')).json()) as { stallsRecorded: number }).stallsRecorded, 0, 'no owner header → nothing to wake → not recorded');
  assert.equal(((await (await ask('/admin/stalls')).json()) as { stalls: unknown[] }).stalls.length, 0);
});

// ---------------------------------------------------------------------------------------------------
// STALL ABSORPTION (su-3650 incident) — RECONCILED with the `everRotated` gate (2026-06-23).
// The original su-3650 tests here asserted that a SINGLE-account / no-proxy upstream stall should be
// ABSORBED (release-slot → re-acquire → retry → 200). That CONTRADICTED the design the egress-circuit
// suite + the 2026-06-19 deadlock guard encode, and that the `everRotated` variable (gateway.ts) is
// documented to enforce: stall-absorption is reserved for a MULTI-account stall STORM (everRotated true —
// the pool has flapping/recovering ALTERNATIVES worth holding the caller for). A LONE / no-proxy stall (no
// alternative) must SHED FAST — re-acquiring on the same dead path would just re-stall for the whole absorb
// budget (the "LONE dead proxy sheds FAST", "N consecutive failures → 503", autowake-503 and streak-reset
// tests in gateway-egress-circuit.test.ts assert exactly that). The su-3650 concern ("a stall must not
// surface as a FATAL error to a bee") is still met WITHOUT absorption: a no-proxy stall sheds a RETRYABLE
// 502 (the Anthropic SDK retries 5xx) and the slot is released so the bee's retry lands on a recovered/
// rotated account — the same slot-release-then-retry the "HEADERS stall aborted (502)" test above proves.
// (If true no-proxy absorption is ever wanted, it must be reconciled with the 2026-06-19 + chaos-storm
// deadlock guards, not bolted on — owner call, see su-3650.)
// ---------------------------------------------------------------------------------------------------

test('[stall-absorb reconciled su-3650] a no-proxy / single-account upstream stall SHEDS a retryable error fast (everRotated gate) + the bee retries through', async () => {
  // everRotated is false (no alternative to rotate to) → NO stall-absorb hold: the request sheds a retryable
  // 502 FAST instead of squatting the slot for the absorb budget. The slot is released, so the bee's retry
  // (a fresh request) succeeds the moment the transient stall clears (calls===2 → 200).
  let calls = 0;
  await boot(
    (_req, res) => {
      calls++;
      if (calls === 1) return; // STALL: accept the socket, never respond
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
    { concurrency: 1, upstreamHeadersTimeoutMs: 120, upstreamBodyIdleTimeoutMs: 120, requestAbsorbMs: 500 },
  );
  const t0 = Date.now();
  const r1 = await post({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r1.status, 502, 'a lone/no-proxy stall sheds a retryable error FAST — not held for the absorb budget (everRotated gate)');
  assert.ok(Date.now() - t0 < 400, `shed fast, no absorb hold: ${Date.now() - t0}ms (< the 500ms requestAbsorbMs budget)`);
  assert.equal((await r1.json() as { gateway?: boolean }).gateway, true, 'gateway-synthesized retryable error');
  const r2 = await post({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'y' }] });
  assert.equal(r2.status, 200, "the slot was released → the bee's retry succeeds once the transient stall clears");
  assert.equal(calls, 2, 'first attempt stalled+shed, the bee retry is the second (successful) attempt');
});

test('[429-absorb SU-3650] upstream 429 (bare, transient) WITHIN absorption deadline is ABSORBED + retried, not forwarded', async () => {
  // A bare 429 (no rate-limit-window headers, x-should-retry:true) signals CAPACITY EXISTS (a transient
  // burst-throttle). The extended-absorption path HOLDS the slot while waiting for recovery. PRE-FIX: the
  // `(transient || up.status === 529)` gate on line 1984 prevented absorption for 429s marked non-transient
  // (e.g. a 429 with a 5h reset window) — only retrying immediately w/o absorption. POST-FIX: absorption
  // fires for ALL 429 responses, letting the re-acquire logic's timeout handle truly non-recoverable cases.
  let calls = 0;
  await boot(
    (_req, res) => {
      calls++;
      if (calls === 1) {
        // A bare 429: rate_limit_error, no window headers.
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'burst' } }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    },
    { concurrency: 1, requestAbsorbMs: 500, bare429FailoverBackoffMs: 100 },
  );
  const r = await post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 200, 'bare 429 within absorption deadline is ABSORBED + retried → 200, not forwarded');
  assert.equal((await r.json() as { ok: boolean }).ok, true);
  assert.equal(calls, 2, 'bare-429 + successful retry (absorption held the slot through the transient burst)');
});

test('[429-absorb SU-3650] all-accounts transient-429 under HIGH CONCURRENCY: absorbed + retried even on exhausted rotation, no slot-squat (wedge-prevention)', async () => {
  // The hardest case: EVERY account in the pool returns a bare 429 simultaneously. The old code's rotation
  // cycle burns through all accounts while on the internal-retry loop HOLDING the admission slot, then
  // falls through to shed. Under concurrency:4 with 20-wide load, a single account holding the slot for the
  // FULL rotation budget causes slot-squatting → the backlog grows unbounded → wedge. POST-FIX: extended
  // absorption fires AFTER rotation exhausts, releasing + re-acquiring the slot so it's never held past
  // the absorption budget, even when ALL accounts burst-throttle together.
  const acct = (id: string): ActiveAccount => ({ accountId: id, token: async () => 't', invalidateToken: () => {} });
  const pool = createFailoverPool([acct('A'), acct('B')]);
  let calls = 0;
  await boot(
    (_req, res) => {
      calls++;
      if (calls <= 2) {
        // Both A and B hit the bare burst on the first attempt
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'burst' } }));
      } else {
        // Capacity recovered
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    },
    { pool, concurrency: 4, requestAbsorbMs: 300 },
  );
  const N = 20;
  const t0 = Date.now();
  const rs = await Promise.all(
    Array.from({ length: N }, () => post({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] })),
  );
  const elapsed = Date.now() - t0;
  const ok = rs.filter((r) => r.status === 200).length;
  assert.ok(ok > 0, `some requests absorbed the all-429 burst and recovered (got ${ok}/${N} 200)`);
  // 45s threshold (not 15s): this asserts NO slot-squat WEDGE — a real wedge holds slots until the self-heal
  // valve (75s) / watchdog (120s) reclaim them, so anything well under 75s proves no wedge. 15s was too tight
  // for a contended CI box (it flaked at 15017ms and held the deploy gate red for hours); 45s tolerates load
  // while still failing a true wedge (which would blow the 60s test timeout below).
  assert.ok(elapsed < 45_000, `the 20-wide all-429 burst was handled without a slot-squat wedge (${elapsed}ms)`);
  const inFlight = await drainToZeroInFlight();
  assert.equal(inFlight, 0, 'all admission slots drained — no slot-squat even under the all-429 storm');
}, 60_000);

test('egress-ip-pool: a bare-burst 429 on one egress IP rotates to a SIBLING IP on the SAME account — no account pause, no cross-account failover (gateway-per-account-egress-ip-pool-2026-06-30)', async () => {
  // THE FIX for the owner-reported "pinned aviynw8 (ample budget) still throws API errors": a bare-burst
  // 429 is a Cloudflare per-IP EDGE throttle on the egress IP, NOT the account budget. With a per-account
  // egress IP pool the gateway must cool the throttled IP and retry the SAME account/credential on a sibling
  // IP (honoring a hard pin) → a 200, WITHOUT pausing the whole account or failing over to a different one.
  resetGovernorRegistry();
  const captured: { dispatcher?: unknown }[] = [];
  let call = 0;
  const fetchImpl = (async (_url: string, init: { dispatcher?: unknown }) => {
    captured.push({ dispatcher: init.dispatcher });
    call += 1;
    // First attempt's egress IP is Cloudflare-edge-throttled: a BARE 429 (rate_limit_error, NO
    // anthropic-ratelimit-* / retry-after headers). The sibling IP serves a 200.
    if (call === 1) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const gov = new RateLimitGovernor({ maxConcurrent: 20 });
  let failovers = 0;
  // A single account with TWO egress IPs — the pool the owner is provisioning (3/account); 2 suffices to prove rotation.
  const acct: ActiveAccount = {
    accountId: 'A',
    token: async () => 'A-tok',
    egressPool: [{ proxyUrl: 'http://127.0.0.1:3128' }, { proxyUrl: 'http://127.0.0.1:3129' }],
  };
  const pool: AccountPool = {
    active: () => acct,
    onExhausted: () => {
      failovers += 1; // a cross-account failover must NEVER happen here (only one account, and the IP rotated)
      return null;
    },
    select: (id: string) => (id === 'A' ? acct : null),
  };
  gw = createInferenceGateway({
    pool,
    upstreamBase: 'http://upstream.invalid',
    fetchImpl,
    governorFor: () => gov,
    maxQueueWaitMs: 200,
    bare429FailoverBackoffMs: 50,
  });
  port = await gw.listen(0);

  const r = await ask('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }),
  });

  assert.equal(r.status, 200, 'the bare-burst 429 on IP-1 was retried on the sibling IP → 200 (not forwarded, not paused)');
  assert.equal(captured.length, 2, 'exactly two upstream attempts: the throttled IP, then the sibling IP');
  assert.notEqual(
    captured[0].dispatcher,
    captured[1].dispatcher,
    'the retry egressed through a DIFFERENT egress IP on the SAME account (per-IP rotation, not a re-hit of the throttled IP)',
  );
  assert.equal(failovers, 0, 'no cross-account failover — the throttle was handled by rotating IPs within the account');
  assert.ok(
    gov.state.pausedUntil <= Date.now(),
    'the account governor was NOT paused — a per-IP Cloudflare throttle must not take the whole account out of rotation',
  );
  resetGovernorRegistry();
});

test('egress-ip-pool de-concentration: an account with partly-cooled egress IPs is down-ranked so UNPINNED traffic steers to a FRESH sibling account (P-005; pinned steering removed by the 2026-07-01 dedicated-pin redesign)', async () => {
  // Account A has a 3-IP pool; B is a fresh 1-IP account. Request 1 (pinned to A) bare-429s on A's
  // first two IPs (each cools + rotates to the next), then 200 on the third — so A ends with 2/3 IPs
  // cooled but is NOT account-paused (the per-IP rotation skips the account circuit). Request 2 is
  // UNPINNED: the proactive health pick must prefer fresh B over down-ranked A (keyOf adds +1 per cooled
  // IP, so A scores ~2 vs B's 0). A PINNED request no longer steers on partial cooling — it keeps its pin
  // and rides A's remaining fresh IP (request 3); only ALL-cooled (keyOf=Infinity) yields a pin.
  resetGovernorRegistry();
  const aCalls = { n: 0 };
  const fetchImpl = (async (_url: string, init: { headers: Record<string, string> }) => {
    if (init.headers.authorization === 'Bearer A-tok') {
      aCalls.n += 1;
      if (aCalls.n <= 2) {
        return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const A: ActiveAccount = {
    accountId: 'A',
    token: async () => 'A-tok',
    egressPool: [{ proxyUrl: 'http://127.0.0.1:3128' }, { proxyUrl: 'http://127.0.0.1:3129' }, { proxyUrl: 'http://127.0.0.1:3130' }],
  };
  const B: ActiveAccount = { accountId: 'B', token: async () => 'B-tok', egress: { proxyUrl: 'http://127.0.0.1:3200' } };
  const pool = createFailoverPool([A, B]);
  gw = createInferenceGateway({
    pool,
    upstreamBase: 'http://upstream.invalid',
    fetchImpl,
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    maxQueueWaitMs: 200,
    bare429FailoverBackoffMs: 60_000, // keep A's cooled IPs cooled across both requests
  });
  port = await gw.listen(0);

  const pinA = () =>
    ask('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-papercusp-account': 'A' },
      body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }),
    });

  const unpinned = () =>
    ask('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }),
    });

  const r1 = await pinA();
  assert.equal(r1.status, 200, "request 1 rode A's IP pool to a 200 (rotated past the two throttled IPs)");
  assert.ok(aCalls.n >= 3, 'A took ≥3 attempts: IP-1 (429) → IP-2 (429) → IP-3 (200) — per-IP rotation within the account');

  const r2 = await unpinned();
  assert.equal(r2.status, 200, 'request 2 served a 200');
  assert.equal(
    r2.headers.get('x-papercusp-routed-account'),
    'B',
    'unpinned request 2 steered to the FRESH account B — A was down-ranked because 2/3 of its egress IPs are cooled (de-concentration)',
  );

  const r3 = await pinA();
  assert.equal(r3.status, 200, 'request 3 served a 200');
  assert.equal(
    r3.headers.get('x-papercusp-routed-account'),
    'A',
    'a PINNED request stays on its partly-cooled pin (still serviceable via its fresh IP) — dedicated-pin redesign',
  );
  resetGovernorRegistry();
});


// ───────────────────────────────────────────────────────────────────────────────
// Codex-CLI bridge (ChatGPT subscription) — codex-cli-bridge.ts + proxyOpenAi
// resolution: CLI accounts serve /v1/responses when pinned, or as the fallback
// when no bearer pool exists / the bearer pool resolves no account.
// ───────────────────────────────────────────────────────────────────────────────

test('[codex-cli] with NO bearer pool, /v1/responses is served by the CLI runner (subscription path)', async () => {
  resetGovernorRegistry();
  const runs: Array<{ home: string; model: string; effort: string; prompt: string }> = [];
  await boot(
    (_req, res) => {
      res.writeHead(500);
      res.end('the HTTP upstream must never be hit on the CLI path');
    },
    {
      codexCliAccounts: () => [{ accountId: 'chatgpt-sub', home: '/tmp/sub-home' }],
      codexCliRun: async (o) => {
        runs.push({ home: o.home, model: o.model, effort: o.effort, prompt: o.prompt });
        return { text: 'BRIDGED', inputTokens: 11, outputTokens: 3 };
      },
    },
  );
  const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.4:high', input: 'hello', instructions: 'SYS', stream: false }),
  });
  assert.equal(res.status, 200, 'CLI bridge served the request');
  assert.equal(res.headers.get('x-papercusp-routed-account'), 'chatgpt-sub');
  const body = (await res.json()) as { output_text: string; usage: { input_tokens: number; output_tokens: number }; gateway_codex_cli: boolean };
  assert.equal(body.output_text, 'BRIDGED');
  assert.equal(body.usage.input_tokens, 11);
  assert.equal(body.gateway_codex_cli, true, 'reply is marked as CLI-served');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].home, '/tmp/sub-home', 'CODEX_HOME comes from the account credentialRef');
  assert.equal(runs[0].model, 'gpt-5.4', 'model spec normalized to the bare id');
  assert.equal(runs[0].effort, 'high', ':effort suffix mapped to codex reasoning effort');
  assert.equal(runs[0].prompt, 'SYS\n\nhello', 'instructions prepended to the input');
});

test('[codex-cli] stream:true is rejected 400 (the bridge is non-streaming)', async () => {
  resetGovernorRegistry();
  await boot(
    (_req, res) => {
      res.writeHead(500);
      res.end();
    },
    {
      codexCliAccounts: () => [{ accountId: 'chatgpt-sub', home: '/tmp/sub-home' }],
      codexCliRun: async () => ({ text: 'x', inputTokens: 0, outputTokens: 0 }),
    },
  );
  const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.4', input: 'hello', stream: true }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: { message: string } };
  assert.match(body.error.message, /non-streaming/);
});

test('[codex-cli] an explicit x-papercusp-account pin to a CLI account WINS over an existing bearer pool', async () => {
  resetGovernorRegistry();
  let upstreamHits = 0;
  const bearer: ActiveAccount = { accountId: 'cdx-bearer', token: async () => 'tokB' };
  await boot(
    (_req, res) => {
      upstreamHits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ servedBy: 'bearer' }));
    },
    {
      codexPool: createFailoverPool([bearer]),
      codexCliAccounts: () => [{ accountId: 'chatgpt-sub', home: '/tmp/sub-home' }],
      codexCliRun: async () => ({ text: 'CLI-PINNED', inputTokens: 1, outputTokens: 1 }),
    },
  );
  const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-account': 'chatgpt-sub' },
    body: JSON.stringify({ model: 'gpt-5.4', input: 'hi' }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { output_text?: string };
  assert.equal(body.output_text, 'CLI-PINNED', 'the pin routed to the CLI bridge');
  assert.equal(upstreamHits, 0, 'bearer upstream untouched');
});

test('[codex-cli] bearer pool keeps PRIORITY when both exist and no pin names the CLI account', async () => {
  resetGovernorRegistry();
  const bearer: ActiveAccount = { accountId: 'cdx-bearer', token: async () => 'tokB' };
  let cliRuns = 0;
  await boot(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ servedBy: 'bearer' }));
    },
    {
      codexPool: createFailoverPool([bearer]),
      // The bearer path egresses via the codex adapter's OWN upstream (default
      // api.openai.com) — intercept it (same pattern as the codex failover test).
      fetchImpl: (async () =>
        new Response(JSON.stringify({ servedBy: 'bearer' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
      codexCliAccounts: () => [{ accountId: 'chatgpt-sub', home: '/tmp/sub-home' }],
      codexCliRun: async () => {
        cliRuns++;
        return { text: 'x', inputTokens: 0, outputTokens: 0 };
      },
    },
  );
  const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5', input: 'hi' }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { servedBy?: string };
  assert.equal(body.servedBy, 'bearer', 'the API-bearer path served it (cheaper per call)');
  assert.equal(cliRuns, 0);
});

test('[codex-cli] a CLI runner failure surfaces as a 502 with the routed account', async () => {
  resetGovernorRegistry();
  await boot(
    (_req, res) => {
      res.writeHead(500);
      res.end();
    },
    {
      codexCliAccounts: () => [{ accountId: 'chatgpt-sub', home: '/tmp/sub-home' }],
      codexCliRun: async () => {
        throw new Error('codex exited 1: auth expired');
      },
    },
  );
  const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.4', input: 'hi' }),
  });
  assert.equal(res.status, 502);
  assert.equal(res.headers.get('x-papercusp-routed-account'), 'chatgpt-sub');
  const body = (await res.json()) as { error: { message: string } };
  assert.match(body.error.message, /codex-cli bridge failed/);
});

test('[codex-cli] GET /v1/models works with ONLY a CLI account (no bearer pool)', async () => {
  resetGovernorRegistry();
  await boot(
    (_req, res) => {
      res.writeHead(500);
      res.end();
    },
    {
      codexCliAccounts: () => [{ accountId: 'chatgpt-sub', home: '/tmp/sub-home' }],
      codexCliRun: async () => ({ text: 'x', inputTokens: 0, outputTokens: 0 }),
    },
  );
  const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
    headers: { 'x-papercusp-account': 'chatgpt-sub' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-papercusp-routed-account'), 'chatgpt-sub');
  const body = (await res.json()) as { models: Array<{ slug: string }> };
  assert.ok(body.models.length > 0, 'the synthesized model catalog is served');
});

test('[codex-cli] no bearer pool + no CLI accounts → the 503 is unchanged (pre-bridge behavior)', async () => {
  resetGovernorRegistry();
  await boot((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5', input: 'hi' }),
  });
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: { message: string } };
  assert.match(body.error.message, /no Codex account pool configured/);
});

/* ── effectivePriorityLabel: owner-prefix tier inference (2026-07-01 tier-5 starvation guard) ── */

test('effectivePriorityLabel prefers the explicit priority header', () => {
  assert.equal(
    // Explicit labels pass through verbatim (trim+lowercase) — legacy 'mug'
    // still lands in tier 1 via the DEFAULT_GATEWAY_PRIORITY_MAP dual keys.
    effectivePriorityLabel({ 'x-papercusp-priority': ' Queen ', 'x-papercusp-owner': 'su-abc' }),
    'mug',
  );
});

test('effectivePriorityLabel infers su/bee from the owner id prefix when priority is absent', () => {
  assert.equal(effectivePriorityLabel({ 'x-papercusp-owner': 'su-42371aaa-bbb' }), 'su');
  assert.equal(effectivePriorityLabel({ 'x-papercusp-owner': 's-1782946527495-3e5fd845' }), 'cup');
});

test('effectivePriorityLabel leaves unknown owners and headerless requests in the default band', () => {
  assert.equal(effectivePriorityLabel({ 'x-papercusp-owner': 'queen-like-unknown' }), undefined);
  assert.equal(effectivePriorityLabel({}), undefined);
  // An empty/whitespace priority header must not mask owner inference.
  assert.equal(effectivePriorityLabel({ 'x-papercusp-priority': '  ', 'x-papercusp-owner': 'su-x' }), 'su');
});

/* ── proactive egress probing (gateway-rayobyte-hardening P-002) ── */

test('[proactive-probe] a dead proxy is circuit-opened by the IDLE prober before any live request, and a pinned request routes around it', async () => {
  // A has a proxy egress whose probe always fails; B is healthy. No live traffic touches A — the
  // proactive prober alone must cool it (the reactive circuit would need two live requests to burn
  // first). A subsequent request PINNED to A yields (unserviceable pin) and serves via B.
  resetGovernorRegistry();
  const probed: string[] = [];
  const probeEgressImpl = (async (acct: { id: string }) => {
    probed.push(acct.id);
    return acct.id === 'A'
      ? { accountId: acct.id, hasEgress: true, exitIp: null, reputation: null, asn: null, error: 'connect ECONNREFUSED' }
      : { accountId: acct.id, hasEgress: true, exitIp: '203.0.113.7', reputation: null, asn: null };
  }) as unknown as typeof import('./egress-probe').probeEgress;
  const A: ActiveAccount = { accountId: 'A', token: async () => 'A-tok', egress: { proxyUrl: 'http://127.0.0.1:3128' } };
  const B: ActiveAccount = { accountId: 'B', token: async () => 'B-tok' };
  const pool = createFailoverPool([A, B]);
  gw = createInferenceGateway({
    pool,
    upstreamBase: 'http://upstream.invalid',
    fetchImpl: (async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    maxQueueWaitMs: 200,
    proactiveEgressProbeMs: 25,
    probeEgressImpl,
  });
  port = await gw.listen(0);

  // Wait for the prober to reach the open threshold (3 consecutive failures at 25ms cadence).
  const deadline = Date.now() + 5_000;
  let opens = 0;
  for (;;) {
    const s = (await (await ask('/stats')).json()) as { proactiveEgressProbe: { circuitOpens: number; enabled: boolean } };
    assert.equal(s.proactiveEgressProbe.enabled, true, 'prober armed');
    opens = s.proactiveEgressProbe.circuitOpens;
    if (opens >= 1 || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(opens >= 1, `the idle prober opened A's egress circuit (opens=${opens}) with zero live traffic`);
  assert.ok(probed.filter((id) => id === 'A').length >= 3, 'A was probed to the threshold');

  const r = await ask('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-account': 'A' },
    body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(r.status, 200);
  await r.text();
  assert.equal(r.headers.get('x-papercusp-routed-account'), 'B', 'pinned-to-A request yielded around the proactively-cooled proxy');
}, 20_000);

/* ── structured SSE error on mid-stream stall (gateway-rayobyte-hardening P-005) ── */

test('[P-005] a mid-stream SSE body stall ends the stream with an Anthropic-shaped error event, not a socket reset', async () => {
  // Upstream sends SSE headers + one event, then hangs forever. The body-idle guard aborts the relay;
  // the client must receive a parseable final `event: error` (overloaded_error, gateway:true) and a clean
  // stream end — the SDK retries that; a raw destroy surfaces as an opaque "API Error".
  resetGovernorRegistry();
  await boot(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      // ... then never send another byte (mid-stream stall).
    },
    { upstreamBodyIdleTimeoutMs: 150 },
  );
  const r = await post({ model: 'claude-opus-4', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 200, 'headers had already been relayed');
  const text = await r.text(); // resolves because the gateway ENDS the stream instead of destroying it
  assert.match(text, /event: message_start/, 'the relayed prefix arrived');
  assert.match(text, /event: error/, 'a final structured error event was appended');
  assert.match(text, /"type":"overloaded_error"/, 'Anthropic-shaped overloaded_error (the SDK auto-retries this)');
  assert.match(text, /"gateway":true/, 'marked as gateway-synthesized');
}, 20_000);

test('[P-008] /admin/owner-report returns the per-owner outcome ledger', async () => {
  resetGovernorRegistry();
  await boot((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  const r = await ask('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-owner': 'su-ledger-test' },
    body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(r.status, 200);
  await r.text();
  const rep = (await (await ask('/admin/owner-report?owner=su-ledger-test')).json()) as {
    ok: boolean; ledger: { requests: number; ok: number; lastAccount: string | null } | null;
  };
  assert.equal(rep.ok, true);
  assert.ok(rep.ledger, 'the owner has a ledger entry');
  assert.ok(rep.ledger!.requests >= 1, 'request counted');
  assert.ok(rep.ledger!.ok >= 1, 'ok outcome counted');
  const top = (await (await ask('/admin/owner-report')).json()) as { owners: Array<{ owner: string }> };
  assert.ok(top.owners.some((o) => o.owner === 'su-ledger-test'), 'overview lists the owner');
}, 20_000);

test('[egress kill-switch] ?proxy=off means NO request builds a proxy dispatcher — including proxy-only accounts (the default-param leak)', async () => {
  // Account A is PROXY-ONLY (no direct pool entry). With proxy egress disabled, its requests must ride
  // the DEFAULT box egress (init.dispatcher undefined). Before the chokepoint guard, pickEgress filtered
  // A's entries to [] and passed entry:undefined — which re-triggered dispatcherFor's `= account.egress`
  // default and dialed the squid anyway (observed live 2026-07-01 22:33 on aviynw6).
  resetGovernorRegistry();
  const dispatchersSeen: Array<unknown> = [];
  const fetchImpl = (async (_url: string, init: { dispatcher?: unknown }) => {
    dispatchersSeen.push(init.dispatcher);
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const A: ActiveAccount = { accountId: 'A', token: async () => 'A-tok', egress: { proxyUrl: 'http://127.0.0.1:3128' } };
  const pool = createFailoverPool([A]);
  gw = createInferenceGateway({
    pool,
    upstreamBase: 'http://upstream.invalid',
    fetchImpl,
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    maxQueueWaitMs: 200,
  });
  port = await gw.listen(0);

  await ask('/admin/egress-mode?proxy=off', { method: 'POST' }).then((r) => r.json());
  const r1 = await ask('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-account': 'A' },
    body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(r1.status, 200);
  await r1.text();
  assert.equal(dispatchersSeen.length, 1);
  assert.equal(dispatchersSeen[0], undefined, 'box-ip-only: no proxy dispatcher on a proxy-only account');

  // Flip back on: the same account dials through its proxy again.
  await ask('/admin/egress-mode?proxy=on', { method: 'POST' }).then((r) => r.json());
  const r2 = await ask('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-account': 'A' },
    body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(r2.status, 200);
  await r2.text();
  assert.ok(dispatchersSeen[1] !== undefined, 'proxy-pool restored: the proxy dispatcher is back');
}, 20_000);

test('POST /admin/readmit clears a live in-memory pool pause and reports fresh healthyAccounts (EI-8797 reset-rate split-brain)', async () => {
  // accounts:reset-rate resets the PERSISTED store; this endpoint is its live-process dual. A pool
  // with two paused accounts: readmit one by name (?account=A) → healthyAccounts 0→1; readmit with
  // no arg → every pool entry rejoins → healthyAccounts 2.
  const acct = (id: string): ActiveAccount => ({ accountId: id, token: async () => `t${id}`, invalidateToken: () => {} });
  const A = acct('A');
  const B = acct('B');
  const paused = new Set(['A', 'B']);
  const pool: AccountPool = {
    active: () => A,
    onExhausted: () => null,
    readmit: (id) => {
      paused.delete(id);
    },
    healthyCount: () => 2 - paused.size,
    entries: () => [A, B],
  };
  await boot((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, { pool });
  const one = (await (await ask('/admin/readmit?account=A', { method: 'POST' })).json()) as {
    ok: boolean;
    readmitted: string[];
    healthyAccounts: number;
  };
  assert.equal(one.ok, true, 'named readmit ok');
  assert.deepEqual(one.readmitted, ['A'], 'only the named account readmits');
  assert.equal(one.healthyAccounts, 1, 'A back in rotation, B still paused — the response reports the FRESH count');
  const all = (await (await ask('/admin/readmit', { method: 'POST' })).json()) as { readmitted: string[]; healthyAccounts: number };
  assert.deepEqual(all.readmitted, ['A', 'B'], 'no-arg readmits every pool entry');
  assert.equal(all.healthyAccounts, 2, 'whole pool back in rotation');
});

// ── Advisory serviceable-admission clamp (owner directive 2026-07-09) ─────────────────────────────
// "when the inference gateway clamps it should just be a recommendation, agents should be able to
// override". The clamp stays ON by default (thundering-herd guard); `mode:'off'` still COMPUTES and
// REPORTS the recommendation but admits at the AIMD effective. The live flip is the escape hatch for a
// STALE in-memory exhaustion, which otherwise pins the whole fleet at MIN_SERVICEABLE_ADMISSION until a
// full process restart.

/** A pool whose serviceable count is 0 — the live 2026-07-09 condition (healthyAccounts:0). */
function zeroHealthyPool(): AccountPool {
  const A: ActiveAccount = { accountId: 'A', token: async () => 'tA', invalidateToken: () => {} };
  return { active: () => A, onExhausted: () => null, readmit: () => {}, healthyCount: () => 0, entries: () => [A] };
}

test('serviceable clamp defaults to auto: a 0-serviceable pool pins live admission to the MIN floor', async () => {
  await boot((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, { pool: zeroHealthyPool(), concurrency: 24 });
  const s = (await (await ask('/admin/stats')).json()) as {
    admission: { maxConcurrent: number };
    clamp: { mode: string; recommendation: number | null; applied: number; overridden: boolean };
  };
  assert.equal(s.clamp.mode, 'auto', 'guard is ON by default');
  assert.equal(s.clamp.recommendation, 2, '0 serviceable accounts ⇒ recommendation is the MIN_SERVICEABLE_ADMISSION floor');
  assert.equal(s.admission.maxConcurrent, 2, 'and it is APPLIED to live admission');
  assert.equal(s.clamp.applied, 2);
  assert.equal(s.clamp.overridden, false);
});

test('POST /admin/clamp-mode?mode=off overrides the clamp LIVE — admission returns to the AIMD effective', async () => {
  await boot((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, { pool: zeroHealthyPool(), concurrency: 24 });
  // Precondition: the stale clamp is binding.
  const before = (await (await ask('/admin/stats')).json()) as { admission: { maxConcurrent: number } };
  assert.equal(before.admission.maxConcurrent, 2, 'clamped before the override');

  const flip = (await (await ask('/admin/clamp-mode?mode=off', { method: 'POST' })).json()) as {
    ok: boolean; mode: string; recommendation: number | null; applied: number;
  };
  assert.equal(flip.ok, true);
  assert.equal(flip.mode, 'off');
  assert.equal(flip.recommendation, 2, 'the recommendation is still COMPUTED — an override is not blindness');
  assert.equal(flip.applied, 24, 'live admission is back at the AIMD effective');

  const after = (await (await ask('/admin/stats')).json()) as {
    admission: { maxConcurrent: number };
    clamp: { mode: string; recommendation: number | null; overridden: boolean };
  };
  assert.equal(after.admission.maxConcurrent, 24, 'the flip took effect on the RUNNING queue, no restart');
  assert.equal(after.clamp.overridden, true, 'and the override is visible on /stats — never mistakable for a healthy pool');
  assert.equal(after.clamp.recommendation, 2);
});

test('POST /admin/clamp-mode?mode=auto restores the guard', async () => {
  await boot((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, { pool: zeroHealthyPool(), concurrency: 24 });
  await ask('/admin/clamp-mode?mode=off', { method: 'POST' }).then((r) => r.json());
  const back = (await (await ask('/admin/clamp-mode?mode=auto', { method: 'POST' })).json()) as { mode: string; applied: number };
  assert.equal(back.mode, 'auto');
  assert.equal(back.applied, 2, 'the guard re-clamps immediately');
  const s = (await (await ask('/admin/stats')).json()) as { admission: { maxConcurrent: number }; clamp: { overridden: boolean } };
  assert.equal(s.admission.maxConcurrent, 2);
  assert.equal(s.clamp.overridden, false);
});

test('POST /admin/clamp-mode with no mode READS current state without changing it', async () => {
  await boot((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, { pool: zeroHealthyPool(), concurrency: 24 });
  const r = (await (await ask('/admin/clamp-mode', { method: 'POST' })).json()) as { mode: string; applied: number };
  assert.equal(r.mode, 'auto', 'read-only probe');
  assert.equal(r.applied, 2, 'unchanged');
});

test('POST /admin/clamp-mode rejects an unknown mode (400) rather than silently defaulting', async () => {
  await boot((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, { pool: zeroHealthyPool(), concurrency: 24 });
  const res = await ask('/admin/clamp-mode?mode=yolo', { method: 'POST' });
  assert.equal(res.status, 400);
  await res.text();
  const s = (await (await ask('/admin/stats')).json()) as { clamp: { mode: string } };
  assert.equal(s.clamp.mode, 'auto', 'a bad flip never mutates the mode');
});

test('an override does NOT lift the clamp for a pool that has real capacity (recommendation ≥ effective ⇒ overridden:false)', async () => {
  // 8 serviceable accounts × PER_ACCOUNT_ADMISSION(4) = 32 ≥ concurrency 24 ⇒ the clamp was never binding,
  // so flipping to `off` must not REPORT an override that didn't happen.
  const A: ActiveAccount = { accountId: 'A', token: async () => 'tA', invalidateToken: () => {} };
  const pool: AccountPool = { active: () => A, onExhausted: () => null, readmit: () => {}, healthyCount: () => 8, entries: () => [A] };
  await boot((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  }, { pool, concurrency: 24 });
  await ask('/admin/clamp-mode?mode=off', { method: 'POST' }).then((r) => r.json());
  const s = (await (await ask('/admin/stats')).json()) as {
    admission: { maxConcurrent: number }; clamp: { recommendation: number | null; overridden: boolean };
  };
  assert.equal(s.clamp.recommendation, 32);
  assert.equal(s.admission.maxConcurrent, 24, 'admission was already the AIMD effective');
  assert.equal(s.clamp.overridden, false, 'nothing was actually overridden');
});

test('POST /admin/readmit on a pool without readmit (single-account) → 503, never a crash', async () => {
  await boot((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const res = await ask('/admin/readmit?account=X', { method: 'POST' });
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error?: { message?: string } };
  assert.match(body.error?.message ?? '', /no readmit/, 'explains the pool has no readmit');
});
