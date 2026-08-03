// @vitest-environment jsdom
//
// HarnessesDock — the /adv/harnesses dockview shell. Mostly an effect-only
// mount around <HarnessDock>, but it owns the slug→layoutName mapping
// (`adv-harnesses3:<slug>` vs the bare name) and registers its panel set on
// mount. We stub HarnessDock + the dock-actions wiring + every heavy panel
// child so the assertions land on the layout-name threading and the
// register-on-mount side effect (no dockview boot).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
const registerSpy = vi.fn();
vi.mock('../../harness/dock/HarnessDock', () => ({
  HarnessDock: ({ layoutName }: { layoutName: string }) => (
    <div data-testid="harness-dock" data-layout={layoutName} />
  ),
}));
vi.mock('../../harness/dock/panel-registry', () => ({
  panelRegistry: { register: (...args: unknown[]) => registerSpy(...args) },
}));
// onDockApiBind returns an unbind fn; the effects call it but we never fire an
// api, so the slug-rebind / chat-drain bodies stay no-ops.
vi.mock('../../harness/dock/dock-actions', () => ({
  focusPanel: vi.fn(),
  listPanels: vi.fn(() => []),
  onDockApiBind: vi.fn(() => () => {}),
  openPanel: vi.fn(() => 'p1'),
  setPanelParams: vi.fn(),
  setPanelTitle: vi.fn(),
}));
// Heavy panel children referenced by the registration block — tiny markers.
vi.mock('./WorkItemsPanel', () => ({ default: () => null }));
vi.mock('./DetailPanel', () => ({ default: () => null }));
vi.mock('./AdvChatPanel', () => ({ default: () => null }));
vi.mock('./AdvAgentsPanel', () => ({ default: () => null }));
vi.mock('./MemberWorkPanel', () => ({ default: () => null }));
vi.mock('./AdvLogsPanel', () => ({ default: () => null }));
vi.mock('./AdvInsightsPanel', () => ({ default: () => null }));
vi.mock('./AdvContributorsPanel', () => ({ default: () => null }));

import HarnessesDock from './HarnessesDock';

// NOTE: `ensureRegistered` guards on a module-level `registered` boolean — the
// panel set is registered exactly once for the whole file (the first mount). So
// the registration assertion reads the spy WITHOUT a per-test clear, and runs
// first to capture that one-time call.
afterEach(cleanup);

describe('HarnessesDock', () => {
  it('registers its panel set on first mount (work-items, detail, chat, …)', () => {
    render(<HarnessesDock slug="sheets" />);
    const types = registerSpy.mock.calls.map((c) => c[0]);
    expect(types).toContain('adv:work-items');
    expect(types).toContain('adv:detail');
    expect(types).toContain('adv:chat');
  });

  it('mounts HarnessDock with the slug-keyed layout name', () => {
    render(<HarnessesDock slug="sheets" />);
    expect(screen.getByTestId('harness-dock').getAttribute('data-layout')).toBe('adv-harnesses3:sheets');
  });

  it('uses the bare layout name when slug is empty', () => {
    render(<HarnessesDock slug="" />);
    expect(screen.getByTestId('harness-dock').getAttribute('data-layout')).toBe('adv-harnesses3');
  });

  // dependency-health-pane-2026-08-02 P-011 (D-003 req 3: "like other tabs this
  // should also have a pot selector to filter").
  //
  // The graph pane needs NO pot selector of its own, and this test is what makes
  // that claim safe to rely on. The Work tab already carries the shared AdvPotBar
  // ('harnesses' ∈ POT_BAR_TAB_IDS, guarded in operator-vite's AdvPotBar.test),
  // which writes `?slug=`; HarnessesWorkspace reads it and hands it here; and this
  // dock REBINDS every panel's `harnessSlug` param whenever the slug changes
  // (`patch()` above, applied to listPanels() and to onDidAddPanel).
  //
  // That inheritance is the whole mechanism, and it is load-bearing but invisible:
  // it holds only while the graph pane is a REGISTERED DOCK PANEL. If it were ever
  // mounted outside the registry, it would silently keep rendering the previous
  // pot's graph on every pot switch — no error, just quietly wrong data. Pinning
  // registration here is what turns "satisfied by reuse" into something a future
  // change cannot break unnoticed.
  it('registers the dependency-graph pane, so it inherits the pot bar’s slug rebinding', () => {
    render(<HarnessesDock slug="sheets" />);
    const types = registerSpy.mock.calls.map((c) => c[0]);
    expect(types).toContain('adv:dep-graph');
  });
});
