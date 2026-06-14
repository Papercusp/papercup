// network-board assembler (hive-network-surface-2026-06-11 B-08 / C-3, P-006):
// the PURE composition of the four data sources into C-3 rows. No PG — fixtures
// in, rows out — so the tier classification + field-presence rules are pinned
// here without a database.

import { describe, expect, it } from 'vitest';
import type { HiveDescriptor } from '../agent-tools/hive/_resolve';
import type { UnifiedPresenceRecord } from '../agent-tools/coordination/federated-presence';
import type { DiscoveredHive } from '../hive-directory';
import type { HiveStatusBeacon } from '../hive-beacon';
import type { FleetAssignmentRow } from '../fleet/assignments';
import { assembleNetworkBoard, watchOwnersByHarness, type NetworkBoardInputs } from './build-board';

// ── fixture factories ──────────────────────────────────────────────
function hive(slug: string, over: Partial<HiveDescriptor> = {}): HiveDescriptor {
  return {
    slug,
    path: `/hives/${slug}`,
    kind: 'hive',
    deployment: { target: 'local' },
    deployed: false,
    wake: {
      active: false,
      nextFireAt: null,
      lastFiredAt: null,
      subscriptions: [],
      lastWakeAt: null,
    },
    ...over,
  };
}

function fedPeer(over: Partial<UnifiedPresenceRecord> = {}): UnifiedPresenceRecord {
  return {
    ownerId: 'fed:1@boxA',
    ownerLabel: 'gh:1 · boxA',
    workspaceId: 'ws',
    source: 'federated',
    intent: '',
    currentPlanSlug: null,
    currentFiles: [],
    host: 'boxA',
    pid: null,
    startedAt: '2026-06-11T00:00:00.000Z',
    heartbeatAt: '2026-06-11T00:00:00.000Z',
    lastActiveAt: null,
    agentRole: null,
    hiveSlug: null,
    stale: false,
    userId: '1',
    revoked: false,
    federated: true,
    devicePubkey: 'devA',
    harnessSlug: 'papercup',
    currentView: null,
    ...over,
  };
}

function beacon(over: Partial<HiveStatusBeacon> = {}): HiveStatusBeacon {
  return { v: 1, liveAgents: 3, queueDepth: 7, focus: 'shipping X', lastCompleted: 'did Y', ts: '2026-06-11T00:00:00.000Z', ...over };
}

function foreign(pubkey: string, over: Partial<DiscoveredHive> = {}): DiscoveredHive {
  return {
    hiveId: `hid-${pubkey}`,
    title: `Hive ${pubkey}`,
    description: 'a foreign hive',
    ownerGithubLogin: 'someone',
    ownerGithubUserId: 9,
    ownerDevicePubkey: 'dev-foreign',
    hivePubkey: pubkey,
    memberTopics: [],
    visibility: 'public',
    createdAt: 1,
    announcedTs: 2,
    lastSeenMs: Date.parse('2026-06-11T01:00:00.000Z'),
    attested: true,
    ...over,
  };
}

const EMPTY: NetworkBoardInputs = {
  homeSlug: null,
  hives: [],
  liveAgentsBySlug: new Map(),
  federatedPeers: [],
  discovered: [],
  grantsByPeer: new Map(),
};

describe('assembleNetworkBoard — tiers 1–2 (own hives)', () => {
  it('splits the home hive (tier 1/local) from own other hives (tier 2/admin) and carries liveAgents + wake', () => {
    const rows = assembleNetworkBoard({
      ...EMPTY,
      homeSlug: 'home',
      hives: [
        hive('other', { wake: { active: true, nextFireAt: '2026-06-11T02:00:00.000Z', lastFiredAt: null, subscriptions: [], lastWakeAt: null } }),
        hive('home'),
      ],
      liveAgentsBySlug: new Map([['home', 4], ['other', 1]]),
    });
    // tier-ordered: home (1) before other (2)
    expect(rows.map((r) => [r.tier, r.key, r.trust])).toEqual([
      [1, 'home', 'local'],
      [2, 'other', 'admin'],
    ]);
    const home = rows.find((r) => r.key === 'home')!;
    expect(home.liveAgents).toBe(4);
    expect(home.wake).toEqual({ active: false, nextFireAt: null });
    const other = rows.find((r) => r.key === 'other')!;
    expect(other.wake).toEqual({ active: true, nextFireAt: '2026-06-11T02:00:00.000Z' });
  });

  it('with no homeSlug, every own hive is tier 2 (no tier-1 row faked)', () => {
    const rows = assembleNetworkBoard({ ...EMPTY, hives: [hive('a'), hive('b')], liveAgentsBySlug: new Map() });
    expect(rows.every((r) => r.tier === 2)).toBe(true);
    expect(rows.map((r) => r.liveAgents)).toEqual([0, 0]); // absent count → 0
  });

  it('excludes a remote (joiner-side VIEW) hive — it is not an owned Swarm', () => {
    const rows = assembleNetworkBoard({
      ...EMPTY,
      homeSlug: 'home',
      hives: [hive('home'), hive('peeked', { remote: true })],
    });
    expect(rows.map((r) => r.key)).toEqual(['home']);
  });
});

