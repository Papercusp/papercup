/**
 * accounts.test.ts — the accounts:* HANDLERS (the pure pool ops registerAccount/
 * removeAccount/recordAccountReset + the store load/save are mocked). These manage the
 * Queen's Claude-account pool — the multi-account routing the whole fleet depends on —
 * so the handler wiring is worth pinning:
 *   • register: load→register→save→getAccount, and never-throw (400-char truncation);
 *   • remove: the `removed` flag reflects whether the account existed;
 *   • reset-rate: the unknown_account guard (no save when absent) + the success path;
 *   • scale_out: the force→requireSustained mapping (force skips the sustained check)
 *     and never-throw.
 * A regression in any of these silently breaks account management. Pure-op correctness
 * lives in the account-pool unit tests; this covers the tool layer.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/accounts/accounts.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'default') }));
vi.mock('../../deployment/account-pool-store', () => ({
  loadAccountPool: vi.fn(),
  saveAccountPool: vi.fn(),
  accountStatus: vi.fn(),
  handleAccountExhausted: vi.fn(),
  defaultScaleOutDeps: vi.fn(() => ({})),
}));
vi.mock('../../deployment/account-pool', () => ({
  registerAccount: vi.fn(() => 'POOL2'),
  removeAccount: vi.fn(() => 'POOL2'),
  recordAccountReset: vi.fn(() => 'POOL2'),
  getAccount: vi.fn(() => ({ id: 'A1', label: 'acct' })),
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));

import { loadAccountPool, saveAccountPool, handleAccountExhausted } from '../../deployment/account-pool-store';
import { getAccount } from '../../deployment/account-pool';
const loadM = vi.mocked(loadAccountPool);
const saveM = vi.mocked(saveAccountPool);
const exhaustM = vi.mocked(handleAccountExhausted);
const getAcct = vi.mocked(getAccount);

const mod = await import('./accounts');
const registerTool = mod.default;
const removeTool = mod.accountsRemoveTool;
const resetTool = mod.accountsResetRateTool;
const scaleTool = mod.accountsScaleOutTool;

type Out = { content: { text: string }[] };
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  loadM.mockResolvedValue({ accounts: [] } as never);
  saveM.mockResolvedValue(undefined as never);
  getAcct.mockReturnValue({ id: 'A1', label: 'acct' } as never);
});

describe('accounts:register', () => {
  it('registers, saves, and returns the account', async () => {
    const b = body(await registerTool.handler({ id: 'A1', credentialRef: 'token:/p' } as never, {} as never) as Out);
    expect(b).toMatchObject({ ok: true, account: { id: 'A1' } });
    expect(saveM).toHaveBeenCalledTimes(1);
  });

  it('never throws — a store failure becomes { ok:false, error } truncated to 400', async () => {
    loadM.mockRejectedValue(new Error('y'.repeat(500)));
    const b = body(await registerTool.handler({ id: 'A1', credentialRef: 'token:/p' } as never, {} as never) as Out);
    expect(b.ok).toBe(false);
    expect(String(b.error).length).toBe(400);
  });
});

describe('accounts:remove', () => {
  it('reports removed:true when the account existed', async () => {
    getAcct.mockReturnValue({ id: 'A1' } as never);
    const b = body(await removeTool.handler({ id: 'A1' } as never, {} as never) as Out);
    expect(b).toMatchObject({ ok: true, removed: true, id: 'A1' });
    expect(saveM).toHaveBeenCalledTimes(1);
  });

  it('reports removed:false when the account did not exist', async () => {
    getAcct.mockReturnValue(undefined as never);
    const b = body(await removeTool.handler({ id: 'ghost' } as never, {} as never) as Out);
    expect(b).toMatchObject({ ok: true, removed: false });
  });
});

describe('accounts:reset-rate', () => {
  it('guards unknown_account and does NOT save', async () => {
    getAcct.mockReturnValue(undefined as never);
    const b = body(await resetTool.handler({ id: 'ghost' } as never, {} as never) as Out);
    expect(b).toMatchObject({ ok: false, error: 'unknown_account', id: 'ghost' });
    expect(saveM).not.toHaveBeenCalled();
  });

  it('resets a known account and saves', async () => {
    getAcct.mockReturnValue({ id: 'A1' } as never);
    const b = body(await resetTool.handler({ id: 'A1' } as never, {} as never) as Out);
    expect(b).toMatchObject({ ok: true, account: { id: 'A1' } });
    expect(saveM).toHaveBeenCalledTimes(1);
  });
});

describe('accounts:scale_out', () => {
  it('default (no force) requires the sustained-limit check', async () => {
    exhaustM.mockResolvedValue({ scaledOut: true } as never);
    await scaleTool.handler({ id: 'A1' } as never, {} as never);
    expect(exhaustM.mock.calls[0]![3]).toMatchObject({ requireSustained: true });
  });

  it('force:true skips the sustained-limit check', async () => {
    exhaustM.mockResolvedValue({ scaledOut: true } as never);
    await scaleTool.handler({ id: 'A1', force: true } as never, {} as never);
    expect(exhaustM.mock.calls[0]![3]).toMatchObject({ requireSustained: false });
  });

  it('never throws — a scale-out failure becomes { ok:false, error }', async () => {
    exhaustM.mockRejectedValue(new Error('no capacity'));
    const b = body(await scaleTool.handler({ id: 'A1' } as never, {} as never) as Out);
    expect(b).toMatchObject({ ok: false });
    expect(String(b.error)).toMatch(/no capacity/);
  });
});
