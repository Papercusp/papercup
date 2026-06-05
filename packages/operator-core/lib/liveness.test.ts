import { describe, it, expect } from 'vitest';
import { deriveLiveness, LIVE_MS, STALE_MS, type Liveness } from './liveness';

const NOW = Date.UTC(2026, 5, 4, 12, 0, 0); // fixed clock; epoch ms
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Focused branch coverage for the 3-state threshold leaf. The adv-roster test
 * asserts the STALE_MS↔PRESENCE_STALE_MS constant equality; this file pins the
 * derivation's exact `<` boundaries and the unparseable/missing → stale path.
 */
describe('deriveLiveness — LIVE_MS boundary', () => {
  it('just INSIDE LIVE_MS (age = LIVE_MS - 1) is live', () => {
    expect(deriveLiveness(iso(NOW - (LIVE_MS - 1)), NOW)).toBe<Liveness>('live');
  });

  it('a zero-age (this instant) heartbeat is live', () => {
    expect(deriveLiveness(iso(NOW), NOW)).toBe('live');
  });

  it('a future heartbeat (negative age) is live (age < LIVE_MS holds)', () => {
    expect(deriveLiveness(iso(NOW + 5_000), NOW)).toBe('live');
  });

  it('EXACTLY at LIVE_MS (age = LIVE_MS) flips to idle — the cutoff is strict <', () => {
    expect(deriveLiveness(iso(NOW - LIVE_MS), NOW)).toBe('idle');
  });
});

describe('deriveLiveness — idle vs stale distinction', () => {
  it('mid-window (between LIVE_MS and STALE_MS) is idle, not stale', () => {
    const mid = (LIVE_MS + STALE_MS) / 2;
    expect(deriveLiveness(iso(NOW - mid), NOW)).toBe('idle');
  });

  it('just INSIDE STALE_MS (age = STALE_MS - 1) is still idle', () => {
    expect(deriveLiveness(iso(NOW - (STALE_MS - 1)), NOW)).toBe('idle');
  });

  it('EXACTLY at STALE_MS (age = STALE_MS) flips to stale', () => {
    expect(deriveLiveness(iso(NOW - STALE_MS), NOW)).toBe('stale');
  });

  it('well past STALE_MS is stale', () => {
    expect(deriveLiveness(iso(NOW - STALE_MS * 10), NOW)).toBe('stale');
  });
});

describe('deriveLiveness — unparseable / missing timestamp → stale', () => {
  it('an empty string is stale', () => {
    expect(deriveLiveness('', NOW)).toBe('stale');
  });

  it('a non-date garbage string is stale', () => {
    expect(deriveLiveness('not-a-date', NOW)).toBe('stale');
  });

  it('a partially-valid-looking but unparseable string is stale', () => {
    expect(deriveLiveness('2026-13-99T99:99:99Z', NOW)).toBe('stale');
  });

  it('treats a non-finite parse (NaN time) as stale rather than throwing', () => {
    // new Date('').getTime() === NaN → !Number.isFinite → stale, no exception.
    expect(() => deriveLiveness('', NOW)).not.toThrow();
  });
});

describe('threshold constants', () => {
  it('LIVE_MS < STALE_MS so the idle window is non-empty', () => {
    expect(LIVE_MS).toBeLessThan(STALE_MS);
  });
});
