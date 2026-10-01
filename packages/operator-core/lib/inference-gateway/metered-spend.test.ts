/**
 * Metered spend visibility (anthropic-credits-gateway-2026-09-30 P-009). Drives the REAL gateway against a
 * mock upstream that streams Anthropic SSE (message_start usage + a closing message_delta output count) and
 * answers each credential with its own billing headers, then reads the gateway's own `/stats` — no real spend.
 *
 *   R-29  each served Claude request is recorded under its billing class (included | usage-credits | api-credits);
 *   R-30  /stats reports per-account metered token totals (usage-credits + api-credits), and the pool-wide sum;
 *   R-31  /stats reports each pool account's current billing state.
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createInferenceGateway, ACCOUNT_HEADER, ROUTED_ACCOUNT_HEADER, type GatewayStats } from './gateway';
import type { ActiveAccount } from './provider-contracts';
import { createFailoverPool } from './account-failover';
import { resetGovernorRegistry } from '@papercusp/papercusp-shared/agent';

const resetIn1h = (): string => String(Math.floor(Date.now() / 1000) + 3600);
const INCLUDED = { 'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-reset': resetIn1h() };
const OVERAGE = {
  'anthropic-ratelimit-unified-status': 'rejected',
  'anthropic-ratelimit-unified-overage-status': 'allowed',
  'anthropic-ratelimit-unified-overage-in-use': 'true',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-reset': resetIn1h(),
};

/** Per credential: billing headers + the usage its streamed response reports. */
const USAGE: Record<string, { headers: Record<string, string>; input: number; read: number; create: number; output: number }> = {
  tokA: { headers: INCLUDED, input: 7, read: 70, create: 3, output: 11 },
  tokB: { headers: OVERAGE, input: 10, read: 100, create: 5, output: 42 },
  'sk-keyC': { headers: {}, input: 20, read: 0, create: 8, output: 30 },
};

function sse(u: { input: number; read: number; create: number; output: number }): string {
  const start = { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-4-99',
    content: [], usage: { input_tokens: u.input, cache_read_input_tokens: u.read, cache_creation_input_tokens: u.create, output_tokens: 1 } } };
  return [
    `event: message_start\ndata: ${JSON.stringify(start)}\n\n`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":${u.output}}}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  ].join('');
}

function credentialOf(req: http.IncomingMessage): string {
  const key = req.headers['x-api-key'];
  if (typeof key === 'string' && key) return key;
  return String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
}

let gw: ReturnType<typeof createInferenceGateway> | undefined;
let server: http.Server | undefined;

afterEach(async () => {
  await gw?.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  gw = undefined;
  server = undefined;
});

async function boot(accounts: ActiveAccount[]): Promise<number> {
  server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const u = USAGE[credentialOf(req)];
      if (!u) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"authentication_error","message":"unknown"}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', ...u.headers });
      // Two writes, split mid-line, so the closing usage straddles a chunk boundary.
      const body = sse(u);
      const cut = body.indexOf('"output_tokens":' + u.output) + 5;
      res.write(body.slice(0, cut));
      setTimeout(() => res.end(body.slice(cut)), 5);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  resetGovernorRegistry();
  gw = createInferenceGateway({ pool: createFailoverPool(accounts), upstreamBase: base, maxQueueWaitMs: 200 });
  return gw.listen(0);
}

const oauth = (id: string, tok: string, extra: Partial<ActiveAccount> = {}): ActiveAccount => ({
  accountId: id, token: async () => tok, invalidateToken: () => {}, ...extra,
});
const apiKey = (id: string, key: string): ActiveAccount => ({
  accountId: id, token: async () => key, invalidateToken: () => {}, authMode: 'api-key',
});

