import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PER_SOURCE_RATE_CAP,
  FEDERATION_TIER_WEIGHT,
  federationReputationWeight,
  sourceRateCapExceeded,
  sourceRateRemaining,
} from './federation-reputation';

describe('FEDERATION_TIER_WEIGHT', () => {
  it('hard-zeroes unverified and rises with earned standing', () => {
    expect(FEDERATION_TIER_WEIGHT.unverified).toBe(0);
    expect(FEDERATION_TIER_WEIGHT.known).toBeLessThan(FEDERATION_TIER_WEIGHT.member);
    expect(FEDERATION_TIER_WEIGHT.member).toBeLessThan(FEDERATION_TIER_WEIGHT.trusted);
    expect(FEDERATION_TIER_WEIGHT.trusted).toBe(1);
  });
});

describe('federationReputationWeight — weight = winRate × tierWeight', () => {
  it('weights a trusted source by its Laplace-smoothed verified win-rate', () => {
    const r = federationReputationWeight({
      tier: 'trusted',
      outcomes: { verifiedWins: 8, verifiedDecided: 10 },
      priorCount: 2,
    });
    expect(r.winRate).toBeCloseTo(9 / 12, 10); // (8 + 1) / (10 + 2)
    expect(r.tierWeight).toBe(1);
    expect(r.weight).toBeCloseTo(0.75, 10);
    expect(r.verified).toBe(true);
  });

  it('scales the same win-rate down by a lower tier', () => {
    const r = federationReputationWeight({
      tier: 'member',
      outcomes: { verifiedWins: 8, verifiedDecided: 10 },
      priorCount: 2,
    });
    expect(r.winRate).toBeCloseTo(0.75, 10);
    expect(r.tierWeight).toBe(FEDERATION_TIER_WEIGHT.member);
    expect(r.weight).toBeCloseTo(0.75 * FEDERATION_TIER_WEIGHT.member, 10);
    expect(r.verified).toBe(true);
  });

  it('GUARD 1: an unverified source decays to zero weight even with a great win-rate', () => {
    const r = federationReputationWeight({
      tier: 'unverified',
      outcomes: { verifiedWins: 10, verifiedDecided: 10 },
    });
    expect(r.tierWeight).toBe(0);
    expect(r.weight).toBe(0);
    expect(r.verified).toBe(false);
  });

  it('GUARD 1: no verified decided outcomes ⇒ zero weight / null win-rate (unearned track record)', () => {
    const r = federationReputationWeight({
      tier: 'trusted',
      outcomes: { verifiedWins: 0, verifiedDecided: 0 },
    });
    expect(r.winRate).toBeNull();
    expect(r.weight).toBe(0);
    expect(r.verified).toBe(false);
  });

  it('clamps verifiedWins to verifiedDecided and defaults the prior to 2', () => {
    const r = federationReputationWeight({
      tier: 'trusted',
      outcomes: { verifiedWins: 15, verifiedDecided: 10 }, // wins clamped to 10
    });
    expect(r.winRate).toBeCloseTo(11 / 12, 10); // (10 + 1) / (10 + 2)
  });
});

describe('per-source rate caps — GUARD 2 (anti-flood)', () => {
  it('reports remaining admissions and never goes negative', () => {
    expect(sourceRateRemaining({ usedThisWindow: 5, capPerWindow: 20 })).toBe(15);
    expect(sourceRateRemaining({ usedThisWindow: 25, capPerWindow: 20 })).toBe(0);
  });

  it('falls back to the default cap when unset', () => {
    expect(sourceRateRemaining({ usedThisWindow: 5 })).toBe(DEFAULT_PER_SOURCE_RATE_CAP - 5);
  });

  it('flags an exceeded source at the cap boundary', () => {
    expect(sourceRateCapExceeded({ usedThisWindow: 20, capPerWindow: 20 })).toBe(true);
    expect(sourceRateCapExceeded({ usedThisWindow: 19, capPerWindow: 20 })).toBe(false);
  });
});
