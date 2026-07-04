/**
 * liveness.test.ts — EI-7189 (previous-holder-still-live warning on a plan-item
 * claim steal). Unit-tests the PURE decision (`priorHolderStillLive`) only — the
 * presence/wakeability FETCH that produces a real `SessionState` is the untested IO
 * seam, exactly mirroring presence-wakeability.ts's own fetchWakeability/
 * deriveSessionState split (fetchWakeability is documented best-effort IO; only
 * deriveSessionState is unit-tested there). `claimPlanItem` itself is covered by the
 * existing PG-backed integration tests (claims.integration.test.ts,
 * convert.integration.test.ts) — this file adds no PG dependency.
 */
import { describe, expect, it } from 'vitest';
import { priorHolderStillLive } from './liveness';
import type { PlanItemClaim } from './claims';

const lapsedClaim = (owner: string): Pick<PlanItemClaim, 'owner' | 'expired'> => ({ owner, expired: true });
const liveClaim = (owner: string): Pick<PlanItemClaim, 'owner' | 'expired'> => ({ owner, expired: false });

describe('priorHolderStillLive (EI-7189)', () => {
  it('warns when the prior claim LAPSED and its owner still looks live', () => {
    expect(priorHolderStillLive(lapsedClaim('su-A'), 'su-B', 'live')).toBe(true);
  });

  it('warns when the prior claim LAPSED and its owner looks parked (idle but alive)', () => {
    expect(priorHolderStillLive(lapsedClaim('su-A'), 'su-B', 'parked')).toBe(true);
  });

  it('does NOT warn when the prior owner looks ended (genuinely dead — the normal case)', () => {
    expect(priorHolderStillLive(lapsedClaim('su-A'), 'su-B', 'ended')).toBe(false);
  });

  it('does NOT warn when presence is unknown (a lookup failure or no row — never block on uncertainty)', () => {
    expect(priorHolderStillLive(lapsedClaim('su-A'), 'su-B', null)).toBe(false);
  });

  it('does NOT warn when there is no prior claim at all (a fresh, never-claimed item)', () => {
    expect(priorHolderStillLive(null, 'su-B', 'live')).toBe(false);
  });

  it('does NOT warn when the prior claim is still LIVE, not lapsed (that path is a conflict, not a steal)', () => {
    expect(priorHolderStillLive(liveClaim('su-A'), 'su-B', 'live')).toBe(false);
  });

  it('does NOT warn when the caller is reclaiming their OWN lapsed lease', () => {
    expect(priorHolderStillLive(lapsedClaim('su-A'), 'su-A', 'live')).toBe(false);
  });
});
