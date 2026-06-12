/**
 * affinity.test.ts — the pure owner-preference model (P-043 / FB-15):
 * minimum-evidence cold start, bucket engagement lift (promote AND demote),
 * the ignored-despite-exposure penalty with its engaged-item exemption, and
 * the bounded/rounded output contract. The IO leg is
 * interactions.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  computeOwnerPreference,
  type OwnerEngagement,
  type OwnerSignal,
  type PreferenceItem,
} from './affinity';

const item = (id: string, over: Partial<PreferenceItem> = {}): PreferenceItem => ({
  id,
  severity: 'minor',
  scope: 'operator',
  ageDays: 1,
  ...over,
});

const signal = (over: Partial<OwnerSignal> = {}): OwnerSignal => ({
  engagements: [],
  exposureCountById: new Map(),
  exposureCountByBucket: new Map(),
  totalExposures: 0,
  ...over,
});

/** 6 owner grades, all on critical/operator items (no per-item attribution). */
const criticalHeavyEngagements: OwnerEngagement[] = Array.from({ length: 6 }, () => ({
  kind: 'grade' as const,
  severity: 'critical',
  scope: 'operator',
}));

describe('computeOwnerPreference — cold start (honest data starvation)', () => {
  it('below the minimum-engagement floor everything scores 0 (empty map)', () => {
    const out = computeOwnerPreference(
      [item('EI-A', { severity: 'critical' })],
      signal({
        engagements: criticalHeavyEngagements.slice(0, 4),
        exposureCountByBucket: new Map([['severity:critical', 10]]),
        totalExposures: 10,
      }),
    );
    expect(out.size).toBe(0);
  });

  it('empty queue → empty map', () => {
    expect(computeOwnerPreference([], signal()).size).toBe(0);
  });
});

describe('computeOwnerPreference — bucket engagement lift', () => {
  const liftSignal = signal({
    engagements: criticalHeavyEngagements,
    exposureCountByBucket: new Map([
      ['severity:critical', 10],
      ['severity:nit', 10],
      ['scope:operator', 20],
    ]),
    totalExposures: 20,
  });

  it('promotes items in buckets the owner engages above base rate, with reasons', () => {
    const out = computeOwnerPreference([item('EI-A', { severity: 'critical' })], liftSignal);
    const v = out.get('EI-A')!;
    // rate (6+1)/(10+2) vs base (6+1)/(20+2) → lift 22/12, log2/2 ≈ 0.437.
    expect(v.value).toBeCloseTo(0.437, 3);
    expect(v.reasons?.some((r) => r.includes('severity critical'))).toBe(true);
  });

  it('demotes items in buckets the owner is shown but never engages', () => {
    const out = computeOwnerPreference([item('EI-B', { severity: 'nit' })], liftSignal);
    expect(out.get('EI-B')!.value).toBeLessThan(0);
  });

  it('a bucket at the overall base rate contributes nothing (scope:operator here)', () => {
    // severity:major has no exposures → floored; scope:operator lift is
    // exactly 1 → 0 contribution; so the item nets to no entry at all.
    const out = computeOwnerPreference([item('EI-C', { severity: 'major' })], liftSignal);
    expect(out.has('EI-C')).toBe(false);
  });

  it('ignores buckets below the exposure floor', () => {
    const out = computeOwnerPreference(
      [item('EI-D', { severity: 'major' })],
      signal({
        engagements: criticalHeavyEngagements,
        exposureCountByBucket: new Map([['severity:major', 2]]), // < floor of 3
        totalExposures: 2,
      }),
    );
    expect(out.has('EI-D')).toBe(false);
  });

  it('values are bounded to [-1, 1] and rounded to 3 decimals', () => {
    const extreme = signal({
      engagements: Array.from({ length: 50 }, () => ({
        kind: 'grade' as const,
        severity: 'critical',
        scope: 'operator',
      })),
      exposureCountByBucket: new Map([
        ['severity:critical', 50],
        ['severity:nit', 200],
      ]),
      totalExposures: 250,
    });
    const out = computeOwnerPreference(
      [item('EI-HOT', { severity: 'critical' }), item('EI-COLD', { severity: 'nit', ageDays: 30 })],
      extreme,
    );
    for (const v of out.values()) {
      expect(v.value).toBeGreaterThanOrEqual(-1);
      expect(v.value).toBeLessThanOrEqual(1);
      expect(v.value).toBe(Math.round(v.value * 1000) / 1000);
    }
  });
});

describe('computeOwnerPreference — ignored despite exposure', () => {
  /** 5 engagements with itemId only (gym-rail style: no joined attrs). */
  const attrFree = (engagedId?: string): OwnerSignal =>
    signal({
      engagements: Array.from({ length: 5 }, (_, i) => ({
        kind: 'grade' as const,
        ...(engagedId && i === 0 ? { itemId: engagedId } : {}),
      })),
    });

  it('penalises an old, repeatedly-shown, never-touched item (with the reason)', () => {
    const out = computeOwnerPreference(
      [item('EI-B', { ageDays: 10 })],
      { ...attrFree(), exposureCountById: new Map([['EI-B', 8]]) },
    );
    const v = out.get('EI-B')!;
    expect(v.value).toBeCloseTo(-0.3, 3); // 0.1 × log2(8)
    expect(v.reasons?.[0]).toContain('no owner interaction');
  });

  it('an item the owner actually engaged is exempt from the penalty', () => {
    const out = computeOwnerPreference(
      [item('EI-C', { ageDays: 10 })],
      { ...attrFree('EI-C'), exposureCountById: new Map([['EI-C', 8]]) },
    );
    expect(out.has('EI-C')).toBe(false);
  });

  it('arms only past the exposure AND age floors', () => {
    const fewExposures = computeOwnerPreference(
      [item('EI-E', { ageDays: 10 })],
      { ...attrFree(), exposureCountById: new Map([['EI-E', 4]]) },
    );
    expect(fewExposures.has('EI-E')).toBe(false);

    const tooYoung = computeOwnerPreference(
      [item('EI-F', { ageDays: 1 })],
      { ...attrFree(), exposureCountById: new Map([['EI-F', 8]]) },
    );
    expect(tooYoung.has('EI-F')).toBe(false);
  });

  it('the penalty caps at 0.5 and the total clamps at -1', () => {
    const out = computeOwnerPreference(
      [item('EI-G', { ageDays: 30 })],
      { ...attrFree(), exposureCountById: new Map([['EI-G', 1024]]) },
    );
    expect(out.get('EI-G')!.value).toBeCloseTo(-0.5, 3); // capped, no bucket part
  });
});
