import { describe, it, expect } from 'vitest';
import { costPer1kRemembers, costPer1kSearches } from './cost-model';

describe('cost-model — extraction is subscription-borne by default (D-005)', () => {
  const base = { avgRememberChars: 400, avgSearchChars: 40, extractionOnRemember: true, embeds: true };

  it('a live remember is embedding-only (~$0.002/1k) — extraction rides the subscription session', () => {
    // 400 chars → 100 tok × $0.02/MTok = $0.002/1k; extraction adds nothing by default
    expect(costPer1kRemembers(base)).toBeCloseTo(0.002, 3);
  });

  it('the metered fallback adds the gpt-4o-mini extraction cost (the upper bound)', () => {
    const metered = costPer1kRemembers({ ...base, extractionMetered: true });
    expect(metered).toBeGreaterThan(0.3);
    expect(metered).toBeGreaterThan(costPer1kRemembers(base));
  });

  it('a non-embedding backend (claude-file / noop) is free', () => {
    expect(costPer1kRemembers({ ...base, embeds: false })).toBe(0);
    expect(costPer1kSearches({ ...base, embeds: false })).toBe(0);
  });

  it('searches are embedding-only', () => {
    expect(costPer1kSearches(base)).toBeCloseTo(0.0002, 4);
  });
});
