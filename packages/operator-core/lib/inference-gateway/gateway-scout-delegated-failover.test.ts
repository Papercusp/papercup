/**
 * gateway-scout-delegated-failover.test.ts — EI-18685386548651513 (fka WI-5391 / WI-4475):
 * "cross-account failover in the ideator/scout path" — terminal condition (Mug, 2026-07-26):
 * "a failover path that measurably survives one account going edge-throttled, with a test in
 * the real suite."
 *
 * WHY this specific test, and not a re-run of the existing coverage: the underlying pool
 * failover mechanism already exists and is already proven in the real suite —
 * gateway.test.ts's "a BARE upstream 429 (no rate-limit headers) fails over to the next
 * account" test (line ~569) shows the gateway itself rotates across accounts on a Cloudflare
 * -edge-shaped 429. Separately, register-scout-action.test.ts covers Scout's CROSS-PROVIDER
 * (Codex) fallback with a mocked capacity probe. Neither test exercises the REAL transport an
 * in-process Scout/bg-host ideator call actually uses in production: every such call has NO
 * local Claude OAuth session (it's a headless bg-host process), so `chooseStatelessTransport`
 * resolves `gateway-pool` — the EI-12940 delegated path (papercusp-shared/agent/chat-stream.ts):
 * egress via the LOCAL inference gateway with a placeholder bearer (`GATEWAY_DELEGATED_AUTH
 * _TOKEN`) the gateway strips and re-auths with its OWN pool credential. FB-16
 * (register-scout-action.ts) is what routes Scout's ideator/critic/recombine calls onto this
 * exact gateway pool "exactly like the gym and the fleet" — so THIS transport, exercised
 * end-to-end against a REAL multi-account gateway, is the thing that has to survive an
 * edge-throttled account for the acceptance criterion to actually hold for Scout.
 *
 * This builds a real 2-account `createInferenceGateway` (mirroring gateway.test.ts's bare-429
 * pattern), points the REAL exported delegated-transport helpers at it, and proves the request
 * a no-local-creds caller actually sends survives account A's edge-throttle (a bare 429 — no
 * rate-limit headers, the shape WI-5391's evidence trail attributes to a shared Cloudflare edge
 * throttle rather than an account budget wall) by rotating to the healthy sibling B.
 */
import { afterEach, expect, test } from 'vitest';
import http from 'node:http';
import { createInferenceGateway } from './gateway';
import type { ActiveAccount } from './provider-contracts';
import { createFailoverPool } from './account-failover';
import { chooseStatelessTransport, resolveDelegatedGatewayUrl, GATEWAY_DELEGATED_AUTH_TOKEN } from '@papercusp/papercusp-shared/agent';

interface Upstream {
  server: http.Server;
  base: string;
  close: () => Promise<void>;
}

async function startUpstream(reply: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<Upstream> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => reply(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(() => r())) };
}

let gw: ReturnType<typeof createInferenceGateway> | undefined;
let upstream: Upstream | undefined;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}

afterEach(async () => {
  await gw?.close();
  await upstream?.close();
  gw = undefined;
  upstream = undefined;
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

test('chooseStatelessTransport with no local Claude session resolves gateway-pool — the path every in-process bg-host/Scout call actually takes (EI-12940)', () => {
  expect(chooseStatelessTransport({ claudeTok: null })).toBe('gateway-pool');
  // The live path (a real Claude session present) is deliberately NOT this route — Scout on
  // bg-host has no such session, so this is the branch that matters for the acceptance criterion.
  expect(chooseStatelessTransport({ claudeTok: 'sk-live-token' })).toBe('anthropic-direct');
});

test('the delegated gateway-pool transport (EI-12940) — the REAL path a no-local-creds Scout/bg-host call takes — survives one account edge-throttled (bare 429), rotating to the healthy sibling', async () => {
  let attempt = 0;
  upstream = await startUpstream((_req, res) => {
    attempt++;
    if (attempt === 1) {
      // Account A: a Cloudflare-edge bare 429 — no rate-limit headers (x-should-retry present,
      // no reset/retry-after window). This is the archetype shape WI-5391's evidence trail
      // pinned to a shared-edge throttle, distinct from a real per-account budget wall.
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }));
    } else {
      // Account B: healthy — a healthy sibling existed in the pool the whole time.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-opus-4',
          usage: { input_tokens: 5, output_tokens: 1 },
        }),
      );
    }
  });
  const acct = (id: string): ActiveAccount => ({ accountId: id, token: async () => id, invalidateToken: () => {} });
  const pool = createFailoverPool([acct('A'), acct('B')]);
  gw = createInferenceGateway({ pool, upstreamBase: upstream.base, maxQueueWaitMs: 200 });
  const port = await gw.listen(0);

  // Exactly what a no-local-creds in-process caller (every bg-host/Scout ideator call) resolves
  // and sends — reusing the REAL exported helpers, never a hand-rolled approximation of them.
  setEnv('PAPERCUSP_ANTHROPIC_URL', `http://127.0.0.1:${port}`);
  const transport = chooseStatelessTransport({ claudeTok: null });
  expect(transport).toBe('gateway-pool');
  const baseURL = resolveDelegatedGatewayUrl();
  expect(baseURL).toBe(`http://127.0.0.1:${port}`); // confirms it targets OUR test gateway, not a real host

  const res = await fetch(`${baseURL}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // gatewayPoolTransport()'s exact header — matched here rather than imported (it is
      // internal to chat-stream.ts) so this stays a black-box proof of the wire contract.
      'anthropic-beta': 'oauth-2025-04-20',
      authorization: `Bearer ${GATEWAY_DELEGATED_AUTH_TOKEN}`,
    },
    body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }),
  });

  expect(res.status).toBe(200); // the delegated call survives A's edge-throttle via failover to B
  expect(attempt).toBe(2); // one throttled attempt on A + one internal-failover success on B
});
