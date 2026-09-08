import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '../work-items';
import {
  deriveLegacyFleetScopeDowngradeAdmission,
  type FleetScopeContext,
} from './fleet-scope-admission';
import {
  isLegacyFleetScopeDowngradeAdmission,
  readFleetScopeDowngradeMarker,
} from '../work-item-fleet-scope-recovery';

const fleetIO = vi.hoisted(() => ({ getFleet: vi.fn() }));
vi.mock('../agent-fleets-store', () => ({ getFleet: fleetIO.getFleet }));

const scope = {
  ownerId: 'su-member',
  fleetSlug: 'recovery-fleet',
  fleetRole: 'member',
  workspaceId: 'workspace-1',
  record: { source: 'fleet' },
} as unknown as FleetScopeContext;

function item(over: Partial<Pick<WorkItem, 'id' | 'payload' | 'createdBy'>> = {}) {
  return {
    id: 'EI-recovery',
    createdBy: 'su-leader',
    payload: {
      fleetScopeDowngrade: {
        requestedAssignee: 'stable-member',
        reportedBy: 'su-leader',
        fleet: 'recovery-fleet',
        code: 'fleet_scope_violation',
        at: new Date().toISOString(),
      },
    },
    ...over,
  } satisfies Pick<WorkItem, 'id' | 'payload' | 'createdBy'>;
}

beforeEach(() => {
  fleetIO.getFleet.mockReset().mockResolvedValue({
    controlState: 'active',
    leaderOwnerId: 'su-leader',
  });
});

describe('EI-226378 legacy fleet-scope downgrade recovery admission', () => {
  it('mints only for the exact target and current durable leader', async () => {
    const admission = await deriveLegacyFleetScopeDowngradeAdmission(
      item(),
      'stable-member',
      scope,
      'su-leader',
    );

    expect(admission).toMatchObject({
      itemId: 'EI-recovery',
      target: 'stable-member',
      workspaceId: 'workspace-1',
      leaderOwnerId: 'su-leader',
    });
    expect(isLegacyFleetScopeDowngradeAdmission(admission)).toBe(true);
    // A caller cannot copy the marker/capability fields to manufacture the private receipt.
    expect(isLegacyFleetScopeDowngradeAdmission({ ...admission })).toBe(false);
  });

  it.each([
    ['wrong target', 'other-member', 'su-leader'],
    ['missing actor', 'stable-member', null],
    ['peer actor', 'stable-member', 'su-peer'],
  ])('rejects %s', async (_label, target, actor) => {
    await expect(
      deriveLegacyFleetScopeDowngradeAdmission(item(), target, scope, actor),
    ).resolves.toBeNull();
  });

  it('rejects a marker from a stale reporter even when the item target matches', async () => {
    await expect(
      deriveLegacyFleetScopeDowngradeAdmission(
        item({
          createdBy: 'su-former-leader',
          payload: {
            fleetScopeDowngrade: {
              requestedAssignee: 'stable-member',
              reportedBy: 'su-former-leader',
              fleet: 'recovery-fleet',
              code: 'fleet_scope_violation',
              at: new Date().toISOString(),
            },
          },
        }),
        'stable-member',
        scope,
        'su-former-leader',
      ),
    ).resolves.toBeNull();
  });

  it('rejects a winding-down fleet before minting recovery authority', async () => {
    fleetIO.getFleet.mockResolvedValue({ controlState: 'winding-down', leaderOwnerId: 'su-leader' });
    await expect(
      deriveLegacyFleetScopeDowngradeAdmission(item(), 'stable-member', scope, 'su-leader'),
    ).resolves.toBeNull();
  });

  it.each([
    ['unknown code', 'unknown_code', new Date().toISOString()],
    ['stale marker', 'fleet_scope_violation', new Date(Date.now() - 25 * 60 * 60_000).toISOString()],
    ['future marker', 'fleet_scope_violation', new Date(Date.now() + 6 * 60_000).toISOString()],
  ])('does not parse a %s', (_label, code, at) => {
    expect(readFleetScopeDowngradeMarker({
      fleetScopeDowngrade: {
        requestedAssignee: 'stable-member',
        reportedBy: 'su-leader',
        fleet: 'recovery-fleet',
        code,
        at,
      },
    })).toBeNull();
  });
});
