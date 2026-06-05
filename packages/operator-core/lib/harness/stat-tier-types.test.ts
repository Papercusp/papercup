import { describe, expect, it } from 'vitest';
import {
  STAT_SURFACES,
  STAT_TIERS,
  STAT_TIER_BADGE,
  SURFACE_ALLOWED_TIERS,
  filterStatsForSurface,
  groupStatsByTier,
  isTierAllowedOnSurface,
  isVerifiedByEvidenceTier,
  renderTierBadge,
  shouldRenderStatOnSurface,
  sumWithinTier,
  zeroIfUnverified,
  type TieredStat,
} from './stat-tier-types';

describe('constants', () => {
  it('STAT_TIERS has A/B/C/D in order', () => {
    expect([...STAT_TIERS]).toEqual(['A', 'B', 'C', 'D']);
  });

  it('STAT_SURFACES has 6 surfaces', () => {
    expect(STAT_SURFACES.length).toBe(6);
    for (const s of [
      'cupboard',
      'insights',
      'contributors',
      'user_profile_public',
      'user_profile_member',
      'card_avatar',
    ]) {
      expect([...STAT_SURFACES]).toContain(s);
    }
  });

  it('STAT_TIER_BADGE matches v5 §17 table', () => {
    expect(STAT_TIER_BADGE.A).toBe('✓');
    expect(STAT_TIER_BADGE.B).toBe('✓');
    expect(STAT_TIER_BADGE.C).toBe('');
    expect(STAT_TIER_BADGE.D).toBe('⏱');
  });

  it('Cupboard surface allows tier-A only per §17', () => {
    expect(SURFACE_ALLOWED_TIERS.cupboard.has('A')).toBe(true);
    expect(SURFACE_ALLOWED_TIERS.cupboard.has('B')).toBe(false);
    expect(SURFACE_ALLOWED_TIERS.cupboard.has('C')).toBe(false);
    expect(SURFACE_ALLOWED_TIERS.cupboard.has('D')).toBe(false);
    expect(SURFACE_ALLOWED_TIERS.cupboard.size).toBe(1);
  });

  it('Insights surface allows all 4 tiers per §17', () => {
    expect(SURFACE_ALLOWED_TIERS.insights.size).toBe(4);
  });

  it('Card-avatar surface allows A + B only', () => {
    expect(SURFACE_ALLOWED_TIERS.card_avatar.has('A')).toBe(true);
    expect(SURFACE_ALLOWED_TIERS.card_avatar.has('B')).toBe(true);
    expect(SURFACE_ALLOWED_TIERS.card_avatar.has('C')).toBe(false);
    expect(SURFACE_ALLOWED_TIERS.card_avatar.has('D')).toBe(false);
  });

  it('User_profile_public allows A + B only (no harness-member context)', () => {
    expect(SURFACE_ALLOWED_TIERS.user_profile_public.has('A')).toBe(true);
    expect(SURFACE_ALLOWED_TIERS.user_profile_public.has('B')).toBe(true);
    expect(SURFACE_ALLOWED_TIERS.user_profile_public.has('C')).toBe(false);
    expect(SURFACE_ALLOWED_TIERS.user_profile_public.has('D')).toBe(false);
  });
});

describe('isTierAllowedOnSurface', () => {
  it('matches SURFACE_ALLOWED_TIERS', () => {
    expect(isTierAllowedOnSurface('A', 'cupboard')).toBe(true);
    expect(isTierAllowedOnSurface('C', 'cupboard')).toBe(false);
    expect(isTierAllowedOnSurface('D', 'insights')).toBe(true);
    expect(isTierAllowedOnSurface('D', 'card_avatar')).toBe(false);
  });
});

describe('filterStatsForSurface', () => {
  it('keeps only allowed tiers', () => {
    const stats: TieredStat[] = [
      { value: 1, tier: 'A' },
      { value: 2, tier: 'B' },
      { value: 3, tier: 'C' },
      { value: 4, tier: 'D' },
    ];
    expect(filterStatsForSurface(stats, 'cupboard').map((s) => s.tier)).toEqual(['A']);
    expect(filterStatsForSurface(stats, 'card_avatar').map((s) => s.tier)).toEqual(['A', 'B']);
    expect(filterStatsForSurface(stats, 'insights').length).toBe(4);
  });

  it('returns empty for empty input', () => {
    expect(filterStatsForSurface([], 'insights')).toEqual([]);
  });
});

