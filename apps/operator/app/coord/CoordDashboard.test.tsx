// @vitest-environment jsdom
//
// CoordDashboard — the /coord coordination surface. Real render logic exercised
// here: the four URL-backed panel tabs (sessions/inbox/plans/history) and which
// panel mounts for a given ?panel value, plus the empty-state copy each panel
// shows when its polled endpoint returns nothing. A render-smoke drives a mocked
// fetch (all endpoints empty) with CoordHistory stubbed; the polling/abort
// machinery itself is an effect detail left to e2e.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';

vi.mock('./CoordHistory', () => ({ default: () => <div data-testid="coord-history">history</div> }));

function stubEmpty() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('hook-health')) return { ok: true, json: async () => ({ healthy: true, last_success_ts: null, last_error: null }) } as unknown as Response;
      if (u.includes('presence')) return { ok: true, json: async () => ({ active: [], stale: [] }) } as unknown as Response;
      if (u.includes('inbox')) return { ok: true, json: async () => ({ items: [] }) } as unknown as Response;
      if (u.includes('plans')) return { ok: true, json: async () => ({ plans: [] }) } as unknown as Response;
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch,
  );
}

beforeEach(() => stubEmpty());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderAt(searchParams: string) {
  return render(<CoordDashboard />, { wrapper: withNuqsTestingAdapter({ searchParams }) });
}

import CoordDashboard from './CoordDashboard';

describe('<CoordDashboard />', () => {
  it('renders the header and four panel tabs', () => {
    renderAt('');
    expect(screen.getByText('Coordination')).toBeTruthy();
    for (const tab of ['Sessions', 'Inbox', 'Plans', 'History']) {
      expect(screen.getByRole('button', { name: tab })).toBeTruthy();
    }
  });

  it('defaults to the Sessions panel and shows its empty state', async () => {
    renderAt('');
    await waitFor(() => expect(screen.getByText(/No active agent sessions\./i)).toBeTruthy());
  });

  it('mounts the Inbox panel for ?panel=inbox', async () => {
    renderAt('?panel=inbox');
    await waitFor(() => expect(screen.getByText(/Inbox is empty\./i)).toBeTruthy());
  });

  it('mounts the Plans panel for ?panel=plans', async () => {
    renderAt('?panel=plans');
    await waitFor(() => expect(screen.getByText(/No structured plans found\./i)).toBeTruthy());
  });

  it('mounts the (stubbed) History panel for ?panel=history', () => {
    renderAt('?panel=history');
    expect(screen.getByTestId('coord-history')).toBeTruthy();
  });

  it('switches panels on tab click', async () => {
    renderAt('');
    fireEvent.click(screen.getByRole('button', { name: 'Plans' }));
    await waitFor(() => expect(screen.getByText(/No structured plans found\./i)).toBeTruthy());
  });
});

// stubFull routes each polled endpoint to caller-supplied payloads so the
// populated branches of each panel render for real.
function stubFull(overrides: {
  presence?: unknown;
  inbox?: unknown;
  plans?: unknown;
  hookHealth?: unknown;
  planMarkdown?: (slug: string) => unknown;
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      const json = (v: unknown) => ({ ok: true, json: async () => v }) as Response;
      if (u.includes('hook-health')) return json(overrides.hookHealth ?? { healthy: true, last_success_ts: null, last_error: null });
      if (u.includes('presence')) return json(overrides.presence ?? { active: [], stale: [] });
      if (u.includes('inbox')) return json(overrides.inbox ?? { items: [] });
      if (u.match(/\/plans\/[^/]/)) {
        const slug = decodeURIComponent(u.split('/plans/')[1]);
        return json(overrides.planMarkdown ? overrides.planMarkdown(slug) : { markdown: '# plan body' });
      }
      if (u.includes('plans')) return json(overrides.plans ?? { plans: [] });
      return json({});
    }) as unknown as typeof fetch,
  );
}

