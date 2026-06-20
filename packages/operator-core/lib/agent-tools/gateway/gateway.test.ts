/**
 * gateway.test.ts — the gateway:* tool HANDLERS (B-GWCTL): thin HTTP wrappers over the running
 * gateway's /admin/config + /admin/reload. A mock gateway stands in for :8788 (via PAPERCUSP_GATEWAY_PORT).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/gateway/gateway.test.ts
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gatewayStatusTool, gatewayReloadTool } from './gateway';

let server: http.Server | undefined;
const prevPort = process.env.PAPERCUSP_GATEWAY_PORT;

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  if (prevPort === undefined) delete process.env.PAPERCUSP_GATEWAY_PORT;
  else process.env.PAPERCUSP_GATEWAY_PORT = prevPort;
});

const body = (o: unknown) => JSON.parse((o as { content: { text: string }[] }).content[0]!.text);

test('gateway:status reads /admin/config; gateway:reload POSTs /admin/reload (B-GWCTL round-trip)', async () => {
  let reloadHit = false;
  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/admin/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 3, accounts: ['a', 'b'] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/admin/reload') {
      reloadHit = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, changed: true, version: 4, accounts: ['a', 'b', 'c'] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  process.env.PAPERCUSP_GATEWAY_PORT = String((server!.address() as { port: number }).port);

  const s = body(await gatewayStatusTool.handler({} as never, {} as never));
  assert.equal(s.ok, true);
  assert.equal(s.version, 3);
  assert.deepEqual(s.accounts, ['a', 'b']);

  const rl = body(await gatewayReloadTool.handler({} as never, {} as never));
  assert.equal(rl.ok, true);
  assert.equal(rl.changed, true);
  assert.equal(rl.version, 4);
  assert.deepEqual(rl.accounts, ['a', 'b', 'c']);
  assert.equal(reloadHit, true, 'gateway:reload actually POSTed /admin/reload');
});

test('gateway:status fails SOFT (never throws) when the gateway is unreachable', async () => {
  process.env.PAPERCUSP_GATEWAY_PORT = '1'; // nothing listening → connection refused
  const s = body(await gatewayStatusTool.handler({} as never, {} as never));
  assert.equal(s.ok, false);
  assert.ok(String(s.error).includes('unreachable'), 'reports an unreachable gateway, not a crash');
});
