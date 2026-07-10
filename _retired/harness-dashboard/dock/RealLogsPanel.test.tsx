/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { RealLogsPanel } from './RealLogsPanel';

function mockApi() {
  return { setParams: vi.fn(), setTitle: vi.fn(), close: vi.fn() };
}

const FIXTURE_EVENTS = [
  { ts: '2026-05-10T12:00:00Z', source: 'plugin:foo', level: 'error', msg: 'oops' },
  { ts: '2026-05-10T12:00:01Z', source: 'plugin:foo', level: 'warn', msg: 'careful' },
  { ts: '2026-05-10T12:00:02Z', source: 'plugin:bar', level: 'info', msg: 'all good' },
  { ts: '2026-05-10T12:00:03Z', source: 'system', level: 'info', msg: 'tick' },
];

/**
 * Minimal fake EventSource. The panel subscribes via @papercusp/sse's
 * createResilientEventSource, which wires handlers with addEventListener —
 * an EventTarget subclass that records instances is all the seam we need.
 */
class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  url: string;
  readyState = 0; // CONNECTING
  withCredentials = false;
  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.readyState = 2; // CLOSED
  }
}

function lastSource(): FakeEventSource {
  const es = FakeEventSource.instances.at(-1);
  if (!es) throw new Error('no EventSource constructed');
  return es;
}

/** Connect + replay the fixture backfill on the latest stream instance. */
function streamFixture() {
  const es = lastSource();
  act(() => {
    es.readyState = 1;
    es.dispatchEvent(new Event('open'));
    for (const e of FIXTURE_EVENTS) {
      es.dispatchEvent(new MessageEvent('log', { data: JSON.stringify(e) }));
    }
    // backfill-done flushes the pending batch synchronously.
    es.dispatchEvent(new MessageEvent('backfill-done', { data: String(FIXTURE_EVENTS.length) }));
  });
}

const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
});

afterEach(() => {
  cleanup();
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
});

describe('RealLogsPanel', () => {
  it('renders log entries streamed over SSE with default all-level filter', async () => {
    const api = mockApi();
    render(
      <RealLogsPanel
        panelId="p1"
        panelType="data:logs"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    streamFixture();
    await waitFor(() => screen.getByText('oops'));
    expect(screen.getByText('careful')).toBeTruthy();
    expect(screen.getByText('all good')).toBeTruthy();
    expect(screen.getByText('tick')).toBeTruthy();
    expect(lastSource().url).toContain('/api/harness/sheets/log/stream');
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
    streamFixture();
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
    streamFixture();
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
    streamFixture();
    await waitFor(() => expect(api.setTitle).toHaveBeenCalledWith('Logs: sheets (4)'));
  });

  it('appends live events after the backfill', async () => {
    const api = mockApi();
    render(
      <RealLogsPanel
        panelId="p1"
        panelType="data:logs"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    streamFixture();
    await waitFor(() => screen.getByText('tick'));
    const es = lastSource();
    act(() => {
      es.dispatchEvent(
        new MessageEvent('log', {
          data: JSON.stringify({ ts: '2026-05-10T12:00:04Z', source: 'system', level: 'warn', msg: 'late arrival' }),
        }),
      );
    });
    // Live (non-backfill) events flush on the 100ms coalescing window.
    await waitFor(() => screen.getByText('late arrival'));
  });

  it('shows error UI when the stream fails before any event', async () => {
    const api = mockApi();
    render(
      <RealLogsPanel
        panelId="p1"
        panelType="data:logs"
        params={{ harnessSlug: 'sheets' }}
        api={api}
      />,
    );
    const es = lastSource();
    act(() => {
      es.readyState = 2; // CLOSED — the resilient client flips to failing
      es.dispatchEvent(new Event('error'));
    });
    await waitFor(() => expect(screen.getByText(/log stream disconnected/i)).toBeTruthy());
  });
});
