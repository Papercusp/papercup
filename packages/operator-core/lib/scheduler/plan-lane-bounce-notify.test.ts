/**
 * WI-7316 — the post-claim plan-lane bounce notification must never be able to break the claim path.
 *
 * `getNextForBee` claims a row, finds its linked plan item blocked, tells the caller (so the miss
 * it is about to return can explain itself), then RELEASES the row and writes the audit. The
 * release is what keeps the bounced row claimable by the next agent, so a throw escaping the
 * notification would strand a real work-item claimed-but-unreleased for its whole lease — a
 * caller's observability hook silently removing work from the fleet's queue.
 *
 * That is the one claim in this seam worth pinning, and it is pinned here rather than inside
 * getNextForBee because reaching the bounce there needs a real claim against PG.
 */
import { describe, it, expect, vi } from 'vitest';
import { notifyPlanLaneBlocked } from './claim-spec-store';
import type { PlanItemLaneBlock } from './plan-item-lane-guard';

const BLOCK: PlanItemLaneBlock = {
  reason: 'plan-item drain#P-011 is effectively blocked',
  planSlug: 'drain',
  itemId: 'P-011',
  effectiveStatus: 'blocked',
  staleBlockedHint: "stored status 'blocked' but every blocked-by dependency is already resolved",
};

describe('WI-7316: notifyPlanLaneBlocked', () => {
  it('forwards the whole block PLUS the work-item id — the id is what makes the hint actionable', () => {
    const seen = vi.fn();

    notifyPlanLaneBlocked(seen, BLOCK, 'WI-9');

    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith({ ...BLOCK, workItemId: 'WI-9' });
  });

  it('SWALLOWS a throwing callback — the release + audit that follow it must still run', () => {
    const thrower = vi.fn(() => {
      throw new Error('caller hook blew up');
    });

    // The assertion IS "does not throw": a rejection here propagates out of getNextForBee's
    // bounce path and skips the release, leaving the row claimed by a caller that never got it.
    expect(() => notifyPlanLaneBlocked(thrower, BLOCK, 'WI-9')).not.toThrow();
    expect(thrower).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no callback was supplied — every caller but scheduler:get_next passes none', () => {
    expect(() => notifyPlanLaneBlocked(undefined, BLOCK, 'WI-9')).not.toThrow();
  });
});
