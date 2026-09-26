/**
 * P-004 (plan `gateway-kernel-adoption-2026-08-29`) — the Codex ChatGPT-OAuth
 * adapter driven through the REAL `executeGatewayRequestKernel` with NO gateway
 * wiring, exactly as P-002 did for the bearer lane.
 *
 * Each test names the `serveCodexOAuthProxy` behaviour it pins. The ones that
 * matter most are the SAME-ACCOUNT re-attempts (D-011): a 401 refreshes the
 * token and retries the same account, and a transport failure or 429 retries the
 * same account on a sibling egress IP before the account is parked. Neither is
 * gated on the hard pin in the live handler, and neither is counted as a
 * failover — so both are asserted here in their own right.
 */
import { describe, expect, it, vi } from 'vitest';
import { makeGatewayLaneRegistry } from './provider-adapters';
import type { AccountPool, ActiveAccount } from './provider-contracts';
import type { CodexCliAccount } from './codex-cli-bridge';
import type { CodexAuth } from './codex-oauth-proxy';
import {
  createCodexOAuthKernelAdapter,
  type CodexOAuthAdapterOptions,
  type CodexOAuthChunk,
  type CodexOAuthEgressPick,
  type CodexOAuthFetchResponse,
  type CodexOAuthPreparedAttempt,
  type CodexOAuthResponseMetadata,
  type CodexOAuthRouteValue,
} from './codex-oauth-kernel-adapter';
import {
  executeGatewayRequestKernel,
  GatewayRequestKernelError,
  type ExecuteGatewayRequestKernelOptions,
  type GatewayKernelAccountPin,
  type GatewayKernelPolicy,
} from './request-kernel';
import { GatewayRequestTelemetry } from './request-stage-telemetry';

const STRIP_REQUEST = new Set(['host', 'authorization', 'content-length', 'connection']);

const POLICY: GatewayKernelPolicy = {
  maxBodyBytes: 4096,
  bodyReadTimeoutMs: 2_000,
  requestCeilingMs: 10_000,
  ttfbTimeoutMs: 2_000,
  bodyIdleTimeoutMs: 2_000,
  downstreamIdleTimeoutMs: 2_000,
  maxAttempts: 3,
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
const lane = laneRegistry.openaiResponses;

const cli = (accountId: string): CodexCliAccount => ({ accountId, home: `/tmp/${accountId}` });

const authFor = (accountId: string, token: string): CodexAuth => ({
  authMode: 'chatgpt',
  accessToken: token,
  refreshToken: `refresh-${accountId}`,
  accountId,
  idToken: null,
  lastRefresh: null,
});

function sseBody(...chunks: string[]): CodexOAuthFetchResponse['body'] {
  const body = {
    cancelled: 0,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk);
    },
    async cancel() {
      body.cancelled++;
    },
  };
  return body as unknown as CodexOAuthFetchResponse['body'];
}

function upstream(
  status: number,
  headers: Record<string, string>,
  body: CodexOAuthFetchResponse['body'],
): CodexOAuthFetchResponse {
  return {
    status,
    headers: {
      forEach(callback) {
        for (const [key, value] of Object.entries(headers)) callback(value, key);
      },
    },
    body,
  };
}

/**
 * Rotation pool scripted by the test, mirroring how the live `codexCliPool`
 * parks the failing account and hands back the next. `active()` THROWS: the
 * adapter must never call it (D-010 — `proxyOpenAi` already spent this
 * request's one `active()` call above the kernel cut).
 */
function makePool(rotation: Array<{ accountId: string } | null>) {
  const exhaustedCalls: Array<{ id: string; resetAt: number }> = [];
  let cursor = 0;
  const pool: AccountPool & { exhaustedCalls: typeof exhaustedCalls } = {
    exhaustedCalls,
    active: () => {
      throw new Error('the OAuth adapter must never advance the pool (D-010)');
    },
    select: () => null,
    onExhausted: (exhaustedId: string, resetAt: number) => {
      exhaustedCalls.push({ id: exhaustedId, resetAt });
      return (rotation[cursor++] ?? null) as ReturnType<AccountPool['onExhausted']>;
    },
  };
  return pool;
}

