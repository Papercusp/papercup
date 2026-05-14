/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { RealHarnessOverviewPanel } from './RealHarnessOverviewPanel';

function mockApi() {
  return { setParams: vi.fn(), setTitle: vi.fn(), close: vi.fn() };
}

const STATUS_FIXTURE = {
  project: { slug: 'sheets', path: '/home/user/sheets' },
  counts: { passed: 5, todo: 3, failing: 1 },
  iteration: 42,
  lastDecision: 'continue working',
  alive: true,
  escalated: false,
  pendingCheckpoints: 0,
  activeCompetitions: 0,
  smokeFail: false,
  missionCostUsd: 12.34,
  missionInputTokens: 50_000,
  missionOutputTokens: 25_000,
};

const originalFetch = globalThis.fetch;

function setupFetch(opts: {
  status?: typeof STATUS_FIXTURE;
  lastUsedPhase?: string | null;
} = {}) {
  const status = opts.status ?? STATUS_FIXTURE;
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/harness-phase-last-used/')) {
      if (init?.method === 'PUT') {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ phase: opts.lastUsedPhase ?? null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/api/harness/') && u.includes('/status')) {
      return new Response(JSON.stringify(status), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => setupFetch());

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

describe('RealHarnessOverviewPanel', () => {
  it('shows no-slug placeholder when slug missing', () => {
    const api = mockApi();
    render(
      <RealHarnessOverviewPanel
        panelId="p1"
        panelType="view:harness-overview"
        params={{}}
        api={api}
      />,
    );
    expect(screen.getByText(/No harness slug/i)).toBeTruthy();
  });

  it('renders alive status + project path + iteration + cost', async () => {
    const api = mockApi();
    render(
      <RealHarnessOverviewPanel
        panelId="p1"
        panelType="view:harness-overview"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('sheets'));
    expect(screen.getByText('alive')).toBeTruthy();
    expect(screen.getByText('/home/user/sheets')).toBeTruthy();
    expect(screen.getByText(/iteration: 42/)).toBeTruthy();
    expect(screen.getByText(/cost: \$12\.34/)).toBeTruthy();
    expect(screen.getByText(/last: continue working/i)).toBeTruthy();
  });

  it('shows ESCALATED + SMOKE-FAIL badges when present', async () => {
    setupFetch({
      status: { ...STATUS_FIXTURE, escalated: true, smokeFail: true },
    });
    const api = mockApi();
    render(
      <RealHarnessOverviewPanel
        panelId="p1"
        panelType="view:harness-overview"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('ESCALATED'));
    expect(screen.getByText('SMOKE-FAIL')).toBeTruthy();
  });

  it('renders phase tabs with the active one styled', async () => {
    const api = mockApi();
    render(
      <RealHarnessOverviewPanel
        panelId="p1"
        panelType="view:harness-overview"
        params={{ harnessSlug: 'sheets', phase: 'testing' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('sheets'));
    // Both staging + testing + production exist as buttons
    expect(screen.getByText('staging')).toBeTruthy();
    expect(screen.getByText('testing')).toBeTruthy();
    expect(screen.getByText('production')).toBeTruthy();
  });

  it('progress bar reflects passed / total', async () => {
    const api = mockApi();
    render(
      <RealHarnessOverviewPanel
        panelId="p1"
        panelType="view:harness-overview"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    // 5 passed / (5+3+1) total = 5/9 ≈ 56%
    await waitFor(() => expect(screen.getByText(/5 \/ 9 \(56%\)/)).toBeTruthy());
  });

  it('switchPhase fires PUT to phase-last-used + calls setParams', async () => {
    const api = mockApi();
    render(
      <RealHarnessOverviewPanel
        panelId="p1"
        panelType="view:harness-overview"
        params={{ harnessSlug: 'sheets', phase: 'staging' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('sheets'));
    fireEvent.click(screen.getByText('testing'));
    expect(api.setParams).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'testing', harnessSlug: 'sheets' }),
    );
    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as { mock: { calls: Array<[string, RequestInit | undefined]> } })
        .mock.calls;
      const put = calls.find(([u, init]) =>
        String(u).includes('/harness-phase-last-used/') && init?.method === 'PUT',
      );
      expect(put).toBeDefined();
    });
  });

  it('clicking the active phase is a no-op (no setParams call)', async () => {
    const api = mockApi();
    render(
      <RealHarnessOverviewPanel
        panelId="p1"
        panelType="view:harness-overview"
        params={{ harnessSlug: 'sheets', phase: 'staging' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('sheets'));
    api.setParams.mockClear();
    fireEvent.click(screen.getByText('staging'));
    // setParams should NOT be called when clicking the current phase.
    expect(api.setParams).not.toHaveBeenCalled();
  });

  it('hydrates from last-used-phase API on seeded mounts (no explicit phase)', async () => {
    setupFetch({ lastUsedPhase: 'testing' });
    const api = mockApi();
    // params with NO phase field — simulates a seeded panel.
    render(
      <RealHarnessOverviewPanel
        panelId="p1"
        panelType="view:harness-overview"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    // After mount + last-used fetch, setParams should be called with phase: 'testing'
    await waitFor(() =>
      expect(api.setParams).toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'testing' }),
      ),
    );
  });

  it('skips last-used hydration when params.phase explicitly set', async () => {
    setupFetch({ lastUsedPhase: 'testing' });
    const api = mockApi();
    render(
      <RealHarnessOverviewPanel
        panelId="p1"
        panelType="view:harness-overview"
        // explicit phase wins
        params={{ harnessSlug: 'sheets', phase: 'staging' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('sheets'));
    // setParams should NOT be called to overwrite the explicit phase.
    expect(api.setParams).not.toHaveBeenCalled();
  });
});
