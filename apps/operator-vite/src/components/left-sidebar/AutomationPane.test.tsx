// @vitest-environment jsdom
/**
 * AutomationPane.test — the shared body behind the Blender / Docs / Agents tabs.
 *
 * Covers the 2026-07-25 owner ask "improve the design of the blender and docs tab
 * so it more closely models the mug tab design": the pane must present the Mug's
 * three-part structure (header bar → lane strip → one lane's panel) rather than
 * one long scroll, so the spend total is answerable without scrolling past every
 * routine. It also pins the behaviour that must survive that restyle — the pause
 * writes, and the pane invalidating its OWN read after its own write.
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
      viewParam="blenderView"
      blurb="Learning agents that run on a schedule."
      spendRoles={['gym', 'scout']}
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

  it('renders a lane strip whose values answer both questions without opening a lane', () => {
    renderPane();
    const lanes = screen.getAllByRole('tab');
    expect(lanes.map((l) => l.textContent)).toEqual([
      expect.stringContaining('Schedule'),
      expect.stringContaining('Spend'),
    ]);
    // Only the learning routines count (doc-sweep is another pane's), and only
    // the ACTIVE spenders: gym-cycle. blueprint-singleton is paused, tidy-cache
    // spawns nothing.
    expect(lanes[0].textContent).toContain('1 can spend');
    // spendRoles filters to gym + scout ⇒ 12.50 + 4.25, NOT worker's extra 1.00.
    expect(lanes[1].textContent).toContain('$16.75');
  });

  it('shows ONE lane at a time — spend is not buried under the routine list', () => {
    renderPane();
    // Schedule lane (default): routines visible, spend rows not.
    expect(screen.getByTestId('automation-row-gym-cycle')).toBeTruthy();
    expect(screen.queryByText('1,200 turns')).toBeNull();

    H.nuqsState.blenderView = 'spend';
    cleanup();
    renderPane();

    expect(screen.getByText('1,200 turns')).toBeTruthy();
    expect(screen.queryByTestId('automation-row-gym-cycle')).toBeNull();
  });

  it('switches lane through the URL param, not local state (agent-driveable)', () => {
    renderPane();
    fireEvent.click(screen.getByTestId('automation-lane-spend'));
    expect(H.nuqsSetters['blenderView']).toHaveBeenCalledWith('spend');
  });

  it('lists only this pane’s categories, spending routines first', () => {
    renderPane();
    const names = screen
      .getAllByTestId(/^automation-row-/)
      .map((el) => el.getAttribute('data-testid'));
    expect(names).toEqual([
      'automation-row-blueprint-singleton',
      'automation-row-gym-cycle',
      'automation-row-tidy-cache',
    ].sort() === names ? names : ['automation-row-gym-cycle', 'automation-row-blueprint-singleton', 'automation-row-tidy-cache']);
    expect(names).not.toContain('automation-row-doc-sweep');
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
