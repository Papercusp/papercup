/**
 * P-006 (plan `gateway-kernel-adoption-2026-08-29`) — the Claude
 * (`anthropic-messages` / `oauth-http`) adapter driven through the REAL
 * `executeGatewayRequestKernel` with NO gateway wiring, exactly as P-002/P-004
 * did for the bearer and codex-oauth lanes.
 *
 * Each test names the `proxy` behaviour it pins. The ones that matter most are the
 * SAME-ACCOUNT re-attempts (D-011) — a bare-burst 429 or transport failure retries
 * the same account on a sibling egress IP, and a 529 backs off on the same account
 * — because none is gated on the hard pin in the live handler and none is counted
 * as a failover. The complementary `gateway-claude-ladder.test.ts` goldens pin the
 * same seams end-to-end through the live handler; these pin them at the adapter.
 */
import { describe, expect, it } from 'vitest';
import { makeGatewayLaneRegistry } from './provider-adapters';
import type { AccountPool, ActiveAccount } from './provider-contracts';
import {
  createClaudeKernelAdapter,
  type ClaudeAdapterOptions,
  type ClaudeChunk,
  type ClaudeFetchResponse,
  type ClaudePreparedAttempt,
  type ClaudeResponseClassification,
  type ClaudeResponseMetadata,
  type ClaudeRouteValue,
} from './claude-kernel-adapter';
import {
  executeGatewayRequestKernel,
  type ExecuteGatewayRequestKernelOptions,
  type GatewayKernelAccountPin,
  type GatewayKernelPolicy,
} from './request-kernel';
import { GatewayRequestTelemetry } from './request-stage-telemetry';

const POLICY: GatewayKernelPolicy = {
  maxBodyBytes: 4096,
  bodyReadTimeoutMs: 2_000,
  requestCeilingMs: 10_000,
  ttfbTimeoutMs: 2_000,
  bodyIdleTimeoutMs: 2_000,
  downstreamIdleTimeoutMs: 2_000,
  maxAttempts: 4,
};

const unusedPool: AccountPool = {
  active: () => {
    throw new Error('unused pool');
  },
  onExhausted: () => null,
  select: () => null,
};

const laneRegistry = makeGatewayLaneRegistry({
  claudePool: unusedPool,
  codexPool: null,
  codexCliAccountCount: () => 1,
  anthropicUpstreamBase: 'https://anthropic.test',
  openaiUpstreamBase: 'https://openai.test',
});
const lane = laneRegistry.anthropicMessages;

const acct = (accountId: string): ActiveAccount =>
  ({ accountId, token: async () => `${accountId}-tok` }) as ActiveAccount;

function res(status: number, headers: Record<string, string> = {}): ClaudeFetchResponse {
  return {
    status,
    headers: {
      forEach(cb: (value: string, key: string) => void) {
        for (const [k, v] of Object.entries(headers)) cb(v, k);
      },
    },
    body: status === 200 ? (async function* () { yield Buffer.from('{"ok":true}'); })() : null,
  };
}

/** A response carrying a real error BODY, split across several chunks so the
 *  classification peek has to reassemble it — and so the replay is proven to
 *  restore the whole stream, not just the first chunk. */
function errorRes(status: number, body: string, headers: Record<string, string> = {}): ClaudeFetchResponse {
  const chunks = body.match(/[\s\S]{1,8}/g) ?? [];
  return {
    status,
    headers: {
      forEach(cb: (value: string, key: string) => void) {
        for (const [k, v] of Object.entries(headers)) cb(v, k);
      },
    },
    body: (async function* () {
      for (const c of chunks) yield Buffer.from(c);
    })(),
  };
}

/** Stands in for the caller's Anthropic predicates (`classifyHttpError`,
 *  `parseUsageReset`, `ORG_DISALLOWED_RE`), which stay in gateway.ts under D-013.
 *  Deliberately reads the BODY, which is the whole point: status and headers
 *  cannot separate these shapes. */
