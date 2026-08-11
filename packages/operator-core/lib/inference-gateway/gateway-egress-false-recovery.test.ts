/**
 * gateway-egress-false-recovery.test.ts — EI-18664933641195210.
 *
 * A cooldown EXPIRING is permission to RETRY. It is not evidence of health. `computeEgressProxyHealth`
 * counted an entry as reachable whenever its cooldown was not currently active, so the moment a
 * transport cooldown lapsed the dead entry silently counted as healthy again, `allDown` flipped false,
 * and the edge-triggered EGRESS ALARM CANCELLED ITSELF — then re-fired on the next failed attempt.
 *
 * Measured on the live gateway 2026-08-11: 147 "EGRESS ALARM" and 147 "pool RECOVERED — N/4 proxy
 * entries reachable again" in 24h, while all three squid proxies were hard-refusing TCP the entire
 * time. Every one of those recoveries was false. The effect is worse than silence: a 16-day outage
 * rendered as routine flapping, which is why 147 error-level alarms were never acted on.
 *
 * Recovery must require a real transport SUCCESS (which clears `ipTransportFailStreak` alongside the
 * cooldown at the success sites), never the mere passage of time.
 *
 * The circuit window is read at MODULE scope from PAPERCUSP_GATEWAY_EGRESS_CIRCUIT_MS, so this file
 * pins a short one and imports the gateway DYNAMICALLY afterwards — that is what makes the expiry
 * deterministic instead of a 20s sleep.
 */
import { test, afterEach, expect } from 'vitest';

process.env.PAPERCUSP_GATEWAY_EGRESS_CIRCUIT_MS = '150';

const { createInferenceGateway } = await import('./gateway');
type ActiveAccount = import('./gateway').ActiveAccount;
type AccountPool = import('./gateway').AccountPool;
const { RateLimitGovernor, resetGovernorRegistry } = await import('@papercusp/papercusp-shared/agent');

let gw: { close: () => Promise<void>; listen: (p: number) => Promise<number> } | undefined;
let port = 0;

afterEach(async () => {
  await gw?.close();
  gw = undefined;
  resetGovernorRegistry();
});

type Health = { totalProxyEntries: number; reachableProxyEntries: number; allDown: boolean; configured: boolean };
const health = async (): Promise<Health> =>
  ((await (await fetch(`http://127.0.0.1:${port}/stats`)).json()) as { egressProxyHealth?: Health }).egressProxyHealth!;

test('[EI-18664933641195210] an EXPIRED cooldown is not a recovery — allDown stays true until a real success', async () => {
  resetGovernorRegistry();
  // Every upstream attempt fails at the transport layer, exactly like a squid that refuses TCP.
  const fetchImpl = (async () => {
    throw new Error('connect ECONNREFUSED');
  }) as unknown as typeof fetch;

  const acctA: ActiveAccount = { accountId: 'A', token: async () => 'A-tok', egress: { proxyUrl: 'http://127.0.0.1:9201' } };
  const acctB: ActiveAccount = { accountId: 'B', token: async () => 'B-tok', egress: { proxyUrl: 'http://127.0.0.1:9202' } };
  const pool: AccountPool = {
    active: () => acctA,
    onExhausted: () => null,
    select: (id) => (id === 'A' ? acctA : id === 'B' ? acctB : null),
    entries: () => [acctA, acctB],
  };

  const logs: { level: string; msg: string }[] = [];
  gw = createInferenceGateway({
    pool,
    upstreamBase: 'http://upstream.invalid',
    fetchImpl,
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    maxQueueWaitMs: 2000,
    log: (level: string, msg: string) => logs.push({ level, msg }),
  }) as never;
  port = await gw!.listen(0);

  const pin = (id: string) =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-papercusp-account': id },
      body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }),
    });

  await pin('A');
  await pin('B');

  const downNow = await health();
  expect(downNow.totalProxyEntries).toBe(2);
  expect(downNow.reachableProxyEntries).toBe(0);
  expect(downNow.allDown).toBe(true);
  expect(logs.filter((l) => l.level === 'error' && l.msg.includes('EGRESS ALARM'))).toHaveLength(1);

  // Let BOTH transport cooldowns lapse. Nothing else changes: the proxies are still dead, and no
  // request has succeeded through either entry.
  await new Promise((r) => setTimeout(r, 400));

  const afterExpiry = await health();
  expect(afterExpiry.reachableProxyEntries, 'an expired cooldown is not proof the proxy came back').toBe(0);
  expect(afterExpiry.allDown, 'the outage is still on — allDown must not self-clear on a timer').toBe(true);

  // The self-cancelling alarm is the user-visible symptom: no RECOVERED line may be emitted, and the
  // alarm must not have re-armed (which is what produced 147 alarm/recovery pairs for one outage).
  expect(logs.filter((l) => l.msg.includes('pool RECOVERED')), 'no proxy actually recovered').toHaveLength(0);
  expect(logs.filter((l) => l.level === 'error' && l.msg.includes('EGRESS ALARM')), 'still ONE alarm for one outage').toHaveLength(1);
}, 20_000);

test('[EI-18664933641195210] a real transport SUCCESS does clear the alarm (the fix must not wedge it on)', async () => {
  resetGovernorRegistry();
  // Fail the first attempt per account, then serve 200s — so recovery is proven by traffic, not time.
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls <= 2) throw new Error('connect ECONNREFUSED');
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const acctA: ActiveAccount = { accountId: 'A', token: async () => 'A-tok', egress: { proxyUrl: 'http://127.0.0.1:9203' } };
  const acctB: ActiveAccount = { accountId: 'B', token: async () => 'B-tok', egress: { proxyUrl: 'http://127.0.0.1:9204' } };
  const pool: AccountPool = {
    active: () => acctA,
    onExhausted: () => null,
    select: (id) => (id === 'A' ? acctA : id === 'B' ? acctB : null),
    entries: () => [acctA, acctB],
  };

  const logs: { level: string; msg: string }[] = [];
  gw = createInferenceGateway({
    pool,
    upstreamBase: 'http://upstream.invalid',
    fetchImpl,
    governorFor: () => new RateLimitGovernor({ maxConcurrent: 20 }),
    maxQueueWaitMs: 2000,
    log: (level: string, msg: string) => logs.push({ level, msg }),
  }) as never;
  port = await gw!.listen(0);

  const pin = (id: string) =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-papercusp-account': id },
      body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] }),
    });

  await pin('A');
  await pin('B');
  expect((await health()).allDown, 'both entries transport-failed').toBe(true);

  await new Promise((r) => setTimeout(r, 400)); // cooldowns lapse so the entries are retryable
  await pin('A');
  await pin('B');

  const recovered = await health();
  expect(recovered.reachableProxyEntries, 'a proven success restores reachability').toBe(2);
  expect(recovered.allDown).toBe(false);
  expect(logs.some((l) => l.msg.includes('pool RECOVERED')), 'a genuine recovery still logs').toBe(true);
}, 20_000);
