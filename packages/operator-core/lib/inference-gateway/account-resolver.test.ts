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

  it('treats a pool-load failure as an empty pool (→ local fallback)', async () => {
    mockedLoad.mockRejectedValue(new Error('pg down'));
    expect((await resolveBoundAccount('ws')).source).toBe('local-fallback');
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

  it('falls back to a single local account when the pool is empty', async () => {
    mockedLoad.mockResolvedValue({ accounts: [] } as never);
    const pool = await resolveAccountPool('ws');
    expect(pool).toHaveLength(1);
    expect(pool[0].source).toBe('local-fallback');
  });

  it('treats a pool-load failure as empty (→ single local account)', async () => {
    mockedLoad.mockRejectedValue(new Error('pg down'));
    const pool = await resolveAccountPool('ws');
    expect(pool).toHaveLength(1);
    expect(pool[0].accountId).toBe('local');
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
