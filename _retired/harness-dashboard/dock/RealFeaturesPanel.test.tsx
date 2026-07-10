/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { RealFeaturesPanel } from './RealFeaturesPanel';
import { bindDockApi } from './dock-actions';

function mockApi() {
  return {
    setParams: vi.fn(),
    setTitle: vi.fn(),
    close: vi.fn(),
  };
}

function mockDockviewApi() {
  return {
    addPanel: vi.fn((opts: { id: string; component: string }) => ({
      id: opts.id,
      api: { setActive: vi.fn() },
    })),
    getPanel: vi.fn((id: string) => ({ id, api: { setActive: vi.fn() } })),
    removePanel: vi.fn(),
    panels: [],
    activeGroup: null,
    toJSON: vi.fn(),
  } as unknown as Parameters<typeof bindDockApi>[0];
}

const FIXTURE = {
  features: [
    { id: 'F-001', title: 'First feature', status: 'passed', summary: 'Test summary' },
    { id: 'F-002', title: 'Second feature', status: 'todo' },
    { id: 'F-003', title: 'Failing one', status: 'failing', needs_human_review: true },
  ],
  counts: { passed: 1, todo: 1, failing: 1 },
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  bindDockApi(mockDockviewApi());
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(FIXTURE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  bindDockApi(null);
});

describe('RealFeaturesPanel', () => {
  it('shows "no slug" placeholder when params.harnessSlug is missing', () => {
    const api = mockApi();
    render(
      <RealFeaturesPanel
        panelId="p1"
        panelType="data:features"
        params={{}}
        api={api}
      />,
    );
    expect(screen.getByText(/No harness slug in params/i)).toBeTruthy();
  });

  it('shows loading then renders features', async () => {
    const api = mockApi();
    render(
      <RealFeaturesPanel
        panelId="p1"
        panelType="data:features"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    expect(screen.getByText(/Loading sheets/i)).toBeTruthy();
    await waitFor(() => expect(screen.getByText('First feature')).toBeTruthy());
    expect(screen.getByText('Second feature')).toBeTruthy();
    expect(screen.getByText('Failing one')).toBeTruthy();
  });

  it('renders all status filter chips with counts', async () => {
    const api = mockApi();
    render(
      <RealFeaturesPanel
        panelId="p1"
        panelType="data:features"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('First feature'));
    expect(screen.getByText(/all \(3\)/i)).toBeTruthy();
    expect(screen.getByText(/passed \(1\)/i)).toBeTruthy();
    expect(screen.getByText(/todo \(1\)/i)).toBeTruthy();
    expect(screen.getByText(/failing \(1\)/i)).toBeTruthy();
  });

  it('clicking a status filter filters the list', async () => {
    const api = mockApi();
    render(
      <RealFeaturesPanel
        panelId="p1"
        panelType="data:features"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('First feature'));
    fireEvent.click(screen.getByText(/passed \(1\)/i));
    expect(screen.getByText('First feature')).toBeTruthy();
    expect(screen.queryByText('Second feature')).toBeNull();
    expect(screen.queryByText('Failing one')).toBeNull();
  });

  it('updates panel title with slug + count', async () => {
    const api = mockApi();
    render(
      <RealFeaturesPanel
        panelId="p1"
        panelType="data:features"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => expect(api.setTitle).toHaveBeenCalledWith('Features: sheets (3)'));
  });

  it('right-click on a row opens a pinned panel', async () => {
    const api = mockApi();
    const dvApi = mockDockviewApi();
    bindDockApi(dvApi);
    render(
      <RealFeaturesPanel
        panelId="p1"
        panelType="data:features"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('First feature'));
    const row = screen.getByText('First feature').closest('li')!;
    fireEvent.contextMenu(row);
    const calls = (dvApi as unknown as { addPanel: { mock: { calls: Array<[Record<string, unknown>]> } } })
      .addPanel.mock.calls;
    expect(calls.length).toBe(1);
    const opts = calls[0][0];
    expect(opts.component).toBe('pin:feature');
    expect((opts.params as Record<string, unknown>).featureId).toBe('F-001');
    expect((opts.params as Record<string, unknown>).harnessSlug).toBe('sheets');
  });

  it('Cmd-click on a row opens a pinned panel', async () => {
    const api = mockApi();
    const dvApi = mockDockviewApi();
    bindDockApi(dvApi);
    render(
      <RealFeaturesPanel
        panelId="p1"
        panelType="data:features"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('Second feature'));
    const row = screen.getByText('Second feature').closest('li')!;
    fireEvent.click(row, { metaKey: true });
    const calls = (dvApi as unknown as { addPanel: { mock: { calls: Array<[Record<string, unknown>]> } } })
      .addPanel.mock.calls;
    expect(calls.length).toBe(1);
    expect((calls[0][0].params as Record<string, unknown>).featureId).toBe('F-002');
  });

  it('plain click on a row does NOT open a pinned panel', async () => {
    const api = mockApi();
    const dvApi = mockDockviewApi();
    bindDockApi(dvApi);
    render(
      <RealFeaturesPanel
        panelId="p1"
        panelType="data:features"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('First feature'));
    fireEvent.click(screen.getByText('First feature').closest('li')!);
    const calls = (dvApi as unknown as { addPanel: { mock: { calls: unknown[][] } } }).addPanel.mock.calls;
    expect(calls.length).toBe(0);
  });

  it('shows error UI when fetch fails', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500 }),
    ) as typeof fetch;
    const api = mockApi();
    render(
      <RealFeaturesPanel
        panelId="p1"
        panelType="data:features"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Failed: status 500/i)).toBeTruthy());
  });

  it('shows REVIEW badge on rows needing human review', async () => {
    const api = mockApi();
    render(
      <RealFeaturesPanel
        panelId="p1"
        panelType="data:features"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('Failing one'));
    expect(screen.getByText('review')).toBeTruthy();
  });
});
