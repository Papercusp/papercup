/**
 * Unit tests for the pure `shapePlanItemStates` DTO mapper (P-005a). No DB — the
 * live DB read path is covered by the HTTP round-trip live-verify. Here we pin the
 * flattening: assignment/claim → flat fields, disposition pass-through, the
 * availability-vs-activity liveness surface, and empty-intent → null.
 */
import { describe, it, expect } from 'vitest';
import { shapePlanItemStates } from './plan-item-states';
import type { MergedPlanItemState } from '../../../plan-items/liveness';
import type { PlanItemAssignment } from '../../../plan-items/assignments';
import type { PlanItemClaim } from '../../../plan-items/claims';

function assignment(itemId: string, assigneeName: string): PlanItemAssignment {
  return {
    workspaceId: '*', harnessSlug: 'papercup', planSlug: 'p', itemId,
    assigneeName, assignedByUser: 'user', assignedTs: '2026-06-04T00:00:00Z',
    releasedTs: null, strategy: null, note: null, updatedAt: '2026-06-04T00:00:00Z',
  };
}
function claim(itemId: string, ownerName: string, mode: 'availability' | 'activity', intent = 'building'): PlanItemClaim {
  return {
    workspaceId: '*', harnessSlug: 'papercup', planSlug: 'p', itemId,
    claimId: 'c-1', owner: 'su-abc', ownerLabel: 'su · abc', ownerName,
    intent, livenessMode: mode, ttlSec: 1200,
    acquiredTs: '2026-06-04T00:00:00Z', expiresTs: '2026-06-04T00:20:00Z',
    lastActivityTs: '2026-06-04T00:00:00Z', expired: false,
  };
}
function merged(over: Partial<MergedPlanItemState> & Pick<MergedPlanItemState, 'itemId' | 'disposition'>): MergedPlanItemState {
  return {
    itemStatus: 'todo', assignment: null, claim: null, inPlan: true, ...over,
  };
}

describe('shapePlanItemStates', () => {
  it('passes through harness + plan + harnessLivenessMode', () => {
    const dto = shapePlanItemStates('papercup', 'my-plan', 'activity', []);
    expect(dto).toMatchObject({ harness: 'papercup', plan: 'my-plan', harnessLivenessMode: 'activity', items: [] });
  });

  it('flattens a pooled item to null assignment + null claim', () => {
    const dto = shapePlanItemStates('papercup', 'p', 'availability', [
      merged({ itemId: 'P-001', disposition: 'pooled' }),
    ]);
    expect(dto.items[0]).toEqual({
      itemId: 'P-001', itemStatus: 'todo', inPlan: true, disposition: 'pooled',
      assigneeName: null, claimOwner: null, claimOwnerName: null,
      claimIntent: null, claimLivenessMode: null, claimExpiresTs: null,
    });
  });

  it('flattens an active item (assigned + live claim by the assignee)', () => {
    const dto = shapePlanItemStates('papercup', 'p', 'activity', [
      merged({
        itemId: 'P-002', disposition: 'active',
        assignment: assignment('P-002', 'builder-1'),
        claim: claim('P-002', 'builder-1', 'activity'),
      }),
    ]);
    expect(dto.items[0]).toMatchObject({
      itemId: 'P-002', disposition: 'active', assigneeName: 'builder-1',
      claimOwner: 'su · abc', claimOwnerName: 'builder-1',
      claimIntent: 'building', claimLivenessMode: 'activity',
      claimExpiresTs: '2026-06-04T00:20:00Z',
    });
  });

  it('surfaces a claimed-mismatch (claim held by a non-assignee — drift)', () => {
    const dto = shapePlanItemStates('papercup', 'p', 'availability', [
      merged({
        itemId: 'P-003', disposition: 'claimed-mismatch',
        assignment: assignment('P-003', 'owner-a'),
        claim: claim('P-003', 'other-b', 'availability'),
      }),
    ]);
    expect(dto.items[0]).toMatchObject({
      disposition: 'claimed-mismatch', assigneeName: 'owner-a', claimOwnerName: 'other-b',
    });
  });

  it('coerces an empty/whitespace claim intent to null', () => {
    const dto = shapePlanItemStates('papercup', 'p', 'availability', [
      merged({ itemId: 'P-004', disposition: 'claimed-pooled', claim: claim('P-004', 'x', 'availability', '   ') }),
    ]);
    expect(dto.items[0].claimIntent).toBeNull();
  });

  it('falls back claimOwner to owner when ownerLabel is null', () => {
    const c = claim('P-005', 'n', 'availability');
    c.ownerLabel = null;
    const dto = shapePlanItemStates('papercup', 'p', 'availability', [
      merged({ itemId: 'P-005', disposition: 'claimed-pooled', claim: c }),
    ]);
    expect(dto.items[0].claimOwner).toBe('su-abc');
  });
});
