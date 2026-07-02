/**
 * Behavioral tests for the gateway's LOCAL backend proxy route
 * (local-concurrent-inference-2026-07-02 P-004, D-002): `/v1/chat/completions` routing to a
 * registered llama-server/vllm/ollama backend, least-loaded selection across siblings, in-request
 * failover on a dead backend, and the admin visibility/reload routes. Real HTTP servers stand in
 * for the local backends (no PG — the pool is fed directly via createLocalBackendPool/reload()).
 */
import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createInferenceGateway, OWNER_HEADER, type GatewayDeps } from './gateway';
import { createLocalBackendPool, type LocalBackend, type LocalBackendPool } from './local-backend-pool';

interface FakeBackend {
  id: string;
  server: http.Server;
  baseUrl: string;
  requests: { url?: string; body: string }[];
  close: () => Promise<void>;
}

async function startFakeBackend(
  id: string,
  reply: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<FakeBackend> {
  const requests: FakeBackend['requests'] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ url: req.url, body });
      reply(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  return { id, server, baseUrl: `http://127.0.0.1:${addr.port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}

const okJsonReply = (payload: unknown) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

let backends: FakeBackend[] = [];
let pool: LocalBackendPool;
let gw: ReturnType<typeof createInferenceGateway>;
let port = 0;

afterEach(async () => {
  await gw?.close();
  await Promise.all(backends.map((b) => b.close()));
  backends = [];
});

/** The gateway requires SOME account routing config even when a test only exercises the
 *  local-backend path (it never reaches the account/token code for those routes). */
const stubAccount = { accountId: 'unused-stub', token: async () => 'unused' };

async function boot(entries: LocalBackend[]) {
  pool = createLocalBackendPool(entries);
  gw = createInferenceGateway({ ...stubAccount, localBackends: pool });
  port = await gw.listen(0);
}

const chatCompletions = (body: unknown) =>
  fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('routes a matching model to the registered local backend', async () => {
  const b1 = await startFakeBackend('b1', okJsonReply({ id: 'chatcmpl-1', choices: [] }));
  backends = [b1];
  await boot([{ id: 'b1', kind: 'llama-server', baseUrl: b1.baseUrl, models: ['ornith-35b'], maxConcurrent: 4, enabled: true }]);

  const res = await chatCompletions({ model: 'ornith-35b', messages: [] });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { id: string };
  assert.equal(json.id, 'chatcmpl-1');
  assert.equal(b1.requests.length, 1);
  assert.equal(b1.requests[0].url, '/v1/chat/completions');
});

test('an unregistered model 502s with no reachable backend, not a hang or a crash', async () => {
  await boot([]);
  const res = await chatCompletions({ model: 'unknown-model', messages: [] });
  assert.equal(res.status, 502);
  const json = (await res.json()) as { error: { message: string } };
  assert.match(json.error.message, /no reachable local backend/);
});

test('a non-JSON / model-less body 400s', async () => {
  await boot([]);
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
  assert.equal(res.status, 400);
});

test('least-loaded routing: sends the next request to the LESS busy backend', async () => {
  // b1 never responds (simulates a busy/slow backend held mid-flight); b2 replies fast.
  const held: http.ServerResponse[] = [];
  const b1 = await startFakeBackend('b1', (req, res) => {
    held.push(res); // never end() — keeps the request "in flight" from the pool's perspective
  });
  const b2 = await startFakeBackend('b2', okJsonReply({ id: 'from-b2' }));
  backends = [b1, b2];
  await boot([
    { id: 'b1', kind: 'llama-server', baseUrl: b1.baseUrl, models: ['m'], maxConcurrent: 4, enabled: true },
    { id: 'b2', kind: 'llama-server', baseUrl: b2.baseUrl, models: ['m'], maxConcurrent: 4, enabled: true },
  ]);

  // Fire one request that will hang on b1 (don't await — it stays in-flight).
  const inflight = chatCompletions({ model: 'm' });
  await new Promise((r) => setTimeout(r, 50)); // let it land + recordStart tick
  assert.equal(pool.inFlight('b1'), 1);

  // The NEXT request should route to b2 (b1 is busier).
  const res2 = await chatCompletions({ model: 'm' });
  assert.equal(res2.status, 200);
  const json2 = (await res2.json()) as { id: string };
  assert.equal(json2.id, 'from-b2');

  // Clean up the held request so afterEach can close cleanly.
  held.forEach((res) => res.writeHead(200, { 'content-type': 'application/json' }));
  held.forEach((res) => res.end('{}'));
  await inflight;
});

test('in-request failover: a dead backend is skipped in favor of a healthy sibling on the SAME request', async () => {
  const b2 = await startFakeBackend('b2', okJsonReply({ id: 'from-healthy-sibling' }));
  backends = [b2];
  await boot([
    // b1 points at a closed port — connection refused.
    { id: 'b1', kind: 'llama-server', baseUrl: 'http://127.0.0.1:1', models: ['m'], maxConcurrent: 4, enabled: true },
    { id: 'b2', kind: 'llama-server', baseUrl: b2.baseUrl, models: ['m'], maxConcurrent: 4, enabled: true },
  ]);

  const res = await chatCompletions({ model: 'm' });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { id: string };
  assert.equal(json.id, 'from-healthy-sibling');
  // The dead backend's failed attempt was recorded (feeds health demotion for FUTURE requests).
  assert.ok((pool.health().get('b1')?.consecutiveFailures ?? 0) >= 1);
});

test('a disabled backend is never selected even though it is registered', async () => {
  const b1 = await startFakeBackend('b1', okJsonReply({ id: 'should-not-be-called' }));
  backends = [b1];
  await boot([{ id: 'b1', kind: 'llama-server', baseUrl: b1.baseUrl, models: ['m'], maxConcurrent: 4, enabled: false }]);
  const res = await chatCompletions({ model: 'm' });
  assert.equal(res.status, 502);
  assert.equal(b1.requests.length, 0);
});

test('GET /admin/local-backends reports the live registry + health + in-flight', async () => {
  const b1 = await startFakeBackend('b1', okJsonReply({}));
  backends = [b1];
  await boot([{ id: 'b1', kind: 'llama-server', baseUrl: b1.baseUrl, models: ['m'], maxConcurrent: 4, enabled: true }]);
  const res = await fetch(`http://127.0.0.1:${port}/admin/local-backends`);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { configured: boolean; backends: { id: string; inFlight: number }[] };
  assert.equal(json.configured, true);
  assert.equal(json.backends.length, 1);
  assert.equal(json.backends[0].id, 'b1');
  assert.equal(json.backends[0].inFlight, 0);
});

