import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../deployment/account-pool-store', () => ({ loadAccountPool: vi.fn() }));
vi.mock('../deployment/account-pool', () => ({ accountByCredentialRef: vi.fn() }));

import { resolveBoundAccount, resolveAccountPool, poolAccountIdForRef } from './account-resolver';
import { loadAccountPool } from '../deployment/account-pool-store';
import { accountByCredentialRef } from '../deployment/account-pool';

const mockedLoad = vi.mocked(loadAccountPool);
const mockedByRef = vi.mocked(accountByCredentialRef);

const acct = (id: string, credentialRef: string) => ({ id, credentialRef });

describe('resolveBoundAccount', () => {
  const savedAccountId = process.env.PAPERCUSP_ACCOUNT_ID;
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PAPERCUSP_ACCOUNT_ID;
  });
  afterEach(() => {
    if (savedAccountId === undefined) delete process.env.PAPERCUSP_ACCOUNT_ID;
    else process.env.PAPERCUSP_ACCOUNT_ID = savedAccountId;
  });

  it('uses the env-pinned account when PAPERCUSP_ACCOUNT_ID matches a pool account', async () => {
    process.env.PAPERCUSP_ACCOUNT_ID = 'acct-b';
    mockedLoad.mockResolvedValue({ accounts: [acct('acct-a', 'ref:a'), acct('acct-b', 'ref:b')] } as never);
    expect(await resolveBoundAccount('ws')).toEqual({
      accountId: 'acct-b', credentialRef: 'ref:b', source: 'env',
    });
  });

  it('throws when the env-pinned account id is not in the pool', async () => {
    process.env.PAPERCUSP_ACCOUNT_ID = 'missing';
    mockedLoad.mockResolvedValue({ accounts: [acct('acct-a', 'ref:a')] } as never);
    await expect(resolveBoundAccount('ws')).rejects.toThrow(/not in the account pool/);
  });

  it('carries the account egress (per-account IP routing, B-GW-3) through to the resolved account', async () => {
    // End-to-end leg: the resolver must NOT drop a registered account's egress, else the gateway
    // never builds its per-account dispatcher and all subscriptions share one egress IP.
    process.env.PAPERCUSP_ACCOUNT_ID = 'acct-b';
    mockedLoad.mockResolvedValue({
      accounts: [acct('acct-a', 'ref:a'), { id: 'acct-b', credentialRef: 'ref:b', egress: { proxyUrl: 'http://10.0.0.2:3128' } }],
    } as never);
    expect(await resolveBoundAccount('ws')).toEqual({
      accountId: 'acct-b', credentialRef: 'ref:b', egress: { proxyUrl: 'http://10.0.0.2:3128' }, source: 'env',
    });
  });

  it('uses the sole pool account when there is no env pin and exactly one account', async () => {
    mockedLoad.mockResolvedValue({ accounts: [acct('only', 'ref:only')] } as never);
    expect(await resolveBoundAccount('ws')).toEqual({
      accountId: 'only', credentialRef: 'ref:only', source: 'sole-pool-account',
    });
  });

  it('falls back to the local login bundle when the pool is empty', async () => {
    mockedLoad.mockResolvedValue({ accounts: [] } as never);
    const r = await resolveBoundAccount('ws');
    expect(r.accountId).toBe('local');
    expect(r.source).toBe('local-fallback');
    expect(r.credentialRef).toMatch(/^file:.*\.claude\/\.credentials\.json$/);
  });

  it('falls back to local when >1 account and no env pin (ambiguous → safe default)', async () => {
    mockedLoad.mockResolvedValue({ accounts: [acct('a', 'ref:a'), acct('b', 'ref:b')] } as never);
    expect((await resolveBoundAccount('ws')).source).toBe('local-fallback');
  });

  it('FAILS CLOSED on a pool-load error — throws rather than silently using the local credential', async () => {
    // Regression (silent-local-fallback fault): a swallowed read error used to collapse the
    // lifetime-cached pool to `local`, silently ignoring every account pin for hours. A load
    // FAILURE must fail closed (the supervised gateway exits → systemd restarts → retries); only a
    // genuinely EMPTY pool resolves to local.
    mockedLoad.mockRejectedValue(new Error('pg down'));
    await expect(resolveBoundAccount('ws')).rejects.toThrow(/account-pool load failed/);
  });

  it('trims surrounding whitespace on PAPERCUSP_ACCOUNT_ID before matching a pool account', async () => {
    process.env.PAPERCUSP_ACCOUNT_ID = '  acct-b  ';
    mockedLoad.mockResolvedValue({ accounts: [acct('acct-a', 'ref:a'), acct('acct-b', 'ref:b')] } as never);
    expect(await resolveBoundAccount('ws')).toEqual({ accountId: 'acct-b', credentialRef: 'ref:b', source: 'env' });
  });

  it('treats a whitespace-only PAPERCUSP_ACCOUNT_ID as NO pin (falls through to the sole pool account)', async () => {
    process.env.PAPERCUSP_ACCOUNT_ID = '   ';
    mockedLoad.mockResolvedValue({ accounts: [acct('only', 'ref:only')] } as never);
    expect(await resolveBoundAccount('ws')).toEqual({ accountId: 'only', credentialRef: 'ref:only', source: 'sole-pool-account' });
  });
});

