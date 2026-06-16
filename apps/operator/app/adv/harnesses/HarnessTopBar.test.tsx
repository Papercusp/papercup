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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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
const resetLayout = vi.fn();
vi.mock('../../harness/dock/dock-actions', () => ({ resetLayout: () => resetLayout() }));
vi.mock('../../harness/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

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
  resetLayout.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
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

  it('reset-layout button invokes resetLayout()', async () => {
    render(<HarnessTopBar slug="h" />);
    await waitFor(() => expect(screen.getByTestId('stat-pulse')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /reset layout/i }));
    expect(resetLayout).toHaveBeenCalledTimes(1);
  });
});

// The Register-sub-harnesses action handler — the 70-line POST + toast branching
// that the original suite never rendered. Each branch (new / reconciled / errors /
// up-to-date / HTTP failure / network throw) is exercised through a real click so
// a destructure/await bug in the handler would surface.
describe('<HarnessTopBar /> RegisterSubsButton', () => {
  function statusServer(extra: (url: string) => Response | null) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/register-subs') && init?.method === 'POST') {
          const r = extra(u);
          if (r) return r;
        }
        if (u.includes('/lanes')) return new Response(JSON.stringify(LANES), { status: 200 });
        if (u.includes('/status')) return new Response(JSON.stringify(STATUS), { status: 200 });
        return new Response('{}', { status: 200 });
      }),
    );
  }
  async function clickRegister() {
    render(<HarnessTopBar slug="root-h" />);
    await waitFor(() => expect(screen.getByTestId('stat-pulse')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /register sub-hives/i }));
  }

  it('POSTs with the rootSlug and reports new + reconciled counts on success', async () => {
    statusServer(() =>
      new Response(
        JSON.stringify({ ok: true, discovered: 3, registered: ['a', 'b'], reconciled: ['c'], hiveReconciled: [], membership: null, errors: [] }),
        { status: 200 },
      ),
    );
    await clickRegister();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    // POST body carried the selected slug
    const post = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([u]) => String(u).includes('/register-subs'));
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({ rootSlug: 'root-h' });
    // 2 new + (1 reconciled + 0 hive) reconciled
    expect(toastSuccess.mock.calls[0][0]).toMatch(/Discovered 3 submodules — 2 new, 1 reconciled/);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('appends the hive note when membership.kind is hive_slug', async () => {
    statusServer(() =>
      new Response(
        JSON.stringify({ ok: true, discovered: 1, registered: ['a'], reconciled: [], hiveReconciled: [], membership: { kind: 'hive_slug', value: 'my-hive' }, errors: [] }),
        { status: 200 },
      ),
    );
    await clickRegister();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastSuccess.mock.calls[0][0]).toMatch(/Members of hive 'my-hive'\./);
  });

  it('reports the up-to-date case (zero new + zero reconciled) as a quiet success', async () => {
    statusServer(() =>
      new Response(JSON.stringify({ ok: true, discovered: 2, registered: [], reconciled: [], hiveReconciled: [], membership: null, errors: [] }), { status: 200 }),
    );
    await clickRegister();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastSuccess.mock.calls[0][0]).toMatch(/No new sub-hives/);
  });

  it('routes a payload with per-slug errors to toast.error', async () => {
    statusServer(() =>
      new Response(
        JSON.stringify({ ok: true, discovered: 2, registered: ['a'], reconciled: [], hiveReconciled: [], membership: null, errors: [{ slug: 'bad', error: 'boom' }] }),
        { status: 200 },
      ),
    );
    await clickRegister();
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0][0]).toMatch(/1 errors/);
  });

  it('surfaces an HTTP failure (non-ok / ok:false) via toast.error', async () => {
    statusServer(() => new Response(JSON.stringify({ ok: false, error: 'not authorized' }), { status: 403 }));
    await clickRegister();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/register-subs failed: not authorized/)));
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('surfaces a thrown fetch (network error) via toast.error', async () => {
    statusServer((u) => {
      if (u.includes('/register-subs')) throw new Error('network down');
      return null;
    });
    await clickRegister();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/register-subs failed: network down/)));
  });
});
