import { describe, expect, it, vi } from 'vitest';
import { executeClaimedOffer, foreignPresenceLabel, type OfferExecutorDeps } from './offer-executor';
import type { ForeignWorkspace } from './foreign-workspaces';
import type { WorkOffer } from './offer-budget';
import type { HostAvailability } from './claim-authority';

const offer: WorkOffer = {
  offerId: 'offer-1',
  fleetSlug: 'fleet-a',
  publisherRef: 'device:origin-1',
  billedTo: 'pool:origin',
  modelClass: 'standard',
  priority: 5,
  isolationReqs: [],
  budget: { remote: { cap: 1000, unit: 'usd-micros', maxPerCall: 100 }, local: null },
  publishedAt: 1_000,
  ttlMs: 60_000,
};

const fakeWs = (over: Partial<ForeignWorkspace> = {}): ForeignWorkspace => ({
  workspaceId: 'ws-1',
  offerId: 'offer-1',
  fleetSlug: 'fleet-a',
  originGithubUserId: 42,
  executorDevice: 'dev-host',
  rootPath: '/foreign/offer-1',
  clonePath: '/foreign/offer-1/repo',
  sessionId: null,
  executionEpoch: 7,
  state: 'provisioning',
  parkReason: null,
  baseSha: 'abc',
  ...over,
});

const availability: HostAvailability = {
  remote: { allotmentRemaining: 500, liveHeadroom: 800 },
  local: null,
};

function makeDeps(over: Partial<OfferExecutorDeps> = {}) {
  const calls: string[] = [];
  const receipts: any[] = [];
  const deps: OfferExecutorDeps = {
    currentGrantorEpoch: vi.fn(async () => 7),
    hostAvailability: vi.fn(async () => availability),
    applyCapabilityEnvelope: vi.fn(async () => {
      calls.push('envelope');
    }),
    launchSession: vi.fn(async () => {
      calls.push('launch');
      return { sessionId: 'sess-9' };
    }),
    provisionForeignClone: vi.fn(async () => {
      calls.push('provision');
      return { ok: true as const, workspace: fakeWs(), clonePath: '/foreign/offer-1/repo' };
    }),
    bindForeignSession: vi.fn(async (_ws: string, _offer: string, sessionId: string) =>
      fakeWs({ sessionId, state: 'active' }),
    ) as any,
    setForeignWorkspaceState: vi.fn(async () => fakeWs({ state: 'parked' })) as any,
    emitP2pReceipt: vi.fn(async (a: any) => {
      receipts.push(a);
      return { ok: true as const, receipt: {} as any };
    }) as any,
    ...over,
  };
  return { deps, calls, receipts };
}

const baseArgs = {
  offer,
  originGithubUserId: 42,
  stampedGrantorEpoch: 7,
  workspaceId: 'ws-1',
  hiveSlug: 'hive-h',
  responderGithubUserId: 99,
  executorDevice: 'dev-host',
  sourceRepoPath: '/src/repo',
  rootPath: '/foreign/offer-1',
};

describe('foreignPresenceLabel (M14)', () => {
  it('is fleet-scoped and offer-threaded', () => {
    expect(foreignPresenceLabel('fleet-a', 'offer-1')).toBe('foreign:fleet-a:offer-1');
  });
});

