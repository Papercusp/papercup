import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), setDefault: vi.fn(), invalidate: vi.fn() }));
vi.mock('../../cors', () => ({ requireAllowedOriginOr403: () => null }));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'displayed-workspace' }));
vi.mock('../../../deployment/account-session-override', () => ({ getAccountOverride: h.get, setAccountOverride: h.set }));
vi.mock('../../../deployment/account-pool-store', () => ({ setDefaultAccount: h.setDefault }));
vi.mock('../../../sync-sse', () => ({ notifySyncInvalidate: h.invalidate }));
import routes from './deploy-accounts-session-override';

async function post(body: unknown) {
  const response = await routes[1].handler(new Request('http://localhost/api/admin/deploy-accounts/session-override', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) as never, {} as never) as Response;
  return { status: response.status, body: await response.json() };
}
beforeEach(() => {
  vi.clearAllMocks();
  h.set.mockResolvedValue({ forcedAccounts: [], excludeAccounts: [], defaultAccountId: 'preserved' });
  h.setDefault.mockResolvedValue({ forcedAccounts: ['one'], excludeAccounts: [], defaultAccountId: 'chosen' });
  h.invalidate.mockResolvedValue(undefined);
});
describe('scoped native account steering', () => {
  it('refuses a different or malformed displayed workspace before any write', async () => {
    for (const workspaceId of ['another-workspace', '', null, 17]) {
      expect((await post({ workspaceId, forcedAccounts: ['one'] })).status).toBe(409);
    }
    expect(h.set).not.toHaveBeenCalled(); expect(h.setDefault).not.toHaveBeenCalled();
  });
  it('passes Auto to the canonical clear operation and preserves its confirmed default', async () => {
    const result = await post({ workspaceId: 'displayed-workspace', clear: true });
    expect(h.set).toHaveBeenCalledWith('displayed-workspace', { clear: true });
    expect(h.setDefault).not.toHaveBeenCalled();
    expect(result.body.override.defaultAccountId).toBe('preserved');
  });
  it('keeps Default separate from Force and Exclude writes', async () => {
    expect((await post({ workspaceId: 'displayed-workspace', defaultAccountId: 'chosen' })).body.ok).toBe(true);
    expect(h.setDefault).toHaveBeenCalledWith('chosen', 'displayed-workspace');
    expect(h.set).not.toHaveBeenCalled();
  });
  it('reports canonical failures without a successful state or invalidation', async () => {
    h.set.mockRejectedValueOnce(new Error('write denied'));
    const result = await post({ workspaceId: 'displayed-workspace', excludeAccounts: ['one'] });
    expect(result.status).toBe(500); expect(result.body).toEqual({ ok: false, error: 'write denied' });
    expect(h.invalidate).not.toHaveBeenCalled();
  });
});
