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
  // Volume-fair rate: DEAD failed its single attempt (1/1 = 1.0); OK served its single attempt (0/1 = 0.0). The
  // rate is per-account-denominated, so a dead proxy reads 1.0 even on tiny traffic and a healthy one reads 0.0 —
  // exactly the signal a raw count buries when one proxy is busier than another.
  const s = gw.stats();
  assert.equal(s.egressAttemptsByAccount.DEAD, 1, 'DEAD got one egress attempt (the denominator)');
  assert.equal(s.egressAttemptsByAccount.OK, 1, 'OK got one egress attempt');
  assert.equal(s.egressFailRateByAccount.DEAD, 1, 'DEAD: 1 fail / 1 attempt = 1.0');
  assert.equal(s.egressFailRateByAccount.OK, 0, 'OK: 0 fail / 1 attempt = 0.0 (served), even though it carried the same traffic');
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
  // Normalized egress-failure RATE (2026-06-22 audit): every one of DEAD's 3 attempts transport-failed, so its
  // rate is 1.0 over 3 attempts — the volume-fair "this proxy is dead" signal, not just a raw count.
  assert.equal(s.egressAttemptsByAccount.DEAD, 3, 'every attempt on DEAD is counted as the rate denominator');
  assert.equal(s.egressFailsByAccount.DEAD, 3, 'all 3 attempts transport-failed');
  assert.equal(s.egressFailRateByAccount.DEAD, 1, 'egressFailRateByAccount = fails/attempts = 3/3 = 1.0 (dead proxy)');
});

