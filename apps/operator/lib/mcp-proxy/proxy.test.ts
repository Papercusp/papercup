/**
 * Resilient MCP proxy tests (P-005). Pins the load-bearing safety invariant
 * (retry ONLY a refused/pre-connect upstream — never replay a call that may have
 * reached :3070, so a non-idempotent tools/call is never double-applied) plus the
 * passthrough + refused-then-recovers behavior against in-process stub upstreams.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import {
  shouldRetry,
  createMcpProxy,
  prepareForward,
  postConnectRetryable,
  READ_ONLY_TOOLS,
  MAX_POST_CONNECT_RETRIES,
  isBackpressureStatus,
  backpressureRetryable,
  retryAfterMs,
  MAX_BACKPRESSURE_RETRIES,
  handshakeTimeoutRetryable,
  MAX_HANDSHAKE_TIMEOUT_RETRIES,
  isCheapRepeatingBeat,
  effectiveRetryWindowMs,
  CHEAP_REPEATING_BEAT_RETRY_WINDOW_MS,
  shouldShedForInFlight,
  DEFAULT_MAX_IN_FLIGHT,
  DEFAULT_MAX_HANDSHAKES_IN_FLIGHT,
  isMcpSessionHandshakeCall,
  isMcpProxyWatchdogProbePath,
  isReservedControlPlaneCall,
  isReservedControlPlanePath,
  shouldSkipDefaultFailureLog,
  shouldRotateFailureLog,
  injectCurrentSuperuserBearer,
  stripClientConnectionHeader,
  type McpProxyTarget,
} from './proxy';
import { MCP_PROXY_LOCAL_HEALTH_PATH } from './budgets.mjs';
import { DEFAULT_KEEPALIVE_TIMEOUT_MS } from '../../bin/host-request-deadline';

describe('shouldRetry — refused-only + in-window (no double-execution)', () => {
  it('retries when NOT connected and within the window', () => {
    expect(shouldRetry(false, 1_000, 45_000)).toBe(true);
  });
  it('does NOT retry once connected (the request may already be processed at :3070)', () => {
    expect(shouldRetry(true, 1_000, 45_000)).toBe(false);
  });
  it('does NOT retry past the window even if still refused', () => {
    expect(shouldRetry(false, 46_000, 45_000)).toBe(false);
  });
});

// EI-19388683897769817: a test that never sets PAPERCUSP_MCP_PROXY_FAILURE_LOG must never
// silently fall through to the real production ledger (~18% of a live 13,189-record sample
// was test/sidecar noise from exactly this gap). recordProxyFailure() consults this pure
// predicate before ever touching fs — tested directly (inputs, not env/fs) so the guard's
// LOGIC is pinned without depending on real environment state or touching disk.
describe('shouldSkipDefaultFailureLog — the write-site guard against test pollution of the shared prod ledger', () => {
  it('SKIPS under vitest with no explicit override — the exact gap that let 18% test noise into the ledger', () => {
    expect(shouldSkipDefaultFailureLog(true, false)).toBe(true);
  });
  it('WRITES under vitest when an explicit override IS set — a test that wants to assert on ledger content still can', () => {
    expect(shouldSkipDefaultFailureLog(true, true)).toBe(false);
  });
  it('WRITES outside vitest (real production/dev process) regardless of override — never silently drops real telemetry', () => {
    expect(shouldSkipDefaultFailureLog(false, false)).toBe(false);
    expect(shouldSkipDefaultFailureLog(false, true)).toBe(false);
  });
});

describe('failure ledger rotation — bounded diagnostic-path storage', () => {
  it('rotates at the configured byte ceiling and leaves smaller files in place', () => {
    expect(shouldRotateFailureLog(10, 10)).toBe(true);
    expect(shouldRotateFailureLog(9, 10)).toBe(false);
  });
});

// P-005: classify the forward + inject a per-request idempotencyKey on a tools/call so a
// post-connect retry is write-safe (:3070 replays instead of double-applying).
describe('prepareForward — classify + inject idempotencyKey', () => {
  const gen = () => 'KEY123';
  it('injects a key into a tools/call → klass "keyed", content-length fixed', () => {
    const body = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x","arguments":{}}}');
    const r = prepareForward('POST', { 'content-length': String(body.length) }, body, { keyingEnabled: true, genKey: gen });
    expect(r.klass).toBe('keyed');
    expect(JSON.parse(r.body.toString()).params._meta.idempotencyKey).toBe('KEY123');
    expect(r.headers['content-length']).toBe(String(r.body.length));
  });
  it('RESPECTS a valid client-supplied key (body unchanged)', () => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x', arguments: {}, _meta: { idempotencyKey: 'client-key' } } }));
    const r = prepareForward('POST', {}, body, { keyingEnabled: true, genKey: gen });
    expect(r.klass).toBe('keyed');
    expect(r.body).toBe(body); // not mutated
    expect(JSON.parse(r.body.toString()).params._meta.idempotencyKey).toBe('client-key');
  });
  it('an INVALID client key (server would ignore it) drops to "opaque"', () => {
    const body = Buffer.from(JSON.stringify({ method: 'tools/call', params: { name: 'x', _meta: { idempotencyKey: 'z'.repeat(201) } } }));
    expect(prepareForward('POST', {}, body, { keyingEnabled: true, genKey: gen }).klass).toBe('opaque');
  });
  it('keying kill-switch off → tools/call is "opaque" (refused-only, pre-P-005 behavior)', () => {
    const body = Buffer.from('{"method":"tools/call","params":{"name":"x"}}');
    expect(prepareForward('POST', {}, body, { keyingEnabled: false, genKey: gen }).klass).toBe('opaque');
  });
  it('an idempotent method (tools/list) → "idempotent", body untouched', () => {
    const body = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    const r = prepareForward('POST', {}, body, { keyingEnabled: true, genKey: gen });
    expect(r.klass).toBe('idempotent');
    expect(r.body).toBe(body);
  });
  it('a batch [tools/call, tools/list] → keyed, key injected only into the call', () => {
    const body = Buffer.from(JSON.stringify([{ method: 'tools/call', params: { name: 'a' } }, { method: 'tools/list' }]));
    const r = prepareForward('POST', {}, body, { keyingEnabled: true, genKey: () => 'BK' });
    expect(r.klass).toBe('keyed');
    const arr = JSON.parse(r.body.toString());
    expect(arr[0].params._meta.idempotencyKey).toBe('BK');
    expect(arr[1].method).toBe('tools/list');
    expect(arr[1].params).toBeUndefined();
  });
  it('non-JSON body → "opaque"', () => {
    expect(prepareForward('POST', {}, Buffer.from('not json'), { keyingEnabled: true, genKey: gen }).klass).toBe('opaque');
  });
  it('GET / empty body → "opaque"', () => {
    expect(prepareForward('GET', {}, Buffer.alloc(0), { keyingEnabled: true, genKey: gen }).klass).toBe('opaque');
  });
  it('an oversized tools/call is NOT rewritten (blocking guard) → "opaque"', () => {
    const body = Buffer.from(JSON.stringify({ method: 'tools/call', params: { name: 'x', arguments: { big: 'y'.repeat(300 * 1024) } } }));
    expect(prepareForward('POST', {}, body, { keyingEnabled: true, genKey: gen }).klass).toBe('opaque');
  });
  // EI-21268234394605529: a provably read-only tools/call replays safely without key machinery.
  it('every call naming a READ_ONLY_TOOLS verb → "readonly", body untouched', () => {
    const body = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"build:typecheck","arguments":{}}}');
    const r = prepareForward('POST', {}, body, { keyingEnabled: true, genKey: gen });
    expect(r.klass).toBe('readonly');
    expect(r.body).toBe(body); // no idempotencyKey injection — replay re-executes the read
    expect(JSON.parse(r.body.toString()).params._meta).toBeUndefined();
  });
  it('a batch mixing a read-only call with an unknown tool degrades to "keyed" (conservative)', () => {
    const body = Buffer.from(JSON.stringify([
      { method: 'tools/call', params: { name: 'build:typecheck' } },
      { method: 'tools/call', params: { name: 'work_items:create' } },
    ]));
    const r = prepareForward('POST', {}, body, { keyingEnabled: true, genKey: gen });
    expect(r.klass).toBe('keyed');
    expect(JSON.parse(r.body.toString())[1].params._meta.idempotencyKey).toBe('KEY123');
  });
  it('a malformed tools/call with no name is NOT readonly', () => {
    const body = Buffer.from(JSON.stringify({ method: 'tools/call', params: {} }));
    expect(prepareForward('POST', {}, body, { keyingEnabled: true, genKey: gen }).klass).toBe('keyed');
  });
  it('readonlyRetryEnabled:false falls back to the keyed path (kill-switch honored)', () => {
    const body = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"build:typecheck"}}');
    const r = prepareForward('POST', {}, body, { keyingEnabled: true, readonlyRetryEnabled: false, genKey: gen });
    expect(r.klass).toBe('keyed');
  });
});

describe('WI-41045 — refresh the superuser bearer at the proxy boundary', () => {
  it('overrides a stale bearer only for superuser MCP requests and uses the injected reader', () => {
    let reads = 0;
    const headers = { authorization: 'Bearer stale-client-token', accept: 'application/json' };
    const refreshed = injectCurrentSuperuserBearer('/api/mcp?superuser=1', headers, {
      tokenPath: '/tmp/test-superuser-token',
      readToken: (path) => {
        expect(path).toBe('/tmp/test-superuser-token');
        reads++;
        return 'fresh-token';
      },
    });

    expect(refreshed).toEqual({ authorization: 'Bearer fresh-token', accept: 'application/json' });
    expect(reads).toBe(1);
    expect(injectCurrentSuperuserBearer('/api/mcp', headers, {
      tokenPath: '/tmp/test-superuser-token',
      readToken: () => 'must-not-be-read',
    })).toBe(headers);
  });
});

describe('upstream hop-by-hop headers', () => {
  it('strips the client Connection header without mutating the client headers', () => {
    const headers = { connection: 'close', accept: 'application/json' };
    const forwarded = stripClientConnectionHeader(headers);

    expect(forwarded).toEqual({ accept: 'application/json' });
    expect(headers.connection).toBe('close');
  });
});

describe('postConnectRetryable — write-free requests only', () => {
  it('opaque never replays (write-safety invariant)', () => {
    expect(postConnectRetryable('opaque', 0, 1, 100, 5_000)).toBe(false);
  });
  it('replays idempotent requests but never a keyed tools/call that may still be running', () => {
    expect(postConnectRetryable('idempotent', 0, 1, 100, 5_000)).toBe(true);
    expect(postConnectRetryable('keyed', 0, 1, 100, 5_000)).toBe(false);
  });
  it('is bounded by maxRetries (no unbounded post-connect replay)', () => {
    expect(postConnectRetryable('idempotent', 1, 1, 100, 5_000)).toBe(false);
    expect(MAX_POST_CONNECT_RETRIES).toBe(1);
  });
  it('does not replay past the window', () => {
    expect(postConnectRetryable('idempotent', 0, 1, 6_000, 5_000)).toBe(false);
  });
  it('EI-21268234394605529: readonly replays like idempotent — bounded, in-window', () => {
    expect(postConnectRetryable('readonly', 0, 1, 100, 5_000)).toBe(true);
    expect(postConnectRetryable('readonly', 1, 1, 100, 5_000)).toBe(false);
    expect(postConnectRetryable('readonly', 0, 1, 6_000, 5_000)).toBe(false);
  });
});

// EI-21268234394605529 guard: the curated allowlist must NEVER contain a mutating verb —
// a write wrongly listed here would be silently double-applied on a post-connect replay.
describe('READ_ONLY_TOOLS — writer-exclusion guard', () => {
  it('never lists a known-mutating tool', () => {
    const writers = [
      'capability:bash', 'capability:edit', 'capability:git', 'capability:write',
      'chat:ask_choice', 'coord:ack', 'coord:ask-owner', 'coord:declare-intent',
      'coord:dispatch', 'coord:orient', 'coord:send', 'db:migrate', 'dev:restart',
      'events:await', 'events:emit', 'flags:set', 'improvements:capture',
      'loop:arm', 'loop:end', 'loop:checkpoint', 'memory:forget', 'memory:remember',
      'plans:add-decision', 'plans:add-item', 'plans:new', 'plans:set-now', 'plans:set-status',
      'release:checkpoint-run', 'release:deploy', 'scheduler:get_next', 'scheduler:set_claim_spec',
      'session:request-compaction', 'tools:invoke', 'watch:create',
      'work_items:checkpoint', 'work_items:claim', 'work_items:claim_next', 'work_items:comment',
      'work_items:complete', 'work_items:create', 'work_items:release', 'work_items:set_state',
      'work_items:update',
    ];
    for (const w of writers) expect([...READ_ONLY_TOOLS]).not.toContain(w);
  });
  it('entries are lowercase namespaced verbs', () => {
    for (const t of READ_ONLY_TOOLS) expect(t).toMatch(/^[a-z0-9_-]+:[a-z0-9_-]+$/);
  });
});

// P-010: absorb an admission-control 429 (loop critically saturated → shed) by retrying.
describe('backpressure (429) absorption — pure decisions', () => {
  it('only 429 is treated as absorbable backpressure', () => {
    expect(isBackpressureStatus(429)).toBe(true);
    expect(isBackpressureStatus(503)).toBe(false); // proxy emits 503 itself; not absorbed
    expect(isBackpressureStatus(500)).toBe(false);
    expect(isBackpressureStatus(200)).toBe(false);
  });
  it('retries while under both the max count and the window', () => {
    expect(backpressureRetryable(0, MAX_BACKPRESSURE_RETRIES, 100, 5_000)).toBe(true);
    expect(backpressureRetryable(MAX_BACKPRESSURE_RETRIES, MAX_BACKPRESSURE_RETRIES, 100, 5_000)).toBe(false);
    expect(backpressureRetryable(0, MAX_BACKPRESSURE_RETRIES, 6_000, 5_000)).toBe(false);
  });
  it('parses Retry-After delta-seconds, clamps, and falls back when absent/invalid', () => {
    expect(retryAfterMs('1', 500, 3_000)).toBe(1_000);
    expect(retryAfterMs(['2', '9'], 500, 3_000)).toBe(2_000); // first element
    expect(retryAfterMs('99', 500, 3_000)).toBe(3_000); // clamped to max
    expect(retryAfterMs(undefined, 500, 3_000)).toBe(500); // fallback
    expect(retryAfterMs('', 500, 3_000)).toBe(500); // empty → fallback
    expect(retryAfterMs('garbage', 500, 3_000)).toBe(500); // invalid → fallback
    expect(retryAfterMs('-4', 500, 3_000)).toBe(500); // negative → fallback
  });
});

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers.length = 0;
});

function track<T extends http.Server>(s: T): T {
  servers.push(s);
  return s;
}
function port(s: http.Server): number {
  return (s.address() as { port: number }).port;
}
function listen(s: http.Server, p = 0): Promise<http.Server> {
  return new Promise((res) => s.listen(p, '127.0.0.1', () => res(s)));
}
function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = port(s);
      s.close(() => res(p));
    });
  });
}
function request(
  p: number,
  body = '{"jsonrpc":"2.0"}',
  path = '/api/mcp',
  headers: http.OutgoingHttpHeaders = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: p, method: 'POST', path, headers }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

function get(p: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: p, method: 'GET', path }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on('error', reject);
    r.end();
  });
}

describe('createMcpProxy — client-facing keep-alive policy (EI-21275891049298859)', () => {
  it('applies the shared WI-1711 timeout instead of Node\'s racy 5s default', async () => {
    const previousKeepAlive = process.env.PAPERCUSP_HTTP_KEEPALIVE_TIMEOUT_MS;
    const previousHeaders = process.env.PAPERCUSP_HTTP_HEADERS_TIMEOUT_MS;
    delete process.env.PAPERCUSP_HTTP_KEEPALIVE_TIMEOUT_MS;
    delete process.env.PAPERCUSP_HTTP_HEADERS_TIMEOUT_MS;
    try {
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: '127.0.0.1',
          targetPort: 1,
          retryWindowMs: 100,
          log: () => {},
        }),
      );
      await listen(proxy);

      expect(proxy.keepAliveTimeout).toBe(DEFAULT_KEEPALIVE_TIMEOUT_MS);
      expect(proxy.keepAliveTimeout).toBeGreaterThan(5_000);
      expect(proxy.headersTimeout).toBeGreaterThan(proxy.keepAliveTimeout);
    } finally {
      if (previousKeepAlive === undefined) delete process.env.PAPERCUSP_HTTP_KEEPALIVE_TIMEOUT_MS;
      else process.env.PAPERCUSP_HTTP_KEEPALIVE_TIMEOUT_MS = previousKeepAlive;
      if (previousHeaders === undefined) delete process.env.PAPERCUSP_HTTP_HEADERS_TIMEOUT_MS;
      else process.env.PAPERCUSP_HTTP_HEADERS_TIMEOUT_MS = previousHeaders;
    }
  });
});

describe('WI-41257: inbound refusal and accept-pressure telemetry', () => {
  it('records clientError/socket-reset and drop events, and exposes bounded counters locally', async () => {
    const logs: string[] = [];
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: '127.0.0.1',
        targetPort: 1,
        retryWindowMs: 100,
        log: (line) => logs.push(line),
      }),
    );
    await listen(proxy);

    const socket = new net.Socket();
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    proxy.emit('clientError', reset, socket);
    proxy.emit('drop', {
      remoteAddress: '127.0.0.1',
      remotePort: 4567,
      remoteFamily: 'IPv4',
    });

    const health = JSON.parse((await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).body);
    expect(health.inbound).toMatchObject({ clientErrors: 1, socketResets: 1, drops: 1 });
    expect(socket.destroyed).toBe(true);
    expect(logs.some((line) => line.includes('inbound client error'))).toBe(true);
    expect(logs.some((line) => line.includes('inbound connection dropped'))).toBe(true);
  });
});

/**
 * WI-6743 regression. The watchdog's liveness probe used to poll `/api/health`, which this
 * proxy FORWARDS. That is unanswerable precisely when retry-on-refused is doing its job, so
 * every :3070 deploy restart was recorded as a proxy outage: 272 false `unreachable` incidents
 * between 2026-07-10 and 2026-08-02, which also buried the genuine-wedge signal the watchdog
 * exists to raise (a real wedge produced a byte-identical log line).
 *
 * The invariant: while the upstream is down and the proxy is holding a forwarded request, the
 * proxy-local health path must STILL answer — that is what makes it a sound liveness probe.
 */
