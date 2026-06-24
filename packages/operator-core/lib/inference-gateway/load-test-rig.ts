/**
 * Vitest LOAD-TEST RIG for the inference gateway (inference-gateway-stability-ownership P-001).
 *
 * The REGRESSION rig the bare-burst-429 fixes are measured against — a deterministic, in-process,
 * NO-real-spend twin of the live `load-test.ts` (which hits api.anthropic.com). It boots a REAL
 * gateway (real per-account governors, real admission queue, real AIMD + absorb) against a MOCK
 * upstream that enforces a per-account SUB-MINUTE BURST cap and returns a BARE-burst 429
 * (`x-should-retry:true`, NO `retry-after`, NO `anthropic-ratelimit-unified-*` headers) on overshoot —
 * the exact shape `classify429Shape` tags `'bare-burst'` and the gateway absorbs + retries.
 *
 * It reproduces the storm (P-001) and measures BOTH what the bee sees (final 503 / forwarded 429) AND
 * the upstream-429 count (the storm magnitude that bee-facing absorb hides). The dominant-mechanism
 * verdict (P-002) and the second-driver probe (P-004) import `runGatewayBurstRig` to vary one lever at
 * a time (smoothRpm on/off, burst cap, rotation-retry) and compare upstream429.
 *
 * Why the numbers are faithful: the gateway's per-account governors come from DEFAULT_FLOORS.anthropic
 * = { maxConcurrent: 3, rpm: 45 } — the SAME `rpm:45` that, under the per-minute COUNT gate alone,
 * lets 45 requests fire INSTANTLY at window start (the tumbling-window burst). smoothRpm floors the
 * pace at 60_000/45 ≈ 1333ms so the same allowance is spread evenly. The rig flips exactly that lever.
 *
 * TIMING (why a storm case takes ~15s): a bare-burst 429 penalizes the account for
 * `BARE_429_FAILOVER_BACKOFF_MS` = 15s (gov.penalize + pool.onExhausted) — so a sub-minute burst takes
 * the WHOLE account out of rotation for 15s, and when every account bursts the pool goes dark and held
 * requests wait that out (then succeed). That 15s is intrinsic real-timer production behaviour (it is
 * also why the SU-3650 absorb tests run 15s), not a rig artifact — and it is itself an amplifier the
 * smoothing fix avoids by never bursting. Storm cases therefore run ~15s; the smoothed (ON) case is
 * fast because it never trips the penalty. Keep storm-case timeouts generous on a loaded box.
 */
import { createInferenceGateway, type ActiveAccount } from './gateway';
import { createFailoverPool } from './account-failover';

export interface MockUpstreamOptions {
  /** Per-account SUB-MINUTE burst cap: how many requests may land within `burstWindowMs` before the
   *  upstream returns a bare-burst 429. This models Anthropic's sub-minute burst limit (distinct from
   *  the per-minute average). */
  burstCap: number;
  /** The sliding sub-minute window (ms) the burst cap is measured over. */
  burstWindowMs: number;
  /** OPTIONAL hard per-account 60s RPM ceiling (the per-minute average wall). Omit ⇒ only the burst gate
   *  fires, which is the bare-burst storm in isolation. */
  rpm?: number;
  /** Latency of a 200 (ms). Default 0 — keep the rig fast; raise to model TTFB. */
  latencyMs?: number;
}

export interface MockUpstream {
  fetchImpl: typeof fetch;
  /** Total bare-burst 429s emitted across all accounts (the storm magnitude at the upstream). */
  upstream429(): number;
  /** Per-account bare-burst 429 tally — the rotation/clustering signal (P-004). */
  perAccount429(): Record<string, number>;
  /** Total upstream calls received (200s + 429s) — the denominator. */
  total(): number;
}

/**
 * A mock `api.anthropic.com` that enforces a per-account sliding-window BURST cap and returns a
 * BARE-burst 429 on overshoot. Keyed on the `Authorization` Bearer token so EACH pool account is
 * rate-limited INDEPENDENTLY (the real per-account / per-IP throttle — rotation across accounts is the
 * capacity lever the gateway exploits, and the storm is when rotation can't outrun the burst).
 */
