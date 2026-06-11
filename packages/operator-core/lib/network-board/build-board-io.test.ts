// buildNetworkBoard IO wrapper (hive-network-surface-2026-06-11 B-08, P-006):
// the thin fetch-then-assemble glue. The pure assembler is covered by
// build-board.test.ts; this pins the wrapper's NEW behavior — that B-05's
// `loadDirectedCrossHiveGrants` is the grant source and its `in`/`out`
// directions thread onto the C-3 row's grants.{in,out} the right way round
// (an in/out swap is invisible to typecheck — both are CrossHiveGrant[]).
// All IO deps are mocked at their module boundary; no PG/fleet/directory runs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FOREIGN = {
  hiveId: 'hid',
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
  vi.doMock('../hive/wake', () => ({ resolveHiveHomeSlug: () => 'home' }));
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