interface HarnessOverrides {
  accounts?: CodexCliAccount[];
  pool?: ReturnType<typeof makePool>;
  pin?: GatewayKernelAccountPin | null;
  streaming?: boolean;
  requestHeaders?: Record<string, string | string[] | undefined>;
  resolveAccessToken?: CodexOAuthAdapterOptions['resolveAccessToken'];
  refreshAccessToken?: CodexOAuthAdapterOptions['refreshAccessToken'];
  pickEgress?: CodexOAuthAdapterOptions['pickEgress'];
  siblingEgressAvailable?: CodexOAuthAdapterOptions['siblingEgressAvailable'];
  dispatcherFor?: CodexOAuthAdapterOptions['dispatcherFor'];
  rateReset?: CodexOAuthAdapterOptions['rateReset'];
  /** WI-10003306 model-refusal wiring (model / onModelRefused / onModelServed / selectAlternate). */
  extra?: Partial<CodexOAuthAdapterOptions>;
}

function harness(fetchImpl: CodexOAuthAdapterOptions['fetch'], overrides: HarnessOverrides = {}) {
  const telemetry = new GatewayRequestTelemetry();
  const written: string[] = [];
  const started: Array<{ status: number; metadata: CodexOAuthResponseMetadata; streaming: boolean }> = [];
  const prepared: CodexOAuthPreparedAttempt[] = [];
  const cooled: Array<{ key: string; ms: number }> = [];
  const accounts = overrides.accounts ?? [cli('chatgpt-a')];
  const tokens = new Map<string, string>(accounts.map((a) => [a.accountId, `${a.accountId}-tok`]));

  const resolveAccessToken =
    overrides.resolveAccessToken ??
    (async (home: string) => {
      const account = accounts.find((a) => a.home === home);
      if (!account) throw new Error(`no auth.json at ${home}`);
      return authFor(account.accountId, tokens.get(account.accountId)!);
    });
  const refreshAccessToken =
    overrides.refreshAccessToken ??
    (async (home: string, current: CodexAuth) => {
      const account = accounts.find((a) => a.home === home)!;
      return authFor(account.accountId, `${current.accessToken}-refreshed`);
    });

  const adapter = createCodexOAuthKernelAdapter({
    initialAccount: accounts[0]!,
    accounts: () => accounts,
    pool: overrides.pool,
    upstreamUrl: 'https://chatgpt.test/backend-api/codex/responses',
    method: 'POST',
    requestHeaders: overrides.requestHeaders ?? { 'content-type': 'application/json', host: 'gateway.local' },
    stripRequestHeaders: STRIP_REQUEST,
    streaming: overrides.streaming ?? true,
    tokenTimeoutMs: 1_000,
    failoverBackoffMs: 5_000,
    ipCooldownMaxMs: 60_000,
    transportCooldownMs: 30_000,
    resolveAccessToken,
    refreshAccessToken,
    buildHeaders: ({ base, accessToken, accountId }) => ({
      ...base,
      authorization: `Bearer ${accessToken}`,
      ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
      'accept-encoding': 'identity',
    }),
    pickEgress: overrides.pickEgress ?? ((account) => ({ entry: undefined, key: `${account.accountId}:default` })),
    siblingEgressAvailable: overrides.siblingEgressAvailable ?? (() => false),
    coolIp: (key, ms) => cooled.push({ key, ms }),
    dispatcherFor: overrides.dispatcherFor ?? (() => undefined),
    fetch: fetchImpl,
    rateReset: overrides.rateReset ?? (() => ({ resetAt: null, retryAfterMs: null })),
    ...overrides.extra,
  });

  const observedAdapter: typeof adapter = {
    ...adapter,
    async prepareAttempt(context) {
      const result = await adapter.prepareAttempt(context);
      prepared.push(result);
      return result;
    },
  };

  async function* body() {
    yield Buffer.from('{"model":"gpt-5.5","stream":true}');
  }

  const options: ExecuteGatewayRequestKernelOptions<
    CodexOAuthRouteValue,
    CodexOAuthPreparedAttempt,
    CodexOAuthChunk,
    CodexOAuthResponseMetadata
  > = {
    request: {
      lane,
      body: body(),
      ownerId: 'su-codex-oauth-adapter',
      correlationId: 'codex-oauth-adapter-test',
      pin: overrides.pin ?? null,
    },
    policy: POLICY,
    telemetry,
    admission: { async run(_context, task) { return task(); } },
    adapter: observedAdapter,
    downstream: {
      start: (response) => {
        started.push({ status: response.status, metadata: response.metadata, streaming: response.streaming });
      },
      write: (chunk) => {
        written.push(Buffer.from(chunk).toString());
      },
      end: () => undefined,
    },
    inFlight: { register: () => ({ unregister: () => undefined }) },
  };

  return { options, written, started, prepared, cooled };
}

