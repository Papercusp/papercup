import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInferenceGateway, OWNER_HEADER, ROUTED_ACCOUNT_HEADER } from './gateway';
import { createFailoverPool } from './account-failover';

let gateway: ReturnType<typeof createInferenceGateway> | undefined;
const homes: string[] = [];

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  await Promise.all(homes.splice(0).map(home => fs.rm(home, { recursive: true, force: true })));
});

async function codexHome(accountId: string): Promise<string> {
  const home = await fs.mkdtemp(join(tmpdir(), `gateway-hot-failover-${accountId}-`));
  homes.push(home);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const accessToken = `${encode({ alg: 'none' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  await fs.writeFile(join(home, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: accessToken, refresh_token: `refresh-${accountId}`, account_id: accountId },
  }));
  return home;
}

describe('proxyOpenAi — Codex OAuth reachability and quota failover', () => {
  it('moves the next retry off an account whose HTTP-200 stream fails after the prelude lookahead', async () => {
    const accounts = [
      { accountId: 'chatgpt-a', home: await codexHome('chatgpt-a') },
      { accountId: 'chatgpt-b', home: await codexHome('chatgpt-b') },
    ];
    const routed: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const account = new Headers(init?.headers).get('chatgpt-account-id') ?? '';
      routed.push(account);
      return new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
          await new Promise((resolve) => setTimeout(resolve, 250));
          const event = account === 'chatgpt-a'
            ? { type: 'response.failed', response: { error: { code: 'server_error', message: 'high demand' } } }
            : { type: 'response.completed', response: { id: 'healthy', status: 'completed', output: [] } };
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
          controller.close();
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    gateway = createInferenceGateway({
      accountId: 'claude-acct', token: async () => 'claude-tok', fetchImpl,
      codexCliAccounts: () => accounts,
      codexCliPool: createFailoverPool(accounts.map(({ accountId }) => ({ accountId, token: async () => 'unused' }))),
      codexOAuthProxy: true, selfHeal: { enabled: false },
      maxAttempts: 4,
    });
    const port = await gateway.listen(0);
    for (const expected of ['high demand', 'response.completed']) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json', [OWNER_HEADER]: 'live-overload-session' },
        body: JSON.stringify({ model: 'gpt-6.1-sol', input: [], stream: true }),
      });
      expect(await response.text()).toContain(expected);
    }
    expect(routed).toEqual(['chatgpt-a', 'chatgpt-b']);
  });

  it('moves a live auto session to a credited account and keeps the new affinity without restarting', async () => {
    const accounts = [
      { accountId: 'chatgpt-a', home: await codexHome('chatgpt-a') },
      { accountId: 'chatgpt-b', home: await codexHome('chatgpt-b') },
    ];
    const routed: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const account = new Headers(init?.headers).get('chatgpt-account-id') ?? '';
      routed.push(account);
      const event = account === 'chatgpt-a'
        ? { type: 'response.failed', response: { error: { code: 'usage_limit_reached', message: 'usage exhausted', resets_at: Math.floor(Date.now() / 1000) + 3600 } } }
        : { type: 'response.completed', response: { id: 'credit-backed-success', output: [] } };
      return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    gateway = createInferenceGateway({
      accountId: 'claude-acct', token: async () => 'claude-tok',
      codexCliAccounts: () => accounts,
      codexCliPool: createFailoverPool(accounts.map(account => ({ accountId: account.accountId, token: async () => '' }))),
      codexOAuthProxy: true, fetchImpl, selfHeal: { enabled: false },
    });
    gateway.setAccountRateHints([
      { accountId: 'chatgpt-a', utilization: 0, utilization7d: 0 },
      { accountId: 'chatgpt-b', utilization7d: 1, windowResetAt7d: Date.now() + 86_400_000, usageCreditsAvailable: true },
    ]);
    const port = await gateway.listen(0);
    for (const input of ['first turn', 'second turn']) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [OWNER_HEADER]: 'one-running-session' },
        body: JSON.stringify({ model: 'gpt-6.1-sol', input, stream: true }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get(ROUTED_ACCOUNT_HEADER)).toBe('chatgpt-b');
      expect(await response.text()).toContain('credit-backed-success');
    }
    expect(routed).toEqual(['chatgpt-a', 'chatgpt-b', 'chatgpt-b']);
    expect(gateway.stats().codex.failovers).toBe(1);
  });

  it('reports an all-account DNS outage separately from a usage wall in /stats', async () => {
    const accountIds = ['chatgpt-a', 'chatgpt-b', 'chatgpt-c'];
    const accounts = await Promise.all(
      accountIds.map(async (accountId) => ({
        accountId,
        home: await codexHome(accountId),
      })),
    );
    const routed: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const account = new Headers(init?.headers).get('chatgpt-account-id') ?? '';
      routed.push(account);
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND chatgpt.com'), {
          code: 'ENOTFOUND',
        }),
      });
    }) as unknown as typeof fetch;
    gateway = createInferenceGateway({
      accountId: 'claude-acct',
      token: async () => 'claude-tok',
      codexCliAccounts: () => accounts,
      codexCliPool: createFailoverPool(
        accounts.map((account) => ({
          accountId: account.accountId,
          token: async () => '',
        })),
      ),
      codexOAuthProxy: true,
      fetchImpl,
      selfHeal: { enabled: false },
      internalRetryDeadlineMs: 500,
    });
    const port = await gateway.listen(0);
    const response = await fetch(
      "http://127.0.0.1:" + port + "/v1/responses",
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', [OWNER_HEADER]: 'dns-outage-session' },
        body: JSON.stringify({ model: 'gpt-6.1-sol', input: 'network check', stream: true }),
      },
    );
    await response.text();

    expect(new Set(routed)).toEqual(new Set(accountIds));
    const statsResponse = await fetch("http://127.0.0.1:" + port + "/stats");
    expect(statsResponse.status).toBe(200);
    const stats = await statsResponse.json() as {
      codex: { upstream429: number };
      codexReachability: {
        unreachable: boolean;
        accountsFailingSinceResponse: number;
        lastTransportFailureKind: string | null;
      };
      codexUnserviceableCause: string | null;
    };
    expect(stats.codex.upstream429).toBe(0);
    expect(stats.codexUnserviceableCause).toBe('upstream-unreachable');
    expect(stats.codexReachability).toMatchObject({
      unreachable: true,
      accountsFailingSinceResponse: 3,
      lastTransportFailureKind: 'dns',
    });
  });
});