test('EXTENDED ABSORB (requestAbsorbMs) — keeps retrying past the slot-hold deadline and SUCCEEDS instead of 429ing the caller (2026-06-22)', async () => {
  let calls = 0;
  // A SHORT transient rate-429 (retry-after:1 ⇒ a ~1s account pause) on the first attempts, then a 200 — i.e.
  // the account recovers. retry-after:1 matters: the absorb only HOLDS the caller when the throttle pause fits
  // inside the remaining absorb budget (the re-acquire returns null otherwise). A header-less bare 429 paces the
  // account BARE_429_FAILOVER_BACKOFF_MS (15s) — which would NOT fit the 5s budget below, so it would (correctly)
  // shed. So the test sizes the throttle (1s) < the absorb budget (5s) to exercise the absorb-WAITS-then-succeeds
  // path; production sizes requestAbsorbMs (~minutes) ≫ the throttle for the same reason.
  const fetchImpl = (async () => {
    calls++;
    if (calls <= 2) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'x-should-retry': 'true', 'retry-after': '1' },
      });
    }
    return new Response(JSON.stringify({ ok: true, servedBy: 'OK' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  gw = createInferenceGateway({
    pool: createFailoverPool([acct('A'), acct('B')]), // 2 accounts → a 429 ROTATES (proceed=true), then the deadline triggers the absorb
    fetchImpl,
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    selfHeal: { enabled: false },
    maxQueueWaitMs: 50,
    internalRetryDeadlineMs: 0, // hit the slot-hold deadline IMMEDIATELY so each 429 triggers the absorb path
    requestAbsorbMs: 5000, // ENABLE extended absorption (off by default)
  });
  port = await gw.listen(0);
  const res = await post();
  assert.equal(res.status, 200, 'absorb-retry held the caller through the transient 429s + returned the eventual 200 — never a shed 429');
  assert.ok(calls >= 3, `it kept re-acquiring + retrying through the 429s until the 200 (calls=${calls})`);
});

test('EXTENDED ABSORB — also holds the caller through a 529 SERVER-OVERLOAD (not just rate-429s) until it clears (2026-06-22)', async () => {
  let calls = 0;
  // A 529 overloaded_error (Anthropic server-side) on the first attempts, then a 200. A 529 is NOT a per-account
  // rate penalty (the account isn't paused), so the absorb backs off OVERLOAD_529_BACKOFF (1s) before each
  // re-acquire rather than hammering the overload. A single account suffices (the 529 path retries in place).
  const fetchImpl = (async () => {
    calls++;
    if (calls <= 2) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }), {
        status: 529,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  gw = createInferenceGateway({
    pool: createFailoverPool([acct('A')]),
    fetchImpl,
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    selfHeal: { enabled: false },
    maxQueueWaitMs: 50,
    internalRetryDeadlineMs: 0, // hit the deadline immediately → each 529 reaches the forward-absorb
    requestAbsorbMs: 8000, // > 2 × OVERLOAD_529_BACKOFF (1s) so the absorb out-waits the overload
  });
  port = await gw.listen(0);
  const res = await post();
  assert.equal(res.status, 200, 'absorb held the caller through the 529 overload + returned the eventual 200');
  assert.ok(calls >= 3, `it backed off + re-acquired through the 529s until the 200 (calls=${calls})`);
});

test('STALL ABSORB (#2, su-3650b) — a MULTI-account transport-stall storm is held + succeeds instead of a 503 (2026-06-23)', async () => {
  let calls = 0;
  // Both proxy accounts transport-FAIL (stall/dead-proxy) the first few calls — the Anthropic-wide storm — then
  // recover (200). The request rotates A→B (everRotated) so the stall-absorb is eligible; it releases the slot +
  // re-acquires (waiting out the short transport pause) + retries instead of sheding the retryable 503.
  const fetchImpl = (async () => {
    calls++;
    if (calls <= 3) throw new Error('socket hang up'); // transport failure
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  gw = createInferenceGateway({
    pool: createFailoverPool([acct('A'), acct('B')]), // 2 proxy accounts → ROTATES → stall-absorb eligible
    fetchImpl,
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    selfHeal: { enabled: false },
    maxQueueWaitMs: 50,
    internalRetryDeadlineMs: 50,
    requestAbsorbMs: 8000, // absorb on
  });
  port = await gw.listen(0);
  const res = await post();
  assert.equal(res.status, 200, 'stall-absorb held the caller through the transport storm + returned the 200, not a 503');
  assert.ok(calls >= 4, `it re-acquired + retried through the stalls until recovery (calls=${calls})`);
});

test('STALL ABSORB — a LONE dead proxy (no rotation alternative) still sheds FAST (no 60s hold) — the everRotated guard', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    throw new Error('socket hang up'); // permanently dead — never recovers
  }) as typeof fetch;
  gw = createInferenceGateway({
    pool: createFailoverPool([acct('DEAD')]), // single account → never rotates → everRotated false → no stall-absorb
    fetchImpl,
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    selfHeal: { enabled: false },
    maxQueueWaitMs: 50,
    internalRetryDeadlineMs: 50,
    requestAbsorbMs: 8000, // absorb ON — but the guard must keep it from holding through a dead proxy
  });
  port = await gw.listen(0);
  const t0 = Date.now();
  const res = await post();
  assert.equal(res.status, 503, 'a lone dead proxy sheds a retryable 503 fast, NOT held for the absorb budget');
  assert.ok(Date.now() - t0 < 4000, `shed fast (no multi-second absorb hold): ${Date.now() - t0}ms`);
});

test('INTERACTIVE fail-fast — a human-labeled caller caps its absorb + sheds fast, while an autonomous role holds the full budget (no-pin-hang follow-up #2, 2026-06-23)', async () => {
  // A never-recovering 529 storm. An AUTONOMOUS caller (x-papercusp-priority: queen) absorbs — releasing the
  // slot + re-acquiring through OVERLOAD_529_BACKOFF (1s) each iteration — for the full requestAbsorbMs budget
  // before shedding. A HUMAN-facing caller (x-papercusp-priority: interactive) must shed FAST: its absorb is
  // capped at interactiveAbsorbMs, so a person at a prompt gets a quick retryable error instead of a multi-
  // second hang. We count upstream attempts: the capped human makes strictly fewer than the full-budget hold.
  const run = async (priority: string, closeAfter: boolean) => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }),
        { status: 529, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    gw = createInferenceGateway({
      pool: createFailoverPool([acct('A')]), // single account → the 529 path retries in place
      fetchImpl,
      governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
      selfHeal: { enabled: false },
      maxQueueWaitMs: 50,
      internalRetryDeadlineMs: 0, // hit the slot-hold deadline immediately → each 529 reaches the absorb
      requestAbsorbMs: 3500, // autonomous hold budget (> several OVERLOAD_529_BACKOFF of 1s)
      interactiveAbsorbMs: 20, // human cap: shed almost immediately
    });
    port = await gw.listen(0);
    const res = await post({ 'x-papercusp-priority': priority });
    const status = res.status;
    await res.text();
    if (closeAfter) await gw.close();
    return { calls, status };
  };

  const human = await run('interactive', true); // capped → sheds after ~1 attempt
  const auto = await run('queen', false); // full budget → absorbs through several attempts (afterEach closes it)
  assert.ok([429, 502, 503].includes(human.status), `human interactive sheds a RETRYABLE error (got ${human.status})`);
  assert.ok(
    auto.calls > human.calls,
    `the capped human shed fast (${human.calls} attempt(s)) while the autonomous 'queen' absorbed through more (${auto.calls})`,
  );
});

