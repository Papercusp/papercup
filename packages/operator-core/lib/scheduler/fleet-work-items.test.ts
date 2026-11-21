import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLAIM_SPEC, positiveIdCohortIds, validateClaimSpec, type ClaimSpec } from './claim-spec';
import { matchesWorkItemClaimSpec } from './claim-spec-match';
import type { WorkItem, OrgSql } from '../work-items';
import { buildFleetWorkItemsClaimSpec, enrollFleetWorkItems, fenceMemberWorkItems, preflightFleetWorkItems } from './fleet-work-items';

const mocks = vi.hoisted(() => ({ sql: vi.fn(), get: vi.fn(), set: vi.fn(), lane: vi.fn() }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: mocks.sql }) }));
vi.mock('./claim-spec-store', () => ({ fleetSpecBeeKey: (fleet: string) => `fleet:${fleet}`,
  getClaimSpecRecord: (...args: unknown[]) => mocks.get(...args), setClaimSpec: (...args: unknown[]) => mocks.set(...args) }));
vi.mock('../fleet/lane-health', () => ({ readClaimSpecLaneHealth: (...args: unknown[]) => mocks.lane(...args) }));

const item = (id: string) => ({ id, kind: 'task', family: 'issue', payload: null }) as WorkItem;
const record = (spec: ClaimSpec) => ({ source: 'fleet', spec, revision: 7,
  updatedBy: 'leader', updatedAt: null, harnessSlug: 'test', fleetSlug: 'outside' });

beforeEach(() => { vi.clearAllMocks(); mocks.set.mockResolvedValue({ ok: true, revision: 8, errors: [] }); });

describe('exact fleet work-item admission', () => {
  it.each([99, 100, 101])('preserves the complete %i-item set through a restart serialization', n => {
    const ids = Array.from({ length: n }, (_, i) => `WI-${i + 1}`);
    const saved = JSON.parse(JSON.stringify(buildFleetWorkItemsClaimSpec('outside', ids))) as ClaimSpec;
    expect(validateClaimSpec(saved).ok).toBe(true);
    expect(positiveIdCohortIds(saved.view.filter)).toEqual(ids);
    expect(matchesWorkItemClaimSpec(item(ids.at(-1)!), saved)).toBe(true);
    expect(matchesWorkItemClaimSpec(item('WI-unrelated'), saved)).toBe(false);
  });

  it.each([79, 80])('retains an intact %i-character identity', n => {
    const id = 'a'.repeat(n);
    expect(positiveIdCohortIds(buildFleetWorkItemsClaimSpec('outside', [id]).view.filter)).toEqual([id]);
  });
  it('rejects overflowing and malformed identities instead of slicing them', () => {
    for (const ids of [[], [''], ['a'.repeat(81)], [' WI-1']]) {
      expect(() => buildFleetWorkItemsClaimSpec('outside', ids)).toThrow('intact');
    }
  });

  it('fences an existing broad member override and follows a later live parent addition', () => {
    const member = { ...DEFAULT_CLAIM_SPEC, view: { filter: { field: 'kind', op: '=', value: 'task' } } } as ClaimSpec;
    const parent = buildFleetWorkItemsClaimSpec('outside', ['WI-1', 'WI-2']);
    expect(matchesWorkItemClaimSpec(item('WI-unrelated'), fenceMemberWorkItems(member, parent))).toBe(false);
    expect(matchesWorkItemClaimSpec(item('WI-3'), fenceMemberWorkItems(member, parent))).toBe(false);
    const later = buildFleetWorkItemsClaimSpec('outside', ['WI-1', 'WI-2', 'WI-3']);
    expect(matchesWorkItemClaimSpec(item('WI-3'), fenceMemberWorkItems(member, later))).toBe(true);
    expect(fenceMemberWorkItems(member, member)).toBe(member);
  });

  it('uses the dependency-aware scheduler frontier and refuses an over-wide launch', async () => {
    mocks.sql.mockResolvedValue(['WI-1', 'WI-2', 'WI-3'].map(id => ({ id })));
    // Third row is blocked by WI-1; the canonical floor reader measures two ready rows.
    mocks.lane.mockResolvedValue({ effective: { claimable: 2, excluded: { dependencies: 1 } } });
    const args = { workspaceId: 'ws', harness: 'test', fleetSlug: 'outside',
      workItems: ['WI-1', 'WI-2', 'WI-3'], requestedSeats: 2 };
    expect(await preflightFleetWorkItems(args)).toMatchObject({ ready: true, executableWidth: 2 });
    expect(await preflightFleetWorkItems({ ...args, requestedSeats: 3 })).toMatchObject({
      ready: false, executableWidth: 2, seatShortfall: 1, reason: 'insufficient-executable-width' });
    expect(positiveIdCohortIds(mocks.lane.mock.calls[0][0].spec.view.filter)).toEqual(args.workItems);
  });
  it('fails closed on an unknown frontier or missing requested item', async () => {
    const args = { workspaceId: 'ws', harness: 'test', fleetSlug: 'outside', workItems: ['WI-1'], requestedSeats: 1 };
    mocks.sql.mockResolvedValue([{ id: 'WI-1' }]); mocks.lane.mockResolvedValue(null);
    expect(await preflightFleetWorkItems(args)).toMatchObject({ ready: false, reason: 'lane-unknown' });
    mocks.sql.mockResolvedValue([]);
    expect(await preflightFleetWorkItems(args)).toMatchObject({ ready: false, missing: ['WI-1'] });
  });
});

describe('transactional child enrollment', () => {
  it('locks and appends in the caller transaction while retaining scope and policy', async () => {
    const spec = { ...buildFleetWorkItemsClaimSpec('outside', ['WI-1']),
      states: ['open'], limits: { maxConcurrentClaims: 1 } } as ClaimSpec;
    mocks.get.mockResolvedValue(record(spec));
    const args = { workspaceId: 'ws', fleetSlug: 'outside', workItemIds: ['WI-2'], updatedBy: 'member' };
    const result = await enrollFleetWorkItems(args, mocks.sql as unknown as OrgSql);
    expect(result).toEqual({ enrolled: true, workItems: ['WI-1', 'WI-2'] });
    expect(mocks.sql.mock.calls[0][0].join('')).toContain('FOR UPDATE');
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({ potSlug: 'test',
      spec: expect.objectContaining({ rank: spec.rank, states: spec.states, limits: spec.limits }) }), mocks.sql);
  });
  it('leaves dynamic fleets untouched and propagates a failed enrollment for rollback', async () => {
    const args = { workspaceId: 'ws', fleetSlug: 'outside', workItemIds: ['WI-2'], updatedBy: 'member' };
    mocks.get.mockResolvedValue(record(DEFAULT_CLAIM_SPEC));
    expect(await enrollFleetWorkItems(args, mocks.sql as unknown as OrgSql)).toEqual({ enrolled: false, workItems: [] });
    expect(mocks.set).not.toHaveBeenCalled();
    mocks.get.mockResolvedValue(record(buildFleetWorkItemsClaimSpec('outside', ['WI-1'])));
    mocks.set.mockResolvedValue({ ok: false, errors: ['write refused'] });
    await expect(enrollFleetWorkItems(args, mocks.sql as unknown as OrgSql)).rejects.toThrow('write refused');
  });
});
