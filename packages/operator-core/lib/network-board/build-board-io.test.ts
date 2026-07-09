// buildNetworkBoard IO wrapper (hive-network-surface-2026-06-11 B-08, P-006):
// the thin fetch-then-assemble glue. The pure assembler is covered by
// build-board.test.ts; this pins the wrapper's NEW behavior — that B-05's
// `loadDirectedCrossHiveGrants` is the grant source and its `in`/`out`
// directions thread onto the C-3 row's grants.{in,out} the right way round
// (an in/out swap is invisible to typecheck — both are CrossHiveGrant[]).
// All IO deps are mocked at their module boundary; no PG/fleet/directory runs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FOREIGN = {
  potId: 'hid',
  title: 'Peer Hive',
  description: '',
  ownerGithubLogin: 'x',
  ownerGithubUserId: 1,
  ownerDevicePubkey: 'd',
  hivePubkey: 'pk',
  memberTopics: [],
  visibility: 'public',
  createdAt: 1,
  announcedTs: 2,
  lastSeenMs: Date.parse('2026-06-11T01:00:00.000Z'),
  attested: true,
};

function mockSources(directed: { in: unknown[]; out: unknown[] }) {
  vi.doMock('../agent-tools/hive/_resolve', () => ({
    listHives: vi.fn(async () => []),
    liveAgentCountByHarness: vi.fn(() => new Map()),
  }));
  vi.doMock('../fleet/assignments', () => ({ listFleetAssignments: vi.fn(async () => []) }));
  vi.doMock('../agent-tools/coordination/federated-presence', () => ({
    listFederatedPresence: vi.fn(async () => []),
  }));
  vi.doMock('../hive-directory-deps', () => ({
    getHiveDirectory: () => ({ listDiscoveredHives: () => [FOREIGN] }),
  }));
  vi.doMock('../cross-hive-grants', () => ({
    loadDirectedCrossHiveGrants: vi.fn(async () => directed),
  }));
  vi.doMock('../cross-hive-asks-pg', () => ({
    PgCrossHiveAsks: class {
      async list() {
        return [];
      }
    },
  }));
  vi.doMock('../hive/wake', () => ({ resolvePotHomeSlug: () => 'home' }));
  vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws' }));
}

describe('buildNetworkBoard — directed grants (B-05 integration)', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('threads loadDirectedCrossHiveGrants in→grants.in and out→grants.out on the tier-4 peer', async () => {
    mockSources({
      in: [{ peerHivePubkey: 'pk', allowedKinds: ['ask'] }],
      out: [{ peerHivePubkey: 'pk', allowedKinds: ['ask', 'work-request'] }],
    });
    const { buildNetworkBoard } = await import('./build-board');
    const rows = await buildNetworkBoard({ workspaceId: 'ws' });

    const peer = rows.find((r) => r.key === 'pk')!;
    expect(peer.tier).toBe(4);
    expect(peer.grants).toEqual({ in: ['ask'], out: ['ask', 'work-request'] });
  });

  it('omits grants entirely when neither direction grants the peer anything', async () => {
    mockSources({ in: [], out: [] });
    const { buildNetworkBoard } = await import('./build-board');
    const rows = await buildNetworkBoard({ workspaceId: 'ws' });

    expect(rows.find((r) => r.key === 'pk')!.grants).toBeUndefined();
  });

  it('surfaces an out-only grant (we may send, they may not) as in:[] out:[kinds]', async () => {
    mockSources({ in: [], out: [{ peerHivePubkey: 'pk', allowedKinds: ['work-request'] }] });
    const { buildNetworkBoard } = await import('./build-board');
    const rows = await buildNetworkBoard({ workspaceId: 'ws' });

    expect(rows.find((r) => r.key === 'pk')!.grants).toEqual({ in: [], out: ['work-request'] });
  });
});

