// @vitest-environment jsdom
//
// AdvOverviewPanel — the per-harness mission-control summary panel. Two halves:
//   • PURE computeStats — extracted + exported, tested branch-by-branch
//     (null counts, empty, passed/total → pct, divide-by-zero guard).
//   • A render-smoke driving the fetch-backed shell: no-slug empty, the loading
//     state, and the populated state (slug/alive/badges/progress/counts/cost).
// Tooltip + StatusPill are stubbed (Radix portal / theme tables aren't the
// thing under test); fetch is stubbed to serve the phase-last-used + status
// endpoints.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../harness/primitives', () => ({
  StatusPill: ({ status }: { status: string }) => <span data-testid={`pill-${status}`}>{status}</span>,
}));

import AdvOverviewPanel, { computeStats } from './AdvOverviewPanel';

function mkApi() {
  return { setParams: vi.fn(), setTitle: vi.fn(), close: vi.fn() };
}

const STATUS = {
  project: { slug: 'my-harness', path: '/repos/my-harness' },
  counts: { passed: 3, pending: 1 },
  iteration: 7,
  lastDecision: 'shipped F-1',
  alive: true,
  escalated: true,
  pendingCheckpoints: 2,
  activeCompetitions: 0,
  smokeFail: false,
  missionCostUsd: 1.234,
  missionInputTokens: 12_000,
  missionOutputTokens: 4_000,
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/harness-phase-last-used/')) {
      return new Response(JSON.stringify({ phase: null }), { status: 200 });
    }
    if (String(url).includes('/status')) {
      return new Response(JSON.stringify(STATUS), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('computeStats', () => {
  it('returns null when counts are missing', () => {
    expect(computeStats(null)).toBeNull();
    expect(computeStats(undefined)).toBeNull();
  });
  it('sums all buckets for total and reads the passed bucket', () => {
    expect(computeStats({ passed: 3, pending: 1, failed: 1 })).toEqual({ total: 5, passed: 3, pct: 60 });
  });
  it('defaults passed to 0 when the bucket is absent', () => {
    expect(computeStats({ pending: 4 })).toEqual({ total: 4, passed: 0, pct: 0 });
  });
  it('guards divide-by-zero with an empty counts object', () => {
    expect(computeStats({})).toEqual({ total: 0, passed: 0, pct: 0 });
  });
  it('rounds the percentage', () => {
    expect(computeStats({ passed: 1, pending: 2 }).pct).toBe(33);
  });
});

describe('<AdvOverviewPanel />', () => {
  it('renders the empty hint when no slug is in params', () => {
    render(<AdvOverviewPanel panelId="p" panelType="adv:overview" params={{}} api={mkApi()} />);
    expect(screen.getByText(/no harness slug in params/i)).toBeTruthy();
  });

  it('shows the loading state before the status fetch resolves', () => {
    render(
      <AdvOverviewPanel
        panelId="p"
        panelType="adv:overview"
        params={{ harnessSlug: 'my-harness', phase: 'staging' }}
        api={mkApi()}
      />,
    );
    expect(screen.getByText(/loading my-harness…/i)).toBeTruthy();
  });

  it('renders the populated summary once the status fetch lands', async () => {
    const api = mkApi();
    const { container } = render(
      <AdvOverviewPanel
        panelId="p"
        panelType="adv:overview"
        params={{ harnessSlug: 'my-harness', phase: 'staging' }}
        api={api}
      />,
    );
    await waitFor(() => expect(screen.getByText('my-harness')).toBeTruthy());
    // alive + escalated badges
    expect(screen.getByText('alive')).toBeTruthy();
    expect(screen.getByText('ESCALATED')).toBeTruthy();
    // progress 3/2-bucket total = 4 → 75%
    expect(container.textContent).toContain('3 / 4 (75%)');
    // per-bucket status pills (mocked)
    expect(screen.getByTestId('pill-passed')).toBeTruthy();
    expect(screen.getByTestId('pill-pending')).toBeTruthy();
    // misc: iteration, last decision, cost, checkpoints
    expect(container.textContent).toContain('iteration: 7');
    expect(container.textContent).toContain('shipped F-1');
    expect(container.textContent).toContain('$1.23');
    expect(container.textContent).toContain('checkpoints pending: 2');
    // title was synced
    expect(api.setTitle).toHaveBeenCalledWith('Overview: my-harness (staging)');
  });

  it('omits the escalated/smoke badges and the checkpoint line when those flags are off/zero', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (String(url).includes('/harness-phase-last-used/')) return new Response(JSON.stringify({ phase: null }), { status: 200 });
      if (String(url).includes('/status'))
        return new Response(
          JSON.stringify({ ...STATUS, alive: false, escalated: false, smokeFail: true, pendingCheckpoints: 0, activeCompetitions: 0, lastDecision: null }),
          { status: 200 },
        );
      return new Response('{}', { status: 200 });
    });
    const { container } = render(
      <AdvOverviewPanel panelId="p" panelType="adv:overview" params={{ harnessSlug: 'my-harness', phase: 'staging' }} api={mkApi()} />,
    );
    await waitFor(() => expect(screen.getByText('my-harness')).toBeTruthy());
    // alive=false → 'idle', no ESCALATED, but smokeFail=true → SMOKE-FAIL
    expect(screen.getByText('idle')).toBeTruthy();
    expect(screen.queryByText('ESCALATED')).toBeNull();
    expect(screen.getByText('SMOKE-FAIL')).toBeTruthy();
    // lastDecision null → no "last:" line; checkpoints 0 → no checkpoint line
    expect(container.textContent).not.toContain('last:');
    expect(container.textContent).not.toContain('checkpoints pending');
  });

  it('renders the Failed surface when the status fetch rejects (non-ok response)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (String(url).includes('/harness-phase-last-used/')) return new Response(JSON.stringify({ phase: null }), { status: 200 });
      if (String(url).includes('/status')) return new Response('nope', { status: 503 });
      return new Response('{}', { status: 200 });
    });
    render(
      <AdvOverviewPanel panelId="p" panelType="adv:overview" params={{ harnessSlug: 'my-harness', phase: 'staging' }} api={mkApi()} />,
    );
    await waitFor(() => expect(screen.getByText(/failed: status 503/i)).toBeTruthy());
  });

  it('switchPhase writes the new phase param + PUTs phase-last-used, and is a no-op on the current phase', async () => {
    const api = mkApi();
    render(
      <AdvOverviewPanel panelId="p" panelType="adv:overview" params={{ harnessSlug: 'my-harness', phase: 'staging' }} api={api} />,
    );
    await waitFor(() => expect(screen.getByText('my-harness')).toBeTruthy());

    // clicking the already-selected phase is a no-op (early return)
    fireEvent.click(screen.getByRole('tab', { name: 'staging' }));
    expect(api.setParams).not.toHaveBeenCalled();

    // clicking a different phase writes the param AND fires the persist PUT
    fireEvent.click(screen.getByRole('tab', { name: 'testing' }));
    expect(api.setParams).toHaveBeenCalledWith(expect.objectContaining({ phase: 'testing' }));
    const putCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    );
    expect(putCall).toBeTruthy();
    expect(String(putCall![0])).toContain('/harness-phase-last-used/my-harness');
    expect((putCall![1] as RequestInit).body).toBe(JSON.stringify({ phase: 'testing' }));
  });

  it('the Refresh button re-fires the status fetch (tick bump)', async () => {
    render(
      <AdvOverviewPanel panelId="p" panelType="adv:overview" params={{ harnessSlug: 'my-harness', phase: 'staging' }} api={mkApi()} />,
    );
    await waitFor(() => expect(screen.getByText('my-harness')).toBeTruthy());
    const statusCalls = () =>
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => String(u).includes('/status')).length;
    const before = statusCalls();
    fireEvent.click(screen.getByRole('button', { name: /refresh status/i }));
    await waitFor(() => expect(statusCalls()).toBeGreaterThan(before));
  });
});
