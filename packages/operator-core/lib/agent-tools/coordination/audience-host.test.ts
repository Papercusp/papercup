/**
 * audience-host.test.ts — the PURE surface of the audience host adapter: the env-gated
 * audienceMode() kill-switch + the pure canonicalizeAudienceSelector / deriveAudienceKey
 * (the write/read audience-key agreement) + the listActivePresence resolver's stale/revoked
 * filter + mapping. (The listTargetSubscribers/listTaggedTopics resolvers run live PG stores
 * — covered by the integration suite, not here.) ./presence is mocked so listPresence is
 * fully controlled.
 *
 * NB: these import the REAL (unmocked) audience-host module — so a MISSING export regresses
 * as an import failure here. This is the guard the tool-level catch-up.test.ts (which mocks
 * ../audience-host) can't provide: it caught the WI-1352 crash where catch-up.ts imported
 * canonicalizeAudienceSelector but the module hadn't exported it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./presence', async (importOriginal) => ({
  // Spread the real module so PRESENCE_STALE_MS (consumed transitively via
  // presence-wakeability.ts) survives; override only the fn we stub.
  ...(await importOriginal<typeof import('./presence')>()),
  listPresence: vi.fn(),
}));
const { getWorkItemMock } = vi.hoisted(() => ({ getWorkItemMock: vi.fn() }));
vi.mock('../../work-items', () => ({
  getWorkItem: (...args: unknown[]) => getWorkItemMock(...args),
}));
vi.mock('../../fleet/fleet-roster', () => ({ liveFleetMemberIds: vi.fn(async () => []) }));
vi.mock('../../agent-fleets-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-fleets-store')>()),
  getFleet: vi.fn(async () => null),
}));
vi.mock('../../fleet-membership-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../fleet-membership-store')>()),
  latestFleetLeader: vi.fn(async () => null),
}));
vi.mock('./fleet-delivery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./fleet-delivery')>()),
  getFleetDeliveryOverrides: vi.fn(async () => new Map()),
}));
vi.mock('../../sync/hyperbee/session-presence-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/hyperbee/session-presence-store')>()),
  // Default: no federated peers (single box). Federated tests override per-case.
  listFederatedFleetMembers: vi.fn(async () => []),
}));
// The lock half of `@file:` (EI-18772330418885814). Spread the real module so the
// REAL normalizePaths (validation + canonicalization) is exercised — only the
// side-database access is stubbed.
vi.mock('../locks/su-lock-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../locks/su-lock-store')>()),
  ensureBootstrap: vi.fn(async () => {}),
  getTxPool: vi.fn(() => ({}) as never),
  readQueue: vi.fn(async () => ({ active_locks: [], waiting: [] })),
}));

import {
  audienceMode,
  canonicalizeAudienceSelector,
  deriveAudienceKey,
  hostAudienceResolvers,
  listFleetControlMembers,
} from './audience-host';
import { listPresence } from './presence';
import { liveFleetMemberIds } from '../../fleet/fleet-roster';
import { getFleet } from '../../agent-fleets-store';
import { getFleetDeliveryOverrides } from './fleet-delivery';
import { latestFleetLeader } from '../../fleet-membership-store';
import { listFederatedFleetMembers } from '../../sync/hyperbee/session-presence-store';
import { readQueue } from '../locks/su-lock-store';

const mockListPresence = listPresence as unknown as ReturnType<typeof vi.fn>;
const mockReadQueue = readQueue as unknown as ReturnType<typeof vi.fn>;

describe('hostAudienceResolvers.listObjectOwners — family-aware owner enrichment', () => {
  beforeEach(() => {
    getWorkItemMock.mockReset();
    getWorkItemMock.mockResolvedValue(null);
  });

  it('returns the current issue assignee', async () => {
    getWorkItemMock.mockResolvedValue({ family: 'issue', assignee: 'issue-owner' });

    await expect(hostAudienceResolvers.listObjectOwners!('issue', 'WI-1')).resolves.toEqual(['issue-owner']);
    expect(getWorkItemMock).toHaveBeenCalledWith('WI-1', undefined);
  });

  it('returns the current feature assignee only for the qualified matching harness', async () => {
    getWorkItemMock.mockResolvedValue({ family: 'feature', harness: 'demo', assignee: 'feature-owner' });

    await expect(hostAudienceResolvers.listObjectOwners!('feature', 'demo#F-1')).resolves.toEqual(['feature-owner']);
    expect(getWorkItemMock).toHaveBeenCalledWith('F-1', 'demo');
    await expect(hostAudienceResolvers.listObjectOwners!('feature', 'other#F-1')).resolves.toEqual([]);
  });

  it('rejects a wrong family and fails soft when the work-item read throws', async () => {
    getWorkItemMock.mockResolvedValue({ family: 'feature', harness: 'demo', assignee: 'wrong-family' });
    await expect(hostAudienceResolvers.listObjectOwners!('issue', 'WI-1')).resolves.toEqual([]);

    getWorkItemMock.mockRejectedValue(new Error('work-item store unavailable'));
    await expect(hostAudienceResolvers.listObjectOwners!('issue', 'WI-1')).resolves.toEqual([]);
  });
});

const lock = (owner: string, path: string) => ({
  path,
  owner,
  owner_label: null,
  intent: 'editing',
  acquired_ts: new Date(),
  expires_ts: new Date(Date.now() + 60_000),
  coordination_domain: '/realpath/of/this/checkout',
});
const waiter = (owner: string, paths: string[]) => ({
  ticket_id: `t-${owner}`,
  owner,
  owner_label: null,
  paths,
  intent: 'queued',
  queued_ts: new Date(),
  wait_until: new Date(Date.now() + 60_000),
  status: 'waiting' as const,
  coordination_domain: '/realpath/of/this/checkout',
});

describe('audienceMode — the PAPERCUSP_COORD_EMIT_SCOPE kill-switch (D-005)', () => {
  const KEY = 'PAPERCUSP_COORD_EMIT_SCOPE';
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[KEY]; delete process.env[KEY]; });
  afterEach(() => { if (saved === undefined) delete process.env[KEY]; else process.env[KEY] = saved; });

  it("returns 'broadcast' only for the exact 'broadcast' value", () => {
    process.env[KEY] = 'broadcast';
    expect(audienceMode()).toBe('broadcast');
  });

  it("defaults to 'scoped' when unset", () => {
    expect(audienceMode()).toBe('scoped');
  });

  it("treats any other value as 'scoped'", () => {
    process.env[KEY] = 'scoped';
    expect(audienceMode()).toBe('scoped');
    process.env[KEY] = 'BROADCAST'; // case-sensitive — not the literal
    expect(audienceMode()).toBe('scoped');
  });
});

describe('canonicalizeAudienceSelector — pure fleet-slugify / as-typed (D-003)', () => {
  it('is a callable export (WI-1352 regression: catch-up.ts imports this)', () => {
    expect(typeof canonicalizeAudienceSelector).toBe('function');
  });

  it('slugifies a @fleet: selector so a human name and its slug key the same history', () => {
    expect(canonicalizeAudienceSelector('@fleet:Backend Team')).toBe('@fleet:backend-team');
    expect(canonicalizeAudienceSelector('@fleet:shared-hive-testing')).toBe('@fleet:shared-hive-testing');
  });

  it('is idempotent on an already-slugified fleet selector', () => {
    const once = canonicalizeAudienceSelector('@fleet:Backend Team');
    expect(canonicalizeAudienceSelector(once)).toBe(once);
  });

  it('slugifies @fleet-leader: the same way as @fleet:', () => {
    expect(canonicalizeAudienceSelector('@fleet-leader:Backend Team')).toBe('@fleet-leader:backend-team');
  });

  it('leaves an empty-bodied fleet selector untouched (nothing to slugify)', () => {
    expect(canonicalizeAudienceSelector('@fleet:')).toBe('@fleet:');
    expect(canonicalizeAudienceSelector('@fleet:   ')).toBe('@fleet:   ');
  });

  it('stores every non-fleet selector as-typed (trimmed)', () => {
    expect(canonicalizeAudienceSelector('@topic:federation')).toBe('@topic:federation');
    expect(canonicalizeAudienceSelector('  @topic:federation  ')).toBe('@topic:federation');
    expect(canonicalizeAudienceSelector('@plan:my-plan')).toBe('@plan:my-plan');
    expect(canonicalizeAudienceSelector('*')).toBe('*');
    expect(canonicalizeAudienceSelector('alice')).toBe('alice');
  });
});

describe('deriveAudienceKey — canonicalized selector provenance from a to[] (D-003)', () => {
  it('is a callable export', () => {
    expect(typeof deriveAudienceKey).toBe('function');
  });

  it('keeps only @-selectors + * (plain ownerIds are already queryable by `to`)', () => {
    expect(deriveAudienceKey(['@fleet:Backend Team', 'alice', '@topic:federation'])).toEqual([
      '@fleet:backend-team',
      '@topic:federation',
    ]);
  });

  it('canonicalizes + dedupes so a name and its slug collapse to one key', () => {
    expect(deriveAudienceKey(['@fleet:Backend Team', '@fleet:backend-team'])).toEqual(['@fleet:backend-team']);
  });

  it('preserves * alongside selectors', () => {
    expect(deriveAudienceKey(['*', '@topic:federation'])).toEqual(['*', '@topic:federation']);
  });

  it('is empty for a plain-id-only send (no selector provenance to retain)', () => {
    expect(deriveAudienceKey(['alice', 'bob'])).toEqual([]);
  });
});

describe('hostAudienceResolvers.listActivePresence — drops stale/revoked, maps to ActivePresence', () => {
  beforeEach(() => vi.clearAllMocks());

  const rec = (over: Record<string, unknown>) =>
    ({ ownerId: 'o', currentPlanSlug: null, currentFiles: [], stale: false, revoked: false, ...over });

  it('keeps only fresh, non-revoked records and projects {ownerId, planSlug, files}', async () => {
    mockListPresence.mockResolvedValue([
      rec({ ownerId: 'alice', currentPlanSlug: 'plan-a', currentFiles: ['a.ts'] }),
      rec({ ownerId: 'stale-bob', stale: true }),
      rec({ ownerId: 'revoked-cy', revoked: true }),
      rec({ ownerId: 'dave', currentPlanSlug: null, currentFiles: [] }),
    ]);

    const active = await hostAudienceResolvers.listActivePresence();

    expect(active).toEqual([
      { ownerId: 'alice', planSlug: 'plan-a', files: ['a.ts'] },
      { ownerId: 'dave', planSlug: null, files: [] },
    ]);
  });

  it('returns an empty list when every record is stale or revoked', async () => {
    mockListPresence.mockResolvedValue([rec({ stale: true }), rec({ revoked: true })]);
    expect(await hostAudienceResolvers.listActivePresence()).toEqual([]);
  });
});

describe('hostAudienceResolvers.listFleetMembers — multi-fleet leader union (mig-407 single-label gap)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('unions the registry leader into the member audience when their presence label points at another fleet', async () => {
    vi.mocked(liveFleetMemberIds).mockResolvedValue(['lane-a', 'lane-d']);
    vi.mocked(getFleet).mockResolvedValue({ leaderOwnerId: 'su-multi-leader' } as never);
    expect(await hostAudienceResolvers.listFleetMembers('git-plan')).toEqual([
      'lane-a',
      'lane-d',
      'su-multi-leader',
    ]);
  });

  it('does not duplicate a leader already present via the presence label', async () => {
    vi.mocked(liveFleetMemberIds).mockResolvedValue(['su-multi-leader', 'lane-a']);
    vi.mocked(getFleet).mockResolvedValue({ leaderOwnerId: 'su-multi-leader' } as never);
    expect(await hostAudienceResolvers.listFleetMembers('git-plan')).toEqual(['su-multi-leader', 'lane-a']);
  });

  it('still applies delivery overrides to the unioned leader (a muted leader stays muted)', async () => {
    vi.mocked(liveFleetMemberIds).mockResolvedValue(['lane-a']);
    vi.mocked(getFleet).mockResolvedValue({ leaderOwnerId: 'su-multi-leader' } as never);
    vi.mocked(getFleetDeliveryOverrides).mockResolvedValue(new Map([['su-multi-leader', 'muted']]) as never);
    expect(await hostAudienceResolvers.listFleetMembers('git-plan')).toEqual(['lane-a']);
  });

  it('control roster bypasses muted/digest delivery overrides for typed fleet control', async () => {
    vi.mocked(liveFleetMemberIds).mockResolvedValue(['muted-member', 'digest-member', 'full-member']);
    vi.mocked(getFleet).mockResolvedValue(null as never);
    vi.mocked(getFleetDeliveryOverrides).mockResolvedValue(
      new Map([
        ['muted-member', 'muted'],
        ['digest-member', 'digest'],
      ]) as never,
    );

    expect(await listFleetControlMembers('git-plan')).toEqual([
      'muted-member',
      'digest-member',
      'full-member',
    ]);
    expect(await hostAudienceResolvers.listFleetMembers('git-plan')).toEqual(['full-member']);
  });
});

describe('hostAudienceResolvers — federated (cross-machine) fleet view (P-301)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('unions FEDERATED members (remote sessions carrying this fleet_slug) into the @fleet audience', async () => {
    vi.mocked(liveFleetMemberIds).mockResolvedValue(['local-a']);
    vi.mocked(getFleet).mockResolvedValue({ leaderOwnerId: 'local-a' } as never);
    vi.mocked(listFederatedFleetMembers).mockResolvedValue([
      { ownerId: 'remote-b', fleetRole: 'member' },
      { ownerId: 'local-a', fleetRole: 'leader' }, // dedupes against the local member
    ] as never);
    expect(await hostAudienceResolvers.listFleetMembers('git-plan')).toEqual(['local-a', 'remote-b']);
  });

  it('derives a CROSS-MACHINE leader when the durable registry row lives on another machine', async () => {
    vi.mocked(liveFleetMemberIds).mockResolvedValue(['local-a']);
    vi.mocked(getFleet).mockResolvedValue(null as never); // agent_fleets row is not on THIS machine
    vi.mocked(listFederatedFleetMembers).mockResolvedValue([
      { ownerId: 'remote-lead', fleetRole: 'leader' },
    ] as never);
    // the member audience folds in the cross-machine leader…
    expect(await hostAudienceResolvers.listFleetMembers('git-plan')).toEqual(['local-a', 'remote-lead']);
    // …and listFleetLeader resolves it from the federated fleet_role='leader' signal.
    expect(await hostAudienceResolvers.listFleetLeader('git-plan')).toEqual(['remote-lead']);
  });

  it('listFleetLeader prefers the durable LOCAL registry leader over any federated signal', async () => {
    vi.mocked(getFleet).mockResolvedValue({ leaderOwnerId: 'local-lead' } as never);
    vi.mocked(listFederatedFleetMembers).mockResolvedValue([
      { ownerId: 'remote-lead', fleetRole: 'leader' },
    ] as never);
    expect(await hostAudienceResolvers.listFleetLeader('git-plan')).toEqual(['local-lead']);
  });

  it('collapses to today\'s local-only behavior with no federated peers', async () => {
    vi.mocked(liveFleetMemberIds).mockResolvedValue(['local-a', 'local-b']);
    vi.mocked(getFleet).mockResolvedValue(null as never);
    vi.mocked(listFederatedFleetMembers).mockResolvedValue([] as never);
    expect(await hostAudienceResolvers.listFleetMembers('git-plan')).toEqual(['local-a', 'local-b']);
    expect(await hostAudienceResolvers.listFleetLeader('git-plan')).toEqual([]);
  });

  it('uses the durable last leader only when a local fleet is winding down', async () => {
    vi.mocked(getFleet).mockResolvedValue({ leaderOwnerId: null, controlState: 'winding-down' } as never);
    vi.mocked(listFederatedFleetMembers).mockResolvedValue([] as never);
    vi.mocked(latestFleetLeader).mockResolvedValue('former-lead');

    expect(await hostAudienceResolvers.listFleetLeader('git-plan')).toEqual(['former-lead']);
    expect(vi.mocked(latestFleetLeader)).toHaveBeenCalledWith(expect.any(String), 'git-plan');
  });

  it('does not resurrect a historical leader for an active leaderless fleet', async () => {
    vi.mocked(getFleet).mockResolvedValue({ leaderOwnerId: null, controlState: 'active' } as never);
    vi.mocked(listFederatedFleetMembers).mockResolvedValue([] as never);
    vi.mocked(latestFleetLeader).mockResolvedValue('stale-former-lead');

    expect(await hostAudienceResolvers.listFleetLeader('git-plan')).toEqual([]);
    expect(vi.mocked(latestFleetLeader)).not.toHaveBeenCalled();
  });
});

describe('hostAudienceResolvers.listPathLockAgents — the LOCK half of @file: (EI-18772330418885814)', () => {
  const PATH = 'apps/operator-vite/src/components/adv/LearningTab.tsx';

  beforeEach(() => {
    mockReadQueue.mockReset();
    mockReadQueue.mockResolvedValue({ active_locks: [], waiting: [] });
  });

  it('returns the owner of a live lock on the path — the case that answered ZERO', async () => {
    mockReadQueue.mockResolvedValue({ active_locks: [lock('su-29fe4', PATH)], waiting: [] });
    expect(await hostAudienceResolvers.listPathLockAgents(PATH)).toEqual(['su-29fe4']);
  });

  it('includes an agent QUEUED on the path, and dedupes one that both holds and waits', async () => {
    mockReadQueue.mockResolvedValue({
      active_locks: [lock('holder', PATH)],
      waiting: [waiter('holder', [PATH]), waiter('queued', [PATH])],
    });
    expect(await hostAudienceResolvers.listPathLockAgents(PATH)).toEqual(['holder', 'queued']);
  });

  it('reads ACROSS coordination domains with the CANONICALIZED path', async () => {
    await hostAudienceResolvers.listPathLockAgents(`./${PATH}`);
    expect(mockReadQueue).toHaveBeenCalledWith(expect.anything(), {
      // Deliberately cross-domain (null), NOT pinned to this checkout: a
      // domain-scoped read silently reports a genuinely-held lock as ABSENT, which
      // is the exact defect this resolver exists to remove. Observed live
      // 2026-07-27: an agent editing the staging tree had its lock recorded under
      // the papercup-RELEASE domain, so a pinned read would have missed it.
      coordinationDomain: null,
      paths: [PATH], // the leading './' canonicalized away — it is the same lock key
    });
  });

  it('is FAIL-SOFT: a lock plane that throws degrades to the presence-only audience, never a failed send', async () => {
    mockReadQueue.mockRejectedValue(new Error('papercusp_su unreachable'));
    await expect(hostAudienceResolvers.listPathLockAgents(PATH)).resolves.toEqual([]);
  });

  it('rejects a path the lock plane would refuse (absolute/traversal) without querying', async () => {
    expect(await hostAudienceResolvers.listPathLockAgents(`/abs/${PATH}`)).toEqual([]);
    expect(await hostAudienceResolvers.listPathLockAgents('../escape.ts')).toEqual([]);
    expect(mockReadQueue).not.toHaveBeenCalled();
  });
});
