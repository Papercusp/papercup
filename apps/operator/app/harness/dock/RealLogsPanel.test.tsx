/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { RealLogsPanel } from './RealLogsPanel';

function mockApi() {
  return { setParams: vi.fn(), setTitle: vi.fn(), close: vi.fn() };
}

const FIXTURE = {
  events: [
    { ts: '2026-05-10T12:00:00Z', source: 'plugin:foo', level: 'error', msg: 'oops' },
    { ts: '2026-05-10T12:00:01Z', source: 'plugin:foo', level: 'warn', msg: 'careful' },
    { ts: '2026-05-10T12:00:02Z', source: 'plugin:bar', level: 'info', msg: 'all good' },
    { ts: '2026-05-10T12:00:03Z', source: 'system', level: 'info', msg: 'tick' },
  ],
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(FIXTURE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  cleanup();
});

describe('RealLogsPanel', () => {
  it('renders log entries with default all-level filter', async () => {
    const api = mockApi();
    render(
      <RealLogsPanel
        panelId="p1"
        panelType="data:logs"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('oops'));
    expect(screen.getByText('careful')).toBeTruthy();
    expect(screen.getByText('all good')).toBeTruthy();
    expect(screen.getByText('tick')).toBeTruthy();
  });

  it('filters by level when level chip clicked', async () => {
    const api = mockApi();
    render(
      <RealLogsPanel
        panelId="p1"
        panelType="data:logs"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('oops'));
    // The "error" word appears both in the chip and in row level labels;
    // target the chip via role=button.
    const chips = screen.getAllByRole('button', { name: 'error' });
    fireEvent.click(chips[0]);
    expect(screen.getByText('oops')).toBeTruthy();
    expect(screen.queryByText('careful')).toBeNull();
    expect(screen.queryByText('all good')).toBeNull();
  });

  it('source filter input narrows the list', async () => {
    const api = mockApi();
    render(
      <RealLogsPanel
        panelId="p1"
        panelType="data:logs"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('oops'));
    const input = screen.getByPlaceholderText(/source filter/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bar' } });
    expect(screen.queryByText('oops')).toBeNull();
    expect(screen.queryByText('careful')).toBeNull();
    expect(screen.getByText('all good')).toBeTruthy();
    expect(screen.queryByText('tick')).toBeNull();
  });

  it('updates panel title with slug + count', async () => {
    const api = mockApi();
    render(
      <RealLogsPanel
        panelId="p1"
        panelType="data:logs"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => expect(api.setTitle).toHaveBeenCalledWith('Logs: sheets (4)'));
  });

  it('shows error UI on fetch fail', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as typeof fetch;
    const api = mockApi();
    render(
      <RealLogsPanel
        panelId="p1"
        panelType="data:logs"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Failed: status 500/i)).toBeTruthy());
  });
});
