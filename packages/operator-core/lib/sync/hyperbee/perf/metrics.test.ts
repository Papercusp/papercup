/**
 * metrics.test.ts — percentile math + the ScenarioMeter envelope (P-001).
 */

import { describe, expect, it } from 'vitest';
import { ScenarioMeter, Series, startTimer, summarize } from './metrics';

describe('summarize', () => {
  it('computes nearest-rank percentiles on a known series', () => {
    const s = summarize(Array.from({ length: 100 }, (_, i) => i + 1)); // 1..100
    expect(s.count).toBe(100);
    expect(s.p50).toBe(50);
    expect(s.p95).toBe(95);
    expect(s.p99).toBe(99);
    expect(s.max).toBe(100);
    expect(s.mean).toBe(50.5);
  });

  it('handles tiny and empty series', () => {
    expect(summarize([])).toMatchObject({ count: 0, p50: 0, p95: 0, max: 0 });
    const one = summarize([7]);
    expect(one).toMatchObject({ count: 1, p50: 7, p95: 7, p99: 7, max: 7, mean: 7 });
  });

  it('is input-order independent', () => {
    expect(summarize([3, 1, 2])).toEqual(summarize([1, 2, 3]));
  });
});

describe('Series + startTimer', () => {
  it('collects and summarizes', () => {
    const s = new Series('ms');
    s.push(1);
    s.push(2);
    expect(s.count).toBe(2);
    expect(s.summarize().max).toBe(2);
  });

  it('startTimer measures elapsed ms', async () => {
    const done = startTimer();
    await new Promise((r) => setTimeout(r, 20));
    const ms = done();
    expect(ms).toBeGreaterThanOrEqual(15);
    expect(ms).toBeLessThan(2000);
  });
});

describe('ScenarioMeter', () => {
  it('produces a complete artifact with the D-003 SLO verdict', async () => {
    const meter = new ScenarioMeter({
      scenario: 'test.meter',
      tier: 1,
      params: { x: 1 },
    });
    meter.metric('aMs').push(5);
    meter.metric('rate', 'ops/sec').push(100);
    meter.opsDecoded = 42;
    meter.note('hello');
    await new Promise((r) => setTimeout(r, 30));
    const a = meter.finish();
    expect(a.schema).toBe(1);
    expect(a.scenario).toBe('test.meter');
    expect(a.tier).toBe(1);
    expect(a.params).toEqual({ x: 1 });
    expect(a.metrics.aMs.count).toBe(1);
    expect(a.metrics.rate.unit).toBe('ops/sec');
    expect(a.opsDecoded).toBe(42);
    expect(a.notes).toEqual(['hello']);
    expect(a.loopLag).not.toBeNull();
    expect(typeof a.sloPassed).toBe('boolean');
    expect(a.sloLimitMs).toBe(100);
    expect(a.durationMs).toBeGreaterThan(0);
    expect(a.rss.peakBytes).toBeGreaterThan(0);
    expect(a.host.cpus).toBeGreaterThan(0);
  });

  it('an idle loop passes the SLO; the verdict references the gauge', () => {
    const meter = new ScenarioMeter({ scenario: 't', tier: 1, params: {} });
    const a = meter.finish();
    // An idle test process should never show 100ms p95 loop lag.
    expect(a.sloPassed).toBe(true);
  });
});
