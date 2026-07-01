/**
 * QueenTab.derivation.test — the pure derivations behind the Queen steering
 * panel (queen-steering-panel-2026-06-15). The component render + write wiring
 * is pinned in QueenTab.test.tsx; this pins the branch behaviour of the
 * exported pure helpers directly so each edge is covered once, fast:
 *   - selectSteerablePlans — terminal/archived filter + rank+recency sort
 *   - buildSteerRows — active rows merged with the eligible set (+ stale slugs)
 *   - toggleEligible — checkbox add/remove
 *   - steerHiveOptions — strips the All + loading sentinels from the option set
 *   - resolveHomeHive — first formal hive, else first steering row, else ''
 *   - pauseStateLabel — indefinite / timed-future / flowing
 *
 * AdvShell + adv-harness-selection are mocked (AdvShell is a heavy Radix tree;
 * buildHarnessSelectOptions itself is pinned in __tests__/adv-shell-logic.test.ts)
 * so steerHiveOptions is tested as the thin filter/map QueenTab layers on top.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PlanListRow } from '@/app/admin/plans/plans-api';

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
  selectSteerablePlans,
  buildSteerRows,
  toggleEligible,
  steerHiveOptions,
  resolveHomeHive,
  pauseStateLabel,
  type HiveSteeringRow,
} from './QueenTab';

function plan(over: Partial<PlanListRow>): PlanListRow {
  return {
    slug: 'p',
    title: 'P',
    status: 'draft',
    updated: null,
    created: null,
    owner: null,
    archived: false,
    isLegacy: false,
    itemCounts: null,
    nextAction: null,
    harness: 'h',
    startStatus: null,
    priority: null,
    ...over,
  } as PlanListRow;
}

function steering(over: Partial<HiveSteeringRow> = {}): HiveSteeringRow {
  return {
    slug: 's',
    directive: null,
    eligiblePlans: [],
    eligibleHives: [],
    pauseNewWork: false,
    pausedUntil: null,
    ...over,
  };
}

describe('selectSteerablePlans', () => {
  it('drops shipped, superseded, and archived plans', () => {
    const rows = [
      plan({ slug: 'draft-x', status: 'draft' }),
      plan({ slug: 'shipped-x', status: 'shipped' }),
      plan({ slug: 'superseded-x', status: 'superseded' }),
      plan({ slug: 'archived-x', status: 'ready', archived: true }),
    ];
    expect(selectSteerablePlans(rows).map((p) => p.slug)).toEqual(['draft-x']);
  });

  it('ranks started < active < ready < other, then by recency desc', () => {
    const rows = [
      plan({ slug: 'ready-old', status: 'ready', updated: '2026-01-01' }),
      plan({ slug: 'draft-1', status: 'draft', updated: '2026-06-01' }),
      plan({ slug: 'active-1', status: 'active', updated: '2026-02-01' }),
      plan({ slug: 'started-1', status: 'active', startStatus: 'started', updated: '2026-01-01' }),
      plan({ slug: 'ready-new', status: 'ready', updated: '2026-05-01' }),
    ];
    expect(selectSteerablePlans(rows).map((p) => p.slug)).toEqual([
      'started-1', // rank 0
      'active-1', // rank 1
      'ready-new', // rank 2, newer
      'ready-old', // rank 2, older
      'draft-1', // rank 3
    ]);
  });

  it('does not mutate the input array', () => {
    const rows = [plan({ slug: 'b', status: 'ready' }), plan({ slug: 'a', status: 'active' })];
    const snapshot = rows.map((r) => r.slug);
    selectSteerablePlans(rows);
    expect(rows.map((r) => r.slug)).toEqual(snapshot);
  });
});

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

  it('falls back title→slug when an active plan has a null title', () => {
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
    expect(pauseStateLabel(steering({ pauseNewWork: true }), now)).toEqual({ active: true, label: 'New work PAUSED' });
  });

  it('reports a future timed pause with rounded minutes remaining', () => {
    const r = pauseStateLabel(steering({ pausedUntil: now + 5 * 60_000 }), now);
    expect(r.active).toBe(true);
    expect(r.label).toBe('Paused ~5m');
  });

  it('clamps the displayed minutes to at least 1 for a sub-minute window', () => {
    const r = pauseStateLabel(steering({ pausedUntil: now + 5_000 }), now);
    expect(r.active).toBe(true);
    expect(r.label).toBe('Paused ~1m');
  });

  it('reports flowing when the timed pause has already elapsed', () => {
    expect(pauseStateLabel(steering({ pausedUntil: now - 1 }), now)).toEqual({ active: false, label: 'New work flowing' });
  });

  it('reports flowing when nothing is paused', () => {
    expect(pauseStateLabel(steering(), now)).toEqual({ active: false, label: 'New work flowing' });
  });
});
