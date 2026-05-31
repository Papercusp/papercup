/**
 * Coverage for the card-response sliding-window rate limiter (per-identity,
 * 30 req / 1s). Pure logic over a global Map + Date.now — driven with fake
 * timers to exercise the window slide.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cardResponseRateAllow,
  _resetCardResponseRateLimitForTests,
  CARD_RESPONSE_RATE_LIMIT,
  CARD_RESPONSE_RATE_WINDOW_MS,
} from './card-response-rate-limit';

beforeEach(() => {
  _resetCardResponseRateLimitForTests();
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe('cardResponseRateAllow', () => {
  it('allows exactly RATE_LIMIT requests then 429s within the window', () => {
    for (let i = 0; i < CARD_RESPONSE_RATE_LIMIT; i++) {
      expect(cardResponseRateAllow('user-1')).toBe(true);
    }
    expect(cardResponseRateAllow('user-1')).toBe(false);
  });

  it('tracks identities independently', () => {
    for (let i = 0; i < CARD_RESPONSE_RATE_LIMIT; i++) cardResponseRateAllow('user-1');
    expect(cardResponseRateAllow('user-1')).toBe(false);
    expect(cardResponseRateAllow('user-2')).toBe(true); // separate bucket
  });

  it('lets requests through again once the window slides past', () => {
    for (let i = 0; i < CARD_RESPONSE_RATE_LIMIT; i++) cardResponseRateAllow('user-1');
    expect(cardResponseRateAllow('user-1')).toBe(false);
    vi.setSystemTime(1_000_000 + CARD_RESPONSE_RATE_WINDOW_MS + 1); // older marks expire
    expect(cardResponseRateAllow('user-1')).toBe(true);
  });

  it('exposes the documented limit + window constants', () => {
    expect(CARD_RESPONSE_RATE_LIMIT).toBe(30);
    expect(CARD_RESPONSE_RATE_WINDOW_MS).toBe(1000);
  });
});
