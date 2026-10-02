/**
 * deploy-accounts-register.test.ts — POST /api/admin/deploy-accounts/register.
 * Focused on the su-c7b4c additions (accounts-pool-tab-2026-06-15): the optional
 * per-account `egress` passthrough (P-003) and the notifySyncInvalidate('accounts.pool')
 * so the Accounts tab refreshes after an add (P-002 UI wiring). The fs write +
 * account-pool logic are mocked; we assert what reaches registerAccount.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  registerAccount: vi.fn((pool: { accounts: unknown[] }, input: Record<string, unknown>) => ({
    accounts: [...pool.accounts, input],
  })),
  updateAccountPool: vi.fn(async (mutator: (p: { accounts: unknown[] }) => unknown) => mutator({ accounts: [] })),
  accountStatus: vi.fn(async () => [] as unknown[]),
  notifySyncInvalidate: vi.fn(),
  gatewayFetch: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  chmod: vi.fn(),
}));

vi.mock('../../cors', () => ({ requireAllowedOriginOr403: () => null }));
vi.mock('node:fs/promises', () => ({ writeFile: h.writeFile, mkdir: h.mkdir, chmod: h.chmod }));
vi.mock('../../../papercusp-root', () => ({ papercuspPath: (...parts: string[]) => '/tmp/test-papercusp/' + parts.join('/') }));
vi.mock('../../../deployment/account-pool', () => ({ registerAccount: h.registerAccount }));
vi.mock('../../../deployment/account-pool-store', () => ({ updateAccountPool: h.updateAccountPool, accountStatus: h.accountStatus }));
vi.mock('../../../sync-sse', () => ({ notifySyncInvalidate: h.notifySyncInvalidate }));

import registerRoute from './deploy-accounts-register';

const OAT = 'sk-ant-oat-' + 'x'.repeat(24);

async function post(body: unknown) {
  const req = new Request('http://127.0.0.1/api/admin/deploy-accounts/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1' },
    body: JSON.stringify(body),
  });
  const res = (await registerRoute.handler(req as never, {} as never)) as Response;
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

function lastRegisterInput() {
  return h.registerAccount.mock.calls[0]?.[1] as
    | { id: string; provider?: 'claude' | 'codex'; credentialRef: string; label?: string; egress?: { proxyUrl?: string; localAddress?: string } }
    | undefined;
}

beforeEach(() => {
  h.gatewayFetch.mockReset();
  h.gatewayFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, changed: true, version: 7, accounts: ['aviynw_3'] })));
  vi.stubGlobal('fetch', h.gatewayFetch);
  h.registerAccount.mockClear();
  h.updateAccountPool.mockClear();
  h.accountStatus.mockClear();
  h.accountStatus.mockResolvedValue([]);
  h.notifySyncInvalidate.mockReset();
  h.notifySyncInvalidate.mockResolvedValue(undefined);
  h.writeFile.mockReset();
  h.writeFile.mockResolvedValue(undefined);
  h.mkdir.mockReset();
  h.mkdir.mockResolvedValue(undefined);
  h.chmod.mockReset();
  h.chmod.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/admin/deploy-accounts/register — egress + invalidation (su-c7b4c)', () => {
  it('passes egress through to registerAccount + invalidates the tab', async () => {
    const { status } = await post({
      accountId: 'a1',
      value: OAT,
      egress: { proxyUrl: 'socks5://1.2.3.4:9050', localAddress: '10.0.0.4' },
    });
    expect(status).toBe(200);
    expect(lastRegisterInput()?.egress).toEqual({ proxyUrl: 'socks5://1.2.3.4:9050', localAddress: '10.0.0.4' });
    expect(h.notifySyncInvalidate).toHaveBeenCalledWith('accounts.pool', {});
  });

  it('omits egress entirely when neither field is given (no empty object)', async () => {
    await post({ accountId: 'a2', value: OAT });
    expect(lastRegisterInput()?.egress).toBeUndefined();
  });

  it('trims a blank egress field to undefined but keeps the set one', async () => {
    await post({ accountId: 'a3', value: OAT, egress: { proxyUrl: '   ', localAddress: '10.0.0.5' } });
    expect(lastRegisterInput()?.egress).toEqual({ proxyUrl: undefined, localAddress: '10.0.0.5' });
  });

  it('registers a setup-token as a token: credentialRef', async () => {
    await post({ accountId: 'a4', value: OAT });
    expect(lastRegisterInput()?.credentialRef).toMatch(/^token:/);
  });

  it('registers a Codex env credential without writing a token file', async () => {
    const { status } = await post({ accountId: 'codex-main', provider: 'codex', value: 'env:OPENAI_API_KEY' });
    expect(status).toBe(200);
    expect(lastRegisterInput()).toMatchObject({
      id: 'codex-main',
      provider: 'codex',
      credentialRef: 'env:OPENAI_API_KEY',
    });
    expect(h.writeFile).not.toHaveBeenCalled();
  });

  it('registers a pasted Codex bearer token as a private token file', async () => {
    const { status } = await post({ accountId: 'codex-file', provider: 'codex', value: 'sk-openai-test-token' });
    expect(status).toBe(200);
    expect(lastRegisterInput()).toMatchObject({
      id: 'codex-file',
      provider: 'codex',
      credentialRef: 'token:/tmp/test-papercusp/deploy-credentials/codex-file.codex',
    });
    expect(h.writeFile).toHaveBeenCalledWith(
      '/tmp/test-papercusp/deploy-credentials/codex-file.codex',
      'sk-openai-test-token',
      { mode: 0o600 },
    );
  });

  it('hot-applies an updated Codex account to the live gateway after saving it', async () => {
    const { status, body } = await post({
      accountId: 'aviynw_3',
      provider: 'codex',
      value: 'env:PAPERCUSP_TEST_OPENAI_KEY',
    });
    expect(status).toBe(200);
    expect(h.gatewayFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8788/admin/reload',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(body?.gatewayReload).toEqual({ appliedLive: true, changed: true, version: 7 });
  });

  it('keeps a durable registration successful and reports when live apply fails', async () => {
    h.gatewayFetch.mockRejectedValueOnce(new Error('connection refused'));
    const { status, body } = await post({
      accountId: 'aviynw_3',
      provider: 'codex',
      value: 'env:PAPERCUSP_TEST_OPENAI_KEY',
    });
    expect(status).toBe(200);
    expect(body?.ok).toBe(true);
    expect(body?.gatewayReload).toMatchObject({
      appliedLive: false,
      warning: expect.stringMatching(/next ~60s pool poll/),
    });
  });

  it('400s an invalid accountId without writing anything', async () => {
    const { status } = await post({ accountId: 'bad id!', value: OAT });
    expect(status).toBe(400);
    expect(h.registerAccount).not.toHaveBeenCalled();
    expect(h.notifySyncInvalidate).not.toHaveBeenCalled();
    expect(h.gatewayFetch).not.toHaveBeenCalled();
  });

  // 2026-07-03 hardening: the two ways a paste goes wrong.
  it('collapses whitespace in a pasted setup-token (a terminal line-wrap embeds a newline)', async () => {
    // The WI-1919 corruption shape: the paste wrapped mid-token — written raw it kills every
    // gateway request on the account with `Headers.append: invalid header value`.
    const wrapped = 'sk-ant-oat01-first-half\nsecond-half\n';
    const { status, body } = await post({ accountId: 'wrapped', value: wrapped });
    expect(status).toBe(200);
    expect(body?.ok).toBe(true);
    expect(h.writeFile).toHaveBeenCalledWith(
      '/tmp/test-papercusp/deploy-credentials/wrapped',
      'sk-ant-oat01-first-halfsecond-half',
      { mode: 0o600 },
    );
  });

  it('names the mistake when the owner pastes an OAuth code#state instead of a token', async () => {
    const { status, body } = await post({
      accountId: 'aviynw10',
      value: '7QKpvlNB2RrBaPOJZiVuNGyMsOYVxuLB6zNneU5Y8Z6xNWkw#70gGhlXv0l-eJMzcmEvX3nEq1DRDMgOHxbhRCsP-vY0',
    });
    expect(status).toBe(400);
    expect(String(body?.error)).toMatch(/OAuth code/i);
    expect(String(body?.error)).toMatch(/browser-login flow/);
    expect(h.registerAccount).not.toHaveBeenCalled();
  });
});
