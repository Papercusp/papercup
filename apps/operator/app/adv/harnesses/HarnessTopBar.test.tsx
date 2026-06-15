// @vitest-environment jsdom
//
// HarnessTopBar — the /adv/harnesses stat-card + actions bar. The logic worth
// pinning is the status-counts derivation (passed/total → progress %, active-
// lane filter) and the gated rendering (loading until /status lands; the cost
// card only when missionCostUsd > 0). The heavy children (StatCard, HealthBadge,
// AddPanelCatalog, the workspaces button, the register-subs POST) are stubbed —
// they aren't the thing under test — and /status + /lanes are served by a
// stubbed fetch. Sync push-triggers are mocked to a static (no-op) query.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: null, loading: false, error: null, fetching: false, transport: 'sse' as const, invalidate: () => {} }),
}));

// StatCard → a marker echoing its label + value so the derivation is assertable.
vi.mock('@papercusp/ui-primitives', () => ({
  StatCard: ({ label, value }: { label: string; value: string }) => (
    <span data-testid={`stat-${label}`}>{value}</span>
  ),
}));
vi.mock('../../harness/HealthBadge', () => ({ default: () => <span data-testid="health" /> }));
vi.mock('../../harness/dock/AddPanelCatalog', () => ({ AddPanelCatalog: () => <span data-testid="add-panel" /> }));
vi.mock('./HarnessWorkspacesButton', () => ({ default: () => <span data-testid="ws-button" /> }));
vi.mock('../../harness/dock/dock-actions', () => ({ resetLayout: vi.fn() }));
vi.mock('../../harness/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import HarnessTopBar from './HarnessTopBar';

const STATUS = { iteration: 12, alive: true, counts: { passed: 3, pending: 1 }, missionCostUsd: 2.5 };
const LANES = { lanes: [{ featureId: 'F-1', elapsedSeconds: 9, alive: true }, { featureId: 'F-2', elapsedSeconds: 4, alive: false }], max: 4 };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/lanes')) return new Response(JSON.stringify(LANES), { status: 200 });
    if (String(url).includes('/status')) return new Response(JSON.stringify(STATUS), { status: 200 });
    return new Response('{}', { status: 200 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<HarnessTopBar />', () => {
  it('shows the loading placeholder until /status lands', () => {
    render(<HarnessTopBar slug="h" />);
    expect(screen.getByText(/loading…/i)).toBeTruthy();
  });

  it('renders the stat cards with the derived pulse / lanes / passed / cost values', async () => {
    render(<HarnessTopBar slug="h" />);
    await waitFor(() => expect(screen.getByTestId('stat-pulse')).toBeTruthy());
    expect(screen.getByTestId('stat-pulse').textContent).toBe('#12');
    // 1 of 2 lanes is alive; max=4 → "1/4"
    expect(screen.getByTestId('stat-Lanes').textContent).toBe('1/4');
    // passed=3, total = passed+pending = 4 → "3/4"
    expect(screen.getByTestId('stat-passed').textContent).toBe('3/4');
    // cost card present because missionCostUsd > 0
    expect(screen.getByTestId('stat-$ spent').textContent).toBe('2.50');
    // health badge + actions render for a slug
    expect(screen.getByTestId('health')).toBeTruthy();
    expect(screen.getByTestId('add-panel')).toBeTruthy();
  });

  it('omits the cost card when missionCostUsd is 0', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (String(url).includes('/lanes')) return new Response(JSON.stringify(LANES), { status: 200 });
      if (String(url).includes('/status')) return new Response(JSON.stringify({ ...STATUS, missionCostUsd: 0 }), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    render(<HarnessTopBar slug="h" />);
    await waitFor(() => expect(screen.getByTestId('stat-pulse')).toBeTruthy());
    expect(screen.queryByTestId('stat-$ spent')).toBeNull();
  });
});
