/**
 * test-egress.test.ts — the accounts:test-egress tool handler (EI-7357: restores the
 * tool egress-probe.ts's own doc comment already referenced by name, but which was never
 * actually registered). The underlying orchestration (testEgressForAccount) is unit-tested
 * in egress-probe.test.ts; this pins the thin tool-layer wiring only: pool load → probe →
 * unknown-account guard.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/accounts/test-egress.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'default') }));
vi.mock('../../deployment/account-pool-store', () => ({ loadAccountPool: vi.fn() }));
vi.mock('../../inference-gateway/egress-probe', () => ({ testEgressForAccount: vi.fn() }));

import { loadAccountPool } from '../../deployment/account-pool-store';
import { testEgressForAccount } from '../../inference-gateway/egress-probe';
const loadM = vi.mocked(loadAccountPool);
const probeM = vi.mocked(testEgressForAccount);

const mod = await import('./test-egress');
const tool = mod.default;

type Out = { data?: any; content?: Array<{ text: string }> };
const body = (o: Out) => (o.data ?? JSON.parse(o.content![0].text));

beforeEach(() => {
  vi.clearAllMocks();
  loadM.mockResolvedValue({ accounts: [{ id: 'A1' }, { id: 'A2' }] } as never);
});

describe('accounts:test-egress', () => {
  it('loads the pool and returns the probe result for a found account', async () => {
    probeM.mockResolvedValue({
      accountId: 'A1',
      hasEgress: true,
      exitIp: '1.2.3.4',
      reputation: { proxy: false, hosting: false, flagged: false, source: 'ip-api.com' },
      asn: 'AS1',
      distinctFromOthers: true,
      comparedOthers: true,
      collisions: [],
      clean: true,
    } as never);
    const b = body((await tool.handler({ accountId: 'A1' } as never, {} as never)) as Out);
    expect(b).toMatchObject({ ok: true, result: { accountId: 'A1', clean: true } });
    expect(probeM).toHaveBeenCalledWith(
      [{ id: 'A1' }, { id: 'A2' }],
      'A1',
      expect.objectContaining({ compareOthers: undefined }),
    );
  });

  it('passes compareOthers:false through to the orchestration', async () => {
    probeM.mockResolvedValue({ accountId: 'A1', clean: true } as never);
    await tool.handler({ accountId: 'A1', compareOthers: false } as never, {} as never);
    expect(probeM).toHaveBeenCalledWith(expect.anything(), 'A1', expect.objectContaining({ compareOthers: false }));
  });

  it('unknown account id → { ok:false, error: account_not_found }, no throw', async () => {
    probeM.mockResolvedValue(null);
    const b = body((await tool.handler({ accountId: 'nope' } as never, {} as never)) as Out);
    expect(b).toMatchObject({ ok: false, error: 'account_not_found', accountId: 'nope' });
  });
});
