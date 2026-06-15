// RoutesTab — per-route perf roll-up across chaos runs + live observer events.
// The render is a table over `mergeRouteRollups`, the genuine logic, which is
// extracted + exported and tested here: chaos accumulation vs max, live tally,
// live errors, and the worst-INP sort. The table shell itself is render-only.

import { describe, expect, it } from 'vitest';
import { mergeRouteRollups, type MergedRollup } from './RoutesTab';
import type { RunSummary, RouteRollup } from '../_lib/recorder-channel';
import type { PerfEvent } from '../_lib/vitals-recorder';

function rollup(over: Partial<RouteRollup> & { route: string }): RouteRollup {
  return { clicks: 0, p50inp: 0, p95inp: 0, maxInp: 0, errors: 0, ...over };
}

function run(routes: RouteRollup[]): RunSummary {
  return {
    runId: 'r', startedAt: 0, endedAt: 0, durationMs: 0, clicks: 0, events: [],
    routes: Object.fromEntries(routes.map((r) => [r.route, r])),
  };
}

function ev(over: Partial<PerfEvent> & { route: string; kind: PerfEvent['kind'] }): PerfEvent {
  return { id: 'e', ts: 0, duration: 0, target: '', ...over };
}

describe('mergeRouteRollups', () => {
  it('returns an empty list for no runs and no live events', () => {
    expect(mergeRouteRollups([], [])).toEqual([]);
  });

  it('accumulates clicks/errors and takes the max of the INP metrics across runs', () => {
    const merged = mergeRouteRollups(
      [
        run([rollup({ route: '/a', clicks: 2, errors: 1, p50inp: 10, p95inp: 40, maxInp: 50 })]),
        run([rollup({ route: '/a', clicks: 3, errors: 2, p50inp: 20, p95inp: 30, maxInp: 60 })]),
      ],
      [],
    );
    const a = merged.find((m) => m.route === '/a')!;
    expect(a.clicks).toBe(5); // accumulated
    expect(a.errors).toBe(3); // accumulated
    expect(a.p50inp).toBe(20); // max
    expect(a.p95inp).toBe(40); // max
    expect(a.maxInp).toBe(60); // max
  });

  it('tallies live interactions into liveCount and the max into liveMaxInp', () => {
    const merged = mergeRouteRollups([], [
      ev({ route: '/b', kind: 'interaction', duration: 30 }),
      ev({ route: '/b', kind: 'interaction', duration: 80 }),
    ]);
    const b = merged.find((m) => m.route === '/b')!;
    expect(b.liveCount).toBe(2);
    expect(b.liveMaxInp).toBe(80);
  });

  it('counts console-error and unhandled-error live events into liveErrors', () => {
    const merged = mergeRouteRollups([], [
      ev({ route: '/c', kind: 'console-error' }),
      ev({ route: '/c', kind: 'unhandled-error' }),
      ev({ route: '/c', kind: 'interaction', duration: 5 }),
    ]);
    const c = merged.find((m) => m.route === '/c')!;
    expect(c.liveErrors).toBe(2);
    expect(c.liveCount).toBe(1);
  });

  it('merges a route that appears in both a chaos run and live events', () => {
    const merged = mergeRouteRollups(
      [run([rollup({ route: '/d', clicks: 1, p95inp: 25 })])],
      [ev({ route: '/d', kind: 'interaction', duration: 70 })],
    );
    const d = merged.find((m) => m.route === '/d')!;
    expect(d.clicks).toBe(1);
    expect(d.p95inp).toBe(25);
    expect(d.liveMaxInp).toBe(70);
  });

  it('sorts routes by the worst of (chaos p95, live max) descending', () => {
    const merged: MergedRollup[] = mergeRouteRollups(
      [
        run([rollup({ route: '/low', p95inp: 10 })]),
        run([rollup({ route: '/high', p95inp: 200 })]),
      ],
      [ev({ route: '/livehot', kind: 'interaction', duration: 500 })],
    );
    expect(merged.map((m) => m.route)).toEqual(['/livehot', '/high', '/low']);
  });
});