const CAP_RESET_AT = 4_000_000_000_000;
function classifier(input: { status: number; headers: Record<string, string>; body: string }) {
  if (input.status === 429 && /session limit/i.test(input.body))
    return { kind: 'usage-cap' as const, resetAt: CAP_RESET_AT };
  if (input.status === 429 && (input.headers['retry-after'] || input.headers['anthropic-ratelimit-unified-reset']))
    return { kind: 'rate-429' as const };
  if (input.status === 429) return { kind: 'bare-429' as const };
  if (input.status === 529) return { kind: 'overload' as const };
  if (input.status === 403 && /disallowed|not allowed/i.test(input.body))
    return { kind: 'org-disallowed' as const, resetAt: CAP_RESET_AT };
  return { kind: 'forward' as const };
}

/** A pool whose rotation sequence is scripted, recording every onExhausted call so
 *  the D-012 "exactly one call site" constraint is directly observable. */
function makePool(rotation: (ActiveAccount | null)[]) {
  const calls: { id: string; resetAt: number }[] = [];
  let cursor = 0;
  const pool: AccountPool = {
    active: () => {
      // D-010: the adapter must NEVER call active() — it would advance the
      // round-robin a second time for one request.
      throw new Error('adapter called pool.active() — D-010 violation');
    },
    select: () => null,
    onExhausted: (id: string, resetAt: number) => {
      calls.push({ id, resetAt });
      return (rotation[cursor++] ?? null) as ReturnType<AccountPool['onExhausted']>;
    },
  };
  return { pool, calls };
}

interface Overrides {
  accounts?: ActiveAccount[];
  pool?: AccountPool;
  pin?: GatewayKernelAccountPin | null;
  siblingEgressAvailable?: ClaudeAdapterOptions['siblingEgressAvailable'];
  pickEgress?: ClaudeAdapterOptions['pickEgress'];
  canRotate?: ClaudeAdapterOptions['canRotate'];
  classifyResponse?: ClaudeAdapterOptions['classifyResponse'];
}

function harness(fetchImpl: ClaudeAdapterOptions['fetch'], overrides: Overrides = {}) {
  const telemetry = new GatewayRequestTelemetry();
  const prepared: ClaudePreparedAttempt[] = [];
  const routeKeys: string[] = [];
  const forwarded: Buffer[] = [];
  const observedClassifications: (ClaudeResponseClassification | null)[] = [];
  const accounts = overrides.accounts ?? [acct('A')];
  let egressSeq = 0;

  const adapter = createClaudeKernelAdapter({
    initialAccount: accounts[0]!,
    pool: overrides.pool,
    upstreamUrl: 'https://anthropic.test/v1/messages',
    method: 'POST',
    baseHeaders: { 'content-type': 'application/json' },
    body: null,
    streaming: true,
    tokenTimeoutMs: 1_000,
    failoverBackoffMs: 5_000,
    overloadBackoffMs: 1_000,
    // Each pick returns a DISTINCT key, mirroring a real egress pool round-robin —
    // which is exactly why failovers must not be counted by route key.
    pickEgress:
      overrides.pickEgress ??
      ((account) => ({ entry: undefined, key: `${account.accountId}:ip${++egressSeq}` })),
    siblingEgressAvailable: overrides.siblingEgressAvailable ?? (() => false),
    dispatcherFor: () => undefined,
    fetch: fetchImpl,
    rateReset: () => ({ resetAt: null, retryAfterMs: null }),
    canRotate: overrides.canRotate,
    classifyResponse: overrides.classifyResponse,
    peekBytes: 4096,
    peekTimeoutMs: 1_000,
  });

  const observed: typeof adapter = {
    ...adapter,
    async prepareAttempt(context) {
      routeKeys.push(context.route.key);
      const result = await adapter.prepareAttempt(context);
      prepared.push(result);
      return result;
    },
  };

  async function* body() {
    yield Buffer.from('{"model":"claude-opus-4"}');
  }

  const options: ExecuteGatewayRequestKernelOptions<
    ClaudeRouteValue,
    ClaudePreparedAttempt,
    ClaudeChunk,
    ClaudeResponseMetadata
  > = {
    request: {
      lane,
      body: body(),
      ownerId: 'su-claude-adapter',
      correlationId: 'claude-adapter-test',
      pin: overrides.pin ?? null,
    },
    policy: POLICY,
    telemetry,
    admission: {
      async run(_context, task) {
        return task();
      },
      // The caller's real side-effect seam (D-012 constraint 1). Recording what it
      // SEES is how we prove the body-derived classification actually reaches the
      // hook that fires gov.penalize / cooldowns / alerts.
      observeAttempt: ({ response }) => {
        observedClassifications.push(response?.metadata?.classification ?? null);
      },
    },
    adapter: observed,
    downstream: {
      start: () => undefined,
      write: (chunk) => {
        forwarded.push(Buffer.from(chunk));
      },
      end: () => undefined,
    },
    inFlight: { register: () => ({ unregister: () => undefined }) },
  };

  return {
    options,
    prepared,
    routeKeys,
    /** Bytes actually relayed downstream — proves a peeked body is replayed whole. */
    forwardedBody: () => Buffer.concat(forwarded).toString('utf8'),
    observedClassifications,
  };
}