describe('executeClaimedOffer', () => {
  it('H9: refuses a stale epoch before any provisioning, with a receipt', async () => {
    const { deps, receipts } = makeDeps({ currentGrantorEpoch: vi.fn(async () => 8) });
    const res = await executeClaimedOffer({ ...baseArgs, stampedGrantorEpoch: 7 }, deps);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.refusal.code).toBe('stale-epoch');
    expect(deps.provisionForeignClone).not.toHaveBeenCalled();
    expect(deps.launchSession).not.toHaveBeenCalled();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].action).toBe('work-offer:spawn');
    expect(receipts[0].offerId).toBe('offer-1');
    expect(receipts[0].refusal.code).toBe('stale-epoch');
  });

  it('H9: a FUTURE stamped epoch is refused too (fail-closed both directions)', async () => {
    const { deps } = makeDeps();
    const res = await executeClaimedOffer({ ...baseArgs, stampedGrantorEpoch: 12 }, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.refusal.code).toBe('stale-epoch');
  });

  it('D-007: refuses when there is no live headroom, receipt carries the axis', async () => {
    const { deps, receipts } = makeDeps({
      hostAvailability: vi.fn(async () => ({
        remote: { allotmentRemaining: 500, liveHeadroom: 0 },
        local: null,
      })),
    });
    const res = await executeClaimedOffer(baseArgs, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.refusal.code).toBe('no_live_headroom');
    expect(deps.provisionForeignClone).not.toHaveBeenCalled();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].action).toBe('work-offer:claim');
    expect(receipts[0].budgetAxis).toBe('remote');
  });

  it('happy path: fence → gate → provision → envelope → launch → bind → ledgers', async () => {
    const { deps, calls } = makeDeps();
    const res = await executeClaimedOffer(baseArgs, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.sessionId).toBe('sess-9');
    expect(res.workspace.state).toBe('active');
    expect(res.presenceLabel).toBe('foreign:fleet-a:offer-1');
    // C2 before launch, provision before both.
    expect(calls).toEqual(['provision', 'envelope', 'launch']);
    // H11 ledger seeded from the EFFECTIVE cap = min(offer 1000, available min(500,800)=500).
    expect(res.ledgers.remote?.cap).toBe(500);
    expect(res.ledgers.remote?.maxPerCall).toBe(100);
    expect(res.ledgers.local).toBeUndefined();
    // The stamped epoch rides into the registry row.
    expect((deps.provisionForeignClone as any).mock.calls[0][0].executionEpoch).toBe(7);
    expect(res.receiptsEmitted).toBe(0);
  });

  it('provision refusal is receipted and stops the pipeline', async () => {
    const { deps, receipts } = makeDeps({
      provisionForeignClone: vi.fn(async () => ({
        ok: false as const,
        refusal: { code: 'odb-not-private' as const, detail: 'alternates present' },
      })),
    });
    const res = await executeClaimedOffer(baseArgs, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.refusal.code).toBe('odb-not-private');
    expect(deps.applyCapabilityEnvelope).not.toHaveBeenCalled();
    expect(deps.launchSession).not.toHaveBeenCalled();
    expect(receipts[0].refusal.code).toBe('odb-not-private');
  });

  it('C2: an envelope failure parks the row and never launches', async () => {
    const { deps, receipts } = makeDeps({
      applyCapabilityEnvelope: vi.fn(async () => {
        throw new Error('no such role');
      }),
    });
    const res = await executeClaimedOffer(baseArgs, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.refusal.code).toBe('capability-envelope-failed');
    expect(deps.launchSession).not.toHaveBeenCalled();
    const parkCall = (deps.setForeignWorkspaceState as any).mock.calls[0];
    expect(parkCall[2]).toBe('parked');
    expect(parkCall[3].fromStates).toEqual(['provisioning', 'active']);
    expect(receipts[0].refusal.code).toBe('capability-envelope-failed');
  });

  it('a launch failure parks the row with the reason', async () => {
    const { deps } = makeDeps({
      launchSession: vi.fn(async () => {
        throw new Error('spawn quota');
      }),
    });
    const res = await executeClaimedOffer(baseArgs, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.refusal.code).toBe('launch-failed');
    expect((deps.setForeignWorkspaceState as any).mock.calls[0][3].parkReason).toContain('spawn quota');
  });

  it('a bind race (row reaped mid-spawn) refuses with a receipt', async () => {
    const { deps, receipts } = makeDeps({ bindForeignSession: vi.fn(async () => null) as any });
    const res = await executeClaimedOffer(baseArgs, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.refusal.code).toBe('bind-race');
    expect(receipts[0].refusal.code).toBe('bind-race');
  });

  it('C3: an unresolvable workspace partition is refused up front', async () => {
    const { deps } = makeDeps();
    const res = await executeClaimedOffer({ ...baseArgs, workspaceId: '*' }, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.refusal.code).toBe('workspace_unresolved');
    expect(deps.currentGrantorEpoch).not.toHaveBeenCalled();
  });
});
