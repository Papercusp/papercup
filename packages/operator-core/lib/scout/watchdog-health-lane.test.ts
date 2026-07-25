import { describe, it, expect } from 'vitest';
import {
  buildWatchdogHealthPatterns,
  type CollectorAggregate,
} from './watchdog-health-lane';

/**
 * blender-self-learning-2026-07-12 P-007 + watchdog-churn-delta-gate-2026-07-25 (P-006/D-002):
 * the watchdog-health lane is the SEAM that keeps metric-lane signals reaching ideation AFTER
 * the churn fix stopped them from minting work items. A `stalled-claim` / `unresolved-escalation`
 * / `orphaned-dispatch` measurement no longer files a `bug` (signal-lane.ts METRIC_SOURCES), so
 * the ONLY path it now reaches the Blender is this lane — it aggregates watchdog_ticks.collectors
 * over 24h and surfaces chronic collectors as citable `watchdog:<collector>` patterns plus the
 * newest tick's standing open conditions as `watchdog:open:<key>`. These pin the PURE builder;
 * the PG edge (buildWatchdogHealthLane's own-SQL aggregate) is fail-soft ([] on any error) and
 * exercised by the cycle integration tests.
 */

/** A chronic collector aggregate; each test overrides only what it exercises. */
function collector(over: Partial<CollectorAggregate> = {}): CollectorAggregate {
  return { name: 'stalled-claim', totalSignals: 40, activeTicks: 40, brokenTicks: 0, ...over };
}

describe('buildWatchdogHealthPatterns — metric signals still reach the Blender after the churn fix', () => {
  it('emits NOTHING when there are no chronic collectors and no open conditions', () => {
    expect(buildWatchdogHealthPatterns([], [])).toEqual([]);
  });

  it('suppresses a blip collector (active < minActiveTicks) but surfaces a chronic one', () => {
    const out = buildWatchdogHealthPatterns(
      [
        collector({ name: 'service-down', totalSignals: 1, activeTicks: 1 }), // a one-tick blip
        collector({ name: 'stalled-claim', totalSignals: 81, activeTicks: 81 }), // chronic
      ],
      [],
    );
    expect(out.some((p) => p.ref === 'watchdog:service-down')).toBe(false);
    const chronic = out.find((p) => p.ref === 'watchdog:stalled-claim');
    expect(chronic).toBeTruthy();
    expect(chronic!.summary).toContain('signalling on 81');
    expect(chronic!.detail).toContain('81 signal(s) across 81 active tick(s)');
  });

  it('surfaces a metric-lane collector that STOPPED filing work items (the churn-fix contract)', () => {
    // These are exactly the sources signal-lane.ts routes to `metric` (never mint a work item):
    // after watchdog-churn-delta-gate-2026-07-25 the lane below is their ONLY route to ideation.
    const out = buildWatchdogHealthPatterns(
      [
        collector({ name: 'unresolved-escalation', totalSignals: 890, activeTicks: 89 }),
        collector({ name: 'orphaned-dispatch', totalSignals: 159, activeTicks: 89 }),
        collector({ name: 'failed-spawn', totalSignals: 55, activeTicks: 55 }),
      ],
      [],
    );
    for (const name of ['unresolved-escalation', 'orphaned-dispatch', 'failed-spawn']) {
      expect(out.some((p) => p.ref === `watchdog:${name}`)).toBe(true);
    }
  });

  it('surfaces a collector that is ITSELF failing even below the active-ticks threshold, with the FAILING summary', () => {
    const out = buildWatchdogHealthPatterns(
      [collector({ name: 'red-test', totalSignals: 0, activeTicks: 0, brokenTicks: 4 })],
      [],
    );
    const broken = out.find((p) => p.ref === 'watchdog:red-test');
    expect(broken).toBeTruthy();
    expect(broken!.summary).toContain('is itself FAILING (4 broken tick(s)/24h)');
  });

  it('orders collectors by chronic-ness: activeTicks desc, then totalSignals desc', () => {
    const out = buildWatchdogHealthPatterns(
      [
        collector({ name: 'few-active-many-signals', totalSignals: 900, activeTicks: 10 }),
        collector({ name: 'most-active', totalSignals: 100, activeTicks: 89 }),
        collector({ name: 'tie-active-fewer-signals', totalSignals: 50, activeTicks: 10 }),
      ],
      [],
    );
    const refs = out.filter((p) => p.ref.startsWith('watchdog:') && !p.ref.startsWith('watchdog:open:')).map((p) => p.ref);
    expect(refs[0]).toBe('watchdog:most-active'); // highest activeTicks leads
    // tie on activeTicks (10) → higher totalSignals first
    expect(refs.indexOf('watchdog:few-active-many-signals')).toBeLessThan(
      refs.indexOf('watchdog:tie-active-fewer-signals'),
    );
  });

  it('surfaces each standing open condition as a watchdog:open:<key> pattern', () => {
    const out = buildWatchdogHealthPatterns(
      [],
      ['insight-staleness:red-vite-build-destroys-the-live-bundle', 'orphaned-dispatch:EI-18586547526096634'],
    );
    const open = out.find((p) => p.ref === 'watchdog:open:insight-staleness:red-vite-build-destroys-the-live-bundle');
    expect(open).toBeTruthy();
    expect(open!.summary).toContain('standing OPEN watchdog condition');
    expect(out.some((p) => p.ref === 'watchdog:open:orphaned-dispatch:EI-18586547526096634')).toBe(true);
  });

  it('respects the pattern cap across collectors + open keys combined', () => {
    const out = buildWatchdogHealthPatterns(
      Array.from({ length: 20 }, (_, i) => collector({ name: `c-${i}`, totalSignals: 100 - i, activeTicks: 50 - i })),
      Array.from({ length: 20 }, (_, i) => `open-${i}`),
      { limit: 5 },
    );
    expect(out.length).toBe(5);
  });

  it('reproduces the 2026-07-25 live post-fix tick: chronic metric collectors + standing open keys both reach ideation', () => {
    // The exact live shape observed after the delta-gate shipped: captured=[] (zero re-files) yet
    // the metric collectors were still fully aggregated and the standing conditions still surfaced.
    const out = buildWatchdogHealthPatterns(
      [
        collector({ name: 'unresolved-escalation', totalSignals: 890, activeTicks: 89 }),
        collector({ name: 'insight-staleness', totalSignals: 356, activeTicks: 89 }),
        collector({ name: 'orphaned-dispatch', totalSignals: 159, activeTicks: 89 }),
        collector({ name: 'stalled-claim', totalSignals: 81, activeTicks: 81 }),
      ],
      [
        'insight-staleness:red-vite-build-destroys-the-live-bundle',
        'orphaned-dispatch:EI-18586547526096634',
        'dark-flag-age:dark-flags',
      ],
    );
    // both a metric collector (stopped filing) and a defect collector reach the Blender as trends
    expect(out.some((p) => p.ref === 'watchdog:stalled-claim')).toBe(true);
    expect(out.some((p) => p.ref === 'watchdog:insight-staleness')).toBe(true);
    // the standing conditions ride alongside as drill-back-able open keys
    expect(out.some((p) => p.ref === 'watchdog:open:dark-flag-age:dark-flags')).toBe(true);
    // chronic collectors lead (all sorted before open keys, which are appended)
    expect(out[0].ref).toBe('watchdog:unresolved-escalation'); // 89 active, 890 signals
  });
});