export function mockBurstUpstream(opts: MockUpstreamOptions): MockUpstream {
  const hist = new Map<string, number[]>(); // token → accept timestamps (ms)
  const c429 = new Map<string, number>();
  let total = 0;
  const fetchImpl = (async (_url: string, init: { headers?: Record<string, string> }) => {
    total += 1;
    const h = init.headers ?? {};
    const auth = h.authorization ?? h.Authorization ?? '';
    const tok = auth.replace(/^Bearer\s+/i, '').trim() || 'anon';
    const now = Date.now();
    const recent = (hist.get(tok) ?? []).filter((t) => now - t < 60_000);
    const inBurst = recent.filter((t) => now - t < opts.burstWindowMs).length;
    const overBurst = inBurst >= opts.burstCap;
    const overRpm = opts.rpm !== undefined && recent.length >= opts.rpm;
    if (overBurst || overRpm) {
      c429.set(tok, (c429.get(tok) ?? 0) + 1);
      // BARE-burst 429: x-should-retry:true, NO retry-after, NO unified util headers → classify429Shape
      // returns 'bare-burst' (a 429 with no window headers + x-should-retry). The body names a generic
      // rate_limit_error, NOT a usage/session cap, so it is never misread as a hard per-account wall.
      return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'bare burst (sub-minute)' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'x-should-retry': 'true' },
      });
    }
    recent.push(now);
    hist.set(tok, recent);
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
    return new Response(
      JSON.stringify({ id: 'msg_rig', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    upstream429: () => [...c429.values()].reduce((a, b) => a + b, 0),
    perAccount429: () => Object.fromEntries(c429),
    total: () => total,
  };
}

export interface RigOptions {
  /** Pool size — distinct accounts (tokens). Default 4. */
  accounts?: number;
  /** Total requests fired at the gateway. Default 12. */
  n?: number;
  /** Gateway admission concurrency cap (the AIMD ceiling). Default = n (let the whole burst race). */
  concurrency?: number;
  /** The FIX under test: smooth each account's per-minute allowance into an even pace. Default false
   *  (reproduce the storm). */
  smoothRpm?: boolean;
  /** Mock per-account sub-minute burst cap. Default 2. */
  burstCap?: number;
  /** Mock sub-minute burst window (ms). Default 800. */
  burstWindowMs?: number;
  /** Mock per-account 60s RPM ceiling (omit ⇒ burst gate only). */
  rpm?: number;
  /** Gateway admission/absorb wait budget (ms). Must exceed the smoothing pace for the ON case to
   *  drain without bee-facing timeouts. Default 8000. */
  maxQueueWaitMs?: number;
  /** The gateway's transient-429 ABSORB budget (ms) — how long it holds + retries a bare-burst before
   *  giving up. The rig defaults this to 4000 (vs the 60s production default) so the OFF storm-repro
   *  drains/relents in a few seconds instead of sitting the full budget — keeps the vitest run fast and
   *  off the load-fragile real-timer cliff. Raise it to model a longer storm. */
  requestAbsorbMs?: number;
  /** Pin concurrency by setting the AIMD floor = cap, so the OFF↔ON comparison isolates the SMOOTHING
   *  variable (AIMD shrinking would otherwise also reduce the burst). Default true. Pass false to let
   *  AIMD adapt (e.g. to measure AIMD under-reaction for P-002). */
  pinConcurrency?: boolean;
  model?: string;
}

export interface RigResult {
  n: number;
  /** Bee saw a 200. */
  ok: number;
  /** Bee saw a forwarded upstream 429. */
  beeFacing429: number;
  /** Bee saw a gateway-final 503 (load-shed / absorb-exhausted). */
  beeFacing503: number;
  /** Any other non-200 (transport, etc.). */
  otherFail: number;
  /** Bare-burst 429s the UPSTREAM emitted — the storm magnitude (what bee-facing absorb hides). */
  upstream429: number;
  /** The gateway's own upstream-429 counter (gw.stats().upstream429) — cross-check on the mock tally. */
  gatewayUpstream429: number;
  /** Per-account upstream bare-burst 429s — rotation/clustering signal (P-004). */
  perAccount429: Record<string, number>;
  wallMs: number;
}

/**
 * Boot a gateway against the mock burst-upstream, fire `n` concurrent requests, and return the
 * bee-facing + upstream metrics. Closes the gateway before returning. The registry is a process
 * singleton, so the caller (the vitest harness) must `resetGovernorRegistry()` between runs to avoid
 * a prior run's learned rpmFactor / window leaking in.
 */
export async function runGatewayBurstRig(opts: RigOptions = {}): Promise<RigResult> {
  const accounts = opts.accounts ?? 4;
  const n = opts.n ?? 12;
  const concurrency = opts.concurrency ?? n;
  const smoothRpm = opts.smoothRpm ?? false;
  const pin = opts.pinConcurrency ?? true;

  const entries: ActiveAccount[] = Array.from({ length: accounts }, (_, i) => ({
    accountId: `rig-acct-${i}`,
    token: async () => `rig-tok-${i}`,
  }));
  const pool = createFailoverPool(entries);
  const upstream = mockBurstUpstream({
    burstCap: opts.burstCap ?? 2,
    burstWindowMs: opts.burstWindowMs ?? 800,
    ...(opts.rpm !== undefined ? { rpm: opts.rpm } : {}),
  });

  const gw = createInferenceGateway({
    pool,
    upstreamBase: 'http://upstream.invalid',
    fetchImpl: upstream.fetchImpl,
    concurrency,
    smoothRpm,
    selfHeal: { enabled: false },
    maxQueueWaitMs: opts.maxQueueWaitMs ?? 8000,
    requestAbsorbMs: opts.requestAbsorbMs ?? 4000,
    ...(pin ? { aimd: { floor: concurrency } } : {}),
    log: () => {},
  });
  const port = await gw.listen(0);
  const model = opts.model ?? 'claude-opus-4';

  const fire = async (i: number): Promise<{ status: number }> => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 4, messages: [{ role: 'user', content: `ping ${i}` }] }),
      });
      await res.text();
      return { status: res.status };
    } catch {
      return { status: 0 };
    }
  };

  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: n }, (_, i) => fire(i)));
  const wallMs = Date.now() - t0;
  const gatewayUpstream429 = gw.stats().upstream429;
  await gw.close();

  return {
    n,
    ok: results.filter((r) => r.status === 200).length,
    beeFacing429: results.filter((r) => r.status === 429).length,
    beeFacing503: results.filter((r) => r.status === 503).length,
    otherFail: results.filter((r) => r.status !== 200 && r.status !== 429 && r.status !== 503).length,
    upstream429: upstream.upstream429(),
    gatewayUpstream429,
    perAccount429: upstream.perAccount429(),
    wallMs,
  };
}
