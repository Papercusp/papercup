/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { RealAgentsPanel } from './RealAgentsPanel';

function mockApi() {
  return { setParams: vi.fn(), setTitle: vi.fn(), close: vi.fn() };
}

const FIXTURE = {
  runs: [
    { runId: 'run-A', role: 'scoper', sizeBytes: 4096, running: true, lastEventTs: Date.now() - 30_000 },
    { runId: 'run-B', role: 'worker', sizeBytes: 32_768, running: true, lastEventTs: Date.now() - 5 * 60_000 },
    { runId: 'run-C', role: 'validator', sizeBytes: 8192, running: false, lastEventTs: Date.now() - 60 * 60_000 },
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

describe('RealAgentsPanel', () => {
  it('renders running agents by default', async () => {
    const api = mockApi();
    render(
      <RealAgentsPanel
        panelId="p1"
        panelType="data:agents"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('scoper'));
    expect(screen.getByText('scoper')).toBeTruthy();
    expect(screen.getByText('worker')).toBeTruthy();
    // validator is not running → hidden by default
    expect(screen.queryByText('validator')).toBeNull();
  });

  it('"All" toggle shows non-running agents', async () => {
    const api = mockApi();
    render(
      <RealAgentsPanel
        panelId="p1"
        panelType="data:agents"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('scoper'));
    fireEvent.click(screen.getByText(/Running only/i));
    expect(screen.getByText('validator')).toBeTruthy();
  });

  it('formats sizeBytes in KB / MB', async () => {
    const api = mockApi();
    render(
      <RealAgentsPanel
        panelId="p1"
        panelType="data:agents"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => screen.getByText('scoper'));
    expect(screen.getByText('4.0KB')).toBeTruthy();
    expect(screen.getByText('32.0KB')).toBeTruthy();
  });

  it('updates panel title with slug + count', async () => {
    const api = mockApi();
    render(
      <RealAgentsPanel
        panelId="p1"
        panelType="data:agents"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    await waitFor(() => expect(api.setTitle).toHaveBeenCalledWith('Agents: sheets (3)'));
  });

  it('shows error UI on fetch fail', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as typeof fetch;
    const api = mockApi();
    render(
      <RealAgentsPanel
        panelId="p1"
        panelType="data:agents"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    // useHarnessAgents surfaces the REST bootstrap failure as `agents <status>`.
    await waitFor(() => expect(screen.getByText(/Failed: agents 500/i)).toBeTruthy());
  });
});
