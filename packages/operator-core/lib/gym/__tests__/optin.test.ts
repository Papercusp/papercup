import { describe, it, expect } from 'vitest';
import { isOptInValidFor, assertProductionOptIn, type ChampionOptIn } from '../optin';

/**
 * Opt-in sign-off (P-023, D-012): the gym's OWN dedicated harness is promoted
 * unattended, but pointing a REAL production harness at the gym champion is a human
 * decision. This pure gate requires an explicit, matching, human-approved opt-in
 * record before that outward action.
 */
const optIn: ChampionOptIn = {
  approvedBy: 'avi@storewolf.com',
  championVariantId: 'v-champ-7',
  targetHarnessSlug: 'papercup',
  approvedAt: 1_780_000_000_000,
};
const ctx = { championVariantId: 'v-champ-7', targetHarnessSlug: 'papercup' };

describe('isOptInValidFor', () => {
  it('accepts a matching, human-approved opt-in', () => {
    expect(isOptInValidFor(optIn, ctx)).toBe(true);
  });
  it('rejects a null opt-in (default — no unattended production promotion)', () => {
    expect(isOptInValidFor(null, ctx)).toBe(false);
  });
  it('rejects when the champion or target does not match the opt-in', () => {
    expect(isOptInValidFor(optIn, { ...ctx, championVariantId: 'v-other' })).toBe(false);
    expect(isOptInValidFor(optIn, { ...ctx, targetHarnessSlug: 'restart' })).toBe(false);
  });
  it('rejects an opt-in with no approver', () => {
    expect(isOptInValidFor({ ...optIn, approvedBy: '' }, ctx)).toBe(false);
  });
});

describe('assertProductionOptIn', () => {
  it('throws without a valid opt-in', () => {
    expect(() => assertProductionOptIn(null, ctx)).toThrow(/opt-in/i);
  });
  it('passes with a valid opt-in', () => {
    expect(() => assertProductionOptIn(optIn, ctx)).not.toThrow();
  });
});
