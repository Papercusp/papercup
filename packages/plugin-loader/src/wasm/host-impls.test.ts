/**
 * Tests for TokenBucket — the fractional-token rate limiter behind events.emit.
 * Run with: npx vitest run packages/plugin-loader/src/wasm/host-impls.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenBucket } from './host-impls';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('TokenBucket', () => {
  it('exposes its capacity and refill rate', () => {
    const tb = new TokenBucket(100, 50);
    expect(tb.capacity).toBe(100);
    expect(tb.refillPerSec).toBe(50);
  });

  it('starts full and drains to empty', () => {
    const tb = new TokenBucket(2, 100);
    expect(tb.tryConsume()).toBe(true);
    expect(tb.tryConsume()).toBe(true);
    expect(tb.tryConsume()).toBe(false);
  });

  it('refills proportionally to elapsed time', () => {
    const tb = new TokenBucket(1, 10); // 10 tokens/sec
    expect(tb.tryConsume()).toBe(true); // -> 0
    expect(tb.tryConsume()).toBe(false);
    vi.advanceTimersByTime(100); // 0.1s × 10 = 1 token
    expect(tb.tryConsume()).toBe(true);
  });

  it('caps the refill at capacity (no unbounded accrual)', () => {
    const tb = new TokenBucket(2, 100);
    tb.tryConsume();
    tb.tryConsume(); // empty
    vi.advanceTimersByTime(10_000); // would add 1000 tokens; capped at 2
    expect(tb.tryConsume()).toBe(true);
    expect(tb.tryConsume()).toBe(true);
    expect(tb.tryConsume()).toBe(false);
  });
});
