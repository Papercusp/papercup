/**
 * egress.test.ts — the egress:provision/list/release/health tool wiring (B-PROV, WI-288). The
 * underlying EgressProvider backends are unit-tested in `inference-gateway/egress-providers/*.test.ts`;
 * this pins the thin tool layer: provider creation → allocate/register/verify → account-pool writes.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/egress/egress.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'default') }));
vi.mock('../../deployment/account-pool-store', () => ({
  loadAccountPool: vi.fn(),
  saveAccountPool: vi.fn(),
}));
vi.mock('../../inference-gateway/egress-probe', () => ({ testEgressForAccount: vi.fn() }));

const allocateMock = vi.fn();
const releaseMock = vi.fn();
const listMock = vi.fn();
const healthcheckMock = vi.fn();
const createEgressProviderMock = vi.fn(() => ({
  name: 'static',
  allocate: allocateMock,
  release: releaseMock,
  list: listMock,
  healthcheck: healthcheckMock,
}));
vi.mock('../../inference-gateway/egress-providers', () => ({
  createEgressProvider: (...args: unknown[]) => createEgressProviderMock(...args),
}));

import { loadAccountPool, saveAccountPool } from '../../deployment/account-pool-store';
import { testEgressForAccount } from '../../inference-gateway/egress-probe';

const loadM = vi.mocked(loadAccountPool);
const saveM = vi.mocked(saveAccountPool);
const verifyM = vi.mocked(testEgressForAccount);

const mod = await import('./egress');
const provisionTool = mod.default;
const { egressListTool, egressReleaseTool, egressHealthTool } = mod;

type Out = { data?: any; content?: Array<{ text: string }> };
const body = (o: Out) => (o.data ?? JSON.parse(o.content![0].text));

const baseAccount = { id: 'acct-a', provider: 'claude', credentialRef: 'token:/x', label: undefined };

beforeEach(() => {
  vi.clearAllMocks();
  loadM.mockResolvedValue({ accounts: [{ ...baseAccount }] } as never);
  saveM.mockResolvedValue(undefined as never);
  verifyM.mockResolvedValue({ accountId: 'acct-a', clean: true } as never);
});

describe('egress:provision', () => {
  it('unknown account → { ok:false, error: account_not_found }', async () => {
    loadM.mockResolvedValue({ accounts: [] } as never);
    const b = body((await provisionTool.handler({ provider: 'static', accountId: 'nope' } as never, {} as never)) as Out);
    expect(b).toMatchObject({ ok: false, error: 'account_not_found', accountId: 'nope' });
    expect(createEgressProviderMock).not.toHaveBeenCalled();
  });

  it('allocates, registers onto the pool, and verifies — writes providerId/providerAllocationId', async () => {
    allocateMock.mockResolvedValue({ id: 'ip-1', proxyUrl: 'http://10.0.0.1:3128', accountId: 'acct-a' });
    const b = body(
      (await provisionTool.handler(
        { provider: 'static', accountId: 'acct-a', config: { entries: [{ id: 'ip-1', proxyUrl: 'http://10.0.0.1:3128' }] } } as never,
        {} as never,
      )) as Out,
    );
    expect(createEgressProviderMock).toHaveBeenCalledWith('static', { entries: [{ id: 'ip-1', proxyUrl: 'http://10.0.0.1:3128' }] });
    expect(allocateMock).toHaveBeenCalledWith('acct-a');
    expect(saveM).toHaveBeenCalledTimes(1);
    const savedPool = saveM.mock.calls[0][0] as { accounts: Array<{ id: string; egress?: unknown }> };
    expect(savedPool.accounts[0].egress).toEqual({
      proxyUrl: 'http://10.0.0.1:3128',
      localAddress: undefined,
      providerId: 'static',
      providerAllocationId: 'ip-1',
    });
    expect(verifyM).toHaveBeenCalled();
    expect(b).toMatchObject({ ok: true, allocation: { id: 'ip-1' }, verify: { clean: true } });
  });

  it('dryRun allocates + verifies but does NOT write the pool', async () => {
    allocateMock.mockResolvedValue({ id: 'ip-1', proxyUrl: 'http://10.0.0.1:3128', accountId: 'acct-a' });
    const b = body(
      (await provisionTool.handler({ provider: 'static', accountId: 'acct-a', dryRun: true } as never, {} as never)) as Out,
    );
    expect(saveM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ ok: true, dryRun: true, allocation: { id: 'ip-1' } });
  });

  it('provider returning no binding → provider_returned_no_binding, no pool write', async () => {
    allocateMock.mockResolvedValue({ id: 'ip-1' });
    const b = body((await provisionTool.handler({ provider: 'static', accountId: 'acct-a' } as never, {} as never)) as Out);
    expect(b).toMatchObject({ ok: false, error: 'provider_returned_no_binding' });
    expect(saveM).not.toHaveBeenCalled();
  });

  it('a provider allocate() throw is caught and surfaced as { ok:false, error }', async () => {
    allocateMock.mockRejectedValue(new Error('egress: static provider pool exhausted'));
    const b = body((await provisionTool.handler({ provider: 'static', accountId: 'acct-a' } as never, {} as never)) as Out);
    expect(b).toMatchObject({ ok: false });
    expect(b.error).toMatch(/exhausted/);
  });
});

describe('egress:list', () => {
  it('returns provider.list() as allocations', async () => {
    listMock.mockResolvedValue([{ id: 'ip-1', proxyUrl: 'http://10.0.0.1:3128' }]);
    const b = body((await egressListTool.handler({ provider: 'static' } as never, {} as never)) as Out);
    expect(b).toMatchObject({ ok: true, allocations: [{ id: 'ip-1' }] });
  });
});

describe('egress:release', () => {
  it('releases provider-side only when accountId is omitted', async () => {
    const b = body((await egressReleaseTool.handler({ provider: 'static', id: 'ip-1' } as never, {} as never)) as Out);
    expect(releaseMock).toHaveBeenCalledWith('ip-1');
    expect(saveM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ ok: true, released: true, accountCleared: false });
  });

  it('also clears the account egress when it matches providerId+providerAllocationId', async () => {
    loadM.mockResolvedValue({
      accounts: [{ ...baseAccount, egress: { proxyUrl: 'http://10.0.0.1:3128', providerId: 'static', providerAllocationId: 'ip-1' } }],
    } as never);
    const b = body(
      (await egressReleaseTool.handler({ provider: 'static', id: 'ip-1', accountId: 'acct-a' } as never, {} as never)) as Out,
    );
    expect(saveM).toHaveBeenCalledTimes(1);
    const savedPool = saveM.mock.calls[0][0] as { accounts: Array<{ egress?: unknown }> };
    expect(savedPool.accounts[0].egress).toEqual({});
    expect(b).toMatchObject({ ok: true, accountCleared: true });
  });

  it('does NOT clear the account when its egress points at a DIFFERENT allocation', async () => {
    loadM.mockResolvedValue({
      accounts: [{ ...baseAccount, egress: { proxyUrl: 'http://10.0.0.9:3128', providerId: 'static', providerAllocationId: 'ip-9' } }],
    } as never);
    const b = body(
      (await egressReleaseTool.handler({ provider: 'static', id: 'ip-1', accountId: 'acct-a' } as never, {} as never)) as Out,
    );
    expect(saveM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ ok: true, accountCleared: false });
  });
});

describe('egress:health', () => {
  it('returns provider.healthcheck(id)', async () => {
    healthcheckMock.mockResolvedValue({ reachable: true, exitIp: '1.2.3.4' });
    const b = body((await egressHealthTool.handler({ provider: 'static', id: 'ip-1' } as never, {} as never)) as Out);
    expect(b).toMatchObject({ ok: true, health: { reachable: true, exitIp: '1.2.3.4' } });
  });
});
