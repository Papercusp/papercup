// @vitest-environment jsdom
/**
 * dogfood-substrate.test.tsx — /admin/dogfood-substrate diagnostic route. Covers:
 * the health fetch → table-vs-empty branch, the blank-entry row filter, the
 * always-present summary / boot-history / claim-attempts sections, the claim
 * harness picker driving the timeline slug, the non-ok + throwing fetch paths
 * (hold-empty), and the 10s re-fetch interval. AdminShell + the 4 self-fetching
 * insights clients are stubbed.
 *
 * Seams: @tanstack/react-router (createFileRoute → Route), AdminShell + insights
 * clients stubbed, useLexicon → identity, fetch stubbed per-call (call-counted).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts }),
}));
vi.mock('../../components/admin/AdminShell', () => ({
  default: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div data-testid="admin-shell" data-title={title}>{children}</div>
  ),
}));
vi.mock('@/app/harness/insights/SubstrateSummaryCardClient', () => ({
  SubstrateSummaryCardClient: () => <div data-testid="summary-card" />,
}));
vi.mock('@/app/harness/insights/BootHistoryTableClient', () => ({
  BootHistoryTableClient: ({ limit }: { limit: number }) => <div data-testid="boot-history" data-limit={limit} />,
}));
vi.mock('@/app/harness/insights/SubstrateHealthPill', () => ({
  SubstrateHealthPill: ({ verdict }: { verdict: string }) => <span data-testid="health-pill" data-verdict={verdict} />,
}));
vi.mock('@/app/harness/insights/ClaimAttemptTimelineClient', () => ({
  ClaimAttemptTimelineClient: ({ slug, limit }: { slug: string; limit: number }) => (
    <div data-testid="claim-timeline" data-slug={slug} data-limit={limit} />
  ),
}));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

import { Route } from './dogfood-substrate';

const Comp = Route.component as () => JSX.Element;

interface Harness { workspaceId: string; harnessSlug: string; verdict: string; reasons?: string[] }
let healthBody: { harnesses?: Harness[] } | null;
let healthOk = true;
let fetchThrows = false;
let fetchCount = 0;
function stubFetch() {
  fetchCount = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    fetchCount++;
    if (fetchThrows) throw new Error('down');
    return { ok: healthOk, status: healthOk ? 200 : 500, json: async () => healthBody } as unknown as Response;
  }));
}

function renderDogfood() {
  return render(<Comp />);
}

beforeEach(() => {
  healthOk = true; fetchThrows = false;
  healthBody = { harnesses: [] };
  stubFetch();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ALPHA: Harness = { workspaceId: 'w1', harnessSlug: 'alpha', verdict: 'healthy' };
const BETA: Harness = { workspaceId: 'w2', harnessSlug: 'beta', verdict: 'degraded', reasons: ['slow'] };

describe('/admin/dogfood-substrate route', () => {
  it('renders inside AdminShell with the fixed sub-sections', async () => {
    renderDogfood();
    expect(screen.getByTestId('admin-shell').getAttribute('data-title')).toBe('Substrate diagnostic');
    expect(screen.getByTestId('summary-card')).toBeTruthy();
    expect(screen.getByTestId('dogfood-substrate-boot-history-section')).toBeTruthy();
    expect(screen.getByTestId('dogfood-substrate-claim-attempts-section')).toBeTruthy();
    expect(screen.getByTestId('boot-history').getAttribute('data-limit')).toBe('50');
    await waitFor(() => expect(fetchCount).toBeGreaterThan(0));
  });

  it('shows the empty state (no table, no picker) when no harnesses are booted', async () => {
    healthBody = { harnesses: [] };
    renderDogfood();
    await waitFor(() => expect(fetchCount).toBeGreaterThan(0));
    expect(screen.getByTestId('dogfood-substrate-empty')).toBeTruthy();
    expect(screen.queryByTestId('dogfood-substrate-table')).toBeNull();
    expect(screen.queryByTestId('claim-attempts-harness-picker')).toBeNull();
    expect(screen.getByText(/claim attempts only record under a booted substrate/i)).toBeTruthy();
  });

  it('renders a table row + health pill per booted harness', async () => {
    healthBody = { harnesses: [ALPHA, BETA] };
    renderDogfood();
    expect(await screen.findByTestId('dogfood-substrate-table')).toBeTruthy();
    expect(screen.getByTestId('dogfood-substrate-row-alpha')).toBeTruthy();
    expect(screen.getByTestId('dogfood-substrate-row-beta')).toBeTruthy();
    expect(screen.getAllByTestId('health-pill')).toHaveLength(2);
    // first harness drives the claim timeline by default
    expect(screen.getByTestId('claim-timeline').getAttribute('data-slug')).toBe('alpha');
  });

  it('filters out harnesses with a blank workspaceId or slug', async () => {
    healthBody = { harnesses: [
      { workspaceId: '', harnessSlug: 'ghost', verdict: 'healthy' },
      { workspaceId: 'w1', harnessSlug: '', verdict: 'healthy' },
      { workspaceId: 'w2', harnessSlug: 'real', verdict: 'healthy' },
    ] };
    renderDogfood();
    expect(await screen.findByTestId('dogfood-substrate-row-real')).toBeTruthy();
    expect(screen.queryByTestId('dogfood-substrate-row-ghost')).toBeNull();
    expect(screen.getAllByTestId('health-pill')).toHaveLength(1);
  });

  it('the claim-attempts picker re-points the timeline slug', async () => {
    healthBody = { harnesses: [ALPHA, BETA] };
    renderDogfood();
    await screen.findByTestId('dogfood-substrate-table');
    fireEvent.change(screen.getByTestId('claim-attempts-harness-picker'), { target: { value: 'beta' } });
    expect(screen.getByTestId('claim-timeline').getAttribute('data-slug')).toBe('beta');
  });

  it('holds the empty state when the health fetch is not ok', async () => {
    healthOk = false;
    healthBody = { harnesses: [ALPHA] };
    renderDogfood();
    await waitFor(() => expect(fetchCount).toBeGreaterThan(0));
    expect(screen.getByTestId('dogfood-substrate-empty')).toBeTruthy();
    expect(screen.queryByTestId('dogfood-substrate-table')).toBeNull();
  });

  it('holds the empty state when the health fetch throws', async () => {
    fetchThrows = true;
    renderDogfood();
    await waitFor(() => expect(fetchCount).toBeGreaterThan(0));
    expect(screen.getByTestId('dogfood-substrate-empty')).toBeTruthy();
  });

  it('re-fetches health on the 10s interval', async () => {
    vi.useFakeTimers();
    try {
      healthBody = { harnesses: [] };
      renderDogfood();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const after1 = fetchCount;
      expect(after1).toBeGreaterThan(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(fetchCount).toBeGreaterThan(after1);
    } finally {
      vi.useRealTimers();
    }
  });
});
