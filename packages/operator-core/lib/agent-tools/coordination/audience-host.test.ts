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
vi.mock('../../fleet/fleet-roster', () => ({ liveFleetMemberIds: vi.fn(async () => []) }));
vi.mock('../../agent-fleets-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-fleets-store')>()),
  getFleet: vi.fn(async () => null),
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

import {
  audienceMode,
  canonicalizeAudienceSelector,
  deriveAudienceKey,
  hostAudienceResolvers,
} from './audience-host';
import { listPresence } from './presence';
import { liveFleetMemberIds } from '../../fleet/fleet-roster';
import { getFleet } from '../../agent-fleets-store';
import { getFleetDeliveryOverrides } from './fleet-delivery';
import { listFederatedFleetMembers } from '../../sync/hyperbee/session-presence-store';

const mockListPresence = listPresence as unknown as ReturnType<typeof vi.fn>;

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
});
