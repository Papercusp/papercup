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

async function boot(entries: LocalBackend[], extraDeps: Partial<GatewayDeps> = {}) {
  pool = createLocalBackendPool(entries);
  gw = createInferenceGateway({ ...stubAccount, localBackends: pool, ...extraDeps });
  port = await gw.listen(0);
}

const chatCompletions = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const chatCompletionsAs = (ownerId: string, body: unknown) => chatCompletions(body, { [OWNER_HEADER]: ownerId });

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

test('a local-backend body stream that ERRORS mid-pipe does NOT crash the gateway (W2.2 crash-proofing guard)', async () => {
  // backend-reliability-100pct-2026-07-03 W2.2: the upstream body is piped to the client via
  // Readable.fromWeb(...).pipe(res). If that stream errors mid-body with NO 'error' listener,
  // Node throws it as an uncaughtException → the WHOLE shared gateway process dies (observed
  // 2026-07-02). This "bad" backend sends a 200 + partial body then RSTs the socket, forcing the
  // piped stream to error mid-flight. GUARD: the gateway must survive and still serve a LATER
  // request (pre-fix, this test crashes the worker; post-fix it is green).
  const bad = await startFakeBackend('bad', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"partial":true,'); // partial body — never completes
    setTimeout(() => { try { res.socket?.destroy(); } catch { /* gone */ } }, 20); // RST mid-stream
  });
  const good = await startFakeBackend('good', okJsonReply({ id: 'from-good' }));
  backends = [bad, good];
  await boot([
    { id: 'bad', kind: 'llama-server', baseUrl: bad.baseUrl, models: ['m-bad'], maxConcurrent: 4, enabled: true },
    { id: 'good', kind: 'llama-server', baseUrl: good.baseUrl, models: ['m-good'], maxConcurrent: 4, enabled: true },
  ]);

  // Hit the bad backend — its body stream errors mid-pipe. The client may see a reset/partial
  // response; that is acceptable. What must NOT happen is a process crash.
  await chatCompletions({ model: 'm-bad', messages: [] }).catch(() => undefined);

  // The gateway is still up: a subsequent request to a healthy backend succeeds.
  const res2 = await chatCompletions({ model: 'm-good', messages: [] });
  assert.equal(res2.status, 200, 'gateway survived the mid-pipe stream error and served a later request');
  const json = (await res2.json()) as { id: string };
  assert.equal(json.id, 'from-good');
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

// ---------------------------------------------------------------------------------------------
// Per-CLIENT circuit breaker (local-concurrent-inference-2026-07-02 P-015, D-010) — protects the
// shared local-backend pool from one storming/wedged owner. See local-backend-client-circuit.ts.
// ---------------------------------------------------------------------------------------------

test('per-client in-flight cap sheds a storming owner with 429 + retry-after, without touching the backend — a DIFFERENT owner is unaffected', async () => {
  const held: http.ServerResponse[] = [];
  const b1 = await startFakeBackend('b1', (_req, res) => {
    held.push(res); // never end() — keeps requests "in flight" from the pool's perspective
  });
  backends = [b1];
  await boot([{ id: 'b1', kind: 'llama-server', baseUrl: b1.baseUrl, models: ['m'], maxConcurrent: 8, enabled: true }], {
    localBackendClientMaxInFlight: 1,
  });

  // Owner A's first request is admitted and hangs (never resolves) — occupies its one allowed slot.
  const inflightA = chatCompletionsAs('owner-a', { model: 'm' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(pool.inFlight('b1'), 1);

  // Owner A's SECOND concurrent request is shed by the in-flight cap — never reaches the backend.
  const shedRes = await chatCompletionsAs('owner-a', { model: 'm' });
  assert.equal(shedRes.status, 429);
  assert.ok(shedRes.headers.get('retry-after'));
  const shedJson = (await shedRes.json()) as { error: { message: string } };
  assert.match(shedJson.error.message, /in-flight cap/);
  assert.equal(pool.inFlight('b1'), 1); // unchanged — the shed never touched the backend

  // A DIFFERENT owner is unaffected — its request is admitted normally onto the same backend.
  const inflightB = chatCompletionsAs('owner-b', { model: 'm' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(pool.inFlight('b1'), 2);

  held.forEach((res) => res.writeHead(200, { 'content-type': 'application/json' }));
  held.forEach((res) => res.end('{}'));
  await Promise.all([inflightA, inflightB]);
});

test('a saturated pool (model served, every slot busy) 429s with retry-after — retryable backpressure, NOT a 502 dead end', async () => {
  const held: http.ServerResponse[] = [];
  const b1 = await startFakeBackend('b1', (_req, res) => {
    held.push(res); // never end() — occupies the backend's one slot
  });
  backends = [b1];
  // A single-slot backend: once one request is in flight, the pool is saturated for 'm'.
  await boot([{ id: 'b1', kind: 'llama-server', baseUrl: b1.baseUrl, models: ['m'], maxConcurrent: 1, enabled: true }]);

  // Occupy the one slot with a hanging request (unidentified caller — isolates POOL saturation from
  // the per-client circuit entirely).
  const inflight = chatCompletions({ model: 'm' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(pool.inFlight('b1'), 1);

  // A second request for the SAME (served, healthy) model finds every slot busy → 429 + Retry-After,
  // NOT a 502: the model is reachable, just at capacity, so the caller should back off and retry
  // rather than treat it as a hard server error (D-010/D-012 graceful load-shed).
  const busy = await chatCompletions({ model: 'm' });
  assert.equal(busy.status, 429);
  assert.ok(busy.headers.get('retry-after'));
  const busyJson = (await busy.json()) as { error: { message: string } };
  assert.match(busyJson.error.message, /at capacity/);
  assert.equal(pool.inFlight('b1'), 1); // the shed never touched the backend

  held.forEach((res) => res.writeHead(200, { 'content-type': 'application/json' }));
  held.forEach((res) => res.end('{}'));
  await inflight;
});

test('per-client failure-streak circuit opens after repeated no-reachable-backend failures, sheds fast, isolates other owners, and self-closes after the cooldown', async () => {
  await boot([{ id: 'dead', kind: 'llama-server', baseUrl: 'http://127.0.0.1:1', models: ['m'], maxConcurrent: 4, enabled: true }], {
    localBackendClientFailureThreshold: 2,
    localBackendClientCooldownMs: 100,
  });

  // Two failed (no-reachable-backend) requests trip owner-a's circuit (threshold 2).
  assert.equal((await chatCompletionsAs('owner-a', { model: 'm' })).status, 502);
  assert.equal((await chatCompletionsAs('owner-a', { model: 'm' })).status, 502);

  // The THIRD request is shed immediately by the now-OPEN circuit — the backend is never touched
  // (its recorded health failure count does not advance).
  const failuresBefore = pool.health().get('dead')?.consecutiveFailures ?? 0;
  const shed = await chatCompletionsAs('owner-a', { model: 'm' });
  assert.equal(shed.status, 429);
  const shedJson = (await shed.json()) as { error: { message: string } };
  assert.match(shedJson.error.message, /circuit open/);
  assert.equal(pool.health().get('dead')?.consecutiveFailures ?? 0, failuresBefore);

  // A DIFFERENT owner is NOT gated by owner-a's open circuit (per-owner isolation) — its request is
  // genuinely ATTEMPTED (502 from the dead backend, not a 429 shed).
  assert.equal((await chatCompletionsAs('owner-b', { model: 'm' })).status, 502);

  // After the cooldown elapses, owner-a's circuit self-closes and the next request is attempted again.
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await chatCompletionsAs('owner-a', { model: 'm' })).status, 502); // attempted, not shed
});

test('an unidentified caller (no owner header) is never gated by the per-client circuit, even after repeated failures', async () => {
  await boot([{ id: 'dead', kind: 'llama-server', baseUrl: 'http://127.0.0.1:1', models: ['m'], maxConcurrent: 4, enabled: true }], {
    localBackendClientFailureThreshold: 1,
    localBackendClientCooldownMs: 60_000,
  });
  for (let i = 0; i < 4; i++) {
    const res = await chatCompletions({ model: 'm' }); // no x-papercusp-owner header
    assert.equal(res.status, 502); // always genuinely attempted — never 429-shed
  }
});

test('a caller-input error (no "model" field) does not trip the owner circuit — it is the caller\'s own mistake, not a pool wedge', async () => {
  await boot([{ id: 'dead', kind: 'llama-server', baseUrl: 'http://127.0.0.1:1', models: ['m'], maxConcurrent: 4, enabled: true }], {
    localBackendClientFailureThreshold: 1,
  });
  const res = await chatCompletionsAs('owner-a', {}); // no "model" field
  assert.equal(res.status, 400);
  // A genuinely failing request right after should still be ATTEMPTED (502), not pre-emptively shed
  // by a circuit the 400 should never have tripped.
  assert.equal((await chatCompletionsAs('owner-a', { model: 'm' })).status, 502);
});

test('GET /admin/local-backends reports per-client circuit state for an owner with recorded activity', async () => {
  await boot([{ id: 'dead', kind: 'llama-server', baseUrl: 'http://127.0.0.1:1', models: ['m'], maxConcurrent: 4, enabled: true }], {
    localBackendClientFailureThreshold: 5,
  });
  assert.equal((await chatCompletionsAs('owner-a', { model: 'm' })).status, 502);

  const adminRes = await fetch(`http://127.0.0.1:${port}/admin/local-backends`);
  const json = (await adminRes.json()) as {
    clients: { ownerId: string; consecutiveFailures: number; inFlight: number; circuitOpen: boolean }[];
  };
  const entry = json.clients.find((c) => c.ownerId === 'owner-a');
  assert.ok(entry, 'owner-a should appear in the clients list after a failed request');
  assert.equal(entry!.consecutiveFailures, 1);
  assert.equal(entry!.inFlight, 0);
  assert.equal(entry!.circuitOpen, false);
});

test('GET /admin/local-backends omits an owner with no recorded activity (clean owners are not listed)', async () => {
  const b1 = await startFakeBackend('b1', okJsonReply({ id: 'ok' }));
  backends = [b1];
  await boot([{ id: 'b1', kind: 'llama-server', baseUrl: b1.baseUrl, models: ['m'], maxConcurrent: 4, enabled: true }]);
  assert.equal((await chatCompletionsAs('owner-a', { model: 'm' })).status, 200);

  const adminRes = await fetch(`http://127.0.0.1:${port}/admin/local-backends`);
  const json = (await adminRes.json()) as { clients: { ownerId: string }[] };
  assert.equal(json.clients.find((c) => c.ownerId === 'owner-a'), undefined);
});
