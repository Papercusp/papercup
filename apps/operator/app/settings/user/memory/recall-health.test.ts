/**
 * recall-health.test.ts — EI-10368: the status → copy mapping for the
 * Settings → Memory recall-health line. The load-bearing cases: absence is
 * muted (not an error), `degraded` warns in plain language, and null metrics
 * render as n/a instead of NaN.
 *
 * Run: cd apps/operator && npx vitest run app/settings/user/memory/recall-health.test.ts
 */
import { describe, it, expect } from 'vitest';
import { recallHealthLine, checkedAgo, type RecallCanaryLatest } from './recall-health';

const NOW = Date.parse('2026-07-12T12:00:00.000Z');

const run = (over: Partial<RecallCanaryLatest> = {}): RecallCanaryLatest => ({
  ranAt: '2026-07-12T05:45:00.000Z', // 6h15m before NOW
  status: 'ok',
  rAt10: 0.89,
  baselineRAt10: 0.9,
  ...over,
});

describe('recallHealthLine (EI-10368)', () => {
  it('renders ok in good tone with r@10, baseline and recency', () => {
    const line = recallHealthLine(run(), NOW);
    expect(line.tone).toBe('good');
    expect(line.text).toBe('✓ Recall health: ok — r@10 0.89 (baseline 0.90), checked 6h ago');
  });

  it('renders degraded as a warning that says what it means', () => {
    const line = recallHealthLine(run({ status: 'degraded', rAt10: 0.6 }), NOW);
    expect(line.tone).toBe('warn');
    expect(line.text).toContain('degraded — r@10 0.60 vs baseline 0.90');
    expect(line.text).toContain('under-recalling');
  });

  it('renders decayed and seeded muted (informational, not alarming)', () => {
    expect(recallHealthLine(run({ status: 'decayed' }), NOW).tone).toBe('mute');
    expect(recallHealthLine(run({ status: 'decayed' }), NOW).text).toContain('re-seed');
    expect(recallHealthLine(run({ status: 'seeded' }), NOW).tone).toBe('mute');
    expect(recallHealthLine(run({ status: 'seeded' }), NOW).text).toContain('first live comparison');
  });

  it('treats a missing run as muted absence, never an error', () => {
    const line = recallHealthLine(null, NOW);
    expect(line.tone).toBe('mute');
    expect(line.text).toContain("hasn't run yet");
  });

  it('renders null metrics as n/a instead of NaN', () => {
    const line = recallHealthLine(run({ rAt10: null, baselineRAt10: null }), NOW);
    expect(line.text).toContain('r@10 n/a (baseline n/a)');
  });
});

describe('checkedAgo', () => {
  it('uses hour granularity under 48h and days after', () => {
    expect(checkedAgo('2026-07-12T11:30:00.000Z', NOW)).toBe('checked <1h ago');
    expect(checkedAgo('2026-07-12T05:45:00.000Z', NOW)).toBe('checked 6h ago');
    expect(checkedAgo('2026-07-09T12:00:00.000Z', NOW)).toBe('checked 3d ago');
  });

  it('never renders a negative age (clock skew) or NaN (bad timestamp)', () => {
    expect(checkedAgo('2026-07-13T00:00:00.000Z', NOW)).toBe('just checked');
    expect(checkedAgo('not-a-date', NOW)).toBe('just checked');
  });
});
