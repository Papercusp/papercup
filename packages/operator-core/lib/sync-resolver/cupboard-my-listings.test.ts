import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../cupboard/my-listings', () => ({ readMyCupboardListings: h.read }));
import { getRegistryEntryV2, resolveNamedQueryV2 } from './index';
beforeEach(() => h.read.mockReset());
describe('cupboard.myListings sync query', () => {
  it('uses the authenticated shared client and preserves failures', async () => {
    h.read.mockResolvedValue({ ok: false, error: 'gh_auth_required', status: 401 });
    await expect(resolveNamedQueryV2('cupboard.myListings', { limit: 20, cursor: '20' })).resolves.toEqual([
      { ok: false, error: 'gh_auth_required', status: 401 },
    ]);
    expect(h.read).toHaveBeenCalledExactlyOnceWith({ limit: 20, cursor: '20' });
    expect(getRegistryEntryV2('cupboard.myListings')?.backingTables).toEqual([]);
  });
  it.each([{ ownerId: 'foreign' }, { token: 'secret' }, { limit: 201 }, { cursor: '-1' }])('rejects authority or malformed navigation %j', async args => {
    await expect(resolveNamedQueryV2('cupboard.myListings', args)).rejects.toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });
});
