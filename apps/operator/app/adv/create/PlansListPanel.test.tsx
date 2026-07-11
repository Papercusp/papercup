// @vitest-environment jsdom
//
// PlansListPanel — the create:filter sidebar. Real logic: the New-plan launch
// (launchAgent → toast success/error/install branches), the 3 view buttons
// (set ?view), the harness filter select (shown only with >1 harness option),
// and onSelectPlan's view-dependent behaviour (Plans view → ?plan; other views
// → toggle the ?itemPlans filter). The data hooks (use-create-data /
// usePlanSearch) and the heavy plan children (PlanFilters / PlanBucketTabs /
// PlanRail) are mocked; nuqs is a per-key store the tests seed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/* ── Hoisted shared state ──────────────────────────────────────────── */
const { nuqs, setters, view, maps, launchAgent, toastSpies, resolvedSlug } = vi.hoisted(() => ({
  nuqs: {} as Record<string, unknown>,
  setters: {} as Record<string, ReturnType<typeof vi.fn>>,
  view: { value: 'plans' as string },
  maps: {
    planList: { data: { plans: [] as Array<{ harness: string }> }, refresh: vi.fn() },
    visiblePlans: [] as Array<{ slug: string }>,
    harnessOptions: [] as string[],
  },
  launchAgent: vi.fn(async () => ({ ok: true as const })),
  toastSpies: { success: vi.fn(), error: vi.fn() },
  resolvedSlug: { value: null as string | null },
}));
function mkSetter(key: string) {
  if (!setters[key]) setters[key] = vi.fn(async (v: unknown) => { nuqs[key] = v; });
  return setters[key];
}

