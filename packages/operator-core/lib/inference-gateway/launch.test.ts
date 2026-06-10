/** Hermetic composition smoke for the gateway service (P-013) — injected account + resolver. */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startGatewayService, type RunningGatewayService } from './launch';

let upstream: http.Server | undefined;
let svc: RunningGatewayService | undefined;

afterEach(async () => {
  await svc?.stop();
  svc = undefined;
  await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  upstream = undefined;
});

async function startUpstream(): Promise<{ base: string; lastAuth: () => string | undefined }> {
  let lastAuth: string | undefined;
  upstream = http.createServer((req, res) => {
    lastAuth = req.headers['authorization'] as string | undefined;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', () => r()));
  const port = (upstream!.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, lastAuth: () => lastAuth };
}

test('startGatewayService composes account → resolver → proxy; /healthz + a proxied request work', async () => {
  const up = await startUpstream();
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccount: async () => ({ accountId: 'test-acct', credentialRef: 'token:/dev/null', source: 'env' }),
    makeResolver: () => ({ kind: 'token', current: async () => 'bound-token', invalidate: () => {} }),
    observePool: () => () => {},
  });

  const health = await fetch(`http://127.0.0.1:${svc.port}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { accountId: string }).accountId, 'test-acct');

  const res = await fetch(`http://127.0.0.1:${svc.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  assert.equal(up.lastAuth(), 'Bearer bound-token', 'gateway injected the bound account token');
});
