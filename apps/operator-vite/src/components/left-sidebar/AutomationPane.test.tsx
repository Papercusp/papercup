// @vitest-environment jsdom
/**
 * AutomationPane.test — the shared body behind the Blender / Docs / Agents tabs.
 *
 * Covers the 2026-07-25 owner ask "improve the design of the blender and docs tab
 * so it more closely models the mug tab design" — the pane leads with the Mug's
 * header bar (identity + scope + whole-pane action) over a titled section, not a
 * bare list — plus the same day's correction that COST does not belong here at
 * all (see the no-spend regression below). It also pins what must survive both:
 * the pause writes, and the pane invalidating its OWN read after its own write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Blend } from 'lucide-react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const H = vi.hoisted(() => ({
  catalogResult: { data: [] as unknown[], loading: false, error: null as unknown },
  nuqsState: {} as Record<string, unknown>,
  nuqsSetters: {} as Record<string, ReturnType<typeof vi.fn>>,
  invalidated: [] as string[],
}));

import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => {
    const setter = (H.nuqsSetters[key] ??= vi.fn((v: unknown) => {
      H.nuqsState[key] = v;
    }));
    return [H.nuqsState[key] ?? 'schedule', setter];
  },
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName: string }) => ({
    ...H.catalogResult,
    invalidate: () => H.invalidated.push(opts.queryName),
  }),
}));

import AutomationPane, { armBudgetLabel, armingLaneValue, scheduleLaneValue } from './AutomationPane';

type Routine = {
  name: string;
  installSlug: string;
  category: string;
  cadence: string | null;
  spawnsAgent: boolean;
  active: boolean;
  lastFiredAt: string | null;
  /** Which of the five host scheduling mechanisms this row came from. */
  source: string;
  /** Only `routines` rows can be paused from the pane — `routines:set` writes
   *  that table and nothing else. */
  controllable: boolean;
};

const routine = (over: Partial<Routine> = {}): Routine => ({
  name: 'gym-cycle',
  installSlug: 'papercusp',
  category: 'learning',
  cadence: 'every 6h',
  spawnsAgent: true,
  active: true,
  lastFiredAt: '2026-07-25T18:00:00.000Z',
  source: 'routines',
  controllable: true,
  ...over,
});

const catalog = {
  routines: [
    routine(),
    routine({ name: 'blueprint-singleton', active: false }),
    routine({ name: 'tidy-cache', spawnsAgent: false, cadence: null }),
    routine({ name: 'doc-sweep', category: 'docs' }),
  ],
  spend7d: [
    { role: 'gym', modelClass: 'sonnet', turns: 1200, costUsd: 12.5 },
    { role: 'scout', modelClass: null, turns: 300, costUsd: 4.25 },
    { role: 'worker', modelClass: null, turns: 90, costUsd: 1 },
  ],
};

function renderPane(overrideCatalog?: { routines: Routine[] }) {
  if (overrideCatalog) {
    H.catalogResult = {
      data: [{ ...catalog, ...overrideCatalog }],
      loading: false,
      error: null,
    };
  }
  return render(
    <AutomationPane
      active
      categories={['learning'] as never}
      title="Blender"
      subtitle="Learns and self-improves"
      icon={Blend}
      blurb="Learning agents that run on a schedule."
    />,
  );
}

beforeEach(() => {
  H.catalogResult = { data: [catalog], loading: false, error: null };
  H.nuqsState = {};
  H.nuqsSetters = {};
  H.invalidated = [];
});
afterEach(cleanup);

describe('scheduleLaneValue', () => {
  it('leads with how many scheduled agents can SPEND — the pane’s whole reason to exist', () => {
    expect(scheduleLaneValue([routine(), routine({ name: 'b' })] as never)).toBe('2 can spend');
  });
  it('says None can spend when every spender is off (not "0 can spend")', () => {
    expect(scheduleLaneValue([routine({ active: false })] as never)).toBe('None can spend');
  });
  // Regression for the live Docs-pane misread (2026-07-25): the old wording was
  // "All paused", which is FALSE whenever a non-spending routine is still
  // running — exactly the Docs case, where knowledge-pack-delivery/hygiene were
  // both active. The counter only ever means money, so its zero case must not
  // make a claim about running-ness.
  it('never says "paused" when a non-spending routine is still active', () => {
    const rows = [
      routine({ name: 'doc-steward-dispatch', active: false, spawnsAgent: true }),
      routine({ name: 'knowledge-pack-delivery', active: true, spawnsAgent: false }),
    ];
    const value = scheduleLaneValue(rows as never);
    expect(value).toBe('None can spend');
    expect(value).not.toMatch(/paused/i);
  });
  it('reports a plain count when nothing in the category spends tokens', () => {
    expect(scheduleLaneValue([routine({ spawnsAgent: false })] as never)).toBe('1 scheduled');
  });
  it('handles the empty category', () => {
    expect(scheduleLaneValue([])).toBe('None scheduled');
  });
});

