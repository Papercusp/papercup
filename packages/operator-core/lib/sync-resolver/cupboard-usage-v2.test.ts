import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../cupboard/metered-invocation-door-io', () => ({ readPrincipalUsagePage: H.read }));
import { getRegistryEntryV2, resolveNamedQueryV2 } from './index';

beforeEach(() => {
  H.read.mockReset();
  H.read.mockResolvedValue({ ok: true, page: { receipts: [], nextCursor: null } });
});

describe('P-018 cupboard.identityUsage named query', () => {
  it('passes bounded navigation into the existing server-authenticated client', async () => {
    const input = { limit: 20, cursor: '["a","b"]' };
    await expect(resolveNamedQueryV2('cupboard.identityUsage', input)).resolves.toEqual([
      { ok: true, page: { receipts: [], nextCursor: null } },
    ]);
    expect(H.read).toHaveBeenCalledExactlyOnceWith(input);
    expect(getRegistryEntryV2('cupboard.identityUsage')?.backingTables).toEqual([]);
  });
  it.each([{ payer: 'foreign' }, { principalId: 'foreign' }, { authToken: 'foreign' }, { limit: 201 }])(
    'refuses caller account/credential selection or unbounded requests (%j)', async input => {
      await expect(resolveNamedQueryV2('cupboard.identityUsage', input)).rejects.toBeTruthy();
      expect(H.read).not.toHaveBeenCalled();
    },
  );
  it('carries unavailable evidence as a failure, rather than a measured empty account', async () => {
    H.read.mockResolvedValue({ ok: false, code: 'gh_auth_required', detail: 'sign in', status: 401 });
    await expect(resolveNamedQueryV2('cupboard.identityUsage', {})).resolves.toEqual([
      { ok: false, code: 'gh_auth_required', detail: 'sign in', status: 401 },
    ]);
  });
});