describe('groupStatsByTier', () => {
  it('groups + always populates every tier (zero-len arrays)', () => {
    const stats: TieredStat[] = [
      { value: 1, tier: 'A' },
      { value: 2, tier: 'A' },
      { value: 3, tier: 'C' },
    ];
    const out = groupStatsByTier(stats);
    expect(out.A).toHaveLength(2);
    expect(out.B).toHaveLength(0);
    expect(out.C).toHaveLength(1);
    expect(out.D).toHaveLength(0);
  });
});

describe('sumWithinTier', () => {
  it('sums when all same tier', () => {
    expect(
      sumWithinTier([
        { value: 1, tier: 'B' },
        { value: 2, tier: 'B' },
        { value: 3, tier: 'B' },
      ]),
    ).toEqual({ value: 6, tier: 'B' });
  });

  it('returns null when heterogeneous (§17 cross-tier-aggregate guard)', () => {
    expect(
      sumWithinTier([
        { value: 1, tier: 'B' },
        { value: 2, tier: 'C' },
      ]),
    ).toBeNull();
  });

  it('returns null on empty', () => {
    expect(sumWithinTier([])).toBeNull();
  });

  it('single element sums to itself', () => {
    expect(sumWithinTier([{ value: 42, tier: 'A' }])).toEqual({ value: 42, tier: 'A' });
  });
});

describe('zeroIfUnverified', () => {
  it('returns stat unchanged when binding_status=verified', () => {
    const s: TieredStat = { value: 5, tier: 'C' };
    expect(zeroIfUnverified(s, 'verified')).toEqual({ value: 5, tier: 'C' });
  });

  it('zeroes value when binding_status=pending', () => {
    const s: TieredStat = { value: 5, tier: 'C' };
    expect(zeroIfUnverified(s, 'pending').value).toBe(0);
  });

  it('zeroes value when binding_status=unverified', () => {
    const s: TieredStat = { value: 5, tier: 'C' };
    expect(zeroIfUnverified(s, 'unverified').value).toBe(0);
  });

  it('preserves tier + label even when zeroing', () => {
    const s: TieredStat = { value: 5, tier: 'B', label: 'PRs merged' };
    const out = zeroIfUnverified(s, 'unverified');
    expect(out.tier).toBe('B');
    expect(out.label).toBe('PRs merged');
  });
});

describe('renderTierBadge', () => {
  it('returns the table glyphs', () => {
    expect(renderTierBadge('A')).toBe('✓');
    expect(renderTierBadge('B')).toBe('✓');
    expect(renderTierBadge('C')).toBe('');
    expect(renderTierBadge('D')).toBe('⏱');
  });
});

describe('isVerifiedByEvidenceTier', () => {
  it('true for A + B', () => {
    expect(isVerifiedByEvidenceTier('A')).toBe(true);
    expect(isVerifiedByEvidenceTier('B')).toBe(true);
  });

  it('false for C + D', () => {
    expect(isVerifiedByEvidenceTier('C')).toBe(false);
    expect(isVerifiedByEvidenceTier('D')).toBe(false);
  });
});

describe('shouldRenderStatOnSurface', () => {
  it('false when tier not in surface allow-set', () => {
    expect(
      shouldRenderStatOnSurface({ value: 1, tier: 'C' }, 'cupboard'),
    ).toBe(false);
  });

  it('false for tier-D when viewer is not self', () => {
    expect(
      shouldRenderStatOnSurface({ value: 1, tier: 'D' }, 'contributors'),
    ).toBe(false);
    expect(
      shouldRenderStatOnSurface({ value: 1, tier: 'D' }, 'contributors', { viewerIsSelf: false }),
    ).toBe(false);
  });

  it('true for tier-D when viewer IS self', () => {
    expect(
      shouldRenderStatOnSurface({ value: 1, tier: 'D' }, 'contributors', { viewerIsSelf: true }),
    ).toBe(true);
  });

  it('true for non-D tiers regardless of viewerIsSelf', () => {
    expect(
      shouldRenderStatOnSurface({ value: 1, tier: 'A' }, 'cupboard'),
    ).toBe(true);
    expect(
      shouldRenderStatOnSurface({ value: 1, tier: 'B' }, 'card_avatar'),
    ).toBe(true);
  });
});