/* ── Mocks ─────────────────────────────────────────────────────────── */
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => [nuqs[key], mkSetter(key)],
  parseAsString: { withDefault: () => ({}) },
}));
vi.mock('sonner', () => ({ toast: toastSpies }));
vi.mock('@papercusp/operator-core/lib/launch-agent', () => ({
  launchAgent: (opts: unknown) => launchAgent(opts),
}));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (key: string) => key }));
vi.mock('@/app/harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
// Select: a native <select> so we can drive onChange + read the option labels.
vi.mock('@/app/harness/Select', () => ({
  Select: ({
    value,
    onChange,
    options,
    ariaLabel,
  }: {
    value: string;
    onChange: (v: string) => void;
    options: Array<{ value: string; label: string }>;
    ariaLabel?: string;
  }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock('@/app/admin/plans/PlanFilters', () => ({ default: () => <div data-testid="plan-filters" /> }));
vi.mock('@/app/admin/plans/PlanBucketTabs', () => ({ default: () => <div data-testid="plan-buckets" /> }));
vi.mock('@/app/admin/plans/PlanRail', () => ({
  default: ({ onSelect, selectedSlugs }: { onSelect: (s: string) => void; selectedSlugs: string[] }) => (
    <div data-testid="plan-rail">
      <span data-testid="selected">{selectedSlugs.join(',')}</span>
      <button data-testid="rail-pick" onClick={() => onSelect('picked-plan')}>
        pick
      </button>
    </div>
  ),
}));
vi.mock('@/app/admin/plans/plans-api', () => ({ usePlanSearch: () => ({ data: { hits: [] } }) }));
vi.mock('./use-create-data', () => ({
  useCreateScope: () => ({}),
  usePlanListMaps: () => maps,
  useItemPlanFilter: () => [nuqs.itemPlans ?? [], mkSetter('itemPlans')],
  useResolvedHarnessSlug: () => resolvedSlug.value,
  useCreateView: () => [view.value, mkSetter('view')],
}));

import PlansListPanel from './PlansListPanel';

beforeEach(() => {
  for (const k of Object.keys(nuqs)) delete nuqs[k];
  for (const k of Object.keys(setters)) delete setters[k];
  nuqs.q = '';
  nuqs.plan = null;
  nuqs.itemPlans = [];
  view.value = 'plans';
  maps.planList = { data: { plans: [] }, refresh: vi.fn() };
  maps.visiblePlans = [];
  maps.harnessOptions = [];
  launchAgent.mockReset().mockResolvedValue({ ok: true });
  toastSpies.success.mockReset();
  toastSpies.error.mockReset();
  resolvedSlug.value = null;
});
afterEach(cleanup);

describe('PlansListPanel — view buttons', () => {
  it('renders the New-plan button + the view buttons (Observations moved to Signals, 2026-07-11)', () => {
    render(<PlansListPanel />);
    expect(screen.getByRole('button', { name: /New plan/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Plans/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Queue/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Sessions/i })).toBeTruthy();
    // Observations is no longer a Create-dock view — it lives on the Signals tab.
    expect(screen.queryByRole('button', { name: /Observations/i })).toBeNull();
  });

  it('clicking a view button sets ?view to that view', () => {
    render(<PlansListPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Queue/i }));
    expect(setters.view).toHaveBeenCalledWith('queue');
    fireEvent.click(screen.getByRole('button', { name: /Sessions/i }));
    expect(setters.view).toHaveBeenCalledWith('sessions');
  });

  it('renders the view controls as an icon-only left rail without moving New plan', () => {
    render(<PlansListPanel />);
    const rail = screen.getByRole('navigation', { name: 'Create view' });
    const plans = screen.getByRole('button', { name: 'Plans' });
    const queue = screen.getByRole('button', { name: 'Queue' });
    const sessions = screen.getByRole('button', { name: 'Sessions' });

    expect(rail.classList.contains('pc-create-plans-sidebar__view-rail')).toBe(true);
    for (const button of [plans, queue, sessions]) {
      expect(rail.contains(button)).toBe(true);
      expect(button.classList.contains('pc-create-plans-sidebar__view-btn')).toBe(true);
      expect(button.textContent).toBe('');
      expect(button.querySelector('svg')).toBeTruthy();
    }
    expect(plans.classList.contains('is-active')).toBe(true);
    expect(queue.classList.contains('is-active')).toBe(false);
    expect(rail.contains(screen.getByRole('button', { name: /New plan/i }))).toBe(false);
  });
});

describe('PlansListPanel — harness filter', () => {
  it('hides the harness-filter select when there is at most one harness option', () => {
    maps.harnessOptions = ['only-one'];
    render(<PlansListPanel />);
    expect(screen.queryByLabelText(/Filter plans by pot/i)).toBeNull();
  });

  it('shows the harness-filter select with >1 option and writes ?h on change', () => {
    maps.harnessOptions = ['h1', 'h2'];
    maps.planList = { data: { plans: [{ harness: 'h1' }, { harness: 'h2' }] }, refresh: vi.fn() };
    render(<PlansListPanel />);
    const select = screen.getByLabelText(/Filter plans by pot/i) as HTMLSelectElement;
    expect(select).toBeTruthy();
    fireEvent.change(select, { target: { value: 'h2' } });
    expect(setters.h).toHaveBeenCalledWith('h2');
  });

  it('selecting "All" clears ?h to null', () => {
    maps.harnessOptions = ['h1', 'h2'];
    nuqs.h = 'h1';
    render(<PlansListPanel />);
    const select = screen.getByLabelText(/Filter plans by pot/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '_all' } });
    expect(setters.h).toHaveBeenCalledWith(null);
  });
});

describe('PlansListPanel — plan selection', () => {
  it('in Plans view, picking a plan opens it via ?plan', () => {
    view.value = 'plans';
    render(<PlansListPanel />);
    fireEvent.click(screen.getByTestId('rail-pick'));
    expect(setters.plan).toHaveBeenCalledWith('picked-plan');
  });

  it('in a non-Plans view, picking a plan toggles the ?itemPlans filter', () => {
    view.value = 'queue';
    nuqs.itemPlans = [];
    render(<PlansListPanel />);
    fireEvent.click(screen.getByTestId('rail-pick'));
    expect(setters.itemPlans).toHaveBeenCalledWith(['picked-plan']);
  });

  it('re-picking an already-filtered plan removes it from ?itemPlans', () => {
    view.value = 'queue';
    nuqs.itemPlans = ['picked-plan'];
    render(<PlansListPanel />);
    fireEvent.click(screen.getByTestId('rail-pick'));
    expect(setters.itemPlans).toHaveBeenCalledWith([]);
  });

  it('passes the open ?plan as the selected slug to the rail in Plans view', () => {
    view.value = 'plans';
    nuqs.plan = 'open-plan';
    render(<PlansListPanel />);
    expect(screen.getByTestId('selected').textContent).toBe('open-plan');
  });
});

describe('PlansListPanel — New-plan launch', () => {
  it('launches an agent and toasts success on ok', async () => {
    render(<PlansListPanel />);
    fireEvent.click(screen.getByRole('button', { name: /New plan/i }));
    await waitFor(() => expect(launchAgent).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastSpies.success).toHaveBeenCalled());
  });

  it('toasts the install command when launchAgent returns installCmd', async () => {
    launchAgent.mockResolvedValueOnce({ ok: false, installCmd: 'npm i -g @papercusp/omp' });
    render(<PlansListPanel />);
    fireEvent.click(screen.getByRole('button', { name: /New plan/i }));
    await waitFor(() => expect(toastSpies.error).toHaveBeenCalled());
    expect(String(toastSpies.error.mock.calls[0][0])).toContain('npm i -g @papercusp/omp');
  });

  it('toasts a launch error when launchAgent fails without installCmd', async () => {
    launchAgent.mockResolvedValueOnce({ ok: false, error: 'psu not found' });
    render(<PlansListPanel />);
    fireEvent.click(screen.getByRole('button', { name: /New plan/i }));
    await waitFor(() => expect(toastSpies.error).toHaveBeenCalled());
    expect(String(toastSpies.error.mock.calls[0][0])).toContain('psu not found');
  });

  it('passes the resolved harness slug into the launch when one is active', async () => {
    resolvedSlug.value = 'my-harness';
    render(<PlansListPanel />);
    fireEvent.click(screen.getByRole('button', { name: /New plan/i }));
    await waitFor(() => expect(launchAgent).toHaveBeenCalled());
    expect((launchAgent.mock.calls[0][0] as { slug: string }).slug).toBe('my-harness');
  });
});