describe('<CoordDashboard /> populated panels + interactions', () => {
  it('lists active and stale sessions with their intents', async () => {
    stubFull({
      presence: {
        active: [{ ownerId: 'o1', ownerLabel: 'Agent One', source: 'omp', intent: 'building X', currentPlanSlug: 'plan-x', currentFiles: ['a.ts'], host: 'h', heartbeatAt: new Date().toISOString(), stale: false }],
        stale: [{ ownerId: 'o2', ownerLabel: 'Agent Two', source: 'cc', intent: '', currentPlanSlug: null, currentFiles: [], host: 'h', heartbeatAt: new Date(Date.now() - 3_600_000).toISOString(), stale: true }],
      },
    });
    renderAt('');
    await waitFor(() => expect(screen.getByText('Agent One')).toBeTruthy());
    expect(screen.getByText('Active (1)')).toBeTruthy();
    expect(screen.getByText(/Stale \(1\)/)).toBeTruthy();
    expect(screen.getByText('building X')).toBeTruthy();
    expect(screen.getByText('plan: plan-x')).toBeTruthy();
    // An owner with no declared intent gets the placeholder.
    expect(screen.getByText('(no declared intent)')).toBeTruthy();
  });

  it('renders the session error banner when presence fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('presence')) return { ok: false, status: 500, json: async () => ({}) } as Response;
      return { ok: true, json: async () => ({ healthy: true, last_error: null, last_success_ts: null }) } as Response;
    }));
    renderAt('');
    await waitFor(() => expect(screen.getByText(/Error: status 500/)).toBeTruthy());
  });

  it('styles an escalation inbox item distinctly from a message', async () => {
    stubFull({
      inbox: { items: [
        { ts: new Date().toISOString(), msg_id: 'e1', source: 'escalation', kind: 'escalation', from: 'agent-a', summary: 'needs human' },
        { ts: new Date().toISOString(), msg_id: 'n1', source: 'message', kind: 'note', summary: 'just fyi' },
      ] },
    });
    renderAt('?panel=inbox');
    await waitFor(() => expect(screen.getByText('needs human')).toBeTruthy());
    expect(screen.getByText('just fyi')).toBeTruthy();
    expect(screen.getByText('escalation')).toBeTruthy();
    expect(screen.queryByText(/Inbox is empty/)).toBeNull();
  });

  it('expands a plan to fetch + show its markdown, and collapses on a second click', async () => {
    stubFull({
      plans: { plans: [{ slug: 'plan-x', title: 'Plan X', status: 'active', updated: '2026-01-01', now_state: 'wip', now_next: 'ship it', item_count: 3, decision_count: 1 }] },
      planMarkdown: () => ({ markdown: '## Plan X body' }),
    });
    renderAt('?panel=plans');
    const planBtn = await screen.findByText('Plan X');
    expect(screen.queryByText('## Plan X body')).toBeNull();
    fireEvent.click(planBtn);
    await waitFor(() => expect(screen.getByText('## Plan X body')).toBeTruthy());
    fireEvent.click(planBtn);
    await waitFor(() => expect(screen.queryByText('## Plan X body')).toBeNull());
  });

  it('shows the file-lock-offline banner only when a hook is unhealthy + recent', async () => {
    stubFull({
      hookHealth: {
        healthy: false,
        last_success_ts: null,
        last_error: { ts: new Date().toISOString(), handler: 'pretooluse', phase: 'connect', detail: 'ECONNREFUSED', operator_url: 'http://x' },
      },
    });
    renderAt('');
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText(/File-lock enforcement is offline/)).toBeTruthy();
    expect(screen.getByText(/operator unreachable from an agent session/)).toBeTruthy();
  });

  it('does NOT show the lock banner when the last error is stale (>5m old)', async () => {
    stubFull({
      hookHealth: {
        healthy: false,
        last_success_ts: null,
        last_error: { ts: new Date(Date.now() - 10 * 60_000).toISOString(), handler: 'pretooluse', phase: 'connect', detail: 'x', operator_url: 'http://x' },
      },
    });
    renderAt('');
    // Let the banner poll resolve, then assert it stays absent.
    await waitFor(() => expect(screen.getByText('Coordination')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
