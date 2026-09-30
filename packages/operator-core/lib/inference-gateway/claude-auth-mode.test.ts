/**
 * anthropic-credits-gateway-2026-09-30 P-006 — the Claude credential SHAPE is chosen per
 * ATTEMPT from the account the attempt lands on:
 *   - subscription (oauth) account → `authorization: Bearer` + the `oauth-2025-04-20` beta;
 *   - Console API-key account      → `x-api-key`, no `authorization`, no OAuth beta, every
 *                                     other client beta kept.
 * A request that hits a usage cap on a subscription account can rotate onto an API-key account
 * inside the same request, so the second attempt must switch shape (R-13). A caller can never
 * inject its own credential upstream (R-14).
 *
 * The attempts are driven through the REAL Claude kernel adapter + request kernel (not a copy of
 * the header rule), so a regression in `prepareAttempt`'s wiring fails here, not only a
 * regression in the helper.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeAccount } from '../deployment/account-pool';
import { probeAccountCapacity } from './capacity-probe';
import {
  createClaudeKernelAdapter,
  type ClaudeAdapterOptions,
  type ClaudeFetchResponse,
} from './claude-kernel-adapter';
import {
  CLAUDE_CONTEXT_1M_BETA,
  CLAUDE_OAUTH_BETA,
  claudeAttemptHeaders,
  claudeAuthModeForRef,
  withClientBetas,
} from './credential-store';
import { makeGatewayLaneRegistry } from './provider-adapters';
import type { AccountPool, ActiveAccount } from './provider-contracts';
import { executeGatewayRequestKernel, type GatewayKernelPolicy } from './request-kernel';
import { GatewayRequestTelemetry } from './request-stage-telemetry';

// Built at runtime so no key-shaped literal sits in the tree (the secrets guard is right to flag one).
const API_KEY = ['sk', 'ant', 'api03', 'fixture'].join('-');
const OAUTH_TOKEN = ['sk', 'ant', 'oat01', 'fixture'].join('-');
const OTHER_BETA = 'fine-grained-tool-streaming-2025-05-14';

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
const lane = makeGatewayLaneRegistry({
  claudePool: unusedPool,
  codexPool: null,
  codexCliAccountCount: () => 1,
  anthropicUpstreamBase: 'https://anthropic.test',
  openaiUpstreamBase: 'https://openai.test',
}).anthropicMessages;

const oauthAccount = (accountId = 'sub'): ActiveAccount =>
  ({ accountId, authMode: 'oauth', token: async () => OAUTH_TOKEN }) as ActiveAccount;
const apiKeyAccount = (accountId = 'console'): ActiveAccount =>
  ({ accountId, authMode: 'api-key', token: async () => API_KEY }) as ActiveAccount;

function res(status: number, body = '{"ok":true}'): ClaudeFetchResponse {
  return {
    status,
    headers: { forEach: () => undefined },
    body: (async function* () {
      yield Buffer.from(body);
    })(),
  };
}

/** Mirrors gateway.ts's usage-cap predicate for the one shape these tests need. */
function classifier(input: { status: number; headers: Record<string, string>; body: string }) {
  if (input.status === 429 && /session limit/i.test(input.body))
    return { kind: 'usage-cap' as const, resetAt: 4_000_000_000_000 };
  return { kind: 'forward' as const };
}

