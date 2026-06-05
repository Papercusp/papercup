import { describe, expect, it } from 'vitest';
import { shouldFireNudge, NUDGE_DEDUP_MS } from './voice-nudges';

const now = Date.parse('2026-05-02T12:00:00.000Z');

describe('shouldFireNudge', () => {
  it('fires on first call (no prior timestamp)', () => {
    const r = shouldFireNudge('budget', null, now);
    expect(r.fire).toBe(true);
    if (r.fire) expect(r.nextLastSpokenAtIso).toBe('2026-05-02T12:00:00.000Z');
  });

  it('budget dedup is 30 min', () => {
    const last = new Date(now - 29 * 60_000).toISOString();
    expect(shouldFireNudge('budget', last, now).fire).toBe(false);
    const older = new Date(now - 31 * 60_000).toISOString();
    expect(shouldFireNudge('budget', older, now).fire).toBe(true);
  });

  it('breaker dedup is 10 min', () => {
    const last = new Date(now - 9 * 60_000).toISOString();
    expect(shouldFireNudge('breaker', last, now).fire).toBe(false);
    const older = new Date(now - 11 * 60_000).toISOString();
    expect(shouldFireNudge('breaker', older, now).fire).toBe(true);
  });

  it('pause dedup is 5 min', () => {
    const last = new Date(now - 4 * 60_000).toISOString();
    expect(shouldFireNudge('pause', last, now).fire).toBe(false);
    const older = new Date(now - 6 * 60_000).toISOString();
    expect(shouldFireNudge('pause', older, now).fire).toBe(true);
  });

  it('window constants match v4 spec', () => {
    expect(NUDGE_DEDUP_MS.budget).toBe(30 * 60_000);
    expect(NUDGE_DEDUP_MS.breaker).toBe(10 * 60_000);
    expect(NUDGE_DEDUP_MS.pause).toBe(5 * 60_000);
  });

  it('handles invalid lastSpokenAt by firing', () => {
    expect(shouldFireNudge('budget', 'not a date', now).fire).toBe(true);
  });
});
