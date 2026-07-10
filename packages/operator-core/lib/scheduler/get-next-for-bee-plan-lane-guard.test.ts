/**
 * getNextForBee's plan-item-lane retry loop (WI-3667). The global SQL floors
 * (claimFloorsWhereSql) can't express a linked plan-item's own resolved
 * effectiveStatus (a JS-side blocked-by-graph computation), so getNextForBee
 * claims atomically as before, then POST-CHECKS the plan-item lane via
 * planItemLaneBlockReason: on a hit it releases (never surfaced to the
 * caller) and retries the next row, bounded, failing open (serve-anyway) once
 * the retry budget is exhausted.
 *
 * getNextWorkItem / planItemLaneBlockReason / releaseWorkItem are mocked at
 * the module boundary — no PG. `ignoreStoredSpec:true` skips
 * getClaimSpecRecord entirely (exercised elsewhere), isolating the loop
 * under test. Run: cd packages/operator-core && npx vitest run
 * lib/scheduler/get-next-for-bee-plan-lane-guard.test.ts
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: {} }),
}));

const getNextWorkItemMock = vi.fn();
vi.mock('./get-next', () => ({
  getNextWorkItem: (...args: unknown[]) => getNextWorkItemMock(...args),
}));

const planItemLaneBlockReasonMock = vi.fn();
vi.mock('./plan-item-lane-guard', () => ({
  planItemLaneBlockReason: (...args: unknown[]) => planItemLaneBlockReasonMock(...args),
}));

const releaseWorkItemMock = vi.fn(async () => null);
vi.mock('../work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../work-items')>()),
  releaseWorkItem: (...args: unknown[]) => releaseWorkItemMock(...args),
}));

import { getNextForBee } from './claim-spec-store';

function claimResult(id: string) {
  return {
    workItem: { id, payload: { plan_item: { plan_slug: 'a-plan', item_id: id } }, harness: 'papercusp' },
    claimedUnder: { specId: 'default', revision: 1 },
  };
}

describe('getNextForBee — plan-item-lane guard retry loop', () => {
  beforeEach(() => {
    getNextWorkItemMock.mockReset();
    planItemLaneBlockReasonMock.mockReset();
    releaseWorkItemMock.mockReset().mockResolvedValue(null);
  });

  it('serves the first claim straight through when its plan-item lane is clear', async () => {
    getNextWorkItemMock.mockResolvedValueOnce(claimResult('F-1'));
    planItemLaneBlockReasonMock.mockResolvedValueOnce(null);

    const res = await getNextForBee({ cupId: 'me', harness: 'papercusp', ignoreStoredSpec: true });

    expect(res?.workItem.id).toBe('F-1');
    expect(res?.specSource).toBe('default');
    expect(getNextWorkItemMock).toHaveBeenCalledTimes(1);
    expect(releaseWorkItemMock).not.toHaveBeenCalled();
  });

  it('releases a blocked plan-linked claim and serves the next clear one', async () => {
    getNextWorkItemMock
      .mockResolvedValueOnce(claimResult('F-1')) // blocked
      .mockResolvedValueOnce(claimResult('F-2')); // clear
    planItemLaneBlockReasonMock
      .mockResolvedValueOnce({ reason: 'blocked', planSlug: 'a-plan', itemId: 'F-1', effectiveStatus: 'blocked' })
      .mockResolvedValueOnce(null);

    const res = await getNextForBee({ cupId: 'me', harness: 'papercusp', ignoreStoredSpec: true });

    expect(res?.workItem.id).toBe('F-2');
    expect(getNextWorkItemMock).toHaveBeenCalledTimes(2);
    expect(releaseWorkItemMock).toHaveBeenCalledTimes(1);
    expect(releaseWorkItemMock).toHaveBeenCalledWith('F-1', { harness: 'papercusp', expectedAssignee: 'me' });
  });

  it('returns null (never serves a blocked row) when the queue drains mid-retry', async () => {
    getNextWorkItemMock
      .mockResolvedValueOnce(claimResult('F-1'))
      .mockResolvedValueOnce(null); // nothing left after releasing F-1
    planItemLaneBlockReasonMock.mockResolvedValueOnce({
      reason: 'blocked',
      planSlug: 'a-plan',
      itemId: 'F-1',
      effectiveStatus: 'blocked',
    });

    const res = await getNextForBee({ cupId: 'me', harness: 'papercusp', ignoreStoredSpec: true });

    expect(res).toBeNull();
    expect(releaseWorkItemMock).toHaveBeenCalledTimes(1);
  });

  it('fails open and SERVES the last claim once the 5-attempt retry budget is exhausted', async () => {
    for (let i = 0; i < 5; i += 1) {
      getNextWorkItemMock.mockResolvedValueOnce(claimResult(`F-${i}`));
      planItemLaneBlockReasonMock.mockResolvedValueOnce({
        reason: 'blocked',
        planSlug: 'a-plan',
        itemId: `F-${i}`,
        effectiveStatus: 'blocked',
      });
    }

    const res = await getNextForBee({ cupId: 'me', harness: 'papercusp', ignoreStoredSpec: true });

    // Served anyway (fail-open courtesy guard, not a hard floor) — the LAST attempt's
    // claim, never released.
    expect(res?.workItem.id).toBe('F-4');
    expect(getNextWorkItemMock).toHaveBeenCalledTimes(5);
    // 4 releases (attempts 0-3); the 5th (final) claim is served, not released.
    expect(releaseWorkItemMock).toHaveBeenCalledTimes(4);
  });
});
