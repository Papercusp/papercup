import { describe, expect, it } from 'vitest';
import { reduceLatency } from './operator-ack-latency';

const MIN = 60_000;
const MAX = 30 * 60_000;
const FALLBACK = 4 * 60_000;

function dispatch(id: string, target: string, ts: number) {
  return { ts, subject: id, details: { target } };
}
function ack(id: string, ts: number) {
  return { ts, subject: id };
}

describe('reduceLatency', () => {
  it('returns empty perHarness + fallback when no rows', () => {
    const r = reduceLatency([], [], FALLBACK);
    expect(r.perHarness).toEqual({});
    expect(r.fallbackMs).toBe(FALLBACK);
  });

  it('skips harnesses with fewer than 3 samples', () => {
    const r = reduceLatency(
      [dispatch('a', 'foo', 0), dispatch('b', 'foo', 0)],
      [ack('a', 60_000), ack('b', 90_000)],
    );
    expect(r.perHarness).toEqual({});
  });

  it('computes 1.5× median per harness when ≥3 samples', () => {
    // 3 samples, latencies 100k, 200k, 300k → median 200k → threshold 300k
    const r = reduceLatency(
      [dispatch('a', 'foo', 0), dispatch('b', 'foo', 0), dispatch('c', 'foo', 0)],
      [ack('a', 100_000), ack('b', 200_000), ack('c', 300_000)],
    );
    expect(r.perHarness.foo).toBe(300_000);
  });

  it('clamps below the MIN threshold (60s)', () => {
    // 3 samples, latencies 1k, 2k, 3k → median 2k × 1.5 = 3k → clamp to 60k
    const r = reduceLatency(
      [dispatch('a', 'foo', 0), dispatch('b', 'foo', 0), dispatch('c', 'foo', 0)],
      [ack('a', 1_000), ack('b', 2_000), ack('c', 3_000)],
    );
    expect(r.perHarness.foo).toBe(MIN);
  });

  it('clamps above the MAX threshold (30min)', () => {
    // 3 samples 25min/30min/35min → median 30min × 1.5 = 45min → clamp to 30min
    const r = reduceLatency(
      [dispatch('a', 'foo', 0), dispatch('b', 'foo', 0), dispatch('c', 'foo', 0)],
      [ack('a', 25 * 60_000), ack('b', 30 * 60_000), ack('c', 35 * 60_000)],
    );
    expect(r.perHarness.foo).toBe(MAX);
  });

  it('drops latencies > 24h (likely audit-log noise)', () => {
    const r = reduceLatency(
      [
        dispatch('a', 'foo', 0),
        dispatch('b', 'foo', 0),
        dispatch('c', 'foo', 0),
        dispatch('d', 'foo', 0),
      ],
      [
        ack('a', 100_000),
        ack('b', 200_000),
        ack('c', 300_000),
        ack('d', 25 * 60 * 60 * 1000), // 25h, dropped
      ],
    );
    expect(r.perHarness.foo).toBe(300_000);
  });

  it('drops non-positive latencies (clock skew)', () => {
    const r = reduceLatency(
      [dispatch('a', 'foo', 100_000), dispatch('b', 'foo', 0), dispatch('c', 'foo', 0), dispatch('d', 'foo', 0)],
      [
        ack('a', 50_000), // negative latency, dropped
        ack('b', 100_000),
        ack('c', 200_000),
        ack('d', 300_000),
      ],
    );
    expect(r.perHarness.foo).toBe(300_000);
  });

  it('buckets by target harness independently', () => {
    const r = reduceLatency(
      [
        dispatch('a', 'foo', 0), dispatch('b', 'foo', 0), dispatch('c', 'foo', 0),
        dispatch('x', 'bar', 0), dispatch('y', 'bar', 0), dispatch('z', 'bar', 0),
      ],
      [
        ack('a', 100_000), ack('b', 200_000), ack('c', 300_000),  // median 200k → 300k
        ack('x', 600_000), ack('y', 800_000), ack('z', 1_000_000), // median 800k → 1.2M
      ],
    );
    expect(r.perHarness.foo).toBe(300_000);
    expect(r.perHarness.bar).toBe(1_200_000);
  });

  it('skips dispatched rows missing details.target', () => {
    const r = reduceLatency(
      [
        { ts: 0, subject: 'a', details: {} },
        { ts: 0, subject: 'b', details: {} },
      ],
      [ack('a', 100_000), ack('b', 200_000)],
    );
    expect(r.perHarness).toEqual({});
  });

  it('skips acked rows with no matching dispatch', () => {
    const r = reduceLatency(
      [],
      [ack('a', 100_000), ack('b', 200_000), ack('c', 300_000)],
    );
    expect(r.perHarness).toEqual({});
  });
});