describe('codex OAuth kernel adapter — happy path and header discipline', () => {
  it('serves the resolved account, reporting it and the egress key on the metadata', async () => {
    const { options, started, written } = harness(async () => upstream(200, {}, sseBody('data: hi\n\n')));

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 200, attempts: 1, failovers: 0 });
    expect(started[0]?.metadata.accountId).toBe('chatgpt-a');
    expect(started[0]?.metadata.egressKey).toBe('chatgpt-a:default');
    expect(started[0]?.metadata.pinYieldedFrom).toBeNull();
    expect(written.join('')).toBe('data: hi\n\n');
  });

  it('strips hop-by-hop/downstream credentials and injects the OAuth bearer + account id', async () => {
    const { options, prepared } = harness(async () => upstream(200, {}, sseBody('ok')), {
      requestHeaders: {
        host: 'gateway.local',
        authorization: 'Bearer downstream-secret',
        'content-length': '33',
        'content-type': 'application/json',
        'x-forwarded-multi': ['a', 'b'],
      },
    });

    await executeGatewayRequestKernel(options);

    const headers = prepared[0]!.headers;
    expect(headers.host).toBeUndefined();
    expect(headers['content-length']).toBeUndefined();
    expect(headers.authorization).toBe('Bearer chatgpt-a-tok');
    expect(headers['chatgpt-account-id']).toBe('chatgpt-a');
    expect(headers['accept-encoding']).toBe('identity');
    expect(headers['x-forwarded-multi']).toBe('a, b');
  });

  it('reports the REQUEST-derived streaming flag, not the response content type', async () => {
    // An error response to a streaming request is still a streaming request.
    const { options, started } = harness(async () => upstream(200, { 'content-type': 'application/json' }, sseBody('{}')), {
      streaming: true,
    });

    await executeGatewayRequestKernel(options);

    expect(started[0]?.streaming).toBe(true);
  });
});

describe('codex OAuth kernel adapter — 401 refresh is a re-attempt, not a failover (D-011)', () => {
  it('refreshes the token and retries the SAME account without counting a failover', async () => {
    const seen: string[] = [];
    const { options, started } = harness(async (_url, init) => {
      seen.push(init.headers.authorization!);
      return seen.length === 1
        ? upstream(401, {}, sseBody('{"error":"expired"}'))
        : upstream(200, {}, sseBody('{"ok":true}'));
    });

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 200, attempts: 2, failovers: 0 });
    expect(seen).toEqual(['Bearer chatgpt-a-tok', 'Bearer chatgpt-a-tok-refreshed']);
    expect(started[0]?.metadata.accountId).toBe('chatgpt-a');
  });

  it('passes the selected egress dispatcher into the OAuth refresh callback', async () => {
    const dispatcher = { egress: 'chatgpt-a:ip1' };
    const refreshDispatchers: unknown[] = [];
    const { options } = harness(
      async () =>
        refreshDispatchers.length === 0
          ? upstream(401, {}, sseBody('{"error":"expired"}'))
          : upstream(200, {}, sseBody('{"ok":true}')),
      {
        pickEgress: () => ({ entry: 'egress-entry', key: 'chatgpt-a:ip1' }),
        dispatcherFor: async (_account, entry) => {
          expect(entry).toBe('egress-entry');
          return dispatcher;
        },
        refreshAccessToken: async (_home, current, selectedDispatcher) => {
          refreshDispatchers.push(selectedDispatcher);
          return authFor('chatgpt-a', `${current.accessToken}-refreshed`);
        },
      },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 200, attempts: 2, failovers: 0 });
    expect(refreshDispatchers).toEqual([dispatcher]);
  });

  it('refreshes even when the account is HARD-pinned — a re-auth does not leave the account', async () => {
    // The live 401 path is not gated on `routing.hardPin`, unlike `rotateCli`.
    const seen: string[] = [];
    const { options } = harness(
      async (_url, init) => {
        seen.push(init.headers.authorization!);
        return seen.length === 1 ? upstream(401, {}, sseBody('nope')) : upstream(200, {}, sseBody('ok'));
      },
      { pin: { accountId: 'chatgpt-a', mode: 'hard' } },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 200, attempts: 2, failovers: 0 });
    expect(seen[1]).toBe('Bearer chatgpt-a-tok-refreshed');
  });

  it('forwards a persistent 401 after exactly ONE refresh instead of rotating or looping', async () => {
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const seen: string[] = [];
    const { options, started } = harness(
      async (_url, init) => {
        seen.push(init.headers.authorization!);
        return upstream(401, {}, sseBody('{"error":"still bad"}'));
      },
      { accounts: [cli('chatgpt-a'), cli('chatgpt-b')], pool },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result.status).toBe(401);
    expect(seen).toHaveLength(2);
    // A 401 is recoverable only by refresh — it must not park the account.
    expect(pool.exhaustedCalls).toEqual([]);
    expect(started[0]?.metadata.accountId).toBe('chatgpt-a');
  });

  it('rotates when the REFRESH itself fails, matching the live handler', async () => {
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const seen: string[] = [];
    const { options, started } = harness(
      async (_url, init) => {
        seen.push(init.headers['chatgpt-account-id']!);
        return seen.length === 1 ? upstream(401, {}, sseBody('nope')) : upstream(200, {}, sseBody('ok'));
      },
      {
        accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
        pool,
        refreshAccessToken: async () => {
          throw new Error('refresh grant rejected');
        },
      },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 200, failovers: 1 });
    expect(started[0]?.metadata.accountId).toBe('chatgpt-b');
  });
});