describe('createMcpProxy — proxy-local health path stays truthful during an upstream outage (WI-6743)', () => {
  it('answers the local health path while the upstream is dead', async () => {
    const dead = await freePort(); // nothing listening => ECONNREFUSED on every forward
    const proxy = track(
      createMcpProxy({ listenPort: 0, targetHost: '127.0.0.1', targetPort: dead, retryWindowMs: 5_000, retryBackoffMs: 20, log: () => {} }),
    );
    await listen(proxy);

    const started = Date.now();
    const res = await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH);
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    // Must return immediately — NOT after the retry window. This is the whole point.
    expect(elapsed).toBeLessThan(1_000);
  });

  it('THE BUG: a FORWARDED path cannot answer during the same outage', async () => {
    // Demonstrates why polling `/api/health` (forwarded) made the watchdog lie. The old probe
    // aborted at 5s and logged `unreachable`; here we shorten the window so the hold is visible
    // without the test waiting on it.
    const dead = await freePort();
    const proxy = track(
      createMcpProxy({ listenPort: 0, targetHost: '127.0.0.1', targetPort: dead, retryWindowMs: 700, retryBackoffMs: 20, log: () => {} }),
    );
    await listen(proxy);

    const started = Date.now();
    const res = await request(port(proxy), '{"jsonrpc":"2.0"}', '/api/mcp');
    const elapsed = Date.now() - started;

    expect(res.status).toBe(503); // held for the whole window, then gave up
    expect(elapsed).toBeGreaterThanOrEqual(600);
  });
});

