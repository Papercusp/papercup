/**
 * Resilient MCP proxy tests (P-005). Pins the load-bearing safety invariant
 * (retry ONLY a refused/pre-connect upstream — never replay a call that may have
 * reached :3070, so a non-idempotent tools/call is never double-applied) plus the
 * passthrough + refused-then-recovers behavior against in-process stub upstreams.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { shouldRetry, createMcpProxy, type McpProxyTarget } from './proxy';

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
function request(p: number, body = '{"jsonrpc":"2.0"}'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: p, method: 'POST', path: '/api/mcp' }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

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
});
