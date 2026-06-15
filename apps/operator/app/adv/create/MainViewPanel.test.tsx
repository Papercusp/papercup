// @vitest-environment jsdom
//
// MainViewPanel — the create:main view router. Real logic: it renders the
// active ?view (plans editor when a plan is open · search results when ?q is
// set · sessions / observations / queue split · loading-vs-empty placeholder)
// and auto-opens the first scoped plan when entering Plans view with none
// selected. The heavy children + the data hooks (useCreateScope /
// usePlanListMaps / useCreateView) are mocked; nuqs is a per-key store the
// tests seed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { nuqs, view, maps, setters } = vi.hoisted(() => ({
  nuqs: {} as Record<string, unknown>,
  view: { value: 'plans' as string },
  maps: { visiblePlans: [] as Array<{ slug: string }>, planList: { loading: false } },
  setters: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
function mkSetter(key: string) {
  if (!setters[key]) setters[key] = vi.fn(async (v: unknown) => { nuqs[key] = v; });
  return setters[key];
}

vi.mock('nuqs', () => ({
  useQueryState: (key: string) => [nuqs[key], mkSetter(key)],
  parseAsString: { withDefault: () => ({}) },
}));

vi.mock('./use-create-data', () => ({
  useCreateScope: () => ({ scopeMode: 'self', harnessFilter: null, advActiveSlug: 'h', harnessSlugsForFetch: ['h'] }),
  usePlanListMaps: () => maps,
  useCreateView: () => [view.value, mkSetter('view')],
}));

vi.mock('@/app/admin/plans/PlanDetail', () => ({ default: ({ slug }: { slug: string }) => <div data-testid="plan-detail">{slug}</div> }));
vi.mock('@/app/admin/plans/PlanSearchResults', () => ({ default: ({ query }: { query: string }) => <div data-testid="search-results">{query}</div> }));
vi.mock('@/app/_components/layout/TwoPaneShell', () => ({ default: ({ list, detail }: { list: React.ReactNode; detail: React.ReactNode }) => <div data-testid="twopane">{list}{detail}</div> }));
vi.mock('./QueuePanel', () => ({ default: () => <div data-testid="queue-panel" /> }));
vi.mock('./PreviewPanel', () => ({ default: () => <div data-testid="preview-panel" /> }));
vi.mock('./SessionsPanel', () => ({ default: () => <div data-testid="sessions-panel" /> }));
vi.mock('./ObservationsPanel', () => ({ default: () => <div data-testid="observations-panel" /> }));

import MainViewPanel from './MainViewPanel';

function mkProps() {
  return { panelId: 'p', panelType: 'create:main', params: {}, api: { setParams: vi.fn(), setTitle: vi.fn(), close: vi.fn() } };
}

beforeEach(() => {
  for (const k of Object.keys(nuqs)) delete nuqs[k];
  for (const k of Object.keys(setters)) delete setters[k];
  nuqs.plan = null;
  nuqs.q = '';
  view.value = 'plans';
  maps.visiblePlans = [];
  maps.planList = { loading: false };
});
afterEach(() => cleanup());

describe('<MainViewPanel /> view routing', () => {
  it('renders the full PlanDetail editor when a plan is open in Plans view', () => {
    view.value = 'plans';
    nuqs.plan = 'open-plan';
    render(<MainViewPanel {...mkProps()} />);
    expect(screen.getByTestId('plan-detail').textContent).toBe('open-plan');
  });

  it('auto-opens the first scoped plan when entering Plans view with none selected', () => {
    view.value = 'plans';
    nuqs.plan = null;
    maps.visiblePlans = [{ slug: 'first-plan' }, { slug: 'second-plan' }];
    render(<MainViewPanel {...mkProps()} />);
    expect(setters.plan).toHaveBeenCalledWith('first-plan');
  });

  it('does NOT auto-open when a search query is active', () => {
    view.value = 'plans';
    nuqs.plan = null;
    nuqs.q = 'needle';
    maps.visiblePlans = [{ slug: 'first-plan' }];
    render(<MainViewPanel {...mkProps()} />);
    expect(setters.plan).not.toHaveBeenCalled();
    // search results render instead
    expect(screen.getByTestId('search-results').textContent).toBe('needle');
  });

  it('renders the Sessions panel when view=sessions', () => {
    view.value = 'sessions';
    render(<MainViewPanel {...mkProps()} />);
    expect(screen.getByTestId('sessions-panel')).toBeTruthy();
  });

  it('renders the Observations panel when view=observations', () => {
    view.value = 'observations';
    render(<MainViewPanel {...mkProps()} />);
    expect(screen.getByTestId('observations-panel')).toBeTruthy();
  });

  it('renders the queue split (QueuePanel | PreviewPanel) when view=queue', () => {
    view.value = 'queue';
    render(<MainViewPanel {...mkProps()} />);
    expect(screen.getByTestId('queue-panel')).toBeTruthy();
    expect(screen.getByTestId('preview-panel')).toBeTruthy();
  });

  it('shows the loading placeholder in Plans view while the list loads with no plans', () => {
    view.value = 'plans';
    nuqs.plan = null;
    maps.visiblePlans = [];
    maps.planList = { loading: true };
    render(<MainViewPanel {...mkProps()} />);
    expect(screen.getByText(/loading plans…/i)).toBeTruthy();
  });

  it('shows the empty placeholder in Plans view when there are no plans and not loading', () => {
    view.value = 'plans';
    nuqs.plan = null;
    maps.visiblePlans = [];
    maps.planList = { loading: false };
    render(<MainViewPanel {...mkProps()} />);
    expect(screen.getByText(/no plans in this view yet/i)).toBeTruthy();
  });
});
