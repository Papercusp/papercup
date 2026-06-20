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

test('reloadPool HOT-SWAPS the account pool from the DB source-of-truth, no restart (B-HOT-1)', async () => {
  const up = await startUpstream();
  // The "DB" the gateway re-resolves on reload: starts [a, b], later flips to [a, c, d].
  let dbPool = [
    { accountId: 'a', credentialRef: 'token:/a', source: 'pool' as const },
    { accountId: 'b', credentialRef: 'token:/b', source: 'pool' as const },
  ];
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts: async () => dbPool,
    makeResolver: (_ref, id) => ({ kind: 'token', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0, // disable the auto-poll; drive reloadPool() deterministically
  });

  assert.equal(svc.configVersion(), 1);
  // No DB change → reload is a no-op (same signature), version unchanged.
  const noop = await svc.reloadPool();
  assert.equal(noop.changed, false, 'an unchanged pool does not swap');
  assert.equal(svc.configVersion(), 1, 'version unchanged on a no-op reload');

  // The DB pool changes: 'b' removed, 'c' + 'd' added.
  dbPool = [
    { accountId: 'a', credentialRef: 'token:/a', source: 'pool' as const },
    { accountId: 'c', credentialRef: 'token:/c', source: 'pool' as const },
    { accountId: 'd', credentialRef: 'token:/d', source: 'pool' as const },
  ];
  const changed = await svc.reloadPool();
  assert.equal(changed.changed, true, 'a real DB change hot-reloads');
  assert.equal(svc.configVersion(), 2, 'config version bumped on a real swap');
  assert.deepEqual([...changed.accounts].sort(), ['a', 'c', 'd']);

  // PROOF the swap is LIVE with NO restart: pin a request to 'd' — an account that only exists AFTER the
  // reload — and assert its token reaches the upstream. (Impossible unless the live pool was swapped.)
  const res = await fetch(`http://127.0.0.1:${svc.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-account': 'd' },
    body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  assert.equal(up.lastAuth(), 'Bearer d-tok', 'a hot-reload-ADDED account serves live — pool swapped without a restart');
});

test('/admin/config + /admin/reload expose the live config + on-demand hot-reload (B-HOT-2)', async () => {
  const up = await startUpstream();
  let dbPool = [
    { accountId: 'a', credentialRef: 'token:/a', source: 'pool' as const },
    { accountId: 'b', credentialRef: 'token:/b', source: 'pool' as const },
  ];
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts: async () => dbPool,
    makeResolver: (_ref, id) => ({ kind: 'token', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  const base = `http://127.0.0.1:${svc.port}`;

  // GET /admin/config reflects the live pool.
  const c1 = (await (await fetch(`${base}/admin/config`)).json()) as { version: number; accounts: string[] };
  assert.equal(c1.version, 1);
  assert.deepEqual([...c1.accounts].sort(), ['a', 'b']);

  // Change the DB pool, then trigger an ON-DEMAND reload over HTTP.
  dbPool = [
    { accountId: 'a', credentialRef: 'token:/a', source: 'pool' as const },
    { accountId: 'c', credentialRef: 'token:/c', source: 'pool' as const },
  ];
  const r = await fetch(`${base}/admin/reload`, { method: 'POST' });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { ok: boolean; changed: boolean; version: number; accounts: string[] };
  assert.equal(body.ok, true);
  assert.equal(body.changed, true);
  assert.equal(body.version, 2);
  assert.deepEqual([...body.accounts].sort(), ['a', 'c']);

  // GET /admin/config now reflects the reloaded pool — no restart.
  const c2 = (await (await fetch(`${base}/admin/config`)).json()) as { version: number; accounts: string[] };
  assert.equal(c2.version, 2);
  assert.deepEqual([...c2.accounts].sort(), ['a', 'c']);
});
