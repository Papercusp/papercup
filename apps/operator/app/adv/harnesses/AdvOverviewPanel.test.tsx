// @vitest-environment jsdom
//
// AdvOverviewPanel — the per-harness mission-control summary panel. Two halves:
//   • PURE computeStats — extracted + exported, tested branch-by-branch
//     (null counts, empty, passed/total → pct, divide-by-zero guard).
//   • A render-smoke driving the sync-backed shell: no-slug empty, the loading
//     state, and the populated state (slug/alive/badges/progress/counts/cost).
// Status reads through `useSyncQuery('harnessStatus.snapshot')` (NOT a REST
// fetch) — so we mock @papercusp/sync to drive data/loading/error, the pinned
// sibling pattern (see AdvNowRunning.test.tsx). `fetch` is still stubbed for
// the phase-last-used GET (first-mount hydration) + PUT (switchPhase persist).
// Tooltip + StatusPill are stubbed (Radix portal / theme tables aren't the
// thing under test).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../harness/primitives', () => ({
  StatusPill: ({ status }: { status: string }) => <span data-testid={`pill-${status}`}>{status}</span>,
}));

// The status snapshot arrives via sync, not REST — mock the hook and let each
// test drive the result through these module-scoped knobs. `invalidate` is a
// spy so the Refresh test can assert it fired.
let syncRows: unknown[] | undefined;
let syncError: Error | null = null;
const syncInvalidate = vi.fn();
let lastSyncOpts: { queryName?: string; args?: unknown; enabled?: boolean } | undefined;
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName: string; args?: unknown; enabled?: boolean }) => {
    lastSyncOpts = opts;
    // A disabled query (no slug/workspace) never resolves data — mirror that.
    if (opts.enabled === false) return { data: [], error: null, invalidate: syncInvalidate };
    return { data: syncRows ?? [], error: syncError, invalidate: syncInvalidate };
  },
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
  // Default: status sync delivers a populated snapshot; tests that want the
  // loading/error/variant states reassign syncRows/syncError before render.
  syncRows = [STATUS];
  syncError = null;
  syncInvalidate.mockClear();
  lastSyncOpts = undefined;
  // `fetch` now only serves the phase-last-used GET (hydration) + PUT (persist).
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/harness-phase-last-used/')) {
      return new Response(JSON.stringify({ phase: null }), { status: 200 });
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
    expect(screen.getByText(/no hive slug in params/i)).toBeTruthy();
  });

  it('shows the loading state before the status sync resolves', () => {
    syncRows = []; // sync has no rows yet → data is null → loading branch
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

  it('renders the populated summary once the status sync lands', async () => {
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
    // status is read through sync (harnessStatus.snapshot) keyed by slug+phase,
    // not an ad-hoc REST fetch
    expect(lastSyncOpts?.queryName).toBe('harnessStatus.snapshot');
    expect(lastSyncOpts?.args).toMatchObject({ harnessSlug: 'my-harness', phase: 'staging' });
  });

  it('omits the escalated/smoke badges and the checkpoint line when those flags are off/zero', async () => {
    syncRows = [
      { ...STATUS, alive: false, escalated: false, smokeFail: true, pendingCheckpoints: 0, activeCompetitions: 0, lastDecision: null },
    ];
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

  it('renders the Failed surface when the status sync errors (non-ok response)', async () => {
    syncRows = [];
    syncError = new Error('status 503');
    const { container } = render(
      <AdvOverviewPanel panelId="p" panelType="adv:overview" params={{ harnessSlug: 'my-harness', phase: 'staging' }} api={mkApi()} />,
    );
    // The banner ("Failed: " + the stringified error) is split across text
    // nodes, so match on the err-surface element's full text content.
    await waitFor(() => {
      const banner = container.querySelector('.pc-advpanel__empty--err');
      expect(banner).toBeTruthy();
      expect(banner!.textContent).toMatch(/failed:/i);
      expect(banner!.textContent).toMatch(/status 503/i);
    });
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

  it('the Refresh button invalidates the status sync query (manual refetch)', async () => {
    render(
      <AdvOverviewPanel panelId="p" panelType="adv:overview" params={{ harnessSlug: 'my-harness', phase: 'staging' }} api={mkApi()} />,
    );
    await waitFor(() => expect(screen.getByText('my-harness')).toBeTruthy());
    // Refresh re-reads through sync via invalidate(), not an ad-hoc REST fetch.
    expect(syncInvalidate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /refresh status/i }));
    expect(syncInvalidate).toHaveBeenCalled();
  });
});
