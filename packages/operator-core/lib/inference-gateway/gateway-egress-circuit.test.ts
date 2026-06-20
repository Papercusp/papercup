/**
 * Regression tests for the B-GW-EGRESS transport-failure EGRESS CIRCUIT-BREAKER (2026-06-20 dead-proxy
 * wedge). A dead/half-dead egress proxy (a Rayobyte squid that CONNECT-hangs ~60s) makes the upstream
 * fetch STALL/abort or fail to connect — which never reaches Anthropic, so it carries NO HTTP status
 * and (before this fix) fed NO account-health signal. The router therefore scored the dead-egress
 * account "healthiest", routed the MOST traffic to it, and overrode session pins onto it → the whole
 * gateway wedged into a restart storm (aviynw6/216.41.233.249).
 *
 * The fix (gateway.ts proxy() catch): a transport failure now feeds the SAME `gov.pausedUntil` lever a
 * 429 hard-cap uses (so the existing pin-yield + cross-account selector route around the account),
 * ROTATES + retries instead of 502-ing the bee, and OPENS a longer circuit on a consecutive streak —
 * with a streak reset on any successful response (natural half-open via pause-expiry). The headline
 * invariant proven here: a dead proxy on ONE account is dropped WITHOUT wedging the request.
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { createInferenceGateway, type ActiveAccount } from './gateway';
import { createFailoverPool } from './account-failover';
import { RateLimitGovernor } from '@papercusp/papercusp-shared/agent';

let gw: ReturnType<typeof createInferenceGateway> | undefined;
let port = 0;

afterEach(async () => {
  await gw?.close();
  gw = undefined;
});

/**
 * A pool account whose bearer token === its id (so the mock fetch can tell which account egressed) and
 * which routes through an http egress PROXY — the circuit-breaker is scoped to proxy-egress accounts
 * (a no-proxy transport failure is an Anthropic-side stall, not a dead proxy). The proxy URL is never
 * actually dialed: `egressFetch` is the injected upstream and ignores the dispatcher.
 */
const acct = (id: string): ActiveAccount => ({
  accountId: id,
  token: async () => id,
  invalidateToken: () => {},
  egress: { proxyUrl: `http://proxy-${id}.test:3128` },
});

/**
 * A mock `fetch` standing in for the per-account egress. The upstream call for an account currently in
 * `deadIds` REJECTS — a dead/hanging proxy (the gateway's stall-guard aborts a real 60s CONNECT-hang
 * into this same reject; we reject directly so the test is fast + deterministic). A healthy account
 * returns a 200. The account is identified by the `Authorization: Bearer <id>` the gateway injects.
 */
function egressFetch(deadIds: Set<string>, onCall?: (id: string) => void): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
    const id = auth.replace(/^Bearer\s+/i, '');
    onCall?.(id);
    if (deadIds.has(id)) throw new Error(`connect ECONNREFUSED (simulated dead egress proxy for '${id}')`);
    return new Response(JSON.stringify({ ok: true, servedBy: id }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const MSG = { model: 'claude-opus-4', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] };

const post = (extraHeaders: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(MSG),
  });

test('a dead/hanging egress proxy on one account FAILS OVER to a healthy account → 200, never a 502 wedge', async () => {
  const calls: string[] = [];
  gw = createInferenceGateway({
    pool: createFailoverPool([acct('DEAD'), acct('OK')]),
    fetchImpl: egressFetch(new Set(['DEAD']), (id) => calls.push(id)),
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    selfHeal: { enabled: false },
    maxQueueWaitMs: 2000,
  });
  port = await gw.listen(0);
  // Pin to DEAD so the gateway egresses through the dead proxy FIRST — proving the transport-failure
  // failover (without the fix this returns 502; with it, the request rotates to OK and returns 200).
  const res = await post({ 'x-papercusp-account': 'DEAD' });
  assert.equal(res.status, 200, 'transport failure on the dead-proxy account fails over to the healthy account → 200 (NOT a 502)');
  const body = (await res.json()) as { servedBy: string };
  assert.equal(body.servedBy, 'OK', 'the healthy account actually served the request');
  assert.equal(res.headers.get('x-papercusp-routed-account'), 'OK', 'routed-account header names the survivor (the failover is visible, not silent)');
  assert.ok(calls.includes('DEAD'), 'the dead account was attempted first');
  assert.ok(calls.includes('OK'), 'then the request rotated to the healthy account');
});

test('N consecutive transport failures OPEN the egress circuit (account paused + stat) and return a retryable 503 — never a wedge', async () => {
  const governor = new RateLimitGovernor({ maxConcurrent: 20 });
  gw = createInferenceGateway({
    // Single-account pool → no failover target, so every request actually hits the dead account and
    // accumulates its consecutive transport-failure streak.
    pool: createFailoverPool([acct('DEAD')]),
    fetchImpl: egressFetch(new Set(['DEAD'])),
    governorFor: () => governor,
    selfHeal: { enabled: false },
    maxQueueWaitMs: 3000, // > the pre-circuit pace, so each request waits the prior pace out + re-attempts
  });
  port = await gw.listen(0);
  // EGRESS_FAIL_CIRCUIT_THRESHOLD defaults to 3. Each failing request must be a RETRYABLE 503 (not a
  // terminal 502, not a hang), and the threshold'th failure opens the circuit.
  for (let i = 1; i <= 3; i++) {
    const res = await post();
    assert.equal(res.status, 503, `request ${i}: dead-proxy account with no failover target → retryable 503 (not 502/terminal, not a wedge)`);
    assert.equal(res.headers.get('retry-after'), '5', `request ${i}: carries a retry-after for the bee's CLI`);
  }
  const s = gw.stats();
  assert.ok(s.egressCircuitOpens >= 1, `the egress circuit opened after the consecutive-failure threshold (egressCircuitOpens=${s.egressCircuitOpens})`);
  assert.ok(
    governor.state.pausedUntil > Date.now(),
    'the dead account governor is PAUSED — the same lever as the 429 hard-cap, so the selector routes around it (no longer scored "healthiest")',
  );
});

test('a successful response RESETS the streak — a flapping proxy that recovers does not accumulate toward the circuit', async () => {
  const dead = new Set<string>(['FLAP']);
  gw = createInferenceGateway({
    // Single-account pool: the account must recover in place (no failover to mask it).
    pool: createFailoverPool([acct('FLAP')]),
    fetchImpl: egressFetch(dead),
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    selfHeal: { enabled: false },
    maxQueueWaitMs: 3000,
  });
  port = await gw.listen(0);
  // Two failures — below the threshold of 3, so no circuit yet.
  await post();
  await post();
  assert.equal(gw.stats().egressCircuitOpens, 0, 'two failures (< threshold) have not opened a circuit');
  // The proxy recovers; a 200 must reset the streak.
  dead.clear();
  const ok = await post();
  assert.equal(ok.status, 200, 'the recovered proxy serves a 200');
  // One MORE failure must NOT open the circuit: the success reset the streak, so this is streak 1, not 3.
  dead.add('FLAP');
  await post();
  assert.equal(
    gw.stats().egressCircuitOpens,
    0,
    'the successful response RESET the transport-failure streak — a single post-recovery failure does not re-open the circuit',
  );
});