describe('createMcpProxy — forwarding + restart recovery', () => {
  it('passes a request through to the upstream and returns its response', async () => {
    const upstream = track(
      http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"result":"ok"}');
      }),
    );
    await listen(upstream);
    const proxy = track(createMcpProxy({ listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream), retryWindowMs: 5_000, retryBackoffMs: 50, log: () => {} }));
    await listen(proxy);

    const r = await request(port(proxy));
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":"ok"}');
  });

  it('does not forward a client Connection: close to the capped control-plane agent', async () => {
    const seenConnections: Array<string | undefined> = [];
    const upstream = track(
      http.createServer((req, res) => {
        seenConnections.push(req.headers.connection);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"result":"ok"}');
      }),
    );
    await listen(upstream);
    const controlPlaneAgent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: '127.0.0.1',
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        controlPlaneAgent,
        log: () => {},
      }),
    );
    await listen(proxy);

    try {
      const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
      const headers = {
        connection: 'close',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      };
      const results = await Promise.all(
        Array.from({ length: 4 }, () => request(port(proxy), body, '/api/mcp?superuser=1', headers)),
      );

      expect(results.every((result) => result.status === 200)).toBe(true);
      expect(seenConnections).toHaveLength(4);
      expect(seenConnections.every((connection) => connection !== 'close')).toBe(true);
    } finally {
      controlPlaneAgent.destroy();
    }
  });

  it('does not accumulate connect listeners when a keep-alive upstream socket is reused', async () => {
    const upstream = track(
      http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"result":"ok"}');
      }),
    );
    await listen(upstream);

    const clientSockets: net.Socket[] = [];
    const upstreamAgent = new http.Agent({
      keepAlive: true,
      maxSockets: 1,
    });
    const baseCreateConnection = upstreamAgent.createConnection;
    upstreamAgent.createConnection = (options, callback) => {
      const socket = baseCreateConnection.call(upstreamAgent, options, callback);
      clientSockets.push(socket as net.Socket);
      return socket;
    };
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: '127.0.0.1',
        targetPort: port(upstream),
        retryWindowMs: 5_000,
        upstreamAgent,
        log: () => {},
      }),
    );
    await listen(proxy);

    try {
      expect((await request(port(proxy))).status).toBe(200);
      expect(clientSockets).toHaveLength(1);
      const listenerCountAfterConnect = clientSockets[0].listenerCount('connect');

      // Before the `s.connecting === false` guard, each reuse added a `once('connect')`
      // listener to this already-connected socket. Twelve calls crossed Node's default
      // warning threshold in the incident; the count must remain stable after reuse.
      for (let i = 0; i < 12; i++) {
        expect((await request(port(proxy))).status).toBe(200);
      }
      expect(clientSockets).toHaveLength(1);
      expect(clientSockets[0].listenerCount('connect')).toBe(listenerCountAfterConnect);
      expect(clientSockets[0].listenerCount('connect')).toBe(0);
    } finally {
      upstreamAgent.destroy();
    }
  });

  it('P-010: ABSORBS an upstream 429 (admission shed) and returns the eventual 200 — saturation invisible', async () => {
    let calls = 0;
    const upstream = track(
      http.createServer((_req, res) => {
        calls++;
        if (calls <= 2) {
          // First two forwards: operator sheds (event loop critical). retry-after:0 → retry fast.
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
          res.end('{"error":"shed","data":{"reason":"loop_pressure_critical"}}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"result":"admitted"}');
      }),
    );
    await listen(upstream);
    const proxy = track(createMcpProxy({ listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream), retryWindowMs: 5_000, retryBackoffMs: 20, log: () => {} }));
    await listen(proxy);

    const r = await request(port(proxy));
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":"admitted"}');
    expect(calls).toBe(3); // two 429s absorbed, third admitted — the agent never saw a 429
  });

  it('EI-16883: ABSORBS a boot-window 405 (route table not yet mounted) and returns the eventual 200', async () => {
    let calls = 0;
    const upstream = track(
      http.createServer((_req, res) => {
        calls++;
        if (calls <= 2) {
          // Mid-restart: socket accepts but /api/mcp is not mounted yet → Hono answers 405.
          res.writeHead(405, { 'content-type': 'text/plain' });
          res.end('Method Not Allowed');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"result":"mounted"}');
      }),
    );
    await listen(upstream);
    const proxy = track(createMcpProxy({ listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream), retryWindowMs: 5_000, retryBackoffMs: 20, log: () => {} }));
    await listen(proxy);

    const r = await request(port(proxy));
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":"mounted"}');
    expect(calls).toBe(3); // two boot-window 405s absorbed — the client never saw them
  });

  it('EI-16883: kill-switch (PAPERCUSP_MCP_PROXY_ABSORB_BOOT=0) surfaces the 405 instead of absorbing it', async () => {
    const prev = process.env.PAPERCUSP_MCP_PROXY_ABSORB_BOOT;
    process.env.PAPERCUSP_MCP_PROXY_ABSORB_BOOT = '0';
    try {
      const upstream = track(
        http.createServer((_req, res) => {
          res.writeHead(405, { 'content-type': 'text/plain' });
          res.end('Method Not Allowed');
        }),
      );
      await listen(upstream);
      const proxy = track(createMcpProxy({ listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream), retryWindowMs: 2_000, retryBackoffMs: 20, log: () => {} }));
      await listen(proxy);

      const r = await request(port(proxy));
      expect(r.status).toBe(405);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_MCP_PROXY_ABSORB_BOOT;
      else process.env.PAPERCUSP_MCP_PROXY_ABSORB_BOOT = prev;
    }
  });

  it('P-010: kill-switch (PAPERCUSP_MCP_PROXY_ABSORB_429=0) surfaces the 429 instead of absorbing it', async () => {
    const prev = process.env.PAPERCUSP_MCP_PROXY_ABSORB_429;
    process.env.PAPERCUSP_MCP_PROXY_ABSORB_429 = '0';
    try {
      const upstream = track(
        http.createServer((_req, res) => {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
          res.end('{"error":"shed"}');
        }),
      );
      await listen(upstream);
      const proxy = track(createMcpProxy({ listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream), retryWindowMs: 5_000, retryBackoffMs: 20, log: () => {} }));
      await listen(proxy);
      const r = await request(port(proxy));
      expect(r.status).toBe(429); // forwarded straight through, no absorption
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_MCP_PROXY_ABSORB_429;
      else process.env.PAPERCUSP_MCP_PROXY_ABSORB_429 = prev;
    }
  });

  it('RETRIES a refused upstream and recovers when :3070 comes back (restart invisible)', async () => {
    const targetPort = await freePort(); // nothing listening yet → connection refused
    const proxy = track(createMcpProxy({ listenPort: 0, targetHost: '127.0.0.1', targetPort, retryWindowMs: 5_000, retryBackoffMs: 100, log: () => {} }));
    await listen(proxy);

    // Fire the request while the upstream is DOWN; bring it up ~300ms later.
    const pending = request(port(proxy));
    setTimeout(() => {
      const upstream = track(
        http.createServer((_req, res) => {
          res.writeHead(200);
          res.end('{"result":"recovered"}');
        }),
      );
      void listen(upstream, targetPort);
    }, 300);

    const r = await pending;
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":"recovered"}');
  });

  it('WI-3247: re-resolves a dynamic target between refused retries (packaged operator port changed)', async () => {
    const oldPort = await freePort(); // stale operator.json port: stays down
    const newUpstream = track(
      http.createServer((_req, res) => {
        res.writeHead(200);
        res.end('{"result":"new-port"}');
      }),
    );
    await listen(newUpstream);
    let target: McpProxyTarget = { host: '127.0.0.1', port: oldPort, source: 'operator.json' };
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        resolveTarget: () => target,
        retryWindowMs: 5_000,
        retryBackoffMs: 100,
        log: () => {},
      }),
    );
    await listen(proxy);

    const pending = request(port(proxy));
    setTimeout(() => {
      target = { host: '127.0.0.1', port: port(newUpstream), source: 'operator.json' };
    }, 300);

    const r = await pending;
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":"new-port"}');
  });

  it('exposes proxy-local health without touching the upstream', async () => {
    const targetPort = await freePort(); // down; health should still be proxy-local
    const proxy = track(createMcpProxy({ listenPort: 0, targetHost: '127.0.0.1', targetPort, retryWindowMs: 400, retryBackoffMs: 100, log: () => {} }));
    await listen(proxy);
    const r = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: port(proxy), method: 'GET', path: '/__mcp_proxy_health' }, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(r.status).toBe(200);
    expect(r.body).toContain('"ok":true');
  });

  it('503s (not a hang, not a replay) when the upstream is refused for the whole window', async () => {
    const targetPort = await freePort(); // stays down
    const proxy = track(createMcpProxy({ listenPort: 0, targetHost: '127.0.0.1', targetPort, retryWindowMs: 400, retryBackoffMs: 100, log: () => {} }));
    await listen(proxy);
    const r = await request(port(proxy));
    expect(r.status).toBe(503);
    expect(r.body).toContain('mcp_proxy_upstream_unavailable');
  });

  it('does NOT reuse upstream sockets — a FRESH connection per forward (W1.3 stale-socket-400 guard)', async () => {
    // backend-reliability-100pct-2026-07-03 W1.3: reusing a pooled keep-alive socket to the :3070
    // cluster races the server/worker closing it → a forwarded request lands on a half-closed
    // socket → :3070 returns a spurious `400 Bad Request` the proxy forwards as a tool error
    // (~13% measured). The fix (UPSTREAM_AGENT keepAlive:false) opens a fresh socket per forward.
    // GUARD: sequential requests (where a pooled socket WOULD be reused) must each open a NEW
    // upstream connection — connections === requests. Pre-fix (global keepAlive agent) this is < N.
    let connections = 0;
    const upstream = track(
      http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"result":"ok"}');
      }),
    );
    upstream.on('connection', () => { connections++; });
    await listen(upstream);
    const proxy = track(createMcpProxy({ listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream), retryWindowMs: 5_000, retryBackoffMs: 50, log: () => {} }));
    await listen(proxy);

    const N = 4;
    for (let i = 0; i < N; i++) {
      const r = await request(port(proxy)); // sequential — a pooled keep-alive socket would be reused here
      expect(r.status).toBe(200);
    }
    expect(connections).toBe(N);
  });

  it('RECORDS forwarded failures to the durable JSONL sink (W8 visibility — kills the under-counting)', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const logFile = path.join(os.tmpdir(), `mcp-proxy-fail-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    const prev = process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
    process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = logFile;
    try {
      const targetPort = await freePort(); // nothing listening → refused for the whole window → 503 exhaustion
      const proxy = track(createMcpProxy({ listenPort: 0, targetHost: '127.0.0.1', targetPort, retryWindowMs: 250, retryBackoffMs: 60, log: () => {} }));
      await listen(proxy);
      const r = await request(port(proxy));
      expect(r.status).toBe(503);
      // The exhaustion (previously invisible in tool_invocations) must be durably recorded.
      const recs = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const rec = recs.find((x) => x.kind === 'exhausted_refused');
      expect(rec).toBeTruthy();
      expect(rec.status).toBe(503);
      expect(typeof rec.ts).toBe('string');
      expect(rec.attempts).toBeGreaterThanOrEqual(1);
      fs.rmSync(logFile, { force: true });
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
      else process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = prev;
    }
  });

  it('rotates the durable failure sink before it exceeds the configured ceiling', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const logFile = path.join(os.tmpdir(), `mcp-proxy-rotate-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    const prevPath = process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
    const prevMax = process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG_MAX_BYTES;
    process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = logFile;
    process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG_MAX_BYTES = '32';
    try {
      fs.writeFileSync(logFile, 'x'.repeat(64));
      const targetPort = await freePort();
      const proxy = track(createMcpProxy({ listenPort: 0, targetHost: '127.0.0.1', targetPort, retryWindowMs: 120, retryBackoffMs: 20, log: () => {} }));
      await listen(proxy);
      expect((await request(port(proxy))).status).toBe(503);
      expect(fs.existsSync(`${logFile}.1`)).toBe(true);
      expect(fs.readFileSync(`${logFile}.1`, 'utf8')).toBe('x'.repeat(64));
      expect(fs.readFileSync(logFile, 'utf8')).toContain('"kind":"exhausted_refused"');
    } finally {
      fs.rmSync(logFile, { force: true });
      fs.rmSync(`${logFile}.1`, { force: true });
      if (prevPath === undefined) delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
      else process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = prevPath;
      if (prevMax === undefined) delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG_MAX_BYTES;
      else process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG_MAX_BYTES = prevMax;
    }
  });

  // P-005: an upstream that RESETS the first connection post-connect, then serves.
  function resetOnceUpstream(bodyOut: string): http.Server {
    let hits = 0;
    const s = track(
      http.createServer((req, res) => {
        hits++;
        if (hits === 1) {
          req.socket.destroy(); // post-connect reset (worker-recycle-mid-request class)
          return;
        }
        req.on('data', () => {});
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(bodyOut);
        });
      }),
    );
    (s as http.Server & { hits: () => number }).hits = () => hits;
    return s;
  }
  const TOOLS_CALL = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x","arguments":{}}}';

  function withKeyedRetry(v: string | undefined, fn: () => Promise<void>): () => Promise<void> {
    return async () => {
      const prev = process.env.PAPERCUSP_MCP_PROXY_KEYED_RETRY;
      if (v === undefined) delete process.env.PAPERCUSP_MCP_PROXY_KEYED_RETRY;
      else process.env.PAPERCUSP_MCP_PROXY_KEYED_RETRY = v;
      try {
        await fn();
      } finally {
        if (prev === undefined) delete process.env.PAPERCUSP_MCP_PROXY_KEYED_RETRY;
        else process.env.PAPERCUSP_MCP_PROXY_KEYED_RETRY = prev;
      }
    };
  }

  it(
    'a KEYED tools/call does not replay after a post-connect reset while the first execution may still be running',
    withKeyedRetry('1', async () => {
      const upstream = resetOnceUpstream('{"result":"keyed-recovered"}') as http.Server & { hits: () => number };
      await listen(upstream);
      const proxy = track(createMcpProxy({ listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream), retryWindowMs: 5_000, retryBackoffMs: 40, log: () => {} }));
      await listen(proxy);
      const r = await request(port(proxy), TOOLS_CALL);
      expect(r.status).toBe(502);
      expect(r.body).toContain('mcp_proxy_upstream_error');
      expect(upstream.hits()).toBe(1);
    }),
  );

  it(
    'P-005: an idempotent method (tools/list) retries post-connect EVEN with keying disabled — the toolless-session fix',
    withKeyedRetry('0', async () => {
      const upstream = resetOnceUpstream('{"result":{"tools":[]}}') as http.Server & { hits: () => number };
      await listen(upstream);
      const proxy = track(createMcpProxy({ listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream), retryWindowMs: 5_000, retryBackoffMs: 40, log: () => {} }));
      await listen(proxy);
      const r = await request(port(proxy), '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
      expect(r.status).toBe(200);
      expect(upstream.hits()).toBe(2);
    }),
  );

  it(
    'P-005: with keying DISABLED a tools/call does NOT retry post-connect → 502 (write-safety preserved)',
    withKeyedRetry('0', async () => {
      const upstream = resetOnceUpstream('{"result":"should-not-reach"}') as http.Server & { hits: () => number };
      await listen(upstream);
      const proxy = track(createMcpProxy({ listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream), retryWindowMs: 2_000, retryBackoffMs: 40, log: () => {} }));
      await listen(proxy);
      const r = await request(port(proxy), TOOLS_CALL);
      expect(r.status).toBe(502);
      expect(r.body).toContain('mcp_proxy_upstream_error');
      expect(upstream.hits()).toBe(1); // opaque → not replayed
    }),
  );

  // EI-21268234394605529: the reported failure — build:typecheck (read-only) died with
  // "read ECONNRESET after connecting; attempts=1, retries=0". A read-only tools/call must
  // now absorb ONE post-connect reset and succeed instead of surfacing a 502.
  it(
    'EI-21268234394605529: a READ-ONLY tools/call retries once after a post-connect reset',
    async () => {
      const upstream = resetOnceUpstream('{"result":"readonly-recovered"}') as http.Server & { hits: () => number };
      await listen(upstream);
      const proxy = track(createMcpProxy({ listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream), retryWindowMs: 5_000, retryBackoffMs: 40, log: () => {} }));
      await listen(proxy);
      const r = await request(port(proxy), '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"build:typecheck","arguments":{}}}');
      expect(r.status).toBe(200);
      expect(upstream.hits()).toBe(2);
    },
  );

  it(
    'EI-21268234394605529: PAPERCUSP_MCP_PROXY_READONLY_RETRY=0 restores 502 surfacing (kill-switch)',
    async () => {
      const prev = process.env.PAPERCUSP_MCP_PROXY_READONLY_RETRY;
      process.env.PAPERCUSP_MCP_PROXY_READONLY_RETRY = '0';
      try {
        const upstream = resetOnceUpstream('{"result":"should-not-reach"}') as http.Server & { hits: () => number };
        await listen(upstream);
        const proxy = track(createMcpProxy({ listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream), retryWindowMs: 2_000, retryBackoffMs: 40, log: () => {} }));
        await listen(proxy);
        const r = await request(port(proxy), '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"build:typecheck","arguments":{}}}');
        expect(r.status).toBe(502);
        expect(r.body).toContain('mcp_proxy_upstream_error');
        expect(upstream.hits()).toBe(1);
      } finally {
        if (prev === undefined) delete process.env.PAPERCUSP_MCP_PROXY_READONLY_RETRY;
        else process.env.PAPERCUSP_MCP_PROXY_READONLY_RETRY = prev;
      }
    },
  );

  it('WI-41045: rereads the rotated bearer before a post-connect retry', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tokenPath = path.join(os.tmpdir(), `mcp-proxy-token-rotate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(tokenPath, 'token-one\n');
    let hits = 0;
    const upstream = track(
      http.createServer((req, res) => {
        hits++;
        if (hits === 1) {
          expect(req.headers.authorization).toBe('Bearer token-one');
          // Rotate after the first attempt has authenticated, before its retry.
          fs.writeFileSync(tokenPath, 'token-two\n');
          req.socket.destroy();
          return;
        }
        expect(req.headers.authorization).toBe('Bearer token-two');
        req.on('data', () => {});
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"result":"fresh-token"}');
        });
      }),
    );
    try {
      await listen(upstream);
      const proxy = track(
        createMcpProxy({
          listenPort: 0,
          targetHost: '127.0.0.1',
          targetPort: port(upstream),
          retryWindowMs: 5_000,
          retryBackoffMs: 20,
          superuserTokenPath: tokenPath,
          log: () => {},
        }),
      );
      await listen(proxy);

      const r = await request(
        port(proxy),
        '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        '/api/mcp?superuser=1',
        { authorization: 'Bearer stale-client-token' },
      );
      expect(r.status).toBe(200);
      expect(r.body).toBe('{"result":"fresh-token"}');
      expect(hits).toBe(2);
    } finally {
      fs.rmSync(tokenPath, { force: true });
    }
  });
});

/**
 * WI-6740 — upstream SILENCE.
 *
 * The suite above pins every way upstream can FAIL: refused, socket reset, 429, boot
 * status. None of them covers upstream going QUIET, and that gap is precisely why the
 * bug shipped: with no timeout on the forward, a stalled :3070 produced no error, so no
 * retry path ran, the proxy waited forever, and the CLIENT timed out — permanently
 * tool-dark for the rest of that session (269 occurrences 2026-07-10 → 2026-08-01).
 */
describe('WI-6740: upstream silence — bounded + replayed for the handshake, never for a tools/call', () => {
  const A_TOOLS_CALL = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x","arguments":{}}}';

  it('replays a STALLED handshake and returns the eventual 200 (a client would have gone dark)', async () => {
    let calls = 0;
    const upstream = track(
      http.createServer((_req, res) => {
        calls++;
        // First forward: accept the connection and then say NOTHING — the exact shape of
        // the ~10s :3070 stalls. No error is ever emitted, so only a timeout can catch it.
        if (calls === 1) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"result":"catalog"}');
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream),
        retryWindowMs: 5_000, retryBackoffMs: 20, handshakeTimeoutMs: 150, log: () => {},
      }),
    );
    await listen(proxy);

    // Default body carries no tools/call → 'idempotent', i.e. the initialize/tools/list class.
    const r = await request(port(proxy));
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":"catalog"}');
    expect(calls).toBe(2); // stalled once, replayed once
  });

  it('does NOT bound a tools/call — a slow long-running tool still succeeds', async () => {
    // The anti-regression for the fix itself: build:typecheck legitimately runs ~160s and
    // capability:bash ~120s on this box, so applying the handshake timeout to a real tool
    // call would convert working long tools into hard failures.
    const upstream = track(
      http.createServer((_req, res) => {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"result":"slow-but-fine"}');
        }, 300); // 2× the handshake timeout below
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream),
        retryWindowMs: 5_000, retryBackoffMs: 20, handshakeTimeoutMs: 150, log: () => {},
      }),
    );
    await listen(proxy);

    const r = await request(port(proxy), A_TOOLS_CALL);
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":"slow-but-fine"}');
  });

  it('surfaces honestly (502) without falling through to post-connect replay when the stall outlives the replay budget', async () => {
    let calls = 0;
    const upstream = track(http.createServer(() => {
      calls++;
      /* silent forever */
    }));
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream),
        retryWindowMs: 5_000, retryBackoffMs: 10, handshakeTimeoutMs: 60, log: () => {},
      }),
    );
    await listen(proxy);

    const r = await request(port(proxy));
    expect(r.status).toBe(502); // bounded: an error the client can act on, not an infinite wait
    // Two dedicated timeout retries produce three total attempts. The exhausted timeout must
    // not fall through to postConnectRetryable and create a fourth attempt.
    expect(calls).toBe(MAX_HANDSHAKE_TIMEOUT_RETRIES + 1);
    expect(JSON.parse(r.body).attempts).toBe(MAX_HANDSHAKE_TIMEOUT_RETRIES + 1);
  });

  it('handshakeTimeoutRetryable — idempotent only, bounded, in-window (pure)', () => {
    expect(handshakeTimeoutRetryable('idempotent', 0, MAX_HANDSHAKE_TIMEOUT_RETRIES, 0, 5_000)).toBe(true);
    // A batch carrying a tools/call may ALREADY have applied its side effect upstream —
    // silence tells us nothing about whether it ran, so it must never be replayed.
    expect(handshakeTimeoutRetryable('opaque', 0, MAX_HANDSHAKE_TIMEOUT_RETRIES, 0, 5_000)).toBe(false);
    expect(handshakeTimeoutRetryable('keyed', 0, MAX_HANDSHAKE_TIMEOUT_RETRIES, 0, 5_000)).toBe(false);
    // EI-21268234394605529: 'readonly' is deliberately NOT handshake-timeout-retryable —
    // its members legitimately run minutes (~160s typecheck), so they ride maxHoldMs and
    // must never inherit this 8s control-plane bound.
    expect(handshakeTimeoutRetryable('readonly', 0, MAX_HANDSHAKE_TIMEOUT_RETRIES, 0, 5_000)).toBe(false);
    expect(handshakeTimeoutRetryable('idempotent', MAX_HANDSHAKE_TIMEOUT_RETRIES, MAX_HANDSHAKE_TIMEOUT_RETRIES, 0, 5_000)).toBe(false);
    expect(handshakeTimeoutRetryable('idempotent', 0, MAX_HANDSHAKE_TIMEOUT_RETRIES, 6_000, 5_000)).toBe(false);
  });
});

// EI-19294517824914302: a cheap repeating beat must NOT inherit the restart-sized retry
// window. Measured on the dev box: 13,330 of 13,754 proxy failures in 90 minutes were the
// bootstrap-su heartbeat alone, with SUCCESSES recording attempts:30 / elapsedMs:42361 —
// ~30x amplification on the highest-frequency path in the system.
describe('EI-19294517824914302: cheap repeating beats fail fast instead of amplifying', () => {
  it('classifies the liveness beats, and only those (pure)', () => {
    expect(isCheapRepeatingBeat('/api/agent-mcp/console/bootstrap-su/heartbeat')).toBe(true);
    expect(isCheapRepeatingBeat('/api/admin/owner-presence/touch')).toBe(true);
    // WI-35737 — the per-turn memory-injection pair joined the set. This assertion USED to
    // pin `turn-start-memory` as false; that was not a deliberate exclusion, it was simply
    // the roster as first seeded, and encoding it as "and only those" made a membership
    // GAP look like a settled decision. See the classifier's doc comment: membership is the
    // PROPERTY (high-frequency + soft failure + replacement already scheduled), not a fixed
    // list, and mid-turn-context met it while sitting outside the roster for weeks.
    expect(isCheapRepeatingBeat('/api/agent-mcp/mid-turn-context')).toBe(true);
    expect(isCheapRepeatingBeat('/api/agent-mcp/turn-start-memory')).toBe(true);
    // The MCP control plane keeps the long window — a client fetches the catalog ONCE per
    // session, so losing that single request is session-fatal (WI-6740). Opposite tradeoff.
    // This is the load-bearing NEGATIVE control: it must stay false, or the cheap-beat cap
    // has silently swallowed the one path whose replay is genuinely worth a restart-sized
    // window, and every test above would still pass.
    expect(isCheapRepeatingBeat('/api/mcp')).toBe(false);
    expect(isCheapRepeatingBeat('/api/agent-mcp/console/bootstrap-su/options')).toBe(false);
  });

  it('tolerates a query string and a trailing slash (pure)', () => {
    expect(isCheapRepeatingBeat('/api/agent-mcp/console/bootstrap-su/heartbeat?client=abc')).toBe(true);
    expect(isCheapRepeatingBeat('/api/agent-mcp/console/bootstrap-su/heartbeat/')).toBe(true);
  });

  it('caps the beat window but never LENGTHENS a window shorter than the cap (pure)', () => {
    expect(effectiveRetryWindowMs('/api/agent-mcp/console/bootstrap-su/heartbeat', 45_000)).toBe(
      CHEAP_REPEATING_BEAT_RETRY_WINDOW_MS,
    );
    expect(effectiveRetryWindowMs('/api/mcp', 45_000)).toBe(45_000);
    // A caller configuring a window TIGHTER than the cap must keep its tighter value.
    expect(effectiveRetryWindowMs('/api/agent-mcp/console/bootstrap-su/heartbeat', 500)).toBe(500);
  });

  it('end-to-end: gives up on a refused upstream in ~2s instead of burning a 30s window', async () => {
    // Bind a port, then close it so connections are REFUSED — the exact shape that produced
    // the observed attempts:30 storm (kind:"upstream_error"/"exhausted_refused").
    const dead = track(http.createServer(() => {}));
    await listen(dead);
    const deadPort = port(dead);
    await new Promise<void>((r) => dead.close(() => r()));

    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: '127.0.0.1',
        targetPort: deadPort,
        retryWindowMs: 30_000, // restart-sized, as in production
        retryBackoffMs: 20,
        log: () => {},
      }),
    );
    await listen(proxy);

    const started = Date.now();
    const r = await request(port(proxy), '{"ownerId":"su-test"}', '/api/agent-mcp/console/bootstrap-su/heartbeat');
    const elapsed = Date.now() - started;

    expect(r.status).toBe(503); // still an honest failure — the beat is just not amplified
    // The whole point: it must abandon the beat rather than retry across the full window.
    expect(elapsed).toBeLessThan(8_000);
    expect(JSON.parse(r.body).windowMs).toBe(CHEAP_REPEATING_BEAT_RETRY_WINDOW_MS);
  }, 20_000);

  /**
   * WI-35737 — the SAME storm, on a path the original fix's roster never covered.
   * `mid-turn-context` is the per-tool-batch memory-injection search: the most expensive
   * endpoint on the box AND one of the highest-frequency. Measured 2026-08-08 16:00-18:12Z
   * while :3070's data plane was stalling, it was 385 of 540 handshake-timeout retries (71%)
   * and 175 of 245 post-connect retries (71%) — i.e. the proxy was spending its scarcest
   * capacity replaying the single most expensive call against the dependency that was failing.
   */
  it('WI-35737: mid-turn-context takes the beat window, not the restart-sized one', async () => {
    const dead = track(http.createServer(() => {}));
    await listen(dead);
    const deadPort = port(dead);
    await new Promise<void>((r) => dead.close(() => r()));

    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: '127.0.0.1',
        targetPort: deadPort,
        retryWindowMs: 30_000,
        retryBackoffMs: 20,
        log: () => {},
      }),
    );
    await listen(proxy);

    const started = Date.now();
    const r = await request(port(proxy), '{"owner":"su-test"}', '/api/agent-mcp/mid-turn-context');
    const elapsed = Date.now() - started;

    expect(r.status).toBe(503);
    expect(elapsed).toBeLessThan(8_000);
    expect(JSON.parse(r.body).windowMs).toBe(CHEAP_REPEATING_BEAT_RETRY_WINDOW_MS);
  }, 20_000);
});

/**
 * WI-35737 — CLIENT-DISCONNECT. The proxy had no client-side liveness signal at all, so once a
 * client gave up (its own timeout, a dead agent session, a watchdog restart) the retry loop kept
 * replaying upstream for a response with nowhere to go — spending capacity on the dead during
 * exactly the upstream-stall windows when capacity is scarcest.
 *
 * ⚠ This is NOT a slot leak; an earlier diagnosis on this item said so and was withdrawn
 * (comment 56302). The in-flight slot is already released at response-header time. What these
 * tests pin is the AMPLIFICATION cut, which is why the CONTROL below is load-bearing: without
 * it, "no replays happened" is equally consistent with "this upstream never replays at all",
 * and the subject test would pass against a proxy that had no disconnect handling whatsoever.
 */
describe('WI-35737: a departed client stops the retry loop', () => {
  /** A silent upstream — accepts the connection, never answers. The measured shape
   *  (`upstream silent for 8000ms (no response headers)`), which is what drives the replays. */
  function silentUpstream(onHit: () => void): http.Server {
    return track(http.createServer(() => onHit()));
  }

  function fireAndForget(p: number, path: string, body: string): http.ClientRequest {
    const r = http.request({ host: '127.0.0.1', port: p, method: 'POST', path });
    r.on('error', () => {}); // a deliberate destroy() surfaces here; not a failure
    r.end(body);
    return r;
  }

  it('CONTROL: while the client stays connected, a silent upstream IS replayed', async () => {
    let hits = 0;
    const upstream = silentUpstream(() => {
      hits++;
    });
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: '127.0.0.1',
        targetPort: port(upstream),
        retryWindowMs: 30_000,
        retryBackoffMs: 10,
        handshakeTimeoutMs: 120, // drive the replay loop fast instead of sleeping 8s
        log: () => {},
      }),
    );
    await listen(proxy);

    // tools/list — no tools/call, so klass 'idempotent': the class that replays on silence.
    const req = fireAndForget(port(proxy), '/api/mcp', '{"jsonrpc":"2.0","method":"tools/list"}');
    await new Promise((r) => setTimeout(r, 900));
    req.destroy();

    // The replay machinery is real and observable — this is what the subject test suppresses.
    expect(hits).toBeGreaterThanOrEqual(3);
  }, 20_000);

  it('SUBJECT: once the client hangs up, no further upstream attempt is started', async () => {
    let hits = 0;
    const upstream = silentUpstream(() => {
      hits++;
    });
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: '127.0.0.1',
        targetPort: port(upstream),
        retryWindowMs: 30_000,
        retryBackoffMs: 10,
        handshakeTimeoutMs: 120,
        log: () => {},
      }),
    );
    await listen(proxy);

    const req = fireAndForget(port(proxy), '/api/mcp', '{"jsonrpc":"2.0","method":"tools/list"}');
    await new Promise((r) => setTimeout(r, 300)); // let 1-2 attempts start
    const hitsAtHangup = hits;
    req.destroy(); // the client gives up — exactly what an agent's MCP client timeout does

    // Well past several more handshake windows: under the old behaviour the loop would have
    // kept replaying for the rest of the 30s window.
    await new Promise((r) => setTimeout(r, 900));
    // +1 tolerance for an attempt already in flight at the instant of the hangup; the point is
    // that the loop STOPS, not that it stops with sub-millisecond precision.
    expect(hits).toBeLessThanOrEqual(hitsAtHangup + 1);
  }, 20_000);
});

/**
 * EI-19305299022434394 — mcp-proxy had no in-flight concurrency bound (`maxSockets:Infinity`)
 * and went completely SILENT under a stalling upstream: 3,450 requests held simultaneously,
 * 106 minutes with zero log lines during the measured outage. Three coupled fixes:
 *  (1) admission control — shed a NEW request with 429 once `maxInFlight` forwards are already
 *      outstanding, BEFORE opening any upstream socket (stops the congestion-collapse loop);
 *  (2) a periodic heartbeat while at least one forward is held open (kills the silence);
 *  (3) `maxHoldMs` — an absolute (generous) ceiling on how long a real tools/call may hold its
 *      socket, so a stalled-but-connected upstream can no longer silently park a socket for
 *      32-89 minutes.
 */
describe('EI-19305299022434394: admission control — shed with 429 before opening an upstream socket', () => {
  it('recognizes the MCP session handshake plus fleet bootstrap, direct coordination, continuation checkpoints, scheduler claims, deferred discovery, bounded diagnostics, loop arming, incident capture, event-wait cancellation, file-lock inspection/cancellation/release, checkpoint writes, work-item inspection/release, and work-item completion as reserved control-plane traffic', () => {
    const call = (name: string) => Buffer.from(JSON.stringify({ method: 'tools/call', params: { name } }));
    expect(isReservedControlPlaneCall(Buffer.from(JSON.stringify({ method: 'initialize', params: {} })))).toBe(true);
    expect(isReservedControlPlaneCall(Buffer.from(JSON.stringify({ method: 'ping', params: {} })))).toBe(true);
    expect(isReservedControlPlaneCall(Buffer.from(JSON.stringify({ method: 'tools/list', params: {} })))).toBe(true);
    expect(isReservedControlPlaneCall(call('scheduler:get_next'))).toBe(true);
    expect(isReservedControlPlaneCall(call('coord:orient'))).toBe(true);
    expect(isReservedControlPlaneCall(call('coord:send'))).toBe(true);
    expect(isReservedControlPlaneCall(call('fleet:assignments'))).toBe(true);
    expect(isReservedControlPlaneCall(call('loop:checkpoint'))).toBe(true);
    expect(isReservedControlPlaneCall(call('session:request-compaction'))).toBe(true);
    expect(isReservedControlPlaneCall(call('tools:find'))).toBe(true);
    expect(isReservedControlPlaneCall(call('dev:service_health'))).toBe(true);
    expect(isReservedControlPlaneCall(call('dev:pg_query'))).toBe(true);
    expect(isReservedControlPlaneCall(call('loop:arm'))).toBe(true);
    expect(isReservedControlPlaneCall(call('improvements:capture'))).toBe(true);
    expect(isReservedControlPlaneCall(call('locks:acquire'))).toBe(true);
    expect(isReservedControlPlaneCall(call('locks:queue'))).toBe(true);
    expect(isReservedControlPlaneCall(call('locks:cancel_wait'))).toBe(true);
    expect(isReservedControlPlaneCall(call('locks:release'))).toBe(true);
    expect(isReservedControlPlaneCall(call('events:cancel'))).toBe(true);
    expect(isReservedControlPlaneCall(call('work_items:checkpoint'))).toBe(true);
    expect(isReservedControlPlaneCall(call('work_items:release'))).toBe(true);
    expect(isReservedControlPlaneCall(call('work_items:complete'))).toBe(true);
    expect(isReservedControlPlaneCall(call('work_items:get'))).toBe(true);
    expect(isReservedControlPlaneCall(Buffer.from(JSON.stringify({ method: 'tools/call', params: { name: 'tools:invoke', arguments: { name: 'tools:find', args: {} } } })))).toBe(true);
    expect(isReservedControlPlaneCall(Buffer.from(JSON.stringify({ method: 'tools/call', params: { name: 'tools:invoke', arguments: { name: 'work_items:list', args: {} } } })))).toBe(false);
    expect(isReservedControlPlaneCall(Buffer.from('{bad json'))).toBe(false);
  });

  it('classifies only an all-handshake JSON-RPC batch for the reconnect bulkhead', () => {
    const body = (value: unknown) => Buffer.from(JSON.stringify(value));
    expect(isMcpSessionHandshakeCall(body({ method: 'initialize', params: {} }))).toBe(true);
    expect(isMcpSessionHandshakeCall(body({ method: 'ping', params: {} }))).toBe(true);
    expect(isMcpSessionHandshakeCall(body({ method: 'tools/list', params: {} }))).toBe(true);
    expect(isMcpSessionHandshakeCall(body([
      { method: 'initialize', params: {} },
      { method: 'tools/list', params: {} },
    ]))).toBe(true);
    expect(isMcpSessionHandshakeCall(body({ method: 'resources/list', params: {} }))).toBe(false);
    expect(isMcpSessionHandshakeCall(body([
      { method: 'tools/list', params: {} },
      { method: 'tools/call', params: { name: 'facts:list' } },
    ]))).toBe(false);
    expect(isMcpSessionHandshakeCall(Buffer.from('{bad json'))).toBe(false);
  });

  it('recognizes only the exact watchdog MCP client path for the diagnostic exemption', () => {
    expect(isMcpProxyWatchdogProbePath('/api/mcp?client=mcp-proxy-watchdog')).toBe(true);
    expect(isMcpProxyWatchdogProbePath('/api/mcp?tools=coord%3Aorient&client=mcp-proxy-watchdog&superuser=1')).toBe(true);
    expect(isMcpProxyWatchdogProbePath('/api/mcp?client=mcp-proxy-watchdog-db')).toBe(false);
    expect(isMcpProxyWatchdogProbePath('/api/health?client=mcp-proxy-watchdog')).toBe(false);
    expect(isMcpProxyWatchdogProbePath(undefined)).toBe(false);
  });

  it('recognizes psu launch/resume REST preflight paths and leaves the repeating heartbeat unreserved', () => {
    const ordinaryBody = Buffer.from(JSON.stringify({ ownerId: 'su-test' }));
    expect(isReservedControlPlanePath('/api/adv/sessions/resumable')).toBe(true);
    expect(isReservedControlPlanePath('/api/adv/sessions/resumable?limit=30')).toBe(true);
    expect(isReservedControlPlanePath('/api/agent-mcp/console/bootstrap-su/options')).toBe(true);
    expect(isReservedControlPlanePath('/api/agent-mcp/console/bootstrap-su/')).toBe(true);
    expect(isReservedControlPlanePath('/api/agent-mcp/console/bootstrap-su/heartbeat')).toBe(false);
    expect(isReservedControlPlaneCall(ordinaryBody, '/api/adv/sessions/resumable')).toBe(true);
    expect(isReservedControlPlaneCall(ordinaryBody, '/api/agent-mcp/console/bootstrap-su/options')).toBe(true);
    expect(isReservedControlPlaneCall(ordinaryBody, '/api/agent-mcp/console/bootstrap-su')).toBe(true);
    expect(isReservedControlPlaneCall(ordinaryBody, '/api/agent-mcp/console/bootstrap-su/heartbeat')).toBe(false);
  });

  it.each([
    ['canonical colon-form', 'scheduler:get_next'],
    ['underscore group/verb form', 'scheduler_get_next'],
    ['Claude MCP-advertised form', 'mcp__papercusp-su__scheduler_get_next'],
    ['MCP-advertised form with underscore server slug', 'mcp__papercusp_su__scheduler_get_next'],
    ['canonical locks:queue form', 'locks:queue'],
    ['canonical bounded PG diagnostic form', 'dev:pg_query'],
    ['underscore bounded PG diagnostic form', 'dev_pg_query'],
    ['Claude MCP-advertised bounded PG diagnostic form', 'mcp__papercusp-su__dev_pg_query'],
    ['MCP-advertised bounded PG diagnostic form with underscore server slug', 'mcp__papercusp_su__dev_pg_query'],
    ['canonical locks:acquire form', 'locks:acquire'],
    ['underscore locks:acquire form', 'locks_acquire'],
    ['Claude MCP-advertised locks:acquire form', 'mcp__papercusp-su__locks_acquire'],
    ['MCP-advertised locks:acquire form with underscore server slug', 'mcp__papercusp_su__locks_acquire'],
    ['underscore locks:queue form', 'locks_queue'],
    ['Claude MCP-advertised locks:queue form', 'mcp__papercusp-su__locks_queue'],
    ['MCP-advertised locks:queue form with underscore server slug', 'mcp__papercusp_su__locks_queue'],
    ['canonical locks:cancel_wait form', 'locks:cancel_wait'],
    ['underscore locks:cancel_wait form', 'locks_cancel_wait'],
    ['Claude MCP-advertised locks:cancel_wait form', 'mcp__papercusp-su__locks_cancel_wait'],
    ['MCP-advertised locks:cancel_wait form with underscore server slug', 'mcp__papercusp_su__locks_cancel_wait'],
    ['canonical events:cancel form', 'events:cancel'],
    ['underscore events:cancel form', 'events_cancel'],
    ['Claude MCP-advertised events:cancel form', 'mcp__papercusp-su__events_cancel'],
    ['MCP-advertised events:cancel form with underscore server slug', 'mcp__papercusp_su__events_cancel'],
    ['canonical checkpoint form', 'work_items:checkpoint'],
    ['underscore checkpoint form', 'work_items_checkpoint'],
    ['Claude MCP-advertised checkpoint form', 'mcp__papercusp-su__work_items_checkpoint'],
    ['MCP-advertised checkpoint form with underscore server slug', 'mcp__papercusp_su__work_items_checkpoint'],
    ['canonical release form', 'work_items:release'],
    ['underscore release form', 'work_items_release'],
    ['Claude MCP-advertised release form', 'mcp__papercusp-su__work_items_release'],
    ['MCP-advertised release form with underscore server slug', 'mcp__papercusp_su__work_items_release'],
    ['canonical completion form', 'work_items:complete'],
    ['underscore completion form', 'work_items_complete'],
    ['Claude MCP-advertised completion form', 'mcp__papercusp-su__work_items_complete'],
    ['MCP-advertised completion form with underscore server slug', 'mcp__papercusp_su__work_items_complete'],
    ['canonical work-item inspection form', 'work_items:get'],
    ['underscore work-item inspection form', 'work_items_get'],
    ['Claude MCP-advertised work-item inspection form', 'mcp__papercusp-su__work_items_get'],
    ['MCP-advertised work-item inspection form with underscore server slug', 'mcp__papercusp_su__work_items_get'],
  ])('normalizes %s before checking the reserved set', (_label, name) => {
    expect(isReservedControlPlaneCall(Buffer.from(JSON.stringify({ method: 'tools/call', params: { name } })))).toBe(true);
  });

  it('does not reserve a similarly named non-control-plane call after normalization', () => {
    expect(isReservedControlPlaneCall(Buffer.from(JSON.stringify({
      method: 'tools/call',
      params: { name: 'mcp__papercusp-su__work_items_list' },
    })))).toBe(false);
  });

  it('recognizes a JSON-RPC batch when any member is a reserved control-plane call', () => {
    expect(isReservedControlPlaneCall(Buffer.from(JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'test://ordinary' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ])))).toBe(true);
  });

  it('does not reserve a JSON-RPC batch with no control-plane calls', () => {
    expect(isReservedControlPlaneCall(Buffer.from(JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'work_items:list' } },
      { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'test://ordinary' } },
    ])))).toBe(false);
  });

  it.each(['scheduler:get_next', 'coord:orient', 'coord:send', 'fleet:assignments', 'loop:checkpoint', 'session:request-compaction', 'tools:find', 'tools:invoke → tools:find', 'dev:service_health', 'dev:pg_query', 'loop:arm', 'improvements:capture', 'locks:acquire', 'locks:queue', 'locks:cancel_wait', 'locks:release', 'events:cancel', 'work_items:checkpoint', 'work_items:get', 'work_items:release', 'work_items:complete'])('admits %s from the reserve while ordinary calls shed', async (controlPlaneTool) => {
    let releaseUpstream: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseUpstream = resolve; });
    const upstream = track(http.createServer((_req, res) => void gate.then(() => res.end('{"result":"ok"}'))));
    await listen(upstream);
    const proxy = track(createMcpProxy({
      listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream),
      retryWindowMs: 5_000, maxInFlight: 2, controlPlaneReserve: 1, log: () => {},
    }));
    await listen(proxy);

    const ordinaryBody = JSON.stringify({ method: 'tools/call', params: { name: 'work_items:list', arguments: {} } });
    const heldOrdinary = request(port(proxy), ordinaryBody);
    await new Promise((r) => setTimeout(r, 40));
    expect((await request(port(proxy), ordinaryBody)).status).toBe(429);

    const wrappedDiscovery = controlPlaneTool === 'tools:invoke → tools:find';
    const controlPlaneBody = JSON.stringify({ method: 'tools/call', params: wrappedDiscovery ? { name: 'tools:invoke', arguments: { name: 'tools:find', args: {} } } : { name: controlPlaneTool, arguments: {} } });
    const heldControlPlane = request(port(proxy), controlPlaneBody);
    await new Promise((r) => setTimeout(r, 40));
    releaseUpstream();
    expect((await heldOrdinary).status).toBe(200);
    expect((await heldControlPlane).status).toBe(200);
  });

  it.each([
    '/api/adv/sessions/resumable',
    '/api/agent-mcp/console/bootstrap-su/options',
    '/api/agent-mcp/console/bootstrap-su',
  ])('admits launcher preflight %s from the reserve while ordinary traffic sheds', async (path) => {
    let releaseUpstream: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseUpstream = resolve; });
    const upstream = track(http.createServer((_req, res) => void gate.then(() => res.end('{"result":"ok"}'))));
    await listen(upstream);
    const proxy = track(createMcpProxy({
      listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream),
      retryWindowMs: 5_000, maxInFlight: 2, controlPlaneReserve: 1, log: () => {},
    }));
    await listen(proxy);

    const ordinaryBody = JSON.stringify({ method: 'tools/call', params: { name: 'work_items:list', arguments: {} } });
    const heldOrdinary = request(port(proxy), ordinaryBody);
    await new Promise((r) => setTimeout(r, 40));
    expect((await request(port(proxy), ordinaryBody)).status).toBe(429);

    const heldPreflight = request(port(proxy), '{}', path);
    await new Promise((r) => setTimeout(r, 40));
    releaseUpstream();
    expect((await heldOrdinary).status).toBe(200);
    expect((await heldPreflight).status).toBe(200);
  });

  it('keeps the full reserved pool available when ordinary traffic reaches its ceiling, then enforces the hard ceiling', async () => {
    let releaseUpstream: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseUpstream = resolve; });
    const upstream = track(http.createServer((_req, res) => void gate.then(() => res.end('{"result":"ok"}'))));
    await listen(upstream);
    const proxy = track(createMcpProxy({
      listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream),
      retryWindowMs: 5_000, maxInFlight: 4, controlPlaneReserve: 2, log: () => {},
    }));
    await listen(proxy);

    const ordinaryBody = JSON.stringify({ method: 'tools/call', params: { name: 'work_items:list', arguments: {} } });
    const heldOrdinary = [request(port(proxy), ordinaryBody), request(port(proxy), ordinaryBody)];
    await new Promise((r) => setTimeout(r, 40));
    expect((await request(port(proxy), ordinaryBody)).status).toBe(429);

    const controlPlaneBody = JSON.stringify({ method: 'tools/call', params: { name: 'locks:acquire', arguments: {} } });
    const heldControlPlane = [request(port(proxy), controlPlaneBody), request(port(proxy), controlPlaneBody)];
    await new Promise((r) => setTimeout(r, 40));
    expect((await request(port(proxy), controlPlaneBody)).status).toBe(429);

    releaseUpstream();
    const results = await Promise.all([...heldOrdinary, ...heldControlPlane]);
    expect(results.every((result) => result.status === 200)).toBe(true);
  });

  it('EI-21266423740643882: tools/list bypasses a saturated ordinary upstream socket queue', async () => {
    let releaseFirstUpstream: () => void = () => {};
    const firstUpstreamGate = new Promise<void>((resolve) => { releaseFirstUpstream = resolve; });
    let upstreamHits = 0;
    const upstream = track(http.createServer((_req, res) => {
      upstreamHits++;
      if (upstreamHits === 1) {
        void firstUpstreamGate.then(() => res.end('{"result":"ordinary-released"}'));
        return;
      }
      res.end('{"result":{"tools":[{"name":"coord:orient"}]}}');
    }));
    await listen(upstream);

    // One ordinary socket is deliberately held. The second ordinary forward is admitted but
    // queues inside that one-socket agent — the scaled-down shape of 192 admitted / 64 sockets.
    const ordinaryAgent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    const controlPlaneAgent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    const proxy = track(createMcpProxy({
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort: port(upstream),
      retryWindowMs: 800,
      retryBackoffMs: 20,
      handshakeTimeoutMs: 80,
      maxInFlight: 3,
      controlPlaneReserve: 1,
      upstreamAgent: ordinaryAgent,
      controlPlaneAgent,
      log: () => {},
    }));
    await listen(proxy);

    const ordinaryBody = JSON.stringify({ method: 'tools/call', params: { name: 'work_items:list', arguments: {} } });
    const heldOrdinary = [request(port(proxy), ordinaryBody), request(port(proxy), ordinaryBody)];
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Without the dedicated pool, this probe sits behind the held ordinary socket, burns its
    // handshake timeouts, and returns 502. With end-to-end reservation it reaches upstream now.
    const probe = await request(
      port(proxy),
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    );

    releaseFirstUpstream();
    const ordinaryResults = await Promise.all(heldOrdinary);
    ordinaryAgent.destroy();
    controlPlaneAgent.destroy();

    expect(probe.status).toBe(200);
    expect(JSON.parse(probe.body).result.tools).toHaveLength(1);
    expect(ordinaryResults.every((result) => result.status === 200)).toBe(true);
  });

  it('EI-21391963810159383: a fresh-proxy reconnect herd is class-bounded and leaves the watchdog a diagnostic socket', async () => {
    const reconnects = 60;
    const handshakeLimit = 3;
    let releaseSilentUpstream: () => void = () => {};
    const silentUpstreamGate = new Promise<void>((resolve) => {
      releaseSilentUpstream = resolve;
    });
    let ordinaryHits = 0;
    let ordinaryActive = 0;
    let maxOrdinaryActive = 0;
    let ordinaryHitsAtWatchdog = -1;

    const upstream = track(http.createServer((req, res) => {
      const client = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('client');
      if (client === 'mcp-proxy-watchdog') {
        ordinaryHitsAtWatchdog = ordinaryHits;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"result":{"tools":[{"name":"coord:orient"}]}}');
        return;
      }

      ordinaryHits++;
      ordinaryActive++;
      maxOrdinaryActive = Math.max(maxOrdinaryActive, ordinaryActive);
      res.once('close', () => {
        ordinaryActive--;
      });
      void silentUpstreamGate.then(() => {
        if (res.destroyed) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"result":{"tools":[{"name":"coord:orient"}]}}');
      });
    }));
    await listen(upstream);

    const controlPlaneAgent = new http.Agent({ keepAlive: false, maxSockets: handshakeLimit + 1 });
    const proxy = track(createMcpProxy({
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort: port(upstream),
      retryWindowMs: 2_000,
      retryBackoffMs: 10,
      // Keep the first admitted class silent long enough for all 57 surplus loopback
      // clients to reach admission before any slot can recycle.
      handshakeTimeoutMs: 1_500,
      maxInFlight: 100,
      controlPlaneReserve: handshakeLimit + 1,
      controlPlaneAgent,
      // Scaled-down production policy: reserve one diagnostic socket outside the class cap.
      maxHandshakeInFlight: handshakeLimit,
      log: () => {},
    }));
    await listen(proxy);

    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const completedBeforeRelease: Array<{ status: number; body: string }> = [];
    const herd = Array.from({ length: reconnects }, (_, i) =>
      request(port(proxy), body, `/api/mcp?client=reconnect-${i}`).then((result) => {
        completedBeforeRelease.push(result);
        return result;
      }),
    );
    const arrivalDeadline = Date.now() + 1_000;
    while (
      completedBeforeRelease.filter((result) => result.status === 429).length < reconnects - handshakeLimit &&
      Date.now() < arrivalDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const shedBeforeRelease = completedBeforeRelease.filter((result) => result.status === 429).length;

    // The proxy's own route stays responsive while the upstream-facing class is saturated.
    expect((await get(port(proxy), MCP_PROXY_LOCAL_HEALTH_PATH)).status).toBe(200);

    // The watchdog's specifically named probe bypasses only the class cap and uses the one
    // socket deliberately left outside it. It must reach upstream before a fourth reconnect.
    const watchdog = await request(
      port(proxy),
      body,
      '/api/mcp?superuser=1&client=mcp-proxy-watchdog&tools=coord%3Aorient',
    );
    expect(watchdog.status).toBe(200);
    expect(ordinaryHitsAtWatchdog).toBe(handshakeLimit);

    releaseSilentUpstream();
    const results = await Promise.all(herd);
    controlPlaneAgent.destroy();

    const shed = results.filter((result) => result.status === 429);
    const admitted = results.filter((result) => result.status === 200);
    expect(shedBeforeRelease).toBe(reconnects - handshakeLimit);
    expect(shed).toHaveLength(reconnects - handshakeLimit);
    expect(admitted).toHaveLength(handshakeLimit);
    expect(shed.every((result) => JSON.parse(result.body).error === 'mcp_proxy_handshake_overloaded')).toBe(true);
    expect(maxOrdinaryActive).toBeLessThanOrEqual(handshakeLimit);
    expect(ordinaryHits).toBeLessThanOrEqual(handshakeLimit * (MAX_HANDSHAKE_TIMEOUT_RETRIES + 1));

    const afterDrain = await request(port(proxy), body, '/api/mcp?client=reconnect-after-drain');
    expect(afterDrain.status).toBe(200);
  }, 10_000);

  it('EI-21391953229965975: watchdog probe bypasses ordinary reserved tools/call socket starvation', async () => {
    let releaseOrdinary: () => void = () => {};
    const ordinaryGate = new Promise<void>((resolve) => {
      releaseOrdinary = resolve;
    });
    let ordinaryStarted: () => void = () => {};
    const ordinaryStartedGate = new Promise<void>((resolve) => {
      ordinaryStarted = resolve;
    });
    const upstream = track(http.createServer((req, res) => {
      const client = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('client');
      if (client === 'mcp-proxy-watchdog') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"result":{"tools":[{"name":"coord:orient"}]}}');
        return;
      }
      ordinaryStarted();
      void ordinaryGate.then(() => {
        if (res.destroyed) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"result":{"ok":true}}');
      });
    }));
    await listen(upstream);

    const controlPlaneAgent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    const watchdogAgent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    const proxy = track(createMcpProxy({
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort: port(upstream),
      retryWindowMs: 1_000,
      retryBackoffMs: 10,
      handshakeTimeoutMs: 100,
      maxInFlight: 10,
      controlPlaneReserve: 1,
      controlPlaneAgent,
      watchdogAgent,
      log: () => {},
    }));
    await listen(proxy);

    const ordinary = request(
      port(proxy),
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'coord:orient', arguments: {} } }),
      '/api/mcp?client=ordinary-control-plane',
    );
    await ordinaryStartedGate;

    const watchdog = request(
      port(proxy),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      '/api/mcp?superuser=1&client=mcp-proxy-watchdog&tools=coord%3Aorient',
    );
    const watchdogBeforeOrdinaryRelease = await Promise.race([
      watchdog,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
    ]);

    expect(watchdogBeforeOrdinaryRelease?.status).toBe(200);
    releaseOrdinary();
    expect((await ordinary).status).toBe(200);
    watchdogAgent.destroy();
    controlPlaneAgent.destroy();
  });

  it('shouldShedForInFlight — sheds at the ceiling, never before it (pure)', () => {
    expect(shouldShedForInFlight(4, 5)).toBe(false);
    expect(shouldShedForInFlight(5, 5)).toBe(true);
    expect(shouldShedForInFlight(500, 5)).toBe(true);
  });

  it('shouldShedForInFlight — maxInFlight <= 0 disables shedding entirely (explicit opt-out)', () => {
    expect(shouldShedForInFlight(1_000_000, 0)).toBe(false);
    expect(shouldShedForInFlight(1_000_000, -1)).toBe(false);
  });

  it('has a bounded, non-Infinity default so shedding is not opt-in by accident', () => {
    expect(DEFAULT_MAX_IN_FLIGHT).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_MAX_IN_FLIGHT)).toBe(true);
    expect(DEFAULT_MAX_HANDSHAKES_IN_FLIGHT).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_MAX_HANDSHAKES_IN_FLIGHT)).toBe(true);
  });

  it('sheds an EXCESS request with 429 the instant maxInFlight is reached, and admits the rest once slots free up', async () => {
    let releaseUpstream: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    const upstream = track(
      http.createServer((_req, res) => {
        void gate.then(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"result":"held-then-ok"}');
        });
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream),
        // This case isolates the hard maxInFlight ceiling. The production default
        // reserves control-plane slots, which would intentionally lower the ordinary
        // admission ceiling below 2 and make the second filler request shed instead.
        retryWindowMs: 5_000, retryBackoffMs: 20, maxInFlight: 2, controlPlaneReserve: 0, log: () => {},
      }),
    );
    await listen(proxy);

    // Fill the 2-slot budget with requests the (gated) upstream will not answer yet.
    const held1 = request(port(proxy));
    const held2 = request(port(proxy));
    await new Promise((r) => setTimeout(r, 80)); // let both register as in-flight

    const shed = await request(port(proxy));
    expect(shed.status).toBe(429);
    expect(JSON.parse(shed.body).error).toBe('mcp_proxy_overloaded');

    releaseUpstream();
    const [r1, r2] = await Promise.all([held1, held2]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // The slots freed on completion — a NEW request now succeeds instead of shedding.
    const after = await request(port(proxy), '{"jsonrpc":"2.0"}');
    // upstream still answers 200 immediately post-gate-release for any further hits.
    expect([200, 429]).toContain(after.status);
  });

  it('maxInFlight:0 (explicit) never sheds, even with many concurrent holds', async () => {
    let releaseUpstream: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    const upstream = track(
      http.createServer((_req, res) => {
        void gate.then(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"result":"ok"}');
        });
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream),
        retryWindowMs: 5_000, retryBackoffMs: 20, maxInFlight: 0, log: () => {},
      }),
    );
    await listen(proxy);

    const pending = [request(port(proxy)), request(port(proxy)), request(port(proxy)), request(port(proxy))];
    await new Promise((r) => setTimeout(r, 80));
    releaseUpstream();
    const results = await Promise.all(pending);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});

describe('EI-19305299022434394: heartbeat — logs while a forward is held open (kills the silence)', () => {
  it('emits a heartbeat log line + durable record while a forward is outstanding, none once it completes', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const logFile = path.join(os.tmpdir(), `mcp-proxy-heartbeat-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    const prev = process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
    process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = logFile;
    try {
      let releaseUpstream: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseUpstream = resolve;
      });
      const upstream = track(
        http.createServer((_req, res) => {
          void gate.then(() => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"result":"ok"}');
          });
        }),
      );
      await listen(upstream);
      const logs: string[] = [];
      const proxy = track(
        createMcpProxy({
          listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream),
          retryWindowMs: 30_000, retryBackoffMs: 20, heartbeatIntervalMs: 30, log: (s) => logs.push(s),
        }),
      );
      await listen(proxy);

      const pending = request(port(proxy));
      await new Promise((r) => setTimeout(r, 140)); // several 30ms heartbeat ticks while held open
      releaseUpstream();
      const r = await pending;
      expect(r.status).toBe(200);

      expect(logs.some((l) => l.includes('heartbeat') && l.includes('in flight'))).toBe(true);
      const recs = fs
        .readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const beat = recs.find((x) => x.kind === 'heartbeat');
      expect(beat).toBeTruthy();
      expect(beat.inFlight).toBeGreaterThanOrEqual(1);
      expect(typeof beat.oldestAgeMs).toBe('number');
      fs.rmSync(logFile, { force: true });
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
      else process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = prev;
    }
  });

  it('EI-19388661789704364: a burst of many FAST (short-lived) overlapping requests never beats — only a genuinely long-held one does', async () => {
    // Reproduces the measured production defect: zero `heartbeat` records across a 30h+/27MB
    // ledger despite `shed_max_in_flight` proving real concurrency spikes occurred. A sampled
    // periodic tick can miss every one of many short overlapping holds by bad luck; the
    // per-request threshold timer must not — it fires only for a request that outlives the
    // interval, regardless of how many fast neighbors it had.
    const upstream = track(
      http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"result":"ok"}');
      }),
    );
    await listen(upstream);
    const logs: string[] = [];
    const proxy = track(
      createMcpProxy({
        listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream),
        retryWindowMs: 5_000, retryBackoffMs: 20, heartbeatIntervalMs: 500, log: (s) => logs.push(s),
      }),
    );
    await listen(proxy);

    // A burst of fast requests, each completing well under the 500ms heartbeat threshold
    // (generous headroom for a loaded CI/fleet box) — none of these should ever produce a
    // heartbeat, however many overlap at once.
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.all([request(port(proxy)), request(port(proxy)), request(port(proxy))]);
    }
    expect(logs.some((l) => l.includes('heartbeat'))).toBe(false);
  });

  it('heartbeatIntervalMs:0 disables the beat entirely (opt-out, no timer leak)', async () => {
    const upstream = track(
      http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"result":"ok"}');
      }),
    );
    await listen(upstream);
    const logs: string[] = [];
    const proxy = track(
      createMcpProxy({
        listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream),
        retryWindowMs: 5_000, retryBackoffMs: 20, heartbeatIntervalMs: 0, log: (s) => logs.push(s),
      }),
    );
    await listen(proxy);
    const r = await request(port(proxy));
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 50));
    expect(logs.some((l) => l.includes('heartbeat'))).toBe(false);
  });
});

