import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DARK_FLAG_AGE_RESOLUTION_COOLDOWN_MS,
  detectDarkFlagAge,
  type DarkFlagAgeInput,
} from './dark-flag-age-detect';

const DAY = 86_400_000;
// A fixed reference clock so review-by deltas are exact (ISO round-trips ms precisely).
const NOW = Date.parse('2026-06-29T00:00:00.000Z');
const inDays = (n: number): string => new Date(NOW + n * DAY).toISOString();

// A baseline HEALTHY input: review-by far out, count well under the watermark. Each
// test overrides only the field(s) it exercises.
const healthy = (over: Partial<DarkFlagAgeInput> = {}): DarkFlagAgeInput => ({
  darkCount: 9,
  watermark: 22,
  reviewBy: inDays(60),
  now: NOW,
  ...over,
});

describe('dark-flag-age detector (enforce-system-on-generic-work P-013)', () => {
  it('does NOT flag a HEALTHY allowlist (review-by far out, count well under the watermark)', () => {
    expect(detectDarkFlagAge(healthy())).toEqual([]);
  });

  it('flags MINOR when review-by is within N days (APPROACHING, not yet past)', () => {
    const findings = detectDarkFlagAge(healthy({ reviewBy: inDays(10) })); // default window 14
    expect(findings).toHaveLength(1);
    expect(findings[0].source).toBe('dark-flag-age');
    expect(findings[0].key).toBe('dark-flags');
    expect(findings[0].scope).toBe('operator');
    expect(findings[0].findingClass).toBe('flags:dark-flag-age');
    expect(findings[0].severity).toBe('minor');
    expect(findings[0].metric.daysToReview).toBe(10);
  });

  it('flags MAJOR when review-by is already PAST', () => {
    const findings = detectDarkFlagAge(healthy({ reviewBy: inDays(-3) }));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('major');
    expect(findings[0].metric.daysToReview).toBe(-3);
    expect(findings[0].body).toContain('PAST');
  });

  it('flags MAJOR when the dark count is AT/over the watermark', () => {
    const findings = detectDarkFlagAge(healthy({ darkCount: 22, reviewBy: inDays(60) }));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('major');
    expect(findings[0].metric.darkCount).toBe(22);
    expect(findings[0].body).toContain('22/22');
  });

  it('flags MINOR when the count is NEAR the watermark (>= watermark-2, still below it)', () => {
    const findings = detectDarkFlagAge(healthy({ darkCount: 20, reviewBy: inDays(60) })); // 20 == 22-2
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('minor');
    expect(findings[0].metric.darkCount).toBe(20);
  });

  it('does NOT flag at watermark-3 with review-by far out (just below the near-watermark band)', () => {
    expect(detectDarkFlagAge(healthy({ darkCount: 19, reviewBy: inDays(60) }))).toEqual([]);
  });

  it('emits ONE finding (major) when BOTH the review-by is past AND the count is at the watermark', () => {
    const findings = detectDarkFlagAge(healthy({ darkCount: 22, reviewBy: inDays(-1) }));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('major');
  });

  it('treats an UNPARSEABLE review-by as due now (emits rather than going silent)', () => {
    const findings = detectDarkFlagAge(healthy({ reviewBy: 'not-a-date' }));
    expect(findings).toHaveLength(1);
    expect(findings[0].metric.daysToReview).toBe(0);
  });

  it('honors a custom reviewWithinDays window', () => {
    // 20 days out: healthy at the default 14-day window …
    expect(detectDarkFlagAge(healthy({ reviewBy: inDays(20) }))).toEqual([]);
    // … but flagged once the window widens to 30.
    const findings = detectDarkFlagAge(healthy({ reviewBy: inDays(20), reviewWithinDays: 30 }));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('minor');
  });

  it('carries the { darkCount, watermark, reviewBy, daysToReview } metric', () => {
    const reviewBy = inDays(5);
    const findings = detectDarkFlagAge(healthy({ darkCount: 21, reviewBy }));
    expect(findings[0].metric).toEqual({ darkCount: 21, watermark: 22, reviewBy, daysToReview: 5 });
  });

  // EI-9190: the watchdog re-fired a near-duplicate ~85min after the prior instance
  // was resolved, reporting the identical review-by + count. A resolutionCooldownMs
  // stamped on the finding is what lets watchdog.ts's partitionSignalsByKnownKeys
  // suppress that same-state re-file (see watchdog.ts partitionSignalsByKnownKeys).
  it('stamps latestAt as `now` and a default resolutionCooldownMs (EI-9190)', () => {
    const findings = detectDarkFlagAge(healthy({ reviewBy: inDays(5) }));
    expect(findings).toHaveLength(1);
    expect(findings[0].latestAt).toBe(new Date(NOW).toISOString());
    expect(findings[0].resolutionCooldownMs).toBe(DEFAULT_DARK_FLAG_AGE_RESOLUTION_COOLDOWN_MS);
  });

  it('honors a custom resolutionCooldownMs override', () => {
    const findings = detectDarkFlagAge(healthy({ reviewBy: inDays(5), resolutionCooldownMs: 60_000 }));
    expect(findings[0].resolutionCooldownMs).toBe(60_000);
  });
});