describe('resolveAccountPool (EI-535 failover)', () => {
  const savedAccountId = process.env.PAPERCUSP_ACCOUNT_ID;
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PAPERCUSP_ACCOUNT_ID;
  });
  afterEach(() => {
    if (savedAccountId === undefined) delete process.env.PAPERCUSP_ACCOUNT_ID;
    else process.env.PAPERCUSP_ACCOUNT_ID = savedAccountId;
  });

  it('returns ALL pool accounts in order when there is no pin (not ambiguous → use them all)', async () => {
    mockedLoad.mockResolvedValue({ accounts: [acct('a', 'ref:a'), acct('b', 'ref:b')] } as never);
    expect((await resolveAccountPool('ws')).map((p) => p.accountId)).toEqual(['a', 'b']);
  });

  it('filters provider-specific pools and does not mix Codex accounts into the Claude pool', async () => {
    mockedLoad.mockResolvedValue({
      accounts: [
        acct('claude-a', 'ref:claude-a'),
        { id: 'codex-a', provider: 'codex', credentialRef: 'ref:codex-a' },
      ],
    } as never);
    expect((await resolveAccountPool('ws')).map((p) => p.accountId)).toEqual(['claude-a']);
    expect((await resolveAccountPool('ws', 'codex')).map((p) => p.accountId)).toEqual(['codex-a']);
  });

  it('puts the env-pinned account FIRST (primary) with the rest as failover targets', async () => {
    process.env.PAPERCUSP_ACCOUNT_ID = 'b';
    mockedLoad.mockResolvedValue({ accounts: [acct('a', 'ref:a'), acct('b', 'ref:b'), acct('c', 'ref:c')] } as never);
    const pool = await resolveAccountPool('ws');
    expect(pool.map((p) => p.accountId)).toEqual(['b', 'a', 'c']);
    expect(pool[0].source).toBe('env');
  });

  it('throws when the pinned id is not in the pool', async () => {
    process.env.PAPERCUSP_ACCOUNT_ID = 'missing';
    mockedLoad.mockResolvedValue({ accounts: [acct('a', 'ref:a')] } as never);
    await expect(resolveAccountPool('ws')).rejects.toThrow(/not in the account pool/);
  });

  it('carries each account egress through (end-to-end per-account IP routing, B-GW-3)', async () => {
    // Both egress forms (proxyUrl + bound localAddress) and a no-egress account must survive the
    // resolve → so the gateway can route each account through its own dispatcher (or shared default).
    mockedLoad.mockResolvedValue({
      accounts: [
        { id: 'a', credentialRef: 'ref:a', egress: { proxyUrl: 'http://10.0.0.1:3128' } },
        { id: 'b', credentialRef: 'ref:b', egress: { localAddress: '10.0.0.2' } },
        acct('c', 'ref:c'),
      ],
    } as never);
    const pool = await resolveAccountPool('ws');
    expect(pool.map((p) => p.egress)).toEqual([
      { proxyUrl: 'http://10.0.0.1:3128' },
      { localAddress: '10.0.0.2' },
      undefined,
    ]);
  });

  it('carries each account egress POOL through (gateway-per-account-egress-ip-pool-2026-06-30)', async () => {
    // An account's egressPool must survive the resolve path so the gateway can rotate across its IPs.
    // A {} entry means "the box-direct IP" — a valid distinct egress, not a no-op. An account with
    // only the singular `egress` must still carry that field (the resolver does not touch it). An
    // account with neither must come through with both fields undefined.
    mockedLoad.mockResolvedValue({
      accounts: [
        { id: 'a', credentialRef: 'ref:a', egressPool: [{ proxyUrl: 'http://10.0.0.1:3128' }, {}] },
        { id: 'b', credentialRef: 'ref:b', egress: { proxyUrl: 'http://10.0.0.2:3128' } },
        acct('c', 'ref:c'),
      ],
    } as never);
    const pool = await resolveAccountPool('ws');
    expect(pool.map((p) => p.egressPool)).toEqual([
      [{ proxyUrl: 'http://10.0.0.1:3128' }, {}],
      undefined,
      undefined,
    ]);
    // singular egress is still carried for the single-egress account
    expect(pool[1].egress).toEqual({ proxyUrl: 'http://10.0.0.2:3128' });
  });

  it('falls back to a single local account when the pool is empty', async () => {
    mockedLoad.mockResolvedValue({ accounts: [] } as never);
    const pool = await resolveAccountPool('ws');
    expect(pool).toHaveLength(1);
    expect(pool[0].source).toBe('local-fallback');
  });

  it('FAILS CLOSED on a pool-load error — throws rather than degrading to the local credential', async () => {
    mockedLoad.mockRejectedValue(new Error('pg down'));
    await expect(resolveAccountPool('ws')).rejects.toThrow(/account-pool load failed/);
  });

  it('retries a TRANSIENT load error then succeeds (a PG blip must not collapse the pool)', async () => {
    mockedLoad
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValue({ accounts: [acct('a', 'ref:a'), acct('b', 'ref:b')] } as never);
    expect((await resolveAccountPool('ws')).map((p) => p.accountId)).toEqual(['a', 'b']);
  });

  it('retries up to POOL_LOAD_ATTEMPTS (3): succeeds on the LAST attempt after 2 transient failures', async () => {
    mockedLoad
      .mockRejectedValueOnce(new Error('blip-1'))
      .mockRejectedValueOnce(new Error('blip-2'))
      .mockResolvedValue({ accounts: [acct('a', 'ref:a')] } as never);
    expect((await resolveAccountPool('ws')).map((p) => p.accountId)).toEqual(['a']);
    expect(mockedLoad).toHaveBeenCalledTimes(3);
  });

  it('fails closed after EXACTLY POOL_LOAD_ATTEMPTS (3) attempts — does not retry forever', async () => {
    mockedLoad.mockRejectedValue(new Error('pg down'));
    await expect(resolveAccountPool('ws')).rejects.toThrow(/account-pool load failed/);
    expect(mockedLoad).toHaveBeenCalledTimes(3);
  });

  it('an EMPTY codex pool resolves to [] — codex has no local-login fallback (only claude does)', async () => {
    // Only a claude account is registered; the codex pool is empty. claude empty → local fallback,
    // but codex empty MUST return [] (there is no box-local codex login to degrade to).
    mockedLoad.mockResolvedValue({ accounts: [acct('claude-a', 'ref:claude-a')] } as never);
    expect(await resolveAccountPool('ws', 'codex')).toEqual([]);
  });

  it('trims surrounding whitespace on PAPERCUSP_ACCOUNT_ID when choosing the primary', async () => {
    process.env.PAPERCUSP_ACCOUNT_ID = '  b  ';
    mockedLoad.mockResolvedValue({ accounts: [acct('a', 'ref:a'), acct('b', 'ref:b'), acct('c', 'ref:c')] } as never);
    expect((await resolveAccountPool('ws')).map((p) => p.accountId)).toEqual(['b', 'a', 'c']);
  });
});

describe('poolAccountIdForRef', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the account id for a known credential ref', () => {
    mockedByRef.mockReturnValue(acct('acct-x', 'ref:x') as never);
    expect(poolAccountIdForRef({ accounts: [] }, 'ref:x')).toBe('acct-x');
  });

  it('returns undefined for an unknown credential ref', () => {
    mockedByRef.mockReturnValue(undefined as never);
    expect(poolAccountIdForRef({ accounts: [] }, 'ref:nope')).toBeUndefined();
  });
});
