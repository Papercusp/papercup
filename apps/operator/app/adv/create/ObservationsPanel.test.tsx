// @vitest-environment jsdom
//
// ObservationsPanel — the browse-only Observations pane (turn-end reflections).
// Logic worth covering: the loading / empty / populated branches off the
// `learning.observations` sync query, the KIND_LABEL prettifier (known kind →
// label, unknown kind → raw value, missing kind → no chip), and the optional
// per-row metadata (sourceRole / scope / confidence / refs). The sync hook is
// mocked with a hoisted mutable holder (the OperatorActionLog pattern) so each
// test seeds its own rows without a live transport.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { sync, filters } = vi.hoisted(() => ({
  sync: { data: [] as unknown[], loading: false },
  filters: { itemPlans: [] as string[] },
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({
    data: sync.data,
    loading: sync.loading,
    error: null,
    fetching: false,
    transport: 'sse' as const,
    invalidate: () => {},
  }),
}));
vi.mock('./use-create-data', () => ({
  useItemPlanFilter: () => [filters.itemPlans, vi.fn()],
}));

import ObservationsPanel from './ObservationsPanel';

interface Row {
  id: string;
  title: string;
  body: string | null;
  kind: string | null;
  scope: string | null;
  confidence: string | null;
  refs: string[];
  sourceRole: string | null;
  createdAt: string;
}
function mkRow(over: Partial<Row> = {}): Row {
  return {
    id: 'o1',
    title: 'Title one',
    body: null,
    kind: null,
    scope: null,
    confidence: null,
    refs: [],
    sourceRole: null,
    createdAt: '2026-06-14T12:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  sync.data = [];
  sync.loading = false;
  filters.itemPlans = [];
});
afterEach(() => cleanup());

describe('<ObservationsPanel />', () => {
  it('shows the loading copy while loading with no rows yet', () => {
    sync.loading = true;
    sync.data = [];
    render(<ObservationsPanel />);
    expect(screen.getByText(/loading observations…/i)).toBeTruthy();
  });

  it('shows the empty-state copy when there are no observations', () => {
    sync.loading = false;
    sync.data = [];
    render(<ObservationsPanel />);
    expect(screen.getByText(/no observations yet/i)).toBeTruthy();
  });

  it('renders one list item per observation with its title', () => {
    sync.data = [mkRow({ id: 'a', title: 'First' }), mkRow({ id: 'b', title: 'Second' })];
    const { container } = render(<ObservationsPanel />);
    expect(container.querySelectorAll('ul > li')).toHaveLength(2);
    expect(screen.getByText('First')).toBeTruthy();
    expect(screen.getByText('Second')).toBeTruthy();
  });

  it('filters observations by the selected plan refs', () => {
    filters.itemPlans = ['plan-alpha'];
    sync.data = [
      mkRow({ id: 'a', title: 'Alpha exact', refs: ['plan-alpha'] }),
      mkRow({ id: 'b', title: 'Alpha tagged', refs: ['plan:plan-alpha'] }),
      mkRow({ id: 'c', title: 'Beta', refs: ['plan-beta'] }),
      mkRow({ id: 'd', title: 'Prefix only', refs: ['plan-alphabet'] }),
    ];
    const { container } = render(<ObservationsPanel />);
    expect(container.querySelectorAll('ul > li')).toHaveLength(2);
    expect(screen.getByText('Alpha exact')).toBeTruthy();
    expect(screen.getByText('Alpha tagged')).toBeTruthy();
    expect(screen.queryByText('Beta')).toBeNull();
    expect(screen.queryByText('Prefix only')).toBeNull();
  });

  it('shows a selected-plan empty state when the filter removes every observation', () => {
    filters.itemPlans = ['plan-alpha'];
    sync.data = [mkRow({ id: 'b', title: 'Beta', refs: ['plan-beta'] })];
    render(<ObservationsPanel />);
    expect(screen.getByText(/no observations match the selected plan/i)).toBeTruthy();
  });

  it('maps a known kind to its pretty label and passes an unknown kind through', () => {
    sync.data = [
      mkRow({ id: 'k1', title: 'k1', kind: 'friction' }),
      mkRow({ id: 'k2', title: 'k2', kind: 'mystery-kind' }),
    ];
    render(<ObservationsPanel />);
    expect(screen.getByText('Friction')).toBeTruthy(); // KIND_LABEL.friction
    expect(screen.getByText('mystery-kind')).toBeTruthy(); // unknown → raw
  });

  it('renders the optional body, sourceRole, scope, confidence, and refs metadata', () => {
    sync.data = [
      mkRow({
        id: 'full',
        title: 'Full row',
        body: 'a longer note',
        sourceRole: 'engineer',
        scope: 'repo',
        confidence: 'high',
        refs: ['F-1', 'WI-2'],
      }),
    ];
    render(<ObservationsPanel />);
    expect(screen.getByText('a longer note')).toBeTruthy();
    expect(screen.getByText('engineer')).toBeTruthy();
    expect(screen.getByText(/scope: repo/)).toBeTruthy();
    expect(screen.getByText(/conf: high/)).toBeTruthy();
    expect(screen.getByText('F-1 · WI-2')).toBeTruthy();
  });
});
