import { describe, it, expect } from 'vitest';
import { shouldRevert, decideRollout, ROLLOUT_LADDER } from './regression-gate';
import type { BakeoffResult, BakeoffVerdict } from './framework-bake-off';

const result = (verdict: BakeoffVerdict): BakeoffResult => ({
  flagKey: 'papercusp-touch-set-exclusion',
  baseline: { arm: 'baseline', flagOn: false, scores: [], meanComposite: 0, gatePassRate: 0 },
  treatment: { arm: 'treatment', flagOn: true, scores: [], meanComposite: 0, gatePassRate: 0 },
  delta: { deltaMeanComposite: 0, deltaGatePassRate: 0, verdict },
});

describe('shouldRevert', () => {
  it('reverts only on a regressed verdict', () => {
    expect(shouldRevert(result('regressed'))).toBe(true);
    expect(shouldRevert(result('improved'))).toBe(false);
    expect(shouldRevert(result('neutral'))).toBe(false);
    expect(shouldRevert(result('inconclusive'))).toBe(false);
  });
});

describe('decideRollout', () => {
  it('advances one rung on improved', () => {
    expect(decideRollout('off', 'improved')).toMatchObject({ action: 'advance', to: 'canary' });
    expect(decideRollout('canary', 'improved')).toMatchObject({ action: 'advance', to: 'quarter' });
    expect(decideRollout('half', 'improved')).toMatchObject({ action: 'advance', to: 'full' });
  });

  it('holds at full even on improved (top of the ladder)', () => {
    expect(decideRollout('full', 'improved')).toMatchObject({ action: 'hold', to: 'full' });
  });

  it('reverts to off from ANY rung on regressed (the un-gameable floor)', () => {
    for (const stage of ROLLOUT_LADDER) {
      expect(decideRollout(stage, 'regressed')).toMatchObject({ action: 'revert', to: 'off' });
    }
  });

  it('holds on neutral / inconclusive', () => {
    expect(decideRollout('quarter', 'neutral')).toMatchObject({ action: 'hold', to: 'quarter' });
    expect(decideRollout('canary', 'inconclusive')).toMatchObject({ action: 'hold', to: 'canary' });
  });
});