describe('assembleNetworkBoard — tier 3 (federated peer Swarms)', () => {
  it('groups federated presence by device into one row/Swarm, counts distinct live owners, omits liveAgents when all stale', () => {
    const rows = assembleNetworkBoard({
      ...EMPTY,
      federatedPeers: [
        // boxA: two distinct live owners across two harnesses → liveAgents 2
        fedPeer({ devicePubkey: 'devA', ownerId: 'fed:1@boxA', host: 'boxA', intent: 'on alpha', heartbeatAt: '2026-06-11T03:00:00.000Z' }),
        fedPeer({ devicePubkey: 'devA', ownerId: 'fed:2@boxA', host: 'boxA', heartbeatAt: '2026-06-11T03:05:00.000Z' }),
        // boxB: one stale peer → still lists, liveAgents omitted
        fedPeer({ devicePubkey: 'devB', ownerId: 'fed:9@boxB', host: 'boxB', stale: true, heartbeatAt: '2026-06-10T00:00:00.000Z' }),
      ],
    });
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.key === 'devA')!;
    expect(a).toMatchObject({ tier: 3, trust: 'federated', title: 'boxA', liveAgents: 2, focus: 'on alpha' });
    expect(a.lastSeen).toBe('2026-06-11T03:05:00.000Z'); // max heartbeat in the group
    const b = rows.find((r) => r.key === 'devB')!;
    expect(b.tier).toBe(3);
    expect(b.liveAgents).toBeUndefined(); // all stale → omitted
    expect(b.focus).toBeUndefined(); // no non-empty intent → omitted
    expect(b.lastSeen).toBe('2026-06-10T00:00:00.000Z');
  });
});

describe('watch owners (P-014 item 1 — per-bee drill-in watch panes)', () => {
  function assignment(over: Partial<FleetAssignmentRow> = {}): FleetAssignmentRow {
    return {
      source: 'presence',
      workspaceId: 'ws',
      agentId: 'su-bee-1',
      agentLabel: null,
      agentName: null,
      harnessSlug: 'other',
      planSlug: null,
      itemId: null,
      workItemId: null,
      itemKind: null,
      detail: '',
      status: null,
      claimAcquiredTs: null,
      claimExpiresTs: null,
      claimActive: null,
      livenessMode: null,
      lastActivityTs: null,
      holderPresent: true,
      holderAlive: true,
      holderHeartbeatAt: null,
      holderIntent: null,
      holderPlanSlug: null,
      orphaned: false,
      declaredPlanMatches: null,
      assigneeRank: null,
      rankWriter: null,
      ...over,
    };
  }

  it('watchOwnersByHarness keeps only LIVE holders with a hive + agent id, deduped per hive', () => {
    const owners = watchOwnersByHarness([
      assignment({ agentId: 'su-a' }),
      assignment({ agentId: 'su-a', source: 'plan_item_claim' }), // dup owner, second row
      assignment({ agentId: 'su-b' }),
      assignment({ agentId: 'su-dead', holderAlive: false }), // stale → no watch pane
      assignment({ agentId: null }), // presence debris
      assignment({ agentId: 'su-x', harnessSlug: null }), // no hive attribution
    ]);
    expect(owners.get('other')).toEqual(['su-a', 'su-b']);
  });

  it('populates watchOwners on tier-2 rows only — tier 1 (this Swarm) never carries them', () => {
    const rows = assembleNetworkBoard({
      ...EMPTY,
      homeSlug: 'home',
      hives: [hive('home'), hive('other')],
      watchOwnersBySlug: new Map([
        ['home', ['su-home-bee']],
        ['other', ['su-a', 'su-b']],
      ]),
    });
    expect(rows.find((r) => r.key === 'home')!.watchOwners).toBeUndefined();
    expect(rows.find((r) => r.key === 'other')!.watchOwners).toEqual(['su-a', 'su-b']);
  });

  it('omits watchOwners (never an empty array) when a tier-2 hive has no live bees', () => {
    const rows = assembleNetworkBoard({
      ...EMPTY,
      homeSlug: 'home',
      hives: [hive('home'), hive('idle')],
      watchOwnersBySlug: new Map([['idle', []]]),
    });
    expect(rows.find((r) => r.key === 'idle')!.watchOwners).toBeUndefined();
  });

  it('derives tier-3 watchOwners from the device’s LIVE members (stale-only device omits them)', () => {
    const rows = assembleNetworkBoard({
      ...EMPTY,
      federatedPeers: [
        fedPeer({ devicePubkey: 'devA', ownerId: 'fed:1@boxA' }),
        fedPeer({ devicePubkey: 'devA', ownerId: 'fed:2@boxA' }),
        fedPeer({ devicePubkey: 'devA', ownerId: 'fed:1@boxA' }), // dup owner
        fedPeer({ devicePubkey: 'devB', ownerId: 'fed:9@boxB', stale: true }),
      ],
    });
    expect(rows.find((r) => r.key === 'devA')!.watchOwners).toEqual(['fed:1@boxA', 'fed:2@boxA']);
    expect(rows.find((r) => r.key === 'devB')!.watchOwners).toBeUndefined();
  });
});

