import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolvePresenceFleet = vi.hoisted(() => vi.fn());
const getFleet = vi.hoisted(() => vi.fn());
const resolveFleetClaimSpec = vi.hoisted(() => vi.fn());
const readClaimSpecLaneHealth = vi.hoisted(() => vi.fn());
const getPlanRow = vi.hoisted(() => vi.fn());
const planItemsForRow = vi.hoisted(() => vi.fn());
const analyzePlanDagParallelism = vi.hoisted(() => vi.fn());

vi.mock('../agent-tools/coordination/presence-fleet', () => ({ resolvePresenceFleet }));
vi.mock('../agent-fleets-store', () => ({ getFleet }));
vi.mock('../scheduler/claim-spec-store', () => ({ resolveFleetClaimSpec }));
vi.mock('./lane-health', () => ({ readClaimSpecLaneHealth }));
vi.mock('../agent-tools/plans/source', () => ({ getPlanRow, planItemsForRow }));
vi.mock('../agent-tools/plans/plan-dag-parallelism', () => ({ analyzePlanDagParallelism }));

import {
  canonicalExecutableWidth,
  exactPositiveSinglePlanSlugFromFilter,
  readFleetExecutableFrontier,
} from './executable-frontier';

describe('canonical executable frontier (WI-41169 / P-007 reusing P-011)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolvePresenceFleet.mockResolvedValue({ fleetSlug: 'fleet-a', fleetRole: 'member' });
    getFleet.mockResolvedValue({ controlState: 'active' });
    resolveFleetClaimSpec.mockResolvedValue({
      fleetSlug: 'fleet-a',
      matchedBy: 'fleet-slug',
      record: {
        harnessSlug: 'papercusp',
        spec: {
          view: { filter: { field: 'plan', op: '=', value: 'one-plan' } },
        },
      },
    });
    getPlanRow.mockResolvedValue({ id: 'plan-row' });
    planItemsForRow.mockReturnValue([{ id: 'P-001' }]);
    analyzePlanDagParallelism.mockReturnValue({ readyWidth: 7 });
    readClaimSpecLaneHealth.mockResolvedValue({ effective: { claimable: 3 } });
  });

  it('uses min(readyWidth, family-complete claimable) for an active exact-plan fleet', async () => {
    await expect(
      readFleetExecutableFrontier({ ownerId: 'su-1', workspaceId: 'ws-1' }),
    ).resolves.toEqual({
      fleetSlug: 'fleet-a',
      harnessSlug: 'papercusp',
      planSlug: 'one-plan',
      readyWidth: 7,
      claimable: 3,
      executableWidth: 3,
    });
    expect(getPlanRow).toHaveBeenCalledOnce();
    expect(readClaimSpecLaneHealth).toHaveBeenCalledOnce();
  });

  it('silences paused, broad, missing, and unknown measurements instead of emitting zero', async () => {
    getFleet.mockResolvedValueOnce({ controlState: 'winding-down' });
    await expect(readFleetExecutableFrontier({ ownerId: 'su-1', workspaceId: 'ws-1' })).resolves.toBeNull();

    resolveFleetClaimSpec.mockResolvedValueOnce({
      fleetSlug: 'fleet-a',
      matchedBy: 'fleet-slug',
      record: {
        harnessSlug: 'papercusp',
        spec: {
          view: {
            filter: {
              any: [
                { field: 'plan', op: '=', value: 'one-plan' },
                { field: 'kind', op: '=', value: 'bug' },
              ],
            },
          },
        },
      },
    });
    await expect(readFleetExecutableFrontier({ ownerId: 'su-1', workspaceId: 'ws-1' })).resolves.toBeNull();

    resolvePresenceFleet.mockResolvedValueOnce({ fleetSlug: null, fleetRole: null });
    await expect(readFleetExecutableFrontier({ ownerId: 'su-1', workspaceId: 'ws-1' })).resolves.toBeNull();

    readClaimSpecLaneHealth.mockResolvedValueOnce({ effective: { claimable: null } });
    await expect(readFleetExecutableFrontier({ ownerId: 'su-1', workspaceId: 'ws-1' })).resolves.toBeNull();
  });

  it('fails soft when any reader rejects', async () => {
    getPlanRow.mockRejectedValueOnce(new Error('plan store unavailable'));
    await expect(readFleetExecutableFrontier({ ownerId: 'su-1', workspaceId: 'ws-1' })).resolves.toBeNull();
  });

  it('proves exact plan scope across AND/OR branches and rejects a broad OR', () => {
    expect(
      exactPositiveSinglePlanSlugFromFilter({
        any: [
          { all: [{ field: 'plan', op: '=', value: 'one-plan' }, { field: 'kind', op: '=', value: 'bug' }] },
          { all: [{ field: 'plan', op: '=', value: 'one-plan' }, { field: 'kind', op: '=', value: 'change' }] },
        ],
      }),
    ).toBe('one-plan');
    expect(
      exactPositiveSinglePlanSlugFromFilter({
        any: [
          { field: 'plan', op: '=', value: 'one-plan' },
          { field: 'kind', op: '=', value: 'bug' },
        ],
      }),
    ).toBeNull();
  });

  it('treats invalid or unknown width legs as unknown', () => {
    expect(canonicalExecutableWidth({ readyWidth: 7, claimable: 3 })).toBe(3);
    expect(canonicalExecutableWidth({ readyWidth: null, claimable: 3 })).toBeNull();
    expect(canonicalExecutableWidth({ readyWidth: 7, claimable: -1 })).toBeNull();
  });
});
