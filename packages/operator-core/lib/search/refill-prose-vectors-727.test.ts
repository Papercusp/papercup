import { describe, expect, it } from 'vitest';

import { classifyPass } from '../../../../scripts/refill-prose-vectors-727.mjs';

describe('refill-727 pass freshness', () => {
  const bootMs = 1_000;

  it('refuses to report DONE when the predicate changed after boot', () => {
    expect(
      classifyPass({
        embedded: 0,
        changedAt: 2_000,
        nowMs: 3_000,
        bootMs,
        maxRuntimeMs: 100,
      }),
    ).toBe('stale');
  });

  it('reports DONE only for an empty pass with unchanged code', () => {
    expect(
      classifyPass({
        embedded: 0,
        changedAt: null,
        nowMs: 3_000,
        bootMs,
        maxRuntimeMs: 100,
      }),
    ).toBe('done');
  });

  it('stops a productive driver at its code-freshness runtime budget', () => {
    expect(
      classifyPass({
        embedded: 1,
        changedAt: null,
        nowMs: 2_001,
        bootMs,
        maxRuntimeMs: 1_000,
      }),
    ).toBe('budget');
  });

  it('continues while work remains within the freshness budget', () => {
    expect(
      classifyPass({
        embedded: 1,
        changedAt: null,
        nowMs: 1_999,
        bootMs,
        maxRuntimeMs: 1_000,
      }),
    ).toBe('continue');
  });
});