/** Run one request through the real adapter + kernel; return the headers each attempt SENT. */
async function runAttempts(opts: {
  initial: ActiveAccount;
  rotation?: ActiveAccount[];
  baseHeaders?: Record<string, string>;
  responses?: ClaudeFetchResponse[];
}): Promise<{ sent: Record<string, string>[]; accountIds: string[] }> {
  const sent: Record<string, string>[] = [];
  const accountIds: string[] = [];
  const responses = [...(opts.responses ?? [])];
  let rotationCursor = 0;
  const pool: AccountPool = {
    active: () => {
      throw new Error('adapter must not call pool.active()');
    },
    select: () => null,
    onExhausted: () => (opts.rotation?.[rotationCursor++] ?? null) as ReturnType<AccountPool['onExhausted']>,
  };
  const fetchImpl: ClaudeAdapterOptions['fetch'] = async (_url, init) => {
    sent.push({ ...(init.headers as Record<string, string>) });
    return responses.shift() ?? res(200);
  };
  const adapter = createClaudeKernelAdapter({
    initialAccount: opts.initial,
    pool,
    upstreamUrl: 'https://anthropic.test/v1/messages',
    method: 'POST',
    baseHeaders: opts.baseHeaders ?? { 'content-type': 'application/json' },
    body: null,
    streaming: true,
    tokenTimeoutMs: 1_000,
    failoverBackoffMs: 5_000,
    overloadBackoffMs: 10,
    transientBackoffMs: 10,
    pickEgress: (account) => ({ entry: undefined, key: `${account.accountId}:ip` }),
    siblingEgressAvailable: () => false,
    dispatcherFor: () => undefined,
    fetch: fetchImpl,
    rateReset: () => ({ resetAt: null, retryAfterMs: null }),
    classifyResponse: classifier,
    peekBytes: 4096,
    peekTimeoutMs: 1_000,
  });
  const observed: typeof adapter = {
    ...adapter,
    async prepareAttempt(context) {
      const prepared = await adapter.prepareAttempt(context);
      accountIds.push(prepared.accountId);
      return prepared;
    },
  };
  await executeGatewayRequestKernel({
    request: {
      lane,
      body: (async function* () {
        yield Buffer.from('{"model":"claude-opus-4"}');
      })(),
      ownerId: 'su-claude-auth-mode',
      correlationId: 'claude-auth-mode-test',
      pin: null,
    },
    policy: POLICY,
    telemetry: new GatewayRequestTelemetry(),
    admission: {
      async run(_context, task) {
        return task();
      },
      observeAttempt: () => undefined,
    },
    adapter: observed,
    downstream: { start: () => undefined, write: () => undefined, end: () => undefined },
    inFlight: { register: () => ({ unregister: () => undefined }) },
  });
  return { sent, accountIds };
}

