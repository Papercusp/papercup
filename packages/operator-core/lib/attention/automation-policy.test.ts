import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STANDING_BULK_AUTOMATION_POLICY,
  normalizeStandingBulkAutomationPolicy,
} from './bulk-dispositions';
import { standingAutomationEligibility } from './automation-policy';

describe('P-006 standing automation policy', () => {
  it('ships L0 review-all with an independent high confidence floor', () => {
    expect(DEFAULT_STANDING_BULK_AUTOMATION_POLICY).toEqual({ level: 'L0', minConfidence: 'high' });
    expect(normalizeStandingBulkAutomationPolicy({ level: 'L2', minConfidence: 'low' })).toEqual({
      level: 'L2',
      minConfidence: 'low',
    });
  });

  it('requires BOTH authority and confidence axes for a delegable kind', () => {
    expect(
      standingAutomationEligibility({ level: 'L1', minConfidence: 'high' }, 'coord-message', 'medium'),
    ).toEqual({ allowed: false, reason: 'confidence-below-floor' });
    expect(
      standingAutomationEligibility({ level: 'L1', minConfidence: 'medium' }, 'coord-message', 'high'),
    ).toEqual({ allowed: true, reason: null });
  });

  it('falsifiability control: above-floor owner-by-right still refuses at L1', () => {
    expect(
      standingAutomationEligibility({ level: 'L1', minConfidence: 'high' }, 'work-item-needs-human', 'high'),
    ).toEqual({ allowed: false, reason: 'owner-by-right' });
  });

  it('granting L2 authority does not bypass the confidence floor', () => {
    expect(
      standingAutomationEligibility({ level: 'L2', minConfidence: 'high' }, 'work-item-needs-human', 'medium'),
    ).toEqual({ allowed: false, reason: 'confidence-below-floor' });
  });

  it('never-auto remains a permanent floor at every level and confidence', () => {
    expect(
      standingAutomationEligibility({ level: 'L2', minConfidence: 'low' }, 'smoke-fail', 'high'),
    ).toEqual({ allowed: false, reason: 'never-auto' });
  });
});