// ── NB1: readAsksByPeer bucketing (private fn, reached only via buildNetworkBoard).
//    Each outbound ask row is bucketed by its `state`: queued|sent → pending,
//    answered → answered, declined|expired → NEITHER (build-board.ts:208-210).
//    The summary lands on the tier-4 row whose pubkey matches the ask's
//    peerPubkey; a store throw yields an empty map (no `asks` on any row).
//    The pure assembler test only feeds asksByPeer pre-built — this is the only
//    coverage of the buckets + the per-peer aggregation + the throw fallback.
function mockSourcesWithAsks(askRows: unknown[] | (() => never)) {
  // Two foreign peers so per-peer aggregation (not a global tally) is observable.
  const foreign = (pubkey: string) => ({ ...FOREIGN, potId: `hid-${pubkey}`, hivePubkey: pubkey });
  vi.doMock('../agent-tools/hive/_resolve', () => ({
    listHives: vi.fn(async () => []),
    liveAgentCountByHarness: vi.fn(() => new Map()),
  }));
  vi.doMock('../fleet/assignments', () => ({ listFleetAssignments: vi.fn(async () => []) }));
  vi.doMock('../agent-tools/coordination/federated-presence', () => ({
    listFederatedPresence: vi.fn(async () => []),
  }));
  vi.doMock('../hive-directory-deps', () => ({
    getHiveDirectory: () => ({ listDiscoveredHives: () => [foreign('pkA'), foreign('pkB')] }),
  }));
  vi.doMock('../cross-hive-grants', () => ({
    loadDirectedCrossHiveGrants: vi.fn(async () => ({ in: [], out: [] })),
  }));
  const listCalls: Array<{ direction?: string }> = [];
  vi.doMock('../cross-hive-asks-pg', () => ({
    PgCrossHiveAsks: class {
      async list(opts: { direction?: string }) {
        listCalls.push(opts);
        if (typeof askRows === 'function') return askRows();
        return askRows;
      }
    },
  }));
  vi.doMock('../hive/wake', () => ({ resolvePotHomeSlug: () => 'home' }));
  vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws' }));
  return listCalls;
}

describe('buildNetworkBoard — readAsksByPeer bucketing (NB1)', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  const ask = (peerPubkey: string, state: string) => ({ peerPubkey, state });

  it('buckets queued|sent → pending, answered → answered, declined|expired → neither, per peer', async () => {
    mockSourcesWithAsks([
      // peer A: all five states once each → pending 2 (queued+sent), answered 1,
      // declined+expired contribute to NEITHER bucket.
      ask('pkA', 'queued'),
      ask('pkA', 'sent'),
      ask('pkA', 'answered'),
      ask('pkA', 'declined'),
      ask('pkA', 'expired'),
      // peer B: two answered + one queued → pending 1, answered 2 (separate tally).
      ask('pkB', 'answered'),
      ask('pkB', 'answered'),
      ask('pkB', 'queued'),
    ]);
    const { buildNetworkBoard } = await import('./build-board');
    const rows = await buildNetworkBoard({ workspaceId: 'ws' });

    const a = rows.find((r) => r.key === 'pkA')!;
    const b = rows.find((r) => r.key === 'pkB')!;
    expect(a.asks).toEqual({ pending: 2, answered: 1 }); // declined+expired excluded
    expect(b.asks).toEqual({ pending: 1, answered: 2 });
  });

  it('reads only the OUTBOUND direction from the ask ledger', async () => {
    const listCalls = mockSourcesWithAsks([ask('pkA', 'queued')]);
    const { buildNetworkBoard } = await import('./build-board');
    await buildNetworkBoard({ workspaceId: 'ws' });
    expect(listCalls).toEqual([{ direction: 'out' }]);
  });

  it('omits asks on a peer with only declined/expired rows (no zero-noise summary)', async () => {
    mockSourcesWithAsks([ask('pkA', 'declined'), ask('pkA', 'expired')]);
    const { buildNetworkBoard } = await import('./build-board');
    const rows = await buildNetworkBoard({ workspaceId: 'ws' });
    // peer A is in the map (it had rows) but both resolved-not-answered →
    // pending 0 / answered 0. The summary object still attaches (the row had
    // ledger rows); both counts are 0 — pinning the bucket math, not omission.
    expect(rows.find((r) => r.key === 'pkA')!.asks).toEqual({ pending: 0, answered: 0 });
  });

  it('a peer with NO ledger rows carries no asks summary', async () => {
    mockSourcesWithAsks([ask('pkA', 'queued')]); // only pkA has rows
    const { buildNetworkBoard } = await import('./build-board');
    const rows = await buildNetworkBoard({ workspaceId: 'ws' });
    expect(rows.find((r) => r.key === 'pkB')!.asks).toBeUndefined();
  });

  it('a store throw yields an empty map → no peer carries asks (board still renders)', async () => {
    mockSourcesWithAsks(() => {
      throw new Error('ledger unavailable');
    });
    const { buildNetworkBoard } = await import('./build-board');
    const rows = await buildNetworkBoard({ workspaceId: 'ws' });
    // Both tier-4 peers still render; neither carries an asks summary.
    expect(rows.filter((r) => r.tier === 4)).toHaveLength(2);
    expect(rows.every((r) => r.asks === undefined)).toBe(true);
  });
});