describe('EI-19305299022434394: maxHoldMs — a real tools/call is no longer literally unbounded', () => {
  const A_TOOLS_CALL = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x","arguments":{}}}';

  it('an OPAQUE tools/call that stalls past maxHoldMs surfaces honestly (502) instead of hanging forever', async () => {
    const upstream = track(http.createServer(() => { /* accept + say nothing, forever */ }));
    await listen(upstream);
    const prevKeying = process.env.PAPERCUSP_MCP_PROXY_KEYED_RETRY;
    process.env.PAPERCUSP_MCP_PROXY_KEYED_RETRY = '0'; // force 'opaque' so the ceiling is isolated from the retry
    try {
      const proxy = track(
        createMcpProxy({
          listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream),
          retryWindowMs: 5_000, retryBackoffMs: 10, maxHoldMs: 60, log: () => {},
        }),
      );
      await listen(proxy);

      const started = Date.now();
      const r = await request(port(proxy), A_TOOLS_CALL);
      const elapsed = Date.now() - started;
      expect(r.status).toBe(502); // bounded: an honest error the caller can act on
      // The whole point: the ceiling actually cut the hold short, well under the retry window.
      expect(elapsed).toBeLessThan(3_000);
    } finally {
      if (prevKeying === undefined) delete process.env.PAPERCUSP_MCP_PROXY_KEYED_RETRY;
      else process.env.PAPERCUSP_MCP_PROXY_KEYED_RETRY = prevKeying;
    }
  });

  it('a KEYED tools/call that hits the hold ceiling surfaces 502 without overlapping the still-running write', async () => {
    let hits = 0;
    const upstream = track(
      http.createServer((req, res) => {
        hits++;
        if (hits === 1) return; // first attempt: silent until maxHoldMs fires
        req.on('data', () => {});
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"result":"recovered-after-hold-ceiling"}');
        });
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream),
        retryWindowMs: 5_000, retryBackoffMs: 10, maxHoldMs: 60, log: () => {},
      }),
    );
    await listen(proxy);

    const r = await request(port(proxy), A_TOOLS_CALL);
    expect(r.status).toBe(502);
    expect(r.body).toContain('mcp_proxy_upstream_error');
    expect(hits).toBe(1); // never overlaps the first still-running tools/call
  });

  it('does NOT bound a tools/call by DEFAULT — the generous default ceiling leaves a normal slow tool untouched', async () => {
    // Anti-regression companion to the WI-6740 default-unbounded test: confirm the new ceiling
    // (default ~10 min) does not shrink the effective budget for an ordinary slow call.
    const upstream = track(
      http.createServer((_req, res) => {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"result":"slow-but-fine"}');
        }, 300);
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream),
        retryWindowMs: 5_000, retryBackoffMs: 20, log: () => {}, // maxHoldMs unset → generous default
      }),
    );
    await listen(proxy);
    const r = await request(port(proxy), A_TOOLS_CALL);
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":"slow-but-fine"}');
  });

  it('maxHoldMs:0 (explicit) restores literally-unbounded behavior for a tools/call', async () => {
    const upstream = track(
      http.createServer((_req, res) => {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"result":"still-fine"}');
        }, 120);
      }),
    );
    await listen(upstream);
    const proxy = track(
      createMcpProxy({
        listenPort: 0, targetHost: '127.0.0.1', targetPort: port(upstream),
        retryWindowMs: 5_000, retryBackoffMs: 20, maxHoldMs: 0, log: () => {},
      }),
    );
    await listen(proxy);
    const r = await request(port(proxy), A_TOOLS_CALL);
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"result":"still-fine"}');
  });
});
