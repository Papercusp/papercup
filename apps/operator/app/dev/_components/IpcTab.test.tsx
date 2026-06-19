// @vitest-environment jsdom
/**
 * IpcTab.test.tsx — render-branch coverage for the /dev IPC verification tab.
 * Exercises:
 *   - transport detection (HTTP fallback when no Tauri internals present)
 *   - the dev:ipc_echo Run button driving the dispatchEndpointStream log
 *     (event / done branches → the event-log <pre>)
 *   - the live-traffic section's inspector-inactive vs active branches
 *   - the churn/summary/events view switcher + their empty states
 *   - Clear wiring to the inspector
 * dispatchEndpointStream + RichGrid + Checkbox are mocked to controllable
 * stand-ins so the assertions stay on IpcTab's own logic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactElement } from 'react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
// The async stream the Run button consumes. Default: one event then done.
let streamEvents: Array<Record<string, unknown>> = [];
vi.mock('@papercusp/operator-core/lib/transport-adapters', () => ({
  // eslint-disable-next-line require-yield
  dispatchEndpointStream: vi.fn(async function* () {
    for (const ev of streamEvents) yield ev;
  }),
}));
// RichGrid is a heavy virtualized grid → stub to a simple row list.
vi.mock('@papercusp/grid-core', () => ({
  RichGrid: ({ rows, getRowId }: { rows: Array<{ path?: string; key?: string }>; getRowId: (r: unknown) => string }) => (
    <div data-testid="grid">{rows.map((r) => <div key={getRowId(r)}>{r.path ?? r.key}</div>)}</div>
  ),
}));
// Checkbox → a plain native checkbox so fireEvent works without Radix portals.
vi.mock('@/app/harness/Checkbox', () => ({
  Checkbox: ({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) => (
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
  ),
}));

import IpcTab from './IpcTab';

function renderTab(ui: ReactElement, searchParams = ''): ReturnType<typeof render> {
  return render(<NuqsTestingAdapter searchParams={searchParams}>{ui}</NuqsTestingAdapter>);
}

/** A controllable in-memory inspector stand-in matching IpcInspectorApi. */
function fakeInspector(over: Partial<Record<string, unknown>> = {}) {
  return {
    churn: () => [] as unknown[],
    summary: () => [] as unknown[],
    events: () => [] as unknown[],
    count: () => 0,
    clear: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  streamEvents = [{ kind: 'event', name: 'echo', data: { ok: 1 } }, { kind: 'done', result: { done: true } }];
  delete (window as unknown as { __ipcInspector?: unknown }).__ipcInspector;
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { __ipcInspector?: unknown }).__ipcInspector;
});

describe('IpcTab (/dev IPC verification)', () => {
  it('detects the HTTP transport when no Tauri internals are present', async () => {
    renderTab(<IpcTab />);
    // Mount effect resolves transport → HTTP (no __TAURI_INTERNALS__).
    await waitFor(() => expect(screen.getByText('HTTP')).toBeTruthy());
    expect(screen.getByText(/Calls go through HTTP\+SSE/i)).toBeTruthy();
  });

  it('shows the inspector-inactive notice when window.__ipcInspector is absent', () => {
    renderTab(<IpcTab />);
    expect(screen.getByText(/inspector inactive/i)).toBeTruthy();
    expect(screen.getByText(/is not installed/i)).toBeTruthy();
  });

  it('Run dev:ipc_echo streams an event + done into the event log', async () => {
    renderTab(<IpcTab />);
    expect(screen.getByText(/\(no events yet\)/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Run dev:ipc_echo/i }));
    // The 'event' line then the 'done' line land in the <pre> log.
    await waitFor(() => expect(screen.getByText(/\[event\] echo:/i)).toBeTruthy());
    expect(screen.getByText(/\[done\]/i)).toBeTruthy();
  });

  it('renders the live-traffic view switcher + empty states when an inspector is active', () => {
    (window as unknown as { __ipcInspector?: unknown }).__ipcInspector = fakeInspector({ count: () => 5 });
    renderTab(<IpcTab />);
    expect(screen.getByText(/5 events recorded/i)).toBeTruthy();
    // The three view buttons exist; churn is the default with its empty state.
    expect(screen.getByRole('button', { name: 'churn' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'summary' })).toBeTruthy();
    expect(screen.getByText(/no EventSource traffic yet/i)).toBeTruthy();
  });

  it('switches to the summary view and shows its empty state', () => {
    (window as unknown as { __ipcInspector?: unknown }).__ipcInspector = fakeInspector();
    renderTab(<IpcTab />);
    fireEvent.click(screen.getByRole('button', { name: 'summary' }));
    expect(screen.getByText(/no invoke traffic yet/i)).toBeTruthy();
  });

  it('feeds populated churn rows into the grid', () => {
    (window as unknown as { __ipcInspector?: unknown }).__ipcInspector = fakeInspector({
      churn: () => [{ path: '/api/x/stream', constructions: 2, connects: 3, drops: 1, verdict: 'churning' }],
    });
    renderTab(<IpcTab />);
    expect(screen.getByTestId('grid')).toBeTruthy();
    expect(screen.getByText('/api/x/stream')).toBeTruthy();
  });

  it('Clear calls inspector.clear()', () => {
    const clear = vi.fn();
    (window as unknown as { __ipcInspector?: unknown }).__ipcInspector = fakeInspector({ clear });
    renderTab(<IpcTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(clear).toHaveBeenCalled();
  });

  it('deep-links the events view from ?ipctraffic=events', () => {
    (window as unknown as { __ipcInspector?: unknown }).__ipcInspector = fakeInspector({
      events: () => [{ id: 1, kind: 'construct', path: '/api/y' }],
    });
    renderTab(<IpcTab />, '?ipctraffic=events');
    // events view renders the recent-events <pre> with the row.
    expect(screen.getByText(/#1/)).toBeTruthy();
  });
});