describe('codex OAuth kernel adapter — sibling-egress re-attempt precedes rotation (D-011)', () => {
  it('retries the SAME account on a sibling IP after a transport failure, without a failover', async () => {
    const keys = ['chatgpt-a:ip1', 'chatgpt-a:ip2'];
    let pick = 0;
    const attempts: string[] = [];
    const { options, cooled, started } = harness(
      async () => {
        attempts.push('call');
        if (attempts.length === 1) throw new Error('proxy unreachable');
        return upstream(200, {}, sseBody('ok'));
      },
      {
        pool: makePool([{ accountId: 'chatgpt-b' }]),
        accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
        pickEgress: () => ({ entry: undefined, key: keys[Math.min(pick++, keys.length - 1)]! }),
        siblingEgressAvailable: () => true,
      },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 200, attempts: 2, failovers: 0 });
    // The failed IP is cooled, and the retry stayed on the same account.
    expect(cooled).toEqual([{ key: 'chatgpt-a:ip1', ms: 30_000 }]);
    expect(started[0]?.metadata.accountId).toBe('chatgpt-a');
    expect(started[0]?.metadata.egressKey).toBe('chatgpt-a:ip2');
  });

  it('rotates the account when no sibling IP is available', async () => {
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const seen: string[] = [];
    const { options, started } = harness(
      async (_url, init) => {
        seen.push(init.headers['chatgpt-account-id']!);
        if (seen.length === 1) throw new Error('proxy unreachable');
        return upstream(200, {}, sseBody('ok'));
      },
      { accounts: [cli('chatgpt-a'), cli('chatgpt-b')], pool, siblingEgressAvailable: () => false },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 200, failovers: 1 });
    expect(started[0]?.metadata.accountId).toBe('chatgpt-b');
    expect(pool.exhaustedCalls[0]?.id).toBe('chatgpt-a');
  });

  it('cools the throttled IP from the rate-reset header on a 429 before re-attempting', async () => {
    let pick = 0;
    const keys = ['chatgpt-a:ip1', 'chatgpt-a:ip2'];
    const calls: number[] = [];
    const { options, cooled } = harness(
      async () => {
        calls.push(1);
        return calls.length === 1
          ? upstream(429, { 'retry-after': '12' }, sseBody('{"error":"rate"}'))
          : upstream(200, {}, sseBody('ok'));
      },
      {
        pickEgress: () => ({ entry: undefined, key: keys[Math.min(pick++, keys.length - 1)]! }),
        siblingEgressAvailable: () => true,
        rateReset: () => ({ resetAt: null, retryAfterMs: 12_000 }),
      },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 200, failovers: 0 });
    expect(cooled).toEqual([{ key: 'chatgpt-a:ip1', ms: 12_000 }]);
  });

  it('caps a 429 IP cooldown at the configured maximum', async () => {
    let pick = 0;
    const keys = ['chatgpt-a:ip1', 'chatgpt-a:ip2'];
    const calls: number[] = [];
    const { options, cooled } = harness(
      async () => {
        calls.push(1);
        return calls.length === 1 ? upstream(429, {}, sseBody('rate')) : upstream(200, {}, sseBody('ok'));
      },
      {
        pickEgress: () => ({ entry: undefined, key: keys[Math.min(pick++, keys.length - 1)]! }),
        siblingEgressAvailable: () => true,
        rateReset: () => ({ resetAt: null, retryAfterMs: 999_999_999 }),
      },
    );

    await executeGatewayRequestKernel(options);

    expect(cooled).toEqual([{ key: 'chatgpt-a:ip1', ms: 60_000 }]);
  });
});

