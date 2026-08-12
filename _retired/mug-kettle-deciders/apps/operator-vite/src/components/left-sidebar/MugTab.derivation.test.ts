/**
 * MugTab.derivation.test — the pure derivations behind the Queen steering
 * panel (queen-steering-panel-2026-06-15). The component render + write wiring
 * is pinned in MugTab.test.tsx; this pins the branch behaviour of the
 * exported pure helpers directly so each edge is covered once, fast:
 *   - buildSteerRows — active rows merged with the eligible set (+ stale slugs)
 *
 * The terminal/archived filter + rank/recency sort that used to live here as
 * `selectSteerablePlans` moved SERVER-side under D-071 (the panel is chrome on
 * every route and was holding the whole plans.list feed to compute it). Its
 * branches are pinned in
 * packages/operator-core/lib/sync-resolver/steerable-plans.test.ts.
 *   - toggleEligible — checkbox add/remove
 *   - steerHiveOptions — strips the All + loading sentinels from the option set
 *   - resolveHomeHive — first formal hive, else first steering row, else ''
 *   - pauseStateLabel — indefinite / timed-future / flowing
 *
 * AdvShell + adv-harness-selection are mocked (AdvShell is a heavy Radix tree;
 * buildHarnessSelectOptions itself is pinned in __tests__/adv-shell-logic.test.ts)
 * so steerHiveOptions is tested as the thin filter/map MugTab layers on top.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SteerablePlanRow } from '@papercusp/operator-core/lib/sync-resolver/steerable-plans';

// AdvShell.buildHarnessSelectOptions is mocked to emit the same shape the real
// one does (All sentinel first, then a workspace group wrapping the rows) so
// steerHiveOptions' own flatten + filtering is what we exercise.
vi.mock('../adv/AdvShell', () => ({
  buildHarnessSelectOptions: (projects: Array<{ slug: string }>) => [
    { value: '__all__', label: 'All' },
    { kind: 'group', label: 'workspace', options: projects.map((p) => ({ value: p.slug, label: p.slug.toUpperCase() })) },
  ],
}));
vi.mock('../adv/adv-harness-selection', () => ({ ALL_HARNESSES_OPTION: '__all__' }));

import {
  buildSteerRows,
  toggleEligible,
  steerHiveOptions,
  resolveHomeHive,
  pauseStateLabel,
  type HiveSteeringRow,
} from './MugTab';

function plan(over: Partial<SteerablePlanRow>): SteerablePlanRow {
  // `plans.steerable` rows are a CLOSED 5-field projection whose optional
  // fields are `T | null` (the resolver normalises an absent/blank wire value
  // to null via `str()`), unlike PlanListRow's `?: T` — so this factory writes
  // nulls rather than omitting keys.
  return {
    slug: 'p',
    title: 'P',
    status: 'draft',
    startStatus: null,
    updated: null,
    harness: 'h',
    ...over,
  };
}

function steering(over: Partial<HiveSteeringRow> = {}): HiveSteeringRow {
  return {
    slug: 's',
    directive: null,
    eligiblePlans: [],
    eligibleHives: [],
    // Required on HiveSteeringRow (the "Non-plan work items" toggle, default true)
    // — omitting it made the factory's return type `boolean | undefined`.
    includeUnplannedWork: true,
    pauseNewWork: false,
    pausedUntil: null,
    ...over,
  };
}

describe('buildSteerRows', () => {
  it('flags the active rows that are in the eligible set', () => {
    const active = [plan({ slug: 'a', title: 'A', status: 'ready' }), plan({ slug: 'b', title: 'B', status: 'active' })];
    const rows = buildSteerRows(active, ['b']);
    expect(rows).toEqual([
      { slug: 'a', title: 'A', status: 'ready', startStatus: null, inActive: true, eligible: false },
      { slug: 'b', title: 'B', status: 'active', startStatus: null, inActive: true, eligible: true },
    ]);
  });

  it('appends stale eligible slugs not present in the active list, marked not-active', () => {
    const rows = buildSteerRows([plan({ slug: 'a', title: 'A' })], ['a', 'ghost']);
    expect(rows.map((r) => [r.slug, r.inActive, r.eligible])).toEqual([
      ['a', true, true],
      ['ghost', false, true],
    ]);
    const ghost = rows.find((r) => r.slug === 'ghost')!;
    expect(ghost.title).toBe('ghost'); // falls back to slug
    expect(ghost.status).toBeNull();
  });

  it('falls back title→slug when an active plan has no title', () => {
    const rows = buildSteerRows([plan({ slug: 'a', title: null })], []);
    expect(rows[0].title).toBe('a');
  });
});

describe('toggleEligible', () => {
  it('adds a slug not present', () => {
    expect(toggleEligible(['x'], 'y')).toEqual(['x', 'y']);
  });
  it('removes a slug already present', () => {
    expect(toggleEligible(['x', 'y'], 'x')).toEqual(['y']);
  });
  it('does not mutate the input', () => {
    const current = ['x'];
    toggleEligible(current, 'y');
    expect(current).toEqual(['x']);
  });
});

describe('steerHiveOptions', () => {
  it('strips the All sentinel and keeps real hive options with their labels', () => {
    const opts = steerHiveOptions([
      { slug: 'pot-a' },
      { slug: 'pot-b' },
    ] as never);
    expect(opts).toEqual([
      { value: 'pot-a', label: 'POT-A' },
      { value: 'pot-b', label: 'POT-B' },
    ]);
  });
});

describe('resolveHomeHive', () => {
  it('prefers the SERVER-stamped isHome row over any kind:"hive" project (the sb-devboard-hive dead-queen bug, 2026-07-01)', () => {
    // A workspace with a TEST hive listed first: the old client guess picked it
    // (paused, woke-never) and the 👑-tab showed a dead queen while the real
    // home queen ran. The server stamp must win.
    const projects = [
      { slug: 'sb-devboard-hive', harness_kind: 'hive' },
      { slug: 'papercusp', harness_kind: null },
    ];
    const rows = [steering({ slug: 'sb-devboard-hive' }), { ...steering({ slug: 'papercusp' }), isHome: true }];
    expect(resolveHomeHive(projects, rows)).toBe('papercusp');
  });

  it('prefers the first formal hive (harness_kind === "hive") when no row is stamped', () => {
    const projects = [
      { slug: 'pot-a', harness_kind: null },
      { slug: 'the-hive', harness_kind: 'hive' },
    ];
    expect(resolveHomeHive(projects, [steering({ slug: 's1' })])).toBe('the-hive');
  });

  it('falls back to the first steering row when no formal hive exists', () => {
    expect(resolveHomeHive([{ slug: 'pot-a', harness_kind: null }], [steering({ slug: 's1' })])).toBe('s1');
  });

  it('returns "" when there is neither a hive nor a steering row', () => {
    expect(resolveHomeHive([], [])).toBe('');
  });
});

describe('pauseStateLabel', () => {
  const now = 1_000_000;

  it('reports an indefinite pause as active', () => {
    expect(pauseStateLabel(steering({ pauseNewWork: true }), now)).toEqual({ active: true, label: 'Paused' });
  });

  it('reports a future timed pause with rounded minutes remaining', () => {
    const r = pauseStateLabel(steering({ pausedUntil: now + 5 * 60_000 }), now);
    expect(r.active).toBe(true);
    expect(r.label).toBe('Paused · 5 min left');
  });

  it('clamps the displayed minutes to at least 1 for a sub-minute window', () => {
    const r = pauseStateLabel(steering({ pausedUntil: now + 5_000 }), now);
    expect(r.active).toBe(true);
    expect(r.label).toBe('Paused · 1 min left');
  });

  it('reports flowing when the timed pause has already elapsed', () => {
    expect(pauseStateLabel(steering({ pausedUntil: now - 1 }), now)).toEqual({ active: false, label: 'New work flowing' });
  });

  it('reports flowing when nothing is paused', () => {
    expect(pauseStateLabel(steering(), now)).toEqual({ active: false, label: 'New work flowing' });
  });
});
