/**
 * session-override.test.ts — the accounts:set-session-override / accounts:get-session-override
 * TOOL wrappers. The owner's session-now steer over WHICH pool accounts the fleet may
 * spawn/deploy on (forcedAccounts allow-list + excludeAccounts skip-list). The store logic lives
 * in account-session-override.test.ts; this pins the tool layer:
 *   • set: forwards forcedAccounts/excludeAccounts/clear into the patch (omitting undefined keys),
 *     returns { ok, override }, and never throws (a store failure becomes { ok:false, error });
 *   • get: returns { ok, override } from the store.
 * This is the live "pull an account out of rotation without removing it from the pool" lever
 * (excludeAccounts) — the capability that supersedes a separate accounts:exclude/include pair.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/accounts/session-override.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'default') }));
vi.mock('../../deployment/account-session-override', () => ({
  getAccountOverride: vi.fn(),
  setAccountOverride: vi.fn(),
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));

import { getAccountOverride, setAccountOverride } from '../../deployment/account-session-override';
const getM = vi.mocked(getAccountOverride);
const setM = vi.mocked(setAccountOverride);

const mod = await import('./session-override');
const setTool = mod.accountsSetSessionOverrideTool;
const getTool = mod.accountsGetSessionOverrideTool;

type Out = { content: { text: string }[] };
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  setM.mockResolvedValue({ forcedAccounts: [], excludeAccounts: [] } as never);
  getM.mockResolvedValue({ forcedAccounts: [], excludeAccounts: [] } as never);
});

describe('accounts:set-session-override', () => {
  it('forwards excludeAccounts into the patch and returns the new override', async () => {
    const next = { forcedAccounts: [], excludeAccounts: ['acct-b'] };
    setM.mockResolvedValue(next as never);
    const b = body(await setTool.handler({ excludeAccounts: ['acct-b'] } as never, {} as never) as Out);
    expect(b).toMatchObject({ ok: true, override: next });
    // ws falls back to activeWorkspaceId() ('default'); patch carries ONLY the provided axis.
    expect(setM).toHaveBeenCalledWith('default', { excludeAccounts: ['acct-b'] });
  });

  it('forwards forcedAccounts (allow-list) into the patch', async () => {
    await setTool.handler({ forcedAccounts: ['acct-a'] } as never, {} as never);
    expect(setM).toHaveBeenCalledWith('default', { forcedAccounts: ['acct-a'] });
  });

  it('forwards clear:true and omits the unset axes', async () => {
    await setTool.handler({ clear: true } as never, {} as never);
    expect(setM).toHaveBeenCalledWith('default', { clear: true });
  });

  it('honours an explicit workspace arg', async () => {
    await setTool.handler({ excludeAccounts: [], workspace: 'ws-9' } as never, {} as never);
    expect(setM).toHaveBeenCalledWith('ws-9', { excludeAccounts: [] });
  });

  it('never throws — a store failure becomes { ok:false, error }', async () => {
    setM.mockRejectedValue(new Error('store down'));
    const b = body(await setTool.handler({ clear: true } as never, {} as never) as Out);
    expect(b.ok).toBe(false);
    expect(String(b.error)).toMatch(/store down/);
  });
});

describe('accounts:get-session-override', () => {
  it('returns the current override from the store', async () => {
    const cur = { forcedAccounts: ['acct-a'], excludeAccounts: ['acct-b'] };
    getM.mockResolvedValue(cur as never);
    const b = body(await getTool.handler({} as never, {} as never) as Out);
    expect(b).toMatchObject({ ok: true, override: cur });
    expect(getM).toHaveBeenCalledWith('default');
  });
});
