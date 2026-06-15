// @vitest-environment jsdom
//
// AdvInsightsPanel — the fetch wrapper that supplies the pure InsightsTab with
// the canonical /insights payload + overlays the real claim status onto the
// ProjectCard badge. Render-smoke over the branches: no-slug, loading, error +
// retry, and populated — plus the `withClaim` merge (claim status/claimant
// threaded into InsightsTab's project + the claim header rendered). The pure
// InsightsTab, the claim header, and the claim hook are stubbed; fetch serves
// /insights.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { claimRef } = vi.hoisted(() => ({
  claimRef: { data: null as unknown, claim: vi.fn(), claiming: false },
}));

vi.mock('./useHarnessClaimStatus', () => ({
  useHarnessClaimStatus: () => ({
    data: claimRef.data,
    claim: claimRef.claim,
    claiming: claimRef.claiming,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

// InsightsTab → echo the project's claimStatus/claimantLogin so the withClaim
// merge is observable; HarnessClaimHeader → a marker carrying its status.
vi.mock('../../harness/insights/InsightsTab', () => ({
  InsightsTab: ({ project }: { project: { name: string; claimStatus?: string; claimantLogin?: string } }) => (
    <div data-testid="insights-tab">{`${project.name}|${project.claimStatus ?? 'none'}|${project.claimantLogin ?? 'none'}`}</div>
  ),
}));
vi.mock('../../_components/HarnessClaimHeader', () => ({
  HarnessClaimHeader: ({ status, viewerCanClaim, onClaimClick }: { status: string; viewerCanClaim?: boolean; onClaimClick?: () => void }) => (
    <div data-testid="claim-header">
      {status}
      {viewerCanClaim ? (
        <button type="button" data-testid="claim-cta" onClick={onClaimClick}>
          claim
        </button>
      ) : null}
    </div>
  ),
}));

import AdvInsightsPanel from './AdvInsightsPanel';

const INSIGHTS = { project: { name: 'My Harness', githubUrl: 'https://github.com/x/y', claimStatus: 'unclaimed' } };

function mkProps(params: Record<string, unknown>) {
  return { panelId: 'p', panelType: 'adv:insights', params, api: { setParams: vi.fn(), setTitle: vi.fn(), close: vi.fn() } };
}

beforeEach(() => {
  claimRef.data = null;
  claimRef.claiming = false;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ insights: INSIGHTS }), { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<AdvInsightsPanel />', () => {
  it('renders the no-slug hint when params carry no slug', () => {
    render(<AdvInsightsPanel {...mkProps({})} />);
    expect(screen.getByText(/no harness selected/i)).toBeTruthy();
  });

  it('shows the loading state before the insights fetch resolves', () => {
    render(<AdvInsightsPanel {...mkProps({ harnessSlug: 'h' })} />);
    expect(screen.getByText(/loading insights…/i)).toBeTruthy();
  });

  it('renders the InsightsTab once the fetch lands (no claim → fallback badge stands)', async () => {
    render(<AdvInsightsPanel {...mkProps({ harnessSlug: 'h' })} />);
    await waitFor(() => expect(screen.getByTestId('insights-tab')).toBeTruthy());
    // claimRef.data is null → withClaim === data, so the fallback unclaimed badge is kept
    expect(screen.getByTestId('insights-tab').textContent).toBe('My Harness|unclaimed|none');
    expect(screen.queryByTestId('claim-header')).toBeNull();
  });

  it('overlays the real claim status onto the project badge + renders the claim header', async () => {
    claimRef.data = { status: 'claimed', claimant_login: 'avi', viewer_can_claim: false, superseded_by_href: null };
    render(<AdvInsightsPanel {...mkProps({ harnessSlug: 'h' })} />);
    await waitFor(() => expect(screen.getByTestId('insights-tab')).toBeTruthy());
    expect(screen.getByTestId('insights-tab').textContent).toBe('My Harness|claimed|avi');
    expect(screen.getByTestId('claim-header').textContent).toBe('claimed');
  });

  it('shows the error surface with a Retry button when the fetch fails', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response('nope', { status: 500 }));
    render(<AdvInsightsPanel {...mkProps({ harnessSlug: 'h' })} />);
    await waitFor(() => expect(screen.getByText(/failed to load insights/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('Retry re-fires the insights fetch and recovers to the populated view', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    // first call fails; subsequent calls succeed
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ insights: INSIGHTS }), { status: 200 }));
    render(<AdvInsightsPanel {...mkProps({ harnessSlug: 'h' })} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.getByTestId('insights-tab')).toBeTruthy());
    expect(screen.queryByText(/failed to load insights/i)).toBeNull();
  });

  it('fires the claim hook when the header CTA is clicked (viewer can claim, not claiming)', async () => {
    claimRef.data = { status: 'unclaimed', claimant_login: null, viewer_can_claim: true, superseded_by_href: null };
    render(<AdvInsightsPanel {...mkProps({ harnessSlug: 'h' })} />);
    await waitFor(() => expect(screen.getByTestId('claim-cta')).toBeTruthy());
    fireEvent.click(screen.getByTestId('claim-cta'));
    expect(claimRef.claim).toHaveBeenCalledTimes(1);
  });

  it('hides the claim CTA while a claim is in flight (viewerCanClaim gated by !claiming)', async () => {
    claimRef.data = { status: 'unclaimed', claimant_login: null, viewer_can_claim: true, superseded_by_href: null };
    claimRef.claiming = true;
    render(<AdvInsightsPanel {...mkProps({ harnessSlug: 'h' })} />);
    await waitFor(() => expect(screen.getByTestId('claim-header')).toBeTruthy());
    expect(screen.queryByTestId('claim-cta')).toBeNull();
  });
});
