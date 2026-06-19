// @vitest-environment jsdom
/**
 * AdvGitWorkspace.test.tsx — the /adv Git dock shell's own logic: the `?slug=`
 * guard (empty → "pick a pot" empty state; present → render the AdvGitDock) and
 * the always-present add-panel catalog. AdvGitDock + AddPanelCatalog are stubbed
 * (each has its own coverage); the css import is mocked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactElement } from 'react';

vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
vi.mock('../../harness/dock/AddPanelCatalog', () => ({ AddPanelCatalog: () => <div data-testid="add-panel" /> }));
vi.mock('./AdvGitDock', () => ({ default: ({ slug }: { slug: string }) => <div data-testid="git-dock">{slug}</div> }));
vi.mock('./adv-dock.css', () => ({}));

import AdvGitWorkspace from './AdvGitWorkspace';

function renderWs(ui: ReactElement, searchParams = '') {
  return render(<NuqsTestingAdapter searchParams={searchParams}>{ui}</NuqsTestingAdapter>);
}

afterEach(cleanup);

describe('AdvGitWorkspace', () => {
  it('shows the empty state (and no dock) when no ?slug is set', () => {
    renderWs(<AdvGitWorkspace />);
    expect(screen.getByText(/Pick a .* from the selector/i)).toBeTruthy();
    expect(screen.queryByTestId('git-dock')).toBeNull();
    expect(screen.getByTestId('add-panel')).toBeTruthy();
  });

  it('renders the AdvGitDock (with the slug) when ?slug is present', () => {
    renderWs(<AdvGitWorkspace />, '?slug=my-pot');
    const dock = screen.getByTestId('git-dock');
    expect(dock).toBeTruthy();
    expect(dock.textContent).toBe('my-pot');
    expect(screen.queryByText(/Pick a .* from the selector/i)).toBeNull();
  });
});