describe('assembleNetworkBoard — tier 4 (foreign hives + beacon + grants + asks)', () => {
  it('keys on pubkey, surfaces beacon liveAgents/queueDepth/focus, lastSeen from announce, and our grants/asks when present', () => {
    const rows = assembleNetworkBoard({
      ...EMPTY,
      discovered: [foreign('pkPeer', { beacon: beacon({ liveAgents: 5, queueDepth: 2, focus: 'building Z' }) })],
      grantsByPeer: new Map([['pkPeer', ['ask']]]),
      outboundGrantsByPeer: new Map([['pkPeer', ['ask', 'work-request']]]),
      asksByPeer: new Map([['pkPeer', { pending: 1, answered: 2 }]]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tier: 4,
      trust: 'gossip',
      key: 'pkPeer',
      liveAgents: 5,
      queueDepth: 2,
      focus: 'building Z',
      lastSeen: '2026-06-11T01:00:00.000Z',
      grants: { in: ['ask'], out: ['ask', 'work-request'] },
      asks: { pending: 1, answered: 2 },
    });
  });

  it('omits beacon-sourced fields, grants, and asks when the tier lacks that data (no zero/empty noise)', () => {
    const rows = assembleNetworkBoard({ ...EMPTY, discovered: [foreign('pkBare')] });
    const r = rows[0];
    expect(r.tier).toBe(4);
    expect(r.liveAgents).toBeUndefined();
    expect(r.queueDepth).toBeUndefined();
    expect(r.focus).toBeUndefined();
    expect(r.grants).toBeUndefined(); // default-deny both ways → omitted, not {in:[],out:[]}
    expect(r.asks).toBeUndefined();
    expect(r.lastSeen).toBe('2026-06-11T01:00:00.000Z'); // last-announce is always known
  });

  it('falls back to hiveId for the key when a foreign hive carries no pubkey, and never attaches grants/asks to it', () => {
    const rows = assembleNetworkBoard({
      ...EMPTY,
      discovered: [foreign('', { hivePubkey: '', hiveId: 'hid-x' })],
      // grants keyed by '' must NOT leak onto a pubkey-less hive
      grantsByPeer: new Map([['', ['ask']]]),
    });
    expect(rows[0].key).toBe('hid-x');
    expect(rows[0].grants).toBeUndefined();
  });
});

describe('assembleNetworkBoard — full ladder ordering', () => {
  it('returns rows tier-ascending 1→4 regardless of input order', () => {
    const rows = assembleNetworkBoard({
      ...EMPTY,
      homeSlug: 'home',
      discovered: [foreign('pk')],
      federatedPeers: [fedPeer()],
      hives: [hive('other'), hive('home')],
    });
    expect(rows.map((r) => r.tier)).toEqual([1, 2, 3, 4]);
  });
});
