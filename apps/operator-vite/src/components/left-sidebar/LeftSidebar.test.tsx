// @vitest-environment jsdom
/**
 * LeftSidebar shell coverage (left-sidebar-tauri-2026-06-07) — the docked,
 * collapsible Colony rail. Mirrors the DevAdminRail shell test: the 5 lazy tab
 * panels are stubbed so this covers the SHELL — the collapsed icon rail vs the
 * expanded shell, open/collapse + tab switching writing ?lsb/?lst atomically (one
 * setRail), the OVERWATCH flag gating its tab (and snapping a stale ?lst=overwatch
 * back to Mug), Mug as the default tab, the body-reservation side effect, and
 * the chromeless-route null-out. nuqs runs via the real testing adapter so the
 * atomic useQueryStates write is exercised end-to-end.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

const H = vi.hoisted(() => ({ overwatchOn: false, pathname: '/adv' }));

vi.mock('@papercusp/flags/client', () => ({ useFlag: () => H.overwatchOn }));
vi.mock('@/lib/router-compat/navigation', () => ({ usePathname: () => H.pathname }));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
vi.mock('@papercusp/operator-core/lib/browser-workspace', () => ({
  wsLocalKey: (k: string) => `test:${k}`,
}));
// Stub the lazy tab panels with trivial markers — their own surfaces are tested
// separately (MugTab / OverwatchTab / PotsTab).
vi.mock('./AccountsTab', () => ({ default: () => <div data-testid="panel-accounts" /> }));
vi.mock('./MugTab', () => ({ default: () => <div data-testid="panel-queen" /> }));
vi.mock('./OverwatchTab', () => ({ default: () => <div data-testid="panel-overwatch" /> }));
vi.mock('./PotsTab', () => ({ default: () => <div data-testid="panel-hives" /> }));
vi.mock('./BlenderTab', () => ({ default: () => <div data-testid="panel-blender" /> }));
vi.mock('./DocsTab', () => ({ default: () => <div data-testid="panel-docs" /> }));
vi.mock('./AgentsTab', () => ({ default: () => <div data-testid="panel-agents" /> }));
// SwarmTab / VoiceTab are deliberately NOT stubbed: this rail no longer mounts
// them at all (WI-5162 — they are op-chat sidebar faces now). A stub here would
// hide a regression that re-added them. See the "moved out" test below.

import LeftSidebar from './LeftSidebar';

beforeAll(() => {
  // The vitest jsdom localStorage shim can be broken (`getItem is not a function`);
  // install a real in-memory Storage so components rendered in the tree that read
  // localStorage at render (VoiceButton's wake/ptt-hint useState init; LeftSidebar's
  // own width restore) don't crash. Mirrors AdvShell.test.tsx's pattern.
  const store = new Map<string, string>();
  const ls: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  };
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true });
});
beforeEach(() => {
  localStorage.clear();
  H.overwatchOn = false;
  H.pathname = '/adv';
  document.body.className = '';
});
afterEach(() => {
  cleanup();
  document.body.className = '';
});

function renderRail(searchParams = '') {
  const onUrlUpdate = vi.fn();
  render(<LeftSidebar />, {
    wrapper: ({ children }) => (
      <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>
        {children}
      </NuqsTestingAdapter>
    ),
  });
  const lastQuery = () =>
    onUrlUpdate.mock.calls.length
      ? onUrlUpdate.mock.calls[onUrlUpdate.mock.calls.length - 1][0].queryString
      : '';
  return { onUrlUpdate, lastQuery };
}

describe('<LeftSidebar> shell', () => {
  it('defaults to OPEN on the Mug tab (the owner-default Colony tab)', async () => {
    renderRail();
    const rail = screen.getByTestId('left-sidebar');
    expect(rail.getAttribute('data-collapsed')).toBe('false');
    expect(rail.getAttribute('data-tab')).toBe('queen');
    expect(await screen.findByTestId('panel-queen')).toBeTruthy();
  });

  // Pins the WHOLE owner-set order, not just the first pair (owner ask
  // 2026-07-25: "move the pots tab to the right of the accounts tab" + "move the
  // papercup tab to the right of the pots tab"). The previous version asserted
  // only ['Accounts', 'brain'], which would have stayed green through exactly the
  // reordering the owner asked for — a placement request needs a test that fails
  // when the placement changes, or the next refactor silently undoes it.
  //
  // Labels route through the lexicon (t('pot'), t('operator'), t('brain'),
  // t('overwatch')); the useLexicon mock above echoes the key, so they render as
  // the bare key names (restore-pot-lexicon P-005 — the classic pack shows
  // Pots / Papercup / Brain / Kettle at runtime).
  it('orders the rail Accounts · Pots · Papercup · Mug · Kettle · Blender · Docs · Agents', () => {
    renderRail();
    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
    expect(tabs.map((x) => x.textContent?.trim())).toEqual([
      'Accounts',
      'pot',
      'operator',
      'brain',
      'overwatch',
      'Blender',
      'Docs',
      'Agents',
    ]);
  });

  // The collapsed icon rail is a SECOND rendering of the same TABS array, and the
  // owner navigates by it while collapsed — so it must carry the same order.
  it('keeps the collapsed icon rail in the same order as the expanded tabs', () => {
    renderRail('?lsb=false');
    const railButtons = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="left-sidebar-rail-"]'),
    )
      .map((el) => el.getAttribute('data-testid')!.replace('left-sidebar-rail-', ''))
      // drop the expand control that sits above the tab icons
      .filter((id) => id !== 'expand');
    expect(railButtons).toEqual([
      'accounts',
      'hives',
      'sentinel',
      'queen',
      'overwatch',
      'blender',
      'docs',
      'agents',
    ]);
  });

  it('deep-links a tab from ?lst= and mounts only that panel', async () => {
    renderRail('?lst=hives');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('hives');
    expect(await screen.findByTestId('panel-hives')).toBeTruthy();
    expect(screen.queryByTestId('panel-queen')).toBeNull();
  });

  it('collapses to the icon rail on ?lsb=false and unmounts the active panel', () => {
    renderRail('?lsb=false');
    const rail = screen.getByTestId('left-sidebar');
    expect(rail.getAttribute('data-collapsed')).toBe('true');
    expect(screen.queryByTestId('panel-queen')).toBeNull();
    // The collapsed expand-rail icon buttons are present.
    expect(screen.getByTestId('left-sidebar-rail-hives')).toBeTruthy();
  });

  it('clicking a tab switches the active panel and writes ?lst', async () => {
    const { lastQuery } = renderRail();
    fireEvent.click(screen.getByTestId('left-sidebar-tab-hives'));
    await waitFor(() => expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('hives'));
    expect(await screen.findByTestId('panel-hives')).toBeTruthy();
    expect(lastQuery()).toContain('lst=hives');
  });

  it('the collapse button writes ?lsb=false', async () => {
    const { lastQuery } = renderRail();
    fireEvent.click(screen.getByLabelText('Collapse sidebar'));
    await waitFor(() => expect(lastQuery()).toContain('lsb=false'));
  });

  it('a collapsed icon-rail button expands AND selects its tab atomically (one write)', async () => {
    // ?lsb default is `true`, so the URL omits lsb=true once re-opened; assert the
    // observable rail state instead — both the expand (collapsed=false) AND the tab
    // selection (data-tab=accounts) must land from the single setRail write.
    renderRail('?lsb=false');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-collapsed')).toBe('true');
    fireEvent.click(screen.getByTestId('left-sidebar-rail-accounts'));
    await waitFor(() => {
      const rail = screen.getByTestId('left-sidebar');
      expect(rail.getAttribute('data-collapsed')).toBe('false');
      expect(rail.getAttribute('data-tab')).toBe('accounts');
    });
    expect(await screen.findByTestId('panel-accounts')).toBeTruthy();
  });

  it('the expand control is the TOPMOST collapsed-rail button and re-expands to the last pane without switching tabs (WI-4800)', async () => {
    renderRail('?lsb=false&lst=hives');
    const rail = screen.getByTestId('left-sidebar');
    expect(rail.getAttribute('data-collapsed')).toBe('true');
    expect(rail.getAttribute('data-tab')).toBe('hives');
    // The expand control is the FIRST button in the collapsed rail (topmost) —
    // the mirror of the collapse chevron, not buried under the tab icons.
    const railEl = document.querySelector('.pclsb__expand-rail');
    const firstBtn = railEl!.querySelector('button');
    expect(firstBtn?.getAttribute('aria-label')).toBe('Expand sidebar');
    expect(firstBtn?.getAttribute('data-testid')).toBe('left-sidebar-rail-expand');
    // Clicking it re-expands to the SAME (last) pane — no tab switch.
    fireEvent.click(screen.getByTestId('left-sidebar-rail-expand'));
    await waitFor(() => {
      expect(rail.getAttribute('data-collapsed')).toBe('false');
    });
    expect(rail.getAttribute('data-tab')).toBe('hives');
  });

  // WI-5162 (owner ask 2026-07-17): Fleet + Peers MOVED to the op-chat sidebar,
  // right of the 🫖 Pot Health button. They must be gone from this rail —
  // expanded tabs AND collapsed icon rail — or the owner sees them in two
  // places at once, which is exactly what the move was meant to end.
  it('no longer hosts the Fleet or Peers tabs — they moved to the op-chat sidebar (WI-5162)', () => {
    H.overwatchOn = true;
    renderRail();
    for (const gone of ['swarm', 'voice']) {
      expect(screen.queryByTestId(`left-sidebar-tab-${gone}`)).toBeNull();
      expect(screen.queryByTestId(`left-sidebar-rail-${gone}`)).toBeNull();
    }
    // The steering/settings tabs this rail kept are all still here.
    for (const kept of ['accounts', 'queen', 'overwatch', 'hives']) {
      expect(screen.getByTestId(`left-sidebar-tab-${kept}`)).toBeTruthy();
    }
  });

  // A bookmarked ?lst=swarm must not wedge the rail on a tab that no longer
  // exists: the nuqs literal parser rejects it and falls back to the default.
  it('falls back to the default tab for a stale ?lst pointing at a moved tab (WI-5162)', () => {
    renderRail('?lst=swarm');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('queen');
  });

  it('hides the Overwatch tab while the OVERWATCH flag is off', () => {
    H.overwatchOn = false;
    renderRail();
    expect(screen.queryByTestId('left-sidebar-tab-overwatch')).toBeNull();
    // Other tabs are present.
    expect(screen.getByTestId('left-sidebar-tab-queen')).toBeTruthy();
  });

  it('shows the Overwatch tab when the flag is on', () => {
    H.overwatchOn = true;
    renderRail();
    expect(screen.getByTestId('left-sidebar-tab-overwatch')).toBeTruthy();
  });

  it('snaps a stale ?lst=overwatch back to Mug while the flag is off', async () => {
    H.overwatchOn = false;
    renderRail('?lst=overwatch');
    // The guard effect rewrites lst → queen (the default, so it's omitted from the
    // URL); assert the rail lands on the Mug tab + panel.
    await waitFor(() => expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('queen'));
    expect(await screen.findByTestId('panel-queen')).toBeTruthy();
  });

  it('renders nothing on a chromeless (iframe-target) route', () => {
    H.pathname = '/pi/some-embed';
    const { container } = render(
      <NuqsTestingAdapter>
        <LeftSidebar />
      </NuqsTestingAdapter>,
    );
    expect(container.querySelector('[data-testid="left-sidebar"]')).toBeNull();
  });

  it('reserves left-side layout space (body.has-left-sidebar) when docked', async () => {
    renderRail();
    await waitFor(() => expect(document.body.classList.contains('has-left-sidebar')).toBe(true));
    expect(document.documentElement.style.getPropertyValue('--left-sidebar-w')).toBeTruthy();
  });

  // Blender + Docs (owner ask 2026-07-25) — the automation-control tabs. These
  // exist so scheduled agents that SPEND TOKENS are visible and pausable; if a
  // refactor drops them from TABS the owner silently loses that control again,
  // which is exactly the failure they were added to fix.
  it('opens the Blender tab from ?lst=blender', async () => {
    renderRail('?lst=blender');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('blender');
    expect(await screen.findByTestId('panel-blender')).toBeTruthy();
    expect(screen.queryByTestId('panel-queen')).toBeNull();
  });

  it('opens the Docs tab from ?lst=docs', async () => {
    renderRail('?lst=docs');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('docs');
    expect(await screen.findByTestId('panel-docs')).toBeTruthy();
  });

  it('places Blender and Docs immediately after the kettle/overwatch tab', () => {
    renderRail();
    const ids = Array.from(document.querySelectorAll('[role="tab"]')).map((el) =>
      el.getAttribute('data-testid'),
    );
    const kettle = ids.indexOf('left-sidebar-tab-overwatch');
    const blender = ids.indexOf('left-sidebar-tab-blender');
    const docs = ids.indexOf('left-sidebar-tab-docs');
    expect(blender).toBeGreaterThan(-1);
    expect(docs).toBe(blender + 1);
    // Overwatch is flag-gated, so only assert adjacency when it is actually rendered.
    if (kettle > -1) expect(blender).toBe(kettle + 1);
  });

});
