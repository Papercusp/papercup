/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { RealIssuesPanel } from './RealIssuesPanel';
import { bindDockApi } from './dock-actions';

function mockApi() {
  return { setParams: vi.fn(), setTitle: vi.fn(), close: vi.fn() };
}

function mockDockviewApi() {
  return {
    addPanel: vi.fn((opts: { id: string }) => ({ id: opts.id, api: { setActive: vi.fn() } })),
    getPanel: vi.fn((id: string) => ({ id, api: { setActive: vi.fn() } })),
    removePanel: vi.fn(),
    panels: [],
    activeGroup: null,
    toJSON: vi.fn(),
  } as unknown as Parameters<typeof bindDockApi>[0];
}

const FIXTURE = {
  issues: [
    { id: 'I-0001', title: 'Open one', severity: 'major', status: 'open' },
    { id: 'I-0002', title: 'Triaged one', severity: 'minor', status: 'triaged' },
    { id: 'I-0003', title: 'Fixed one', severity: 'critical', status: 'fixed' },
  ],
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

describe('RealIssuesPanel', () => {
  it('renders the open-filter default and lists open issues', async () => {
    const api = mockApi();
    render(
      <RealIssuesPanel
        panelId="p1"
        panelType="data:issues"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('Open one'));
    // Default filter is "open" — only "Open one" is visible.
    expect(screen.getByText('Open one')).toBeTruthy();
    expect(screen.queryByText('Triaged one')).toBeNull();
    expect(screen.queryByText('Fixed one')).toBeNull();
  });

  it('switching filter to "all" shows all issues', async () => {
    const api = mockApi();
    render(
      <RealIssuesPanel
        panelId="p1"
        panelType="data:issues"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('Open one'));
    fireEvent.click(screen.getByText(/all \(3\)/i));
    expect(screen.getByText('Triaged one')).toBeTruthy();
    expect(screen.getByText('Fixed one')).toBeTruthy();
  });

  it('right-click on a row opens pin:issue', async () => {
    const api = mockApi();
    const dvApi = mockDockviewApi();
    bindDockApi(dvApi);
    render(
      <RealIssuesPanel
        panelId="p1"
        panelType="data:issues"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('Open one'));
    const row = screen.getByText('Open one').closest('li')!;
    fireEvent.contextMenu(row);
    const calls = (dvApi as unknown as { addPanel: { mock: { calls: Array<[Record<string, unknown>]> } } })
      .addPanel.mock.calls;
    expect(calls.length).toBe(1);
    const opts = calls[0][0];
    expect(opts.component).toBe('pin:issue');
    expect((opts.params as Record<string, unknown>).issueId).toBe('I-0001');
  });

  it('Cmd-click on a row also opens pin:issue', async () => {
    const api = mockApi();
    const dvApi = mockDockviewApi();
    bindDockApi(dvApi);
    render(
      <RealIssuesPanel
        panelId="p1"
        panelType="data:issues"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('Open one'));
    // Switch to "all" to see all rows
    fireEvent.click(screen.getByText(/all \(3\)/i));
    fireEvent.click(screen.getByText('Triaged one').closest('li')!, { metaKey: true });
    const calls = (dvApi as unknown as { addPanel: { mock: { calls: Array<[Record<string, unknown>]> } } })
      .addPanel.mock.calls;
    expect(calls.length).toBe(1);
    expect((calls[0][0].params as Record<string, unknown>).issueId).toBe('I-0002');
  });

  it('plain click does NOT open', async () => {
    const api = mockApi();
    const dvApi = mockDockviewApi();
    bindDockApi(dvApi);
    render(
      <RealIssuesPanel
        panelId="p1"
        panelType="data:issues"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('Open one'));
    fireEvent.click(screen.getByText('Open one').closest('li')!);
    const calls = (dvApi as unknown as { addPanel: { mock: { calls: unknown[][] } } }).addPanel.mock.calls;
    expect(calls.length).toBe(0);
  });

  it('updates panel title with slug + count', async () => {
    const api = mockApi();
    render(
      <RealIssuesPanel
        panelId="p1"
        panelType="data:issues"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => expect(api.setTitle).toHaveBeenCalledWith('Issues: sheets (3)'));
  });
});
