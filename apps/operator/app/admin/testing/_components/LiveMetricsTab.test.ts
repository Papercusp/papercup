// LiveMetricsTab — the passive perf-event viewer. Its render is a filter/sort
// table over two pure helpers (filterAndSortEvents + countEventsByKind), which
// are extracted + exported and tested here. The table + nuqs-backed filter
// controls are render-only wiring around these.

import { describe, expect, it } from 'vitest';
import { filterAndSortEvents, countEventsByKind } from './LiveMetricsTab';
import type { PerfEvent, PerfEventKind } from '../_lib/vitals-recorder';

function ev(over: Partial<PerfEvent> & { kind: PerfEventKind; route: string }): PerfEvent {
  return { id: Math.random().toString(36), ts: 0, duration: 0, target: '', ...over };
}

describe('filterAndSortEvents', () => {
  const events: PerfEvent[] = [
    ev({ kind: 'interaction', route: '/harness/a', duration: 30, ts: 100 }),
    ev({ kind: 'longtask', route: '/harness/b', duration: 90, ts: 200 }),
    ev({ kind: 'interaction', route: '/plans', duration: 60, ts: 300 }),
  ];

  it('passes everything through under the "all" kind with no route filter', () => {
    expect(filterAndSortEvents(events, 'all', '', 'duration')).toHaveLength(3);
  });

  it('filters by kind', () => {
    const out = filterAndSortEvents(events, 'interaction', '', 'ts');
    expect(out).toHaveLength(2);
    expect(out.every((e) => e.kind === 'interaction')).toBe(true);
  });

  it('filters by a route substring', () => {
    const out = filterAndSortEvents(events, 'all', '/harness', 'ts');
    expect(out.map((e) => e.route)).toEqual(['/harness/b', '/harness/a']); // ts desc
  });

  it('sorts by duration descending', () => {
    const out = filterAndSortEvents(events, 'all', '', 'duration');
    expect(out.map((e) => e.duration)).toEqual([90, 60, 30]);
  });

  it('sorts by ts descending', () => {
    const out = filterAndSortEvents(events, 'all', '', 'ts');
    expect(out.map((e) => e.ts)).toEqual([300, 200, 100]);
  });

  it('sorts by route ascending (localeCompare)', () => {
    const out = filterAndSortEvents(events, 'all', '', 'route');
    expect(out.map((e) => e.route)).toEqual(['/harness/a', '/harness/b', '/plans']);
  });

  it('caps the result at 50 rows', () => {
    const many = Array.from({ length: 80 }, (_, i) => ev({ kind: 'interaction', route: '/x', duration: i }));
    expect(filterAndSortEvents(many, 'all', '', 'duration')).toHaveLength(50);
  });

  it('does not mutate the input array', () => {
    const input = [...events];
    filterAndSortEvents(input, 'all', '', 'duration');
    expect(input).toEqual(events);
  });
});

describe('countEventsByKind', () => {
  it('returns all five kinds zero-defaulted for an empty input', () => {
    expect(countEventsByKind([])).toEqual({
      interaction: 0, longtask: 0, 'layout-shift': 0, 'console-error': 0, 'unhandled-error': 0,
    });
  });

  it('tallies each kind', () => {
    const counts = countEventsByKind([
      ev({ kind: 'interaction', route: '/a' }),
      ev({ kind: 'interaction', route: '/b' }),
      ev({ kind: 'console-error', route: '/a' }),
    ]);
    expect(counts.interaction).toBe(2);
    expect(counts['console-error']).toBe(1);
    expect(counts.longtask).toBe(0);
  });
});