describe('AutomationPane — Mug-modelled layout (owner ask 2026-07-25)', () => {
  it('renders the Mug-style header bar: title, subtitle and a workspace scope chip', () => {
    renderPane();
    expect(screen.getByText('Blender')).toBeTruthy();
    expect(screen.getByText('Learns and self-improves')).toBeTruthy();
    // Same correction as the Mug/Kettle headers: these are workspace schedules,
    // never a per-pot control, so the chip must say so.
    expect(screen.getByText('workspace')).toBeTruthy();
  });

  it('states the spend-capable count in the section header', () => {
    renderPane();
    // Only the learning routines count (doc-sweep belongs to the Docs pane) and
    // only the ACTIVE spenders: gym-cycle. blueprint-singleton is paused;
    // tidy-cache spawns nothing.
    expect(screen.getByTestId('automation-status').textContent).toBe('1 can spend');
  });

  it('lists only this pane’s categories, spending routines first', () => {
    renderPane();
    const names = screen
      .getAllByTestId(/^automation-row-/)
      .map((el) => el.getAttribute('data-testid'));
    // gym-cycle (spawns + active) → blueprint-singleton (spawns, paused) →
    // tidy-cache (no spawn). doc-sweep is another pane's category.
    expect(names).toEqual([
      'automation-row-gym-cycle',
      'automation-row-blueprint-singleton',
      'automation-row-tidy-cache',
    ]);
  });

  /**
   * REGRESSION (owner correction 2026-07-25): "Why is the spend tab inside
   * blender? is that showing only blender related spend? It looks like not." It
   * wasn't — spend has no routine-level attribution, so the per-pane lane was
   * double-counting shared roles across Blender/Docs/Agents. Cost lives ONLY in
   * the workspace SpendTab now; this pane must never grow a cost readout again.
   */
  it('shows NO spend figures — cost belongs to the one workspace Spend tab', () => {
    renderPane();
    expect(screen.queryByText(/\$/)).toBeNull();
    expect(screen.queryByText(/turns/)).toBeNull();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });
});

describe('AutomationPane — controls', () => {
  it('pauses every spending routine in the pane and refreshes its own read', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { content: [{ text: JSON.stringify({ ok: true }) }] } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPane();

    fireEvent.click(screen.getByTestId('automation-pause-all'));
    await waitFor(() => expect(H.invalidated).toContain('automation.catalog'));

    // Only the ACTIVE spender is written — never a routine outside this pane, and
    // never one already in the target state.
    const sent = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse((init as { body: string }).body) as { name: string; args: { name: string } },
    );
    expect(sent.map((s) => s.args.name)).toEqual(['gym-cycle']);
    expect(sent[0].name).toBe('routines:set');
    vi.unstubAllGlobals();
  });

  it('offers Resume all once nothing is spending', () => {
    H.catalogResult = {
      data: [{ ...catalog, routines: catalog.routines.map((r) => ({ ...r, active: false })) }],
      loading: false,
      error: null,
    };
    renderPane();
    expect(screen.getByTestId('automation-resume-all')).toBeTruthy();
    expect(screen.queryByTestId('automation-pause-all')).toBeNull();
  });

  it('surfaces a refused write inline instead of failing silently', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          result: { content: [{ text: JSON.stringify({ ok: false, message: 'routine locked' }) }] },
        }),
      }),
    );
    renderPane();
    fireEvent.click(screen.getByTestId('automation-toggle-gym-cycle'));
    await waitFor(() => expect(screen.getByText(/routine locked/)).toBeTruthy());
    vi.unstubAllGlobals();
  });
});

/**
 * Schedules that are LISTED but not pausable from this pane.
 *
 * The pane now reads all five host scheduling mechanisms, not just
 * `harness_shared.routines`, so the owner can see every scheduled thing (owner
 * mandate 2026-07-25). But `routines:set` only writes the routines table — the
 * other four have no switch here. They must therefore render as INERT MARKERS,
 * never as buttons: this pane's original defect was offering pause controls
 * that could not act, and a clickable-but-doomed toggle would reproduce exactly
 * that failure in a new place.
 */
