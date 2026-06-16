/**
 * deploy-accounts-register.test.ts — POST /api/admin/deploy-accounts/register.
 * Focused on the su-c7b4c additions (accounts-pool-tab-2026-06-15): the optional
 * per-account `egress` passthrough (P-003) and the notifySyncInvalidate('accounts.pool')
 * so the Accounts tab refreshes after an add (P-002 UI wiring). The fs write +
 * account-pool logic are mocked; we assert what reaches registerAccount.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  registerAccount: vi.fn((pool: { accounts: unknown[] }, input: Record<string, unknown>) => ({
    accounts: [...pool.accounts, input],
  })),
  updateAccountPool: vi.fn(async (mutator: (p: { accounts: unknown[] }) => unknown) => mutator({ accounts: [] })),
  accountStatus: vi.fn(async () => [] as unknown[]),
  notifySyncInvalidate: vi.fn(),
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
    | { id: string; credentialRef: string; label?: string; egress?: { proxyUrl?: string; localAddress?: string } }
    | undefined;
}

beforeEach(() => {
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

  it('400s an invalid accountId without writing anything', async () => {
    const { status } = await post({ accountId: 'bad id!', value: OAT });
    expect(status).toBe(400);
    expect(h.registerAccount).not.toHaveBeenCalled();
    expect(h.notifySyncInvalidate).not.toHaveBeenCalled();
  });
});
