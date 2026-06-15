/**
 * End-to-end multi-account routing (multi-account-routing-verification P-003): the FULL chain
 * "a bee lands on the right account with budget", which was only unit-tested per-leg before —
 *
 *   selectAccountForSpawn (deployment/account-pool: cache-affinity + harness binding, Queen-independent)
 *     → gatewaySpawnEnv (emits the x-papercusp-account routing header into the spawn env)
 *     → the live gateway (createInferenceGateway over a failover pool) routes that header to the
 *       BOUND credential, injects its OAuth Bearer, and STRIPS the internal header before upstream.
 *
 * Uses a mock upstream (a localhost http server capturing the forwarded request) — NO real spend,
 * runnable as an ordinary vitest (the live-spend pacing runner stays load-test.ts). gateway.test.ts
 * already covers the gateway leg with a manually-set header; this asserts the SELECTION + HEADER
 * EMISSION legs feed it, so the whole path is locked.
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createInferenceGateway, ACCOUNT_HEADER, type ActiveAccount } from './gateway';
import { createFailoverPool } from './account-failover';
import { gatewaySpawnEnv } from './spawn-env';
import { bindAccount, emptyPool, registerAccount, selectAccountForSpawn, type AccountPool } from '../deployment/account-pool';

const T0 = 1_700_000_000_000;

interface Upstream {
  base: string;
  last: { headers: http.IncomingHttpHeaders; body: string };
  close: () => Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  const last: Upstream['last'] = { headers: {}, body: '' };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      last.headers = req.headers;
      last.body = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  return { base: `http://127.0.0.1:${addr.port}`, last, close: () => new Promise((r) => server.close(() => r())) };
}

const gwAcct = (id: string, tok: string): ActiveAccount => ({ accountId: id, token: async () => tok, invalidateToken: () => {} });

/** Parse the `ANTHROPIC_CUSTOM_HEADERS` env the claude CLI forwards (newline-separated `Name: Value`). */
function parseCustomHeaders(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (env.ANTHROPIC_CUSTOM_HEADERS ?? '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

/** Deployment-side selection pool: acctA (older) + acctB bound to harness-x. */
function selectionPool(): AccountPool {
  let p = emptyPool();
  p = registerAccount(p, { id: 'acctA', credentialRef: 'token:~/.papercusp/acctA' }, T0);
  p = registerAccount(p, { id: 'acctB', credentialRef: 'token:~/.papercusp/acctB' }, T0 + 1);
  return bindAccount(p, 'acctB', 'harness-x');
}

let gw: ReturnType<typeof createInferenceGateway> | undefined;
let upstream: Upstream | undefined;

afterEach(async () => {
  await gw?.close();
  await upstream?.close();
  gw = undefined;
  upstream = undefined;
});

/** Boot the gateway over a 2-account failover pool pointed at the mock upstream; return its port. */
async function bootGateway(): Promise<number> {
  upstream = await startUpstream();
  gw = createInferenceGateway({
    pool: createFailoverPool([gwAcct('acctA', 'tokA'), gwAcct('acctB', 'tokB')]),
    upstreamBase: upstream.base,
    maxQueueWaitMs: 200,
  });
  return gw.listen(0);
}

async function fireBee(port: number, env: Record<string, string>): Promise<void> {
  const routed = parseCustomHeaders(env);
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...routed },
    body: JSON.stringify({ model: 'claude-opus-4-99', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
  });
}

describe('multi-account routing — end-to-end (selection → spawn header → gateway → bound credential)', () => {
  it('routes a harness-x bee through its BOUND account (acctB) and strips the internal header upstream', async () => {
    const pool = selectionPool();

    // 1. SELECTION (Queen-independent): harness-x is bound to acctB.
    const accountId = selectAccountForSpawn(pool, T0, { harness: 'harness-x' });
    expect(accountId).toBe('acctB');

    // 2. SPAWN ENV emits the x-papercusp-account routing header.
    const env = gatewaySpawnEnv(true, { accountId });
    expect(parseCustomHeaders(env)[ACCOUNT_HEADER]).toBe('acctB');

    // 3. GATEWAY routes that header to acctB's credential + strips it before the upstream forward.
    const port = await bootGateway();
    await fireBee(port, env);
    expect(upstream!.last.headers['authorization']).toBe('Bearer tokB');
    expect(upstream!.last.headers[ACCOUNT_HEADER]).toBeUndefined();
  });

  it('a second same-harness bee shares the SAME account (cache-affinity) → same credential', async () => {
    const pool = selectionPool();
    const a1 = selectAccountForSpawn(pool, T0, { harness: 'harness-x' });
    const a2 = selectAccountForSpawn(pool, T0 + 5_000, { harness: 'harness-x' });
    expect(a2).toBe(a1); // deterministic harness co-location
    const port = await bootGateway();
    await fireBee(port, gatewaySpawnEnv(true, { accountId: a2 }));
    expect(upstream!.last.headers['authorization']).toBe('Bearer tokB');
  });

  it('a bee in an UNBOUND harness egresses through the budget-drain pick (acctA)', async () => {
    const pool = selectionPool();
    const accountId = selectAccountForSpawn(pool, T0, { harness: 'other-harness' });
    expect(accountId).toBe('acctA'); // no binding → oldest-added / budget-drain order
    const port = await bootGateway();
    await fireBee(port, gatewaySpawnEnv(true, { accountId }));
    expect(upstream!.last.headers['authorization']).toBe('Bearer tokA');
    expect(upstream!.last.headers[ACCOUNT_HEADER]).toBeUndefined();
  });
});