describe('claude kernel adapter', () => {
  it('replays the caller-resolved account and never calls pool.active() (D-010)', async () => {
    const { pool } = makePool([]);
    const { options, prepared } = harness(async () => res(200), { accounts: [acct('A')], pool });
    // makePool's active() throws, so a passing run is itself the assertion.
    await executeGatewayRequestKernel(options);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]!.accountId).toBe('A');
  });

  it('retries a SIBLING egress IP on the SAME account for a bare-burst 429, without consulting the pool (D-011)', async () => {
    const { pool, calls } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared } = harness(async () => (++n === 1 ? res(429) : res(200)), {
      accounts: [acct('A')],
      pool,
      siblingEgressAvailable: () => true,
    });
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId)).toEqual(['A', 'A']);
    expect(calls, 'a same-account sibling retry must not park or rotate the account').toHaveLength(0);
  });

  it('rotates accounts when NO sibling egress IP is available, calling onExhausted EXACTLY once (D-012 constraint 2)', async () => {
    const { pool, calls } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared } = harness(async () => (++n === 1 ? res(429) : res(200)), {
      accounts: [acct('A')],
      pool,
      siblingEgressAvailable: () => false,
    });
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId)).toEqual(['A', 'B']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe('A');
  });

  it('backs off and retries the SAME account on a 529, never rotating (server overload is not an account signal)', async () => {
    const { pool, calls } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared } = harness(async () => (++n === 1 ? res(529) : res(200)), {
      accounts: [acct('A')],
      pool,
      // Even with a sibling available, a 529 takes the same-account backoff branch.
      siblingEgressAvailable: () => true,
    });
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId)).toEqual(['A', 'A']);
    expect(calls, 'a 529 must never park a healthy account for the upstream’s outage').toHaveLength(0);
  });

  it('retries a 529 at most ONCE per account, then stops re-attempting it', async () => {
    const { pool, calls } = makePool([]);
    const { options, prepared } = harness(async () => res(529), {
      accounts: [acct('A')],
      pool,
      siblingEgressAvailable: () => false,
    });
    await executeGatewayRequestKernel(options).catch(() => undefined);
    // one initial + exactly one overload-backoff re-attempt; never an unbounded spin
    expect(prepared.map((p) => p.accountId)).toEqual(['A', 'A']);
    expect(calls).toHaveLength(0);
  });

  it('HARD PIN: the sibling-egress re-attempt still happens, while account rotation stays suppressed (D-011)', async () => {
    // The exact shape D-011 exists for. The kernel declines selectFailover under a
    // hard pin BEFORE consulting the adapter, but selectReattempt is still consulted
    // — so a naive migration turns this recovered 200 into a forwarded 429.
    const { pool, calls } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared } = harness(async () => (++n === 1 ? res(429) : res(200)), {
      accounts: [acct('A')],
      pool,
      pin: { accountId: 'A', mode: 'hard' },
      siblingEgressAvailable: () => true,
    });
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId)).toEqual(['A', 'A']);
    expect(calls, 'a hard pin never rotates').toHaveLength(0);
  });

  it('declines rotation WITHOUT consulting the pool when canRotate() is false (fleet-wide bare-burst, G1)', async () => {
    // onExhausted both PARKS and returns, so checking the veto after calling it
    // would park an account for nothing. The veto must come first.
    const { pool, calls } = makePool([acct('B')]);
    const { options, prepared } = harness(async () => res(429), {
      accounts: [acct('A')],
      pool,
      siblingEgressAvailable: () => false,
      canRotate: () => false,
    });
    await executeGatewayRequestKernel(options).catch(() => undefined);
    expect(prepared.map((p) => p.accountId)).toEqual(['A']);
    expect(calls, 'the suppressed rotate must not park an account as a side effect').toHaveLength(0);
  });

  it('never rotates back to an account already tried', async () => {
    // The pool offers A again after B; the adapter's triedAccounts guard declines.
    const { pool } = makePool([acct('B'), acct('A')]);
    const { options, prepared } = harness(async () => res(429), {
      accounts: [acct('A')],
      pool,
      siblingEgressAvailable: () => false,
    });
    await executeGatewayRequestKernel(options).catch(() => undefined);
    expect(prepared.map((p) => p.accountId)).toEqual(['A', 'B']);
  });

  it('gives every same-account re-attempt a DISTINCT route key (the kernel’s route-cycle guard)', async () => {
    // A repeated key is rejected as a cycle, which is the easiest way to break a
    // D-011 re-attempt silently — so the key carries a monotonic sequence.
    const { pool } = makePool([]);
    let n = 0;
    const { options, routeKeys } = harness(async () => (++n === 1 ? res(429) : res(200)), {
      accounts: [acct('A')],
      pool,
      siblingEgressAvailable: () => true,
    });
    await executeGatewayRequestKernel(options);
    expect(routeKeys).toHaveLength(2);
    expect(new Set(routeKeys).size, 'route keys must be unique across same-account re-attempts').toBe(2);
    expect(routeKeys[0]).toContain('claude:A:initial');
    expect(routeKeys[1]).toContain('claude:A:sibling-egress');
  });

  it('resolves the token PER ATTEMPT, so a rotated-to account presents its OWN bearer', async () => {
    const { pool } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared } = harness(async () => (++n === 1 ? res(429) : res(200)), {
      accounts: [acct('A')],
      pool,
      siblingEgressAvailable: () => false,
    });
    await executeGatewayRequestKernel(options);
    expect(prepared[0]!.headers.authorization).toBe('Bearer A-tok');
    expect(prepared[1]!.headers.authorization, 'the rotation must re-auth, not reuse A’s bearer').toBe('Bearer B-tok');
  });

  it('retries a sibling egress IP on a bare TRANSPORT failure (no response at all)', async () => {
    const { pool, calls } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared } = harness(
      async () => {
        if (++n === 1) throw new Error('ECONNRESET');
        return res(200);
      },
      { accounts: [acct('A')], pool, siblingEgressAvailable: () => true },
    );
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId)).toEqual(['A', 'A']);
    expect(calls).toHaveLength(0);
  });

  // ─── D-013: retry branches decided from the response BODY ──────────────────
  //
  // Each of these is INVISIBLE to status + headers alone, which is the whole
  // reason the classification cannot live in the caller's observeAttempt hook.
  // The matched pair is #1/#2: the SAME 429 status, the same available sibling
  // egress IP, opposite routing — the only difference is the body text.

  it('USAGE CAP: a 429 whose BODY names a session limit rotates the account, even though a sibling egress IP is free', async () => {
    const { pool, calls } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared } = harness(
      async () =>
        ++n === 1
          ? errorRes(429, '{"error":{"message":"You have hit your session limit · resets 10:50am"}}')
          : res(200),
      {
        accounts: [acct('A')],
        pool,
        // Deliberately TRUE: a cap is an ACCOUNT wall, so the sibling-IP retry
        // that a bare-burst would take must NOT be taken here.
        siblingEgressAvailable: () => true,
        classifyResponse: classifier,
      },
    );
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId), 'a capped account must be left, not retried on a new IP').toEqual([
      'A',
      'B',
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.resetAt, "the cap's own reset must park the account, not the short failover backoff").toBe(
      CAP_RESET_AT,
    );
  });

  it('BARE BURST: the same 429 status with a bare body retries the SAME account on a sibling IP (the matched control)', async () => {
    const { pool, calls } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared } = harness(
      async () => (++n === 1 ? errorRes(429, '{"error":{"message":"rate_limit_error"}}') : res(200)),
      { accounts: [acct('A')], pool, siblingEgressAvailable: () => true, classifyResponse: classifier },
    );
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId)).toEqual(['A', 'A']);
    expect(calls, 'a per-IP edge throttle must never park the account').toHaveLength(0);
  });

  it('RATE 429: a windowed 429 rotates instead of taking the sibling IP a bare burst would take', async () => {
    const { pool, calls } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared } = harness(
      async () =>
        ++n === 1 ? errorRes(429, '{"error":{"message":"rate_limit_error"}}', { 'retry-after': '30' }) : res(200),
      { accounts: [acct('A')], pool, siblingEgressAvailable: () => true, classifyResponse: classifier },
    );
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId)).toEqual(['A', 'B']);
    expect(calls).toHaveLength(1);
  });

  it('ORG-DISALLOWED 403 rotates, while a PLAIN 403 is forwarded unretried (same status, different body)', async () => {
    const disallowed = makePool([acct('B')]);
    let n = 0;
    const rotated = harness(
      async () => (++n === 1 ? errorRes(403, '{"error":{"message":"OAuth is disallowed for this org"}}') : res(200)),
      { accounts: [acct('A')], pool: disallowed.pool, classifyResponse: classifier },
    );
    await executeGatewayRequestKernel(rotated.options);
    expect(rotated.prepared.map((p) => p.accountId)).toEqual(['A', 'B']);

    const plain = makePool([acct('B')]);
    const forwardedRes = harness(async () => errorRes(403, '{"error":{"message":"invalid_request"}}'), {
      accounts: [acct('A')],
      pool: plain.pool,
      classifyResponse: classifier,
    });
    await executeGatewayRequestKernel(forwardedRes.options);
    expect(forwardedRes.prepared.map((p) => p.accountId), 'an ordinary 403 is the caller’s to see').toEqual(['A']);
    expect(plain.calls).toHaveLength(0);
  });

  it('a plain 5xx is FORWARDED unretried — `proxy` has no 5xx retry branch, only 429/529, 403 and 401', async () => {
    const { pool, calls } = makePool([acct('B')]);
    let n = 0;
    const { options, prepared } = harness(
      async () => {
        n++;
        return errorRes(500, '{"error":{"message":"internal"}}');
      },
      { accounts: [acct('A')], pool, siblingEgressAvailable: () => true, classifyResponse: classifier },
    );
    await executeGatewayRequestKernel(options);
    expect(prepared.map((p) => p.accountId)).toEqual(['A']);
    expect(n).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('REPLAYS the peeked body downstream byte-for-byte, so classification never truncates a forwarded error', async () => {
    // Longer than one chunk AND longer than the peek would consume in one pull,
    // so a lost-remainder bug cannot hide behind a short body.
    const payload = `{"error":{"message":"invalid_request","detail":"${'x'.repeat(200)}"}}`;
    const { pool } = makePool([]);
    const { options, forwardedBody } = harness(async () => errorRes(403, payload), {
      accounts: [acct('A')],
      pool,
      classifyResponse: classifier,
    });
    await executeGatewayRequestKernel(options);
    expect(forwardedBody()).toBe(payload);
  });

  it('carries the classification into admission.observeAttempt, where the caller fires its penalties (D-012 c1)', async () => {
    const { pool } = makePool([acct('B')]);
    let n = 0;
    const { options, observedClassifications } = harness(
      async () =>
        ++n === 1 ? errorRes(429, '{"error":{"message":"You have hit your session limit"}}') : res(200),
      { accounts: [acct('A')], pool, classifyResponse: classifier },
    );
    await executeGatewayRequestKernel(options);
    expect(observedClassifications[0]).toEqual({ kind: 'usage-cap', resetAt: CAP_RESET_AT });
    // A 2xx is never peeked, so the success attempt classifies as nothing at all.
    expect(observedClassifications[1], 'the hot path must stay unpeeked').toBeNull();
  });

  it('never peeks or classifies a 2xx — the hot path pays nothing for this machinery', async () => {
    let classified = 0;
    const { pool } = makePool([]);
    const { options } = harness(async () => res(200), {
      accounts: [acct('A')],
      pool,
      classifyResponse: (input) => {
        classified++;
        return classifier(input);
      },
    });
    await executeGatewayRequestKernel(options);
    expect(classified).toBe(0);
  });
});
