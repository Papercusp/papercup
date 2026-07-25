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

import AutomationPane, { scheduleLaneValue } from './AutomationPane';

type Routine = {
  name: string;
  installSlug: string;
  category: string;
  cadence: string | null;
  spawnsAgent: boolean;
  active: boolean;
  lastFiredAt: string | null;
};

const routine = (over: Partial<Routine> = {}): Routine => ({
  name: 'gym-cycle',
  installSlug: 'papercusp',
  category: 'learning',
  cadence: 'every 6h',
  spawnsAgent: true,
  active: true,
  lastFiredAt: '2026-07-25T18:00:00.000Z',
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

function renderPane() {
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
  it('says All paused when every spender is off (not "0 can spend")', () => {
    expect(scheduleLaneValue([routine({ active: false })] as never)).toBe('All paused');
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
