/**
 * proxy.test.ts — the transparent Anthropic cache proxy (P-006).
 *
 * The load-bearing properties: credentials pass through VERBATIM (this is not an account
 * substitution), the body rewrite applies only to cacheable paths, streaming is preserved,
 * and a rewrite never costs a request.
 *
 * Run: npm run test:file -- apps/operator/lib/cache-proxy/proxy.test.ts
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createCacheProxy, isCacheableAnthropicPath } from './proxy';

const servers: http.Server[] = [];
function track<T extends http.Server>(s: T): T {
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function listen(s: http.Server): Promise<void> {
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r()));
}
function port(s: http.Server): number {
  return (s.address() as AddressInfo).port;
}

function request(
  p: number,
  opts: { path?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body ?? '';
    const r = http.request(
      { host: '127.0.0.1', port: p, path: opts.path ?? '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) } },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }));
      },
    );
    r.on('error', reject);
    r.end(payload);
  });
}

/** An upstream stub that records exactly what the proxy forwarded. */
function upstreamEcho(): { server: http.Server; seen: { headers: http.IncomingHttpHeaders; body: string; path: string }[] } {
  const seen: { headers: http.IncomingHttpHeaders; body: string; path: string }[] = [];
  const server = track(
    http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        seen.push({ headers: req.headers, body: b, path: req.url ?? '' });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    }),
  );
  return { server, seen };
}

describe('cache-proxy — credential passthrough (D-005: NOT an account substitution)', () => {
  it('forwards Authorization, anthropic-version and anthropic-beta VERBATIM', async () => {
    const up = upstreamEcho();
    await listen(up.server);
    const proxy = track(createCacheProxy({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: port(up.server), upstreamInsecure: true, log: () => {} }));
    await listen(proxy);

    await request(port(proxy), {
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [] }),
      headers: {
        authorization: 'Bearer sk-ant-oat-ORIGINAL',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });

    expect(up.seen[0].headers.authorization).toBe('Bearer sk-ant-oat-ORIGINAL');
    expect(up.seen[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(up.seen[0].headers['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  it('rewrites the host header to the upstream (TLS/vhost correctness)', async () => {
    const up = upstreamEcho();
    await listen(up.server);
    const proxy = track(createCacheProxy({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: port(up.server), upstreamInsecure: true, log: () => {} }));
    await listen(proxy);
    await request(port(proxy), { body: '{}' });
    expect(up.seen[0].headers.host).toBe('127.0.0.1');
  });
});

describe('cache-proxy — body policy', () => {
  it('applies the ttl + tools breakpoint on /v1/messages', async () => {
    const up = upstreamEcho();
    await listen(up.server);
    const proxy = track(createCacheProxy({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: port(up.server), upstreamInsecure: true, log: () => {} }));
    await listen(proxy);

    await request(port(proxy), {
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        tools: [{ name: 'a' }, { name: 'b' }],
        system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }],
        messages: [],
      }),
    });

    const fwd = JSON.parse(up.seen[0].body);
    expect(fwd.system[0].cache_control.ttl).toBe('1h');
    expect(fwd.tools[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(Number(up.seen[0].headers['content-length'])).toBe(Buffer.byteLength(up.seen[0].body));
  });

  it('leaves non-cacheable paths untouched (count_tokens, batches, models)', async () => {
    expect(isCacheableAnthropicPath('/v1/messages')).toBe(true);
    expect(isCacheableAnthropicPath('/v1/messages?beta=true')).toBe(true);
    expect(isCacheableAnthropicPath('/v1/messages/count_tokens')).toBe(false);
    expect(isCacheableAnthropicPath('/v1/messages/batches')).toBe(false);
    expect(isCacheableAnthropicPath('/v1/models')).toBe(false);

    const up = upstreamEcho();
    await listen(up.server);
    const proxy = track(createCacheProxy({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: port(up.server), upstreamInsecure: true, log: () => {} }));
    await listen(proxy);
    const original = JSON.stringify({ model: 'claude-opus-4-8', tools: [{ name: 'a' }] });
    await request(port(proxy), { path: '/v1/messages/count_tokens', body: original });
    expect(up.seen[0].body).toBe(original); // byte-identical
  });

  it('kill-switch (PAPERCUSP_CACHE_POLICY=0) forwards the body byte-identically', async () => {
    const prev = process.env.PAPERCUSP_CACHE_POLICY;
    process.env.PAPERCUSP_CACHE_POLICY = '0';
    try {
      const up = upstreamEcho();
      await listen(up.server);
      const proxy = track(createCacheProxy({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: port(up.server), upstreamInsecure: true, log: () => {} }));
      await listen(proxy);
      const original = JSON.stringify({ model: 'claude-opus-4-8', tools: [{ name: 'a' }] });
      await request(port(proxy), { body: original });
      expect(up.seen[0].body).toBe(original);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_CACHE_POLICY;
      else process.env.PAPERCUSP_CACHE_POLICY = prev;
    }
  });

  it('a malformed body still forwards (a rewrite never costs a request)', async () => {
    const up = upstreamEcho();
    await listen(up.server);
    const proxy = track(createCacheProxy({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: port(up.server), upstreamInsecure: true, log: () => {} }));
    await listen(proxy);
    const r = await request(port(proxy), { body: '{not-json' });
    expect(r.status).toBe(200);
    expect(up.seen[0].body).toBe('{not-json');
  });
});

describe('cache-proxy — transport behavior', () => {
  it('streams an SSE response through chunk-for-chunk', async () => {
    const up = track(
      http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message_start\ndata: {"a":1}\n\n');
        setTimeout(() => {
          res.write('event: message_stop\ndata: {}\n\n');
          res.end();
        }, 10);
      }),
    );
    await listen(up);
    const proxy = track(createCacheProxy({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: port(up), upstreamInsecure: true, log: () => {} }));
    await listen(proxy);
    const r = await request(port(proxy), { body: JSON.stringify({ model: 'claude-opus-4-8', stream: true }) });
    expect(r.headers['content-type']).toBe('text/event-stream');
    expect(r.body).toContain('message_start');
    expect(r.body).toContain('message_stop');
  });

  it('surfaces an unreachable upstream as 502 (client retries own it)', async () => {
    const dead = track(http.createServer(() => {}));
    await listen(dead);
    const deadPort = port(dead);
    await new Promise<void>((r) => dead.close(() => r()));

    const proxy = track(createCacheProxy({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: deadPort, upstreamInsecure: true, log: () => {} }));
    await listen(proxy);
    const r = await request(port(proxy), { body: '{}' });
    expect(r.status).toBe(502);
    expect(JSON.parse(r.body).error.type).toBe('api_error');
  });

  it('answers the health endpoint locally without touching upstream', async () => {
    const up = upstreamEcho();
    await listen(up.server);
    const proxy = track(createCacheProxy({ listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: port(up.server), upstreamInsecure: true, log: () => {} }));
    await listen(proxy);
    const r = await request(port(proxy), { path: '/__cache_proxy_health' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).ok).toBe(true);
    expect(up.seen.length).toBe(0);
  });
});