test('GET /admin/local-backends without a configured pool reports configured:false, not a crash', async () => {
  gw = createInferenceGateway({ ...stubAccount });
  port = await gw.listen(0);
  const res = await fetch(`http://127.0.0.1:${port}/admin/local-backends`);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { configured: boolean };
  assert.equal(json.configured, false);
});

test('POST /admin/reload folds onAdminReloadLocalBackends into the response when wired', async () => {
  await boot([]);
  gw.close && (await gw.close());
  let reloadCalls = 0;
  pool = createLocalBackendPool([]);
  gw = createInferenceGateway({
    ...stubAccount,
    localBackends: pool,
    onAdminReload: async () => ({ changed: false, version: 1, accounts: [] }),
    onAdminReloadLocalBackends: async () => {
      reloadCalls++;
      return { changed: true, count: 2 };
    },
  });
  port = await gw.listen(0);
  const res = await fetch(`http://127.0.0.1:${port}/admin/reload`, { method: 'POST' });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { localBackends: { changed: boolean; count: number } };
  assert.equal(reloadCalls, 1);
  assert.deepEqual(json.localBackends, { changed: true, count: 2 });
});

test('/v1/messages (Anthropic path) is unaffected by an unmatched local-backend pool — falls through untouched', async () => {
  await boot([{ id: 'b1', kind: 'llama-server', baseUrl: 'http://127.0.0.1:1', models: ['some-local-model'], maxConcurrent: 4, enabled: true }]);
  // No accountId/token/pool wired, so the Anthropic path errors internally rather than local-backend-routing —
  // proving `/v1/messages` never gets intercepted by the local-backend branch (distinct route namespace).
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'some-local-model', messages: [] }),
  });
  assert.notEqual(res.status, 502); // NOT routed through proxyLocal's "no reachable backend" path
});
