// @vitest-environment jsdom
/**
 * QuickPanelHeaderControls — reuses the EXACT AdvShell header pills in the Quick
 * Panel popup (quick-panel-status-pills-2026-07-13). This guards the composition:
 * the "N agents running" pill is rendered (a regression that dropped it would
 * silently ship an empty status strip). The pill is mocked to a marker so this
 * isolates the composition from its own flag/sync/nuqs guards (it has its own
 * render test).
 *
 * This file used to also guard the "N POT running" pill — this was the SECOND of
 * that pill's two mounts, and the reason P-075 had to remove both: dropping only
 * the AdvShell one would have left it alive right here. The component was
 * deleted ([owner 2026-08-10] "remove the ... 'pots running' button"), so it is
 * deliberately NOT re-stubbed — a re-added import fails at resolution.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('./AgentsRunningPill', () => ({
  default: () => <div data-testid="agents-pill">agents running</div>,
}));

import QuickPanelHeaderControls from './QuickPanelHeaderControls';

afterEach(cleanup);

describe('QuickPanelHeaderControls (quick-panel-status-pills)', () => {
  it('renders the AGENTS-running pill — the same component as the AdvShell header', () => {
    render(<QuickPanelHeaderControls />);
    expect(screen.getByTestId('agents-pill')).toBeTruthy();
  });

  it('does NOT render the retired POT-running pill (P-075)', () => {
    render(<QuickPanelHeaderControls />);
    expect(screen.queryByTestId('hives-pill')).toBeNull();
  });
});