test('GET /admin/route?owner — reports the account that served an identified owner\'s most-recent turn (routed-account visibility, 2026-06-22)', async () => {
  gw = createInferenceGateway({
    pool: createFailoverPool([acct('OK')]),
    fetchImpl: egressFetch(new Set()), // OK is healthy → serves 200
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    selfHeal: { enabled: false },
    maxQueueWaitMs: 2000,
  });
  port = await gw.listen(0);
  // Unknown owner before any request → account null (never falsely attributed).
  const before = (await (await fetch(`http://127.0.0.1:${port}/admin/route?owner=su-xyz`)).json()) as { account: string | null };
  assert.equal(before.account, null, 'no route recorded yet for an unseen owner');
  // An IDENTIFIED request (x-papercusp-owner) served by OK records the route.
  const res = await post({ 'x-papercusp-owner': 'su-xyz' });
  assert.equal(res.status, 200, 'the request is served');
  const after = (await (await fetch(`http://127.0.0.1:${port}/admin/route?owner=su-xyz`)).json()) as { account: string | null; owner: string | null };
  assert.equal(after.account, 'OK', 'the served account is reported back for the owner (what the statusline shows)');
  assert.equal(after.owner, 'su-xyz', 'the queried owner is echoed');
});

test('a bee-facing egress-exhausted 503 RECORDS a stall for an IDENTIFIED bee (autowake coverage, 2026-06-22)', async () => {
  gw = createInferenceGateway({
    pool: createFailoverPool([acct('DEAD')]), // single dead account, no failover target → bee-facing 503
    fetchImpl: egressFetch(new Set(['DEAD'])),
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    selfHeal: { enabled: false },
    maxQueueWaitMs: 3000,
  });
  port = await gw.listen(0);
  const before = gw.stats().stallsRecorded;
  // An IDENTIFIED bee (x-papercusp-owner) that egress-exhausts must record a stall, so the stall-waker can
  // re-wake it when the account recovers — instead of the bee just dying on the retryable 503 with no retry.
  const res = await post({ 'x-papercusp-owner': 'bee-xyz' });
  assert.equal(res.status, 503, 'egress-exhausted with no failover target → retryable 503');
  assert.ok(gw.stats().stallsRecorded > before, 'a stall was recorded for the identified bee (the autowake gap fix)');
  // An UNIDENTIFIED request (no owner header) records NO stall — there is nothing to wake.
  const before2 = gw.stats().stallsRecorded;
  await post();
  assert.equal(gw.stats().stallsRecorded, before2, 'no x-papercusp-owner → no stall recorded (nothing to re-wake)');
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
