/**
 * Unit tests for plans:items payload-tier shaping (context-trimming-tiers-2026-07-01
 * P-021) — pure, no I/O.
 *
 * EI-18679411140143743: `coverageDivergence` (a plan item whose linked work is
 * fully done but whose own status is still non-terminal) must survive both the
 * trimmed and standard projections as `diverged` — a trimmed/standard session
 * (the common case) must not lose the one signal that flags a stale burn-down.
 */
import { describe, it, expect } from 'vitest';
import { shapePlansItems, PLANS_ITEMS_TIER_CAPS } from './items-shape';

function row(over: Record<string, unknown> = {}) {
  return {
    plan: 'my-plan',
    archived: false,
    item: { id: 'P-009', effectiveStatus: 'todo', importance: 'normal', text: 'do the thing' },
    coverage: { level: 'complete', workers: [] },
    coverageDivergence: true,
    ...over,
  };
}

describe('shapePlansItems — coverageDivergence -> diverged', () => {
  it('trimmed tier surfaces diverged:true for a divergent row', () => {
    const out = shapePlansItems({ items: [row()] }, 'trimmed') as { items: Record<string, unknown>[] };
    expect(out.items[0].diverged).toBe(true);
  });

  it('standard tier surfaces diverged:true for a divergent row', () => {
    const out = shapePlansItems({ items: [row()] }, 'standard') as { items: Record<string, unknown>[] };
    expect(out.items[0].diverged).toBe(true);
  });

  it('a non-divergent row (no coverageDivergence key) shapes to diverged:false in both tiers', () => {
    const clean = row({ coverageDivergence: undefined });
    delete (clean as Record<string, unknown>).coverageDivergence;
    for (const tier of ['trimmed', 'standard'] as const) {
      const out = shapePlansItems({ items: [clean] }, tier) as { items: Record<string, unknown>[] };
      expect(out.items[0].diverged).toBe(false);
    }
  });

  it('the truncation placeholder row never claims diverged:true', () => {
    const rows = Array.from({ length: PLANS_ITEMS_TIER_CAPS.trimmed.rows + 5 }, (_, i) =>
      row({ item: { id: `P-${i}`, effectiveStatus: 'todo', importance: 'normal', text: 'x' } }),
    );
    const out = shapePlansItems({ items: rows }, 'trimmed') as { items: Record<string, unknown>[] };
    const placeholder = out.items[out.items.length - 1];
    expect(placeholder.plan).toBe('(truncated)');
    expect(String(placeholder.text)).toContain("tools:invoke { name:'plans:items'");
    expect(placeholder.diverged).toBe(false);
  });

  it('passes through non-array/absent items unchanged (defensive no-op)', () => {
    expect(shapePlansItems({ notItems: [] }, 'trimmed')).toEqual({ notItems: [] });
    expect(shapePlansItems(null, 'standard')).toBeNull();
  });
});

describe('shapePlansItems — text_truncated marker (EI-18762253154342502)', () => {
  it('stamps text_truncated:true when the trimmed-tier cap actually clips item.text', () => {
    const longText = 'x'.repeat(PLANS_ITEMS_TIER_CAPS.trimmed.text + 50);
    const out = shapePlansItems(
      { items: [row({ item: { id: 'P-009', text: longText } })] },
      'trimmed',
    ) as { items: Record<string, unknown>[] };
    expect(out.items[0].text_truncated).toBe(true);
    // EI-20038981829684213: the clip announces itself IN BAND, not only via the
    // sibling flag above — a `projection.pick` of the value alone strips the
    // sibling, and the marker has to survive that. The marker is variable-length
    // (it carries the omitted count), so the result is bounded BY the cap rather
    // than exactly equal to it.
    expect((out.items[0].text as string)).toContain('TRUNCATED');
    expect((out.items[0].text as string).length).toBeLessThanOrEqual(
      PLANS_ITEMS_TIER_CAPS.trimmed.text,
    );
  });

  it('stamps text_truncated:false when item.text fits under the cap untouched', () => {
    const out = shapePlansItems(
      { items: [row({ item: { id: 'P-009', text: 'short' } })] },
      'trimmed',
    ) as { items: Record<string, unknown>[] };
    expect(out.items[0].text_truncated).toBe(false);
    expect(out.items[0].text).toBe('short');
  });

  it('the standard tier also stamps the marker (higher cap, same contract)', () => {
    const longText = 'y'.repeat(PLANS_ITEMS_TIER_CAPS.standard.text + 1);
    const out = shapePlansItems(
      { items: [row({ item: { id: 'P-009', text: longText } })] },
      'standard',
    ) as { items: Record<string, unknown>[] };
    expect(out.items[0].text_truncated).toBe(true);
  });
});