describe('codex OAuth kernel adapter — rotation, credentials, and pool discipline', () => {
  it('NEVER advances the pool for initial selection (D-010)', async () => {
    // `makePool().active()` throws. The adapter takes the account the caller
    // already resolved, so a double-advance is structurally impossible.
    const { options, started } = harness(async () => upstream(200, {}, sseBody('ok')), {
      pool: makePool([]),
      accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
    });

    const result = await executeGatewayRequestKernel(options);

    expect(result.status).toBe(200);
    expect(started[0]?.metadata.accountId).toBe('chatgpt-a');
  });

  it('rotates on a token-resolve failure and reports the pin yield', async () => {
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const { options, started } = harness(async () => upstream(200, {}, sseBody('ok')), {
      accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
      pool,
      pin: { accountId: 'chatgpt-a', mode: 'soft' },
      resolveAccessToken: async (home: string) => {
        if (home === '/tmp/chatgpt-a') throw new Error('no usable auth.json');
        return authFor('chatgpt-b', 'chatgpt-b-tok');
      },
    });

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 200, failovers: 1 });
    expect(started[0]?.metadata.accountId).toBe('chatgpt-b');
    expect(started[0]?.metadata.pinYieldedFrom).toBe('chatgpt-a');
  });

  it('surfaces a 503 when no account can produce a token', async () => {
    const { options } = harness(async () => upstream(200, {}, sseBody('ok')), {
      resolveAccessToken: async () => {
        throw new Error('no usable auth.json');
      },
    });

    await expect(executeGatewayRequestKernel(options)).rejects.toMatchObject({
      code: 'upstream-error',
      status: 503,
    });
  });

  it('does not rotate back to an account it already tried', async () => {
    // The kernel throws `route-cycle` on a repeated KEY, but this adapter's keys
    // carry a sequence number, so the account-level guard must be explicit.
    const pool = makePool([{ accountId: 'chatgpt-b' }, { accountId: 'chatgpt-a' }]);
    const { options } = harness(async () => upstream(500, {}, sseBody('boom')), {
      accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
      pool,
    });

    const result = await executeGatewayRequestKernel(options);

    // a -> b, then the pool offers `a` again; the adapter declines and the 500 is
    // forwarded rather than cycling.
    expect(result).toMatchObject({ status: 500, failovers: 1 });
  });

  it('forwards a hard-pinned 429 rather than rotating off the pinned account', async () => {
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const { options, started } = harness(async () => upstream(429, {}, sseBody('{"error":"rate"}')), {
      accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
      pool,
      pin: { accountId: 'chatgpt-a', mode: 'hard' },
    });

    const result = await executeGatewayRequestKernel(options);

    expect(result.status).toBe(429);
    expect(started[0]?.metadata.accountId).toBe('chatgpt-a');
    expect(pool.exhaustedCalls).toEqual([]);
  });
});

/**
 * WI-10003306 — a ChatGPT account that refuses the request MODEL. The live incident: two
 * subscriptions answered every premium model with this 400 while four siblings served it, the
 * gateway forwarded the 400 as final, and sessions failed "intermittently, on all models".
 */
