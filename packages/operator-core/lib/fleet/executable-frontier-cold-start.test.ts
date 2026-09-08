import { expect, it, vi } from 'vitest';

const cold = vi.hoisted(() => ({
  fleetReads: vi.fn(() => { throw new Error('Fleet read model is unavailable'); }),
}));

vi.mock('../agent-tools/coordination/presence-fleet', () => ({
  resolvePresenceFleet: async () => ({ fleetSlug: null, fleetRole: null }),
}));
vi.mock('../agent-fleets-store', () => ({
  FLEET_TYPES: ['single', 'paired'] as const,
  getFleet: cold.fleetReads(),
}));
vi.mock('../scheduler/claim-spec-store', cold.fleetReads);
vi.mock('./lane-health', cold.fleetReads);
vi.mock('../agent-tools/plans/source', cold.fleetReads);
vi.mock('../agent-tools/plans/plan-dag-parallelism', cold.fleetReads);

import { readFleetExecutableFrontier } from './executable-frontier';

it('answers a fresh non-fleet session without loading the fleet read models', async () => {
  await expect(readFleetExecutableFrontier({ ownerId: 'fresh-su', workspaceId: 'isolated' }))
    .resolves.toBeNull();
  expect(cold.fleetReads).not.toHaveBeenCalled();
});