describe('AutomationPane — non-routine schedules', () => {
  const uncontrollable = routine({
    name: 'doc-freshness-sweep',
    source: 'in-process',
    controllable: false,
    spawnsAgent: true,
    active: true,
  });

  it('renders a marker, NOT a toggle, for a schedule it cannot pause', () => {
    renderPane({ routines: [uncontrollable] });
    expect(screen.queryByTestId('automation-toggle-doc-freshness-sweep')).toBeNull();
    expect(screen.getByTestId('automation-nocontrol-doc-freshness-sweep')).toBeTruthy();
  });

  it('still LISTS it — being unpausable is not a reason to hide it', () => {
    renderPane({ routines: [uncontrollable] });
    expect(screen.getByTestId('automation-row-doc-freshness-sweep')).toBeTruthy();
  });

  it('offers no "Pause all" when nothing in the pane is actually pausable', () => {
    // The button's count must equal what the click can deliver; a pane of
    // uncontrollable rows can deliver nothing, so it must not offer the action.
    renderPane({ routines: [uncontrollable] });
    expect(screen.queryByTestId('automation-pause-all')).toBeNull();
    expect(screen.queryByTestId('automation-resume-all')).toBeNull();
  });

  it('counts only pausable spenders in "Pause all"', () => {
    renderPane({ routines: [uncontrollable, routine({ name: 'gym-cycle' })] });
    const btn = screen.getByTestId('automation-pause-all');
    // One controllable spender present, so the button promises exactly one.
    expect(btn.textContent).toMatch(/Pause all/);
    expect(screen.getByTestId('automation-nocontrol-doc-freshness-sweep')).toBeTruthy();
    expect(screen.getByTestId('automation-toggle-gym-cycle')).toBeTruthy();
  });
});

/**
 * Arming section (P-011 — owner ask 2026-07-25: "where is the ability to
 * disable/enable this in the gui? it should be in the blender tab").
 *
 * On the $-figures note: the no-spend regression above bans per-ROLE spend
 * attribution (a guess rendered as fact). The arming rows show each pot/lane's
 * OWN governor ledger — the metered spend and the budget the owner arms
 * against — which is exactly the number an arming switch must show. The two
 * must not be conflated; the default fixture has no `arming`, so the no-spend
 * test keeps guarding the role-attribution ban.
 */
const arming = {
  gymPots: [
    { harnessSlug: 'papercusp', enabled: true, budgetUsd: 50, spentUsd: 12.892153, status: 'running' },
  ],
  lanes: [
    { loopId: 'red-queen', displayName: 'Red Queen', potSlug: 'papercusp', enabled: false, budgetUsd: null, spentUsd: 0, enforcement: 'governor' },
  ],
};

describe('armingLaneValue / armBudgetLabel', () => {
  it('counts open spend gates across both groups', () => {
    expect(armingLaneValue(arming.gymPots as never, arming.lanes as never)).toBe('1 armed');
    expect(armingLaneValue([], [])).toBe('None registered');
    expect(
      armingLaneValue([{ ...arming.gymPots[0], enabled: false }] as never, arming.lanes as never),
    ).toBe('All disarmed');
  });
  it('renders one honest money label per row', () => {
    expect(armBudgetLabel(12.892153, 50)).toBe('$12.89 of $50');
    expect(armBudgetLabel(0, null)).toBe('$0 · no budget');
  });
});

describe('AutomationPane — Arming section (P-011)', () => {
  it('renders gym pots and governor lanes with toggles for the learning pane', () => {
    renderPane({ arming } as never);
    expect(screen.getByTestId('automation-arming')).toBeTruthy();
    expect(screen.getByTestId('automation-arming-status').textContent).toBe('1 armed');
    expect(screen.getByTestId('arming-row-gym-papercusp')).toBeTruthy();
    expect(screen.getByTestId('arming-row-lane-red-queen')).toBeTruthy();
  });

  it('does NOT render for a pane that does not own the learning category', () => {
    H.catalogResult = { data: [{ ...catalog, arming }], loading: false, error: null };
    render(
      <AutomationPane
        active
        categories={['docs'] as never}
        title="Docs"
        subtitle="Keeps documentation fresh"
        icon={Blend}
        blurb="Docs agents."
      />,
    );
    expect(screen.queryByTestId('automation-arming')).toBeNull();
  });

  it('disarming a gym pot fires gym:arm and refreshes the pane read', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { content: [{ text: JSON.stringify({ ok: true }) }] } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPane({ arming } as never);

    fireEvent.click(screen.getByTestId('arming-toggle-gym-papercusp'));
    await waitFor(() => expect(H.invalidated).toContain('automation.catalog'));
    const sent = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(sent).toEqual([{ name: 'gym:arm', args: { harness: 'papercusp', enabled: false }, confirmed: true }]);
  });

  it('budget click-to-edit saves via governor:arm on Enter (empty clears)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { content: [{ text: JSON.stringify({ ok: true }) }] } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPane({ arming } as never);

    fireEvent.click(screen.getByTestId('arming-budget-lane-red-queen'));
    const input = screen.getByTestId('arming-budget-input-lane-red-queen');
    fireEvent.change(input, { target: { value: '25' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(H.invalidated).toContain('automation.catalog'));
    const sent = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(sent).toEqual([{ name: 'governor:arm', args: { loopId: 'red-queen', budgetUsd: 25 }, confirmed: true }]);
  });
});