const lower = (h: Record<string, string>) =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
const betas = (h: Record<string, string>) =>
  (lower(h)['anthropic-beta'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

describe('P-006 — Claude credential shape per attempt', () => {
  it('R-7: an attempt on an api-key account sends the account key in x-api-key', async () => {
    const { sent } = await runAttempts({ initial: apiKeyAccount() });
    expect(sent).toHaveLength(1);
    expect(lower(sent[0]!)['x-api-key']).toBe(API_KEY);
  });

  it('R-8: an attempt on an api-key account sends no Authorization header', async () => {
    const { sent } = await runAttempts({ initial: apiKeyAccount() });
    expect(Object.keys(lower(sent[0]!))).not.toContain('authorization');
  });

  it('R-9: an attempt on an api-key account omits the oauth-2025-04-20 beta flag', async () => {
    const { sent } = await runAttempts({
      initial: apiKeyAccount(),
      baseHeaders: { 'content-type': 'application/json', 'anthropic-beta': `${CLAUDE_OAUTH_BETA},${OTHER_BETA}` },
    });
    expect(betas(sent[0]!)).not.toContain(CLAUDE_OAUTH_BETA);
  });

  it('R-10: an attempt on an api-key account keeps every client beta other than the oauth flag', async () => {
    const { sent } = await runAttempts({
      initial: apiKeyAccount(),
      baseHeaders: {
        'content-type': 'application/json',
        'anthropic-beta': `${CLAUDE_CONTEXT_1M_BETA}, ${OTHER_BETA},${CLAUDE_OAUTH_BETA}`,
      },
    });
    expect(betas(sent[0]!)).toEqual([CLAUDE_CONTEXT_1M_BETA, OTHER_BETA]);
  });

  it('R-10 (edge): an api-key attempt whose only client beta was the oauth flag sends no anthropic-beta header', async () => {
    const { sent } = await runAttempts({
      initial: apiKeyAccount(),
      baseHeaders: { 'content-type': 'application/json', 'anthropic-beta': CLAUDE_OAUTH_BETA },
    });
    expect(Object.keys(lower(sent[0]!))).not.toContain('anthropic-beta');
  });

  it('R-11: an attempt on an oauth account sends Authorization Bearer with the account token', async () => {
    const { sent } = await runAttempts({ initial: oauthAccount() });
    const h = lower(sent[0]!);
    expect(h.authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
    expect(Object.keys(h)).not.toContain('x-api-key');
  });

  it('R-11 (default): an account with no recorded auth mode is treated as a subscription account', async () => {
    const legacy = { accountId: 'legacy', token: async () => OAUTH_TOKEN } as ActiveAccount;
    const { sent } = await runAttempts({ initial: legacy });
    expect(lower(sent[0]!).authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
    expect(betas(sent[0]!)).toContain(CLAUDE_OAUTH_BETA);
  });

  it('R-12: an attempt on an oauth account carries the oauth-2025-04-20 beta flag (client betas kept)', async () => {
    const { sent } = await runAttempts({
      initial: oauthAccount(),
      baseHeaders: { 'content-type': 'application/json', 'anthropic-beta': OTHER_BETA },
    });
    expect(betas(sent[0]!)).toEqual([OTHER_BETA, CLAUDE_OAUTH_BETA]);
  });

  it('R-13: a usage cap on the oauth account rotates to the api-key account, whose attempt carries api-key headers', async () => {
    const { sent, accountIds } = await runAttempts({
      initial: oauthAccount('sub'),
      rotation: [apiKeyAccount('console')],
      baseHeaders: { 'content-type': 'application/json', 'anthropic-beta': CLAUDE_CONTEXT_1M_BETA },
      responses: [res(429, '{"error":{"message":"You have hit your session limit · resets 10:50am"}}'), res(200)],
    });
    expect(accountIds).toEqual(['sub', 'console']);
    expect(sent).toHaveLength(2);
    // First attempt: subscription shape.
    expect(lower(sent[0]!).authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
    expect(betas(sent[0]!)).toContain(CLAUDE_OAUTH_BETA);
    // Second attempt, same request: api-key shape, nothing of the subscription credential left over.
    const second = lower(sent[1]!);
    expect(second['x-api-key']).toBe(API_KEY);
    expect(Object.keys(second)).not.toContain('authorization');
    expect(betas(sent[1]!)).toEqual([CLAUDE_CONTEXT_1M_BETA]);
  });

  it('R-14: a caller-supplied x-api-key header is never forwarded on an oauth attempt', async () => {
    const { sent } = await runAttempts({
      initial: oauthAccount(),
      baseHeaders: {
        'content-type': 'application/json',
        'X-Api-Key': 'caller-injected-key',
        Authorization: 'Bearer caller-injected-token',
      },
    });
    const h = lower(sent[0]!);
    expect(Object.keys(h)).not.toContain('x-api-key');
    expect(Object.values(sent[0]!)).not.toContain('caller-injected-key');
    expect(h.authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
    // Exactly one authorization header survives — the caller's differently-cased one is gone.
    expect(Object.keys(sent[0]!).filter((k) => k.toLowerCase() === 'authorization')).toHaveLength(1);
  });

  it('R-14 (api-key side): a caller x-api-key cannot override the account key on an api-key attempt', async () => {
    const { sent } = await runAttempts({
      initial: apiKeyAccount(),
      baseHeaders: { 'content-type': 'application/json', 'x-api-key': 'caller-injected-key' },
    });
    expect(lower(sent[0]!)['x-api-key']).toBe(API_KEY);
    expect(Object.keys(sent[0]!).filter((k) => k.toLowerCase() === 'x-api-key')).toHaveLength(1);
  });
});

describe('P-006 — supporting surfaces', () => {
  it('claudeAuthModeForRef reads the mode from the ref alone', () => {
    expect(claudeAuthModeForRef('apikey:env:ANTHROPIC_API_KEY')).toBe('api-key');
    expect(claudeAuthModeForRef('apikey:credentials')).toBe('api-key');
    expect(claudeAuthModeForRef('token:/tmp/x')).toBe('oauth');
    expect(claudeAuthModeForRef('env:CLAUDE_CODE_OAUTH_TOKEN')).toBe('oauth');
  });

  it('the gateway request-level beta value carries client betas without the oauth flag', () => {
    expect(withClientBetas(`${OTHER_BETA},${CLAUDE_OAUTH_BETA}`)).toBe(OTHER_BETA);
    expect(withClientBetas(null, true)).toBe(CLAUDE_CONTEXT_1M_BETA);
    expect(withClientBetas(CLAUDE_OAUTH_BETA)).toBeUndefined();
  });

  it('claudeAttemptHeaders leaves non-auth headers untouched', () => {
    const out = claudeAttemptHeaders({ 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, 'api-key', API_KEY);
    expect(out['content-type']).toBe('application/json');
    expect(out['anthropic-version']).toBe('2023-06-01');
  });

  it('the capacity probe authenticates an api-key account with x-api-key and no oauth beta', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const account = {
      id: 'console',
      credentialRef: 'apikey:env:ANTHROPIC_API_KEY',
      rate: { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0 },
    } as ClaudeAccount;
    await probeAccountCapacity(account, { fetchImpl: f, resolveToken: async () => API_KEY, buildDispatcher: async () => undefined }, 0.97);
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = lower(init.headers as Record<string, string>);
    expect(headers['x-api-key']).toBe(API_KEY);
    expect(Object.keys(headers)).not.toContain('authorization');
    expect(headers['anthropic-beta'] ?? '').not.toContain(CLAUDE_OAUTH_BETA);
  });
});
