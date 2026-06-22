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

import { loadAccountPool, saveAccountPool, handleAccountExhausted, accountStatus } from '../../deployment/account-pool-store';
import { getAccount } from '../../deployment/account-pool';
const loadM = vi.mocked(loadAccountPool);
const saveM = vi.mocked(saveAccountPool);
const exhaustM = vi.mocked(handleAccountExhausted);
const getAcct = vi.mocked(getAccount);
const statusM = vi.mocked(accountStatus);

const mod = await import('./accounts');
const registerTool = mod.default;
const removeTool = mod.accountsRemoveTool;
const resetTool = mod.accountsResetRateTool;
const scaleTool = mod.accountsScaleOutTool;
const statusTool = mod.accountsStatusTool;
const listTool = mod.accountsListTool;

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

describe('accounts:remove (bulk keyed-array, P-006)', () => {
  it('n=1 { id } reports removed:true when the account existed; one keyed result', async () => {
    getAcct.mockReturnValue({ id: 'A1' } as never);
    const b = body(await removeTool.handler({ id: 'A1' } as never, {} as never) as Out);
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'A1', removed: true });
    expect(saveM).toHaveBeenCalledTimes(1);
  });

  it('reports removed:false when the account did not exist', async () => {
    getAcct.mockReturnValue(undefined as never);
    const b = body(await removeTool.handler({ id: 'ghost' } as never, {} as never) as Out);
    expect(b.results[0]).toMatchObject({ ok: true, id: 'ghost', removed: false });
  });

  it('ids:[…] removes many, each result keyed by id', async () => {
    getAcct.mockImplementation((_pool: unknown, id: string) => (id === 'A1' ? ({ id } as never) : (undefined as never)));
    const b = body(await removeTool.handler({ ids: ['A1', 'gone'] } as never, {} as never) as Out);
    expect(b.counts).toEqual({ ok: 2, failed: 0 }); // both remove ops succeed; `removed` differs
    expect(b.results.map((r: any) => [r.id, r.removed])).toEqual([
      ['A1', true],
      ['gone', false],
    ]);
    expect(saveM).toHaveBeenCalledTimes(2);
  });
});

describe('accounts:reset-rate (bulk keyed-array, P-006)', () => {
  it('n=1 guards unknown_account as that item\'s { ok:false } and does NOT save', async () => {
    getAcct.mockReturnValue(undefined as never);
    const b = body(await resetTool.handler({ id: 'ghost' } as never, {} as never) as Out);
    expect(b).toMatchObject({ ok: true, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'ghost', error: 'unknown_account' });
    expect(saveM).not.toHaveBeenCalled();
  });

  it('resets a known account and saves; one keyed result', async () => {
    getAcct.mockReturnValue({ id: 'A1' } as never);
    const b = body(await resetTool.handler({ id: 'A1' } as never, {} as never) as Out);
    expect(b.results[0]).toMatchObject({ ok: true, id: 'A1', account: { id: 'A1' } });
    expect(saveM).toHaveBeenCalledTimes(1);
  });

  it('ids:[…] resets many; an unknown one fails ONLY itself (no save for it)', async () => {
    getAcct.mockImplementation((_pool: unknown, id: string) => (id === 'gone' ? (undefined as never) : ({ id } as never)));
    const b = body(await resetTool.handler({ ids: ['A1', 'gone', 'A2'] } as never, {} as never) as Out);
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 2, failed: 1 });
    expect(b.results.map((r: any) => [r.id, r.ok])).toEqual([
      ['A1', true],
      ['gone', false],
      ['A2', true],
    ]);
    expect(b.results[1]).toMatchObject({ error: 'unknown_account' });
    expect(saveM).toHaveBeenCalledTimes(2); // only the two known accounts saved
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

describe('accounts:status', () => {
  // The DONE criterion of the accounts:* control surface (B-GW-ACCT / gateway-live-control D-004):
  // `accounts:status` must reflect each account's EGRESS MAPPING (the per-account IP pin), so the
  // owner can see "account X → its own outbound IP" alongside rate headroom. This pins that the tool
  // surfaces `egress` verbatim from the read-model — a regression would hide which account egresses
  // through which proxy IP.
  it('surfaces each account row, INCLUDING its per-account egress mapping', async () => {
    statusM.mockResolvedValue([
      {
        id: 'A1',
        label: 'acct-1',
        credentialRef: 'token:/p',
        boundTo: [],
        available: true,
        sustainedlyLimited: false,
        rate: {} as never,
        egress: { proxyUrl: 'http://38.229.109.7:3128' },
        liveBuckets: [],
      },
      // An account with no egress pin (shared default egress) — `egress` must be absent, not faked.
      {
        id: 'A2',
        label: 'acct-2',
        credentialRef: 'token:/q',
        boundTo: [],
        available: false,
        sustainedlyLimited: true,
        rate: {} as never,
        liveBuckets: [],
      },
    ] as never);
    const b = body(await statusTool.handler({} as never, {} as never) as Out);
    expect(b.ok).toBe(true);
    expect(b.accounts).toHaveLength(2);
    expect(b.accounts[0]).toMatchObject({ id: 'A1', egress: { proxyUrl: 'http://38.229.109.7:3128' } });
    expect(b.accounts[1].id).toBe('A2');
    expect(b.accounts[1].egress).toBeUndefined();
  });

  it('passes the workspace arg through to the status read-model', async () => {
    statusM.mockResolvedValue([] as never);
    await statusTool.handler({ workspace: 'ws-7' } as never, {} as never);
    expect(statusM).toHaveBeenCalledWith('ws-7');
  });
});

describe('accounts:list', () => {
  it('returns the pool accounts including their egress pins', async () => {
    loadM.mockResolvedValue({
      accounts: [
        { id: 'A1', credentialRef: 'token:/p', label: 'acct-1', boundTo: [], rate: {}, egress: { localAddress: '203.0.113.7' } },
      ],
    } as never);
    const b = body(await listTool.handler({} as never, {} as never) as Out);
    expect(b.ok).toBe(true);
    expect(b.accounts[0]).toMatchObject({ id: 'A1', egress: { localAddress: '203.0.113.7' } });
  });
});