async function fire(port: number, account: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [ACCOUNT_HEADER]: account },
    body: JSON.stringify({ model: 'claude-opus-4-99', max_tokens: 4, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  await res.text();
  expect(res.status).toBe(200);
  expect(res.headers.get(ROUTED_ACCOUNT_HEADER)).toBe(account);
}

/** /stats once every served request's closing output count has been tallied (it lands at stream end). */
async function billingStats(port: number, servedRequests: number): Promise<GatewayStats['billing']> {
  let billing: GatewayStats['billing'] | undefined;
  for (let i = 0; i < 50; i++) {
    billing = ((await (await fetch(`http://127.0.0.1:${port}/stats`)).json()) as GatewayStats).billing;
    const outputs = Object.values(billing.byAccount)
      .flatMap((a) => Object.values(a.classes))
      .reduce((n, t) => n + (t?.outputKnown ?? 0), 0);
    if (outputs >= servedRequests) return billing;
    await new Promise((r) => setTimeout(r, 20));
  }
  return billing!;
}

describe('metered spend visibility (P-009)', () => {
  const pool = (): ActiveAccount[] => [oauth('incA', 'tokA'), oauth('ovB', 'tokB'), apiKey('keyC', 'sk-keyC'), oauth('idleD', 'tokD')];

  it('R-29: each served Claude request records its billing class', async () => {
    const port = await boot(pool());
    await fire(port, 'incA');
    await fire(port, 'incA');
    await fire(port, 'ovB');
    await fire(port, 'keyC');
    const b = await billingStats(port, 4);
    expect(b.byAccount.incA.classes).toEqual({ included: expect.objectContaining({ requests: 2 }) });
    expect(b.byAccount.ovB.classes).toEqual({ 'usage-credits': expect.objectContaining({ requests: 1 }) });
    expect(b.byAccount.keyC.classes).toEqual({ 'api-credits': expect.objectContaining({ requests: 1 }) });
    expect(b.byAccount.idleD.classes).toEqual({});
  });

  it('R-30: gateway stats report per-account metered token totals', async () => {
    const port = await boot(pool());
    await fire(port, 'incA');
    await fire(port, 'ovB');
    await fire(port, 'ovB');
    await fire(port, 'keyC');
    const b = await billingStats(port, 4);
    const tally = (requests: number, u: (typeof USAGE)[string]) => ({
      requests, inputTokens: u.input * requests, cacheReadTokens: u.read * requests, cacheCreationTokens: u.create * requests,
      outputTokens: u.output * requests, usageKnown: requests, outputKnown: requests,
    });
    // Included allowance is tallied but is NOT metered spend.
    expect(b.byAccount.incA.classes.included).toEqual(tally(1, USAGE.tokA));
    expect(b.byAccount.incA.metered.requests).toBe(0);
    expect(b.byAccount.ovB.metered).toEqual(tally(2, USAGE.tokB));
    expect(b.byAccount.keyC.metered).toEqual(tally(1, USAGE['sk-keyC']));
    expect(b.metered).toEqual({
      requests: 3,
      inputTokens: 2 * USAGE.tokB.input + USAGE['sk-keyC'].input,
      cacheReadTokens: 2 * USAGE.tokB.read + USAGE['sk-keyC'].read,
      cacheCreationTokens: 2 * USAGE.tokB.create + USAGE['sk-keyC'].create,
      outputTokens: 2 * USAGE.tokB.output + USAGE['sk-keyC'].output,
      usageKnown: 3,
      outputKnown: 3,
    });
  });

  it('R-31: gateway stats report each account current billing state', async () => {
    const port = await boot([...pool().slice(0, 3), oauth('idleD', 'tokD', { meteredPolicy: 'never' })]);
    await fire(port, 'incA');
    await fire(port, 'ovB');
    await fire(port, 'keyC');
    const b = await billingStats(port, 3);
    expect(b.byAccount.incA).toMatchObject({ state: 'included', meteredNow: false, authMode: 'oauth', meteredPolicy: 'overflow' });
    expect(b.byAccount.incA.stateUntil).toBeGreaterThan(Date.now());
    expect(b.byAccount.ovB).toMatchObject({ state: 'usage-credits', meteredNow: true, authMode: 'oauth' });
    expect(b.byAccount.keyC).toMatchObject({ state: 'api-credits', meteredNow: true, authMode: 'api-key' });
    expect(b.byAccount.keyC.stateUntil).toBeUndefined();
    // A pool account that has served nothing yet still has a row — its state is honestly unknown.
    expect(b.byAccount.idleD).toMatchObject({ state: 'unknown', meteredNow: false, meteredPolicy: 'never', classes: {} });
  });
});