describe('codex OAuth kernel adapter — model refusal fails over without parking (WI-10003306)', () => {
  const REFUSAL = `{"detail":"The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account."}`;
  const byAccount =
    (responses: Record<string, () => CodexOAuthFetchResponse>): CodexOAuthAdapterOptions['fetch'] =>
    async (_url, init) =>
      responses[init.diagnosticAccountId ?? '']!();

  it('moves the SAME request to a non-refusing account, records the refusal, and never parks the refuser', async () => {
    const pool = makePool([{ accountId: 'chatgpt-b' }]);
    const refused: Array<{ accountId: string; model: string; status: number }> = [];
    const served: Array<{ accountId: string; model: string }> = [];
    const excludes: string[][] = [];
    const { options, started, written } = harness(
      byAccount({
        'chatgpt-a': () => upstream(400, { 'content-type': 'application/json' }, sseBody(REFUSAL)),
        'chatgpt-b': () => upstream(200, {}, sseBody('data: ok\n\n')),
      }),
      {
        accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
        pool,
        extra: {
          model: 'gpt-6-sol',
          onModelRefused: ({ accountId, model, status }) => refused.push({ accountId, model, status }),
          onModelServed: (info) => served.push(info),
          selectAlternate: (exclude) => {
            excludes.push([...exclude]);
            return { accountId: 'chatgpt-b' };
          },
        },
      },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 200, failovers: 1 });
    expect(started).toHaveLength(1);
    expect(started[0]?.metadata.accountId).toBe('chatgpt-b');
    expect(written.join('')).toBe('data: ok\n\n');
    expect(refused).toEqual([{ accountId: 'chatgpt-a', model: 'gpt-6-sol', status: 400 }]);
    expect(served).toEqual([{ accountId: 'chatgpt-b', model: 'gpt-6-sol' }]);
    expect(excludes).toEqual([['chatgpt-a']]);
    // A model refusal says nothing about capacity for OTHER models: the refuser is not parked.
    expect(pool.exhaustedCalls).toEqual([]);
  });

  it('forwards the truthful 400 (body intact) when no account can serve the model', async () => {
    const refused: string[] = [];
    const { options, started, written } = harness(
      byAccount({ 'chatgpt-a': () => upstream(400, {}, sseBody(REFUSAL)) }),
      {
        accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
        pool: makePool([{ accountId: 'chatgpt-b' }]),
        extra: {
          model: 'gpt-6-sol',
          onModelRefused: ({ accountId }) => refused.push(accountId),
          selectAlternate: () => null,
        },
      },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result.status).toBe(400);
    expect(started[0]?.metadata).toMatchObject({ accountId: 'chatgpt-a', modelRefusal: expect.stringContaining('gpt-6-sol') });
    expect(written.join('')).toBe(REFUSAL);
    expect(refused).toEqual(['chatgpt-a']);
  });

  it('keeps a hard pin strict: the refusal is recorded and forwarded, never rotated', async () => {
    const selectAlternate = vi.fn(() => ({ accountId: 'chatgpt-b' }));
    const refused: string[] = [];
    const { options, started } = harness(
      byAccount({
        'chatgpt-a': () => upstream(400, {}, sseBody(REFUSAL)),
        'chatgpt-b': () => upstream(200, {}, sseBody('ok')),
      }),
      {
        accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
        pool: makePool([{ accountId: 'chatgpt-b' }]),
        pin: { accountId: 'chatgpt-a', mode: 'hard' },
        extra: { model: 'gpt-6-sol', onModelRefused: ({ accountId }) => refused.push(accountId), selectAlternate },
      },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result.status).toBe(400);
    expect(started[0]?.metadata.accountId).toBe('chatgpt-a');
    expect(selectAlternate).not.toHaveBeenCalled();
    expect(refused).toEqual(['chatgpt-a']);
  });

  it('does not treat an ordinary 400 (a malformed request) as a model refusal', async () => {
    const selectAlternate = vi.fn(() => ({ accountId: 'chatgpt-b' }));
    const onModelRefused = vi.fn();
    const { options, written } = harness(
      byAccount({ 'chatgpt-a': () => upstream(400, {}, sseBody('{"detail":"Input must be a list"}')) }),
      {
        accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
        pool: makePool([{ accountId: 'chatgpt-b' }]),
        extra: { model: 'gpt-6-sol', onModelRefused, selectAlternate },
      },
    );

    const result = await executeGatewayRequestKernel(options);

    expect(result).toMatchObject({ status: 400, failovers: 0 });
    expect(written.join('')).toBe('{"detail":"Input must be a list"}');
    expect(onModelRefused).not.toHaveBeenCalled();
    expect(selectAlternate).not.toHaveBeenCalled();
  });

  it('without a request model keeps the legacy behaviour: the refusal is forwarded as final', async () => {
    const selectAlternate = vi.fn(() => ({ accountId: 'chatgpt-b' }));
    const { options } = harness(byAccount({ 'chatgpt-a': () => upstream(400, {}, sseBody(REFUSAL)) }), {
      accounts: [cli('chatgpt-a'), cli('chatgpt-b')],
      pool: makePool([{ accountId: 'chatgpt-b' }]),
      extra: { selectAlternate },
    });

    const result = await executeGatewayRequestKernel(options);

    expect(result.status).toBe(400);
    expect(selectAlternate).not.toHaveBeenCalled();
  });
});
