// @vitest-environment jsdom
/**
 * insights.test.tsx — /harness/$slug/insights fetch-then-render route. Fetches
 * /api/harness/:slug/insights then renders <InsightsTab>, and best-effort POSTs
 * the first-visit marker. Covers: the no-slug notFound guard, the loading
 * state, the success render (+ first-visit POST fired), a non-ok HTTP error, a
 * missing payload, and a fetch throw. InsightsTab is stubbed (own coverage).
 *
 * Seams: @tanstack/react-router (createFileRoute → Route with controllable
 * useParams; notFound → a thrown sentinel caught by a local error boundary),
 * fetch stubbed per-call (capturing method+url to assert the first-visit POST).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Component, type ReactNode } from 'react';

let paramsVal: { slug: string };
const notFoundMock = vi.fn(() => new Error('__notFound__'));
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts, useParams: () => paramsVal }),
  notFound: () => notFoundMock(),
}));
vi.mock('@/app/harness/insights/InsightsTab', () => ({
  InsightsTab: (props: { project?: { name?: string } }) => (
    <div data-testid="insights-tab">{props.project?.name ?? 'tab'}</div>
  ),
}));

import { Route } from './insights';

const Comp = Route.component as () => JSX.Element;

let fetchImpl: (url: string, init?: RequestInit) => { status?: number; ok: boolean; body: unknown };
const fetchCalls: string[] = [];
function stubFetch() {
  fetchCalls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    fetchCalls.push(`${init?.method ?? 'GET'} ${url}`);
    const r = fetchImpl(url, init);
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), json: async () => r.body } as unknown as Response;
  }));
}

class Boundary extends Component<{ children: ReactNode }, { caught: boolean }> {
  state = { caught: false };
  static getDerivedStateFromError() { return { caught: true }; }
  render() { return this.state.caught ? <div data-testid="boundary">caught</div> : this.props.children; }
}

function renderInsights(slug = 'sheets') {
  paramsVal = { slug };
  return render(<Boundary><Comp /></Boundary>);
}

beforeEach(() => {
  notFoundMock.mockClear();
  fetchImpl = () => ({ ok: true, body: { insights: { project: { name: 'Sheets' } } } });
  stubFetch();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('/harness/$slug/insights route', () => {
  it('throws notFound when the slug is empty', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderInsights('');
    await waitFor(() => expect(notFoundMock).toHaveBeenCalled());
    expect(await screen.findByTestId('boundary')).toBeTruthy();
    errSpy.mockRestore();
  });

  it('renders the loading state before data arrives', () => {
    renderInsights('sheets');
    expect(screen.getByText(/Loading insights/i)).toBeTruthy();
  });

  it('renders InsightsTab and fires the first-visit POST on success', async () => {
    fetchImpl = (url) => url.includes('insights-first-visit')
      ? { ok: true, body: {} }
      : { ok: true, body: { insights: { project: { name: 'Sheets' } } } };
    renderInsights('sheets');
    expect(await screen.findByTestId('insights-tab')).toBeTruthy();
    await waitFor(() => expect(fetchCalls).toContain('POST /api/harness/sheets/insights-first-visit'));
  });

  it('surfaces a non-ok HTTP error', async () => {
    fetchImpl = () => ({ ok: false, status: 502, body: {} });
    renderInsights('sheets');
    expect(await screen.findByText(/Could not load insights/i)).toBeTruthy();
    expect(screen.getByText(/HTTP 502/i)).toBeTruthy();
  });

  it('surfaces a missing insights payload', async () => {
    fetchImpl = () => ({ ok: true, body: {} });
    renderInsights('sheets');
    expect(await screen.findByText(/insights payload missing/i)).toBeTruthy();
  });

  it('surfaces a fetch rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    renderInsights('sheets');
    expect(await screen.findByText(/offline/i)).toBeTruthy();
  });
});
