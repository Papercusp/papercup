/**
 * accounts:probe-capacity — the persistence wiring around a FAILED probe (EI-18809949582687481).
 * A probe that never got a response (`ok:false`, "no-reading") must NOT be silently dropped: it
 * must stamp `lastProbeFailedAt` on the account so `accounts:status` can tell "we just asked and
 * got nothing" apart from "no one has asked in days". A SUCCESSFUL probe must still record the
 * window as before (and clear any stale failure marker — covered in account-pool.test.ts).
 *
 * The pure pool ops (`recordAccountWindow` / `recordProbeFailure`) are the REAL implementations
 * here (their own correctness is pinned in account-pool.test.ts); only IO (load/save the pool,
 * the actual upstream probe) is mocked, so this test pins the WIRING between them.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/accounts/probe-capacity.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyPool, registerAccount, getAccount, type AccountPool } from '../../deployment/account-pool';

vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'default') }));

let pool: AccountPool = emptyPool();

vi.mock('../../deployment/account-pool-store', () => ({
  loadAccountPool: vi.fn(async () => pool),
  updateAccountPool: vi.fn(async (mutator: (p: AccountPool) => AccountPool) => {
    pool = mutator(pool);
    return pool;
  }),
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));

const probeM = vi.fn();
vi.mock('../../inference-gateway/capacity-probe', () => ({ probeCapacityForAccounts: probeM }));

const gatewayFetchM = vi.fn();

const mod = await import('./probe-capacity');
const tool = mod.default;

type Out = { data?: any; content?: Array<{ text: string }> };
const body = (o: Out) => o.data ?? JSON.parse(o.content![0].text);

const T0 = 1_000_000_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', gatewayFetchM);
  gatewayFetchM.mockResolvedValue(
    new Response(JSON.stringify({ readmitted: ['a'], healthyAccounts: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  pool = emptyPool();
  pool = registerAccount(pool, { id: 'a', credentialRef: 'token:~/.papercusp/a' }, T0);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('accounts:probe-capacity — failure persistence', () => {
  it('a no-reading result stamps lastProbeFailedAt on the account', async () => {
    probeM.mockResolvedValue([
      { accountId: 'a', ok: false, windows: {}, before: {}, unwalls: false, error: 'fetch failed' },
    ]);
    const out = body((await tool.handler({} as never, {} as never)) as Out);
    expect(out.ok).toBe(true);
    expect(out.failed).toEqual(['a']);
    expect(out.applied).toEqual([]);
    expect(getAccount(pool, 'a')!.rate.lastProbeFailedAt).toEqual(expect.any(Number));
  });

  it('does not stamp lastProbeFailedAt when apply:false (dry run)', async () => {
    probeM.mockResolvedValue([
      { accountId: 'a', ok: false, windows: {}, before: {}, unwalls: false, error: 'fetch failed' },
    ]);
    await tool.handler({ apply: false } as never, {} as never);
    expect(getAccount(pool, 'a')!.rate.lastProbeFailedAt).toBeUndefined();
  });

  it('a successful probe records the window and does NOT touch lastProbeFailedAt on other accounts', async () => {
    probeM.mockResolvedValue([
      { accountId: 'a', ok: true, status: 200, windows: { utilization: 0.5 }, before: {}, unwalls: false },
    ]);
    const out = body((await tool.handler({} as never, {} as never)) as Out);
    expect(out.applied).toEqual(['a']);
    expect(getAccount(pool, 'a')!.rate.utilization).toBe(0.5);
    expect(getAccount(pool, 'a')!.rate.lastProbeFailedAt).toBeUndefined();
  });

  it('a prior failure marker is cleared once a later probe succeeds', async () => {
    probeM.mockResolvedValue([
      { accountId: 'a', ok: false, windows: {}, before: {}, unwalls: false, error: 'fetch failed' },
    ]);
    await tool.handler({} as never, {} as never);
    expect(getAccount(pool, 'a')!.rate.lastProbeFailedAt).toBeDefined();

    probeM.mockResolvedValue([
      { accountId: 'a', ok: true, status: 200, windows: { utilization: 0.3 }, before: {}, unwalls: false },
    ]);
    await tool.handler({} as never, {} as never);
    expect(getAccount(pool, 'a')!.rate.lastProbeFailedAt).toBeUndefined();
  });

  it('readmits only serving Claude accounts with an account selector', async () => {
    pool = registerAccount(pool, { id: 'walled', credentialRef: 'token:~/.papercusp/walled' }, T0 + 1);
    pool = registerAccount(
      pool,
      { id: 'codex-account', provider: 'codex', credentialRef: 'codex-cli:/tmp/codex' },
      T0 + 2,
    );
    probeM.mockResolvedValue([
      { accountId: 'a', ok: true, status: 200, windows: {}, before: {}, unwalls: false },
      { accountId: 'walled', ok: true, status: 429, windows: {}, before: {}, unwalls: false },
      { accountId: 'codex-account', ok: true, status: 200, windows: {}, before: {}, unwalls: false },
    ]);

    const out = body((await tool.handler({} as never, {} as never)) as Out);

    expect(out.serving).toEqual(['a', 'codex-account']);
    expect(gatewayFetchM).toHaveBeenCalledTimes(1);
    expect(gatewayFetchM.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8788/admin/readmit?account=a');
    expect(out.gatewayReadmitted).toEqual(['a']);
  });
});
