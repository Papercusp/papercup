// @vitest-environment jsdom
//
// AdvGitDock — the /adv Git dockview shell (git-graph + PRs only). Effect-only
// mount around <HarnessDock>; the assertable surface is the slug→layoutName
// mapping (`adv-git2:<slug>`), the slug threaded to HarnessDock, and the
// two-panel registration on mount. HarnessDock + dock-actions + the two panel
// children are stubbed so nothing boots dockview.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
const registerSpy = vi.fn();
vi.mock('../../harness/dock/HarnessDock', () => ({
  HarnessDock: ({ layoutName, slug }: { layoutName: string; slug?: string }) => (
    <div data-testid="harness-dock" data-layout={layoutName} data-slug={slug ?? ''} />
  ),
}));
vi.mock('../../harness/dock/panel-registry', () => ({
  panelRegistry: { register: (...args: unknown[]) => registerSpy(...args) },
}));
vi.mock('../../harness/dock/dock-actions', () => ({
  closePanel: vi.fn(),
  listPanels: vi.fn(() => []),
  onDockApiBind: vi.fn(() => () => {}),
  openPanel: vi.fn(() => 'p1'),
  setPanelParams: vi.fn(),
}));
vi.mock('./AdvGitGraphPanel', () => ({ default: () => null }));
vi.mock('./AdvPrsPanel', () => ({ default: () => null }));

import AdvGitDock from './AdvGitDock';

afterEach(cleanup);

describe('AdvGitDock', () => {
  it('registers exactly the git-graph + PRs panels on first mount', () => {
    render(<AdvGitDock slug="sheets" />);
    const types = registerSpy.mock.calls.map((c) => c[0]);
    expect(types).toContain('adv:git-graph');
    expect(types).toContain('adv:prs');
  });

  it('mounts HarnessDock with the slug-keyed git layout name + slug', () => {
    render(<AdvGitDock slug="sheets" />);
    const dock = screen.getByTestId('harness-dock');
    expect(dock.getAttribute('data-layout')).toBe('adv-git2:sheets');
    expect(dock.getAttribute('data-slug')).toBe('sheets');
  });

  it('uses the bare git layout name when slug is empty', () => {
    render(<AdvGitDock slug="" />);
    expect(screen.getByTestId('harness-dock').getAttribute('data-layout')).toBe('adv-git2');
  });
});
