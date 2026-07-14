// @vitest-environment jsdom
/**
 * QuickPanelHeaderControls — reuses the EXACT AdvShell header pills in the Quick
 * Panel popup (quick-panel-status-pills-2026-07-13). This guards the composition:
 * BOTH the "N POT running" and "N agents running" pills are rendered (a
 * regression that dropped one would silently ship a half-populated status strip).
 * The two pills are mocked to markers so this isolates the composition from their
 * own flag/sync/nuqs guards (each pill has its own render test).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('./HivesRunningPill', () => ({
  default: () => <div data-testid="hives-pill">pot running</div>,
}));
vi.mock('./AgentsRunningPill', () => ({
  default: () => <div data-testid="agents-pill">agents running</div>,
}));

import QuickPanelHeaderControls from './QuickPanelHeaderControls';

afterEach(cleanup);

describe('QuickPanelHeaderControls (quick-panel-status-pills)', () => {
  it('renders BOTH the POT-running and AGENTS-running pills — the same components as the AdvShell header', () => {
    render(<QuickPanelHeaderControls />);
    expect(screen.getByTestId('hives-pill')).toBeTruthy();
    expect(screen.getByTestId('agents-pill')).toBeTruthy();
  });
});
