// @vitest-environment jsdom
//
// TelemetryTab — the per-tool latency/error aggregation grid. Two pure surfaces
// are pinned: errPct (0-safe error rate %) and nextTransportParam (the
// comma-separated transport URL-filter set arithmetic). The render-level tests
// drive loading / error / populated for real, and exercise the transport
// checkboxes + clear button — asserting each writes the right nuqs `transport`
// param AND refetches with the new transports in the body, plus the per-row
// rerun button firing onRerun. That handler wiring (toggleTransport, the clear
// button, onRerun) is exactly what a pure-fn test of the set arithmetic misses.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// RichGrid mock renders the per-row rerun button so we can click it — the grid's
// `open` column wires onRerun, and we want that handler exercised end-to-end.
vi.mock('@papercusp/grid-core', () => ({
  RichGrid: ({ rows, columns }: { rows: Record<string, unknown>[]; columns: any[] }) => {
    const openCol = columns.find((c) => c.key === 'open');
    return (
      <div data-testid="grid" data-rows={rows.length}>
        {rows.map((row, i) => (
          <div key={i} data-testid="grid-row">{openCol?.render({ row })}</div>
        ))}
      </div>
    );
  },
}));

const { nuqsStore } = vi.hoisted(() => ({ nuqsStore: new Map<string, string>() }));
vi.mock('nuqs', () => {
  const React = require('react');
  return {
    parseAsString: { withDefault: (d: string) => ({ _default: d }) },
    parseAsStringEnum: () => ({ withDefault: (d: string) => ({ _default: d }) }),
    useQueryState: (key: string, parser: { _default?: string }) => {
      const [, force] = React.useState(0);
      const value = nuqsStore.has(key) ? nuqsStore.get(key)! : parser?._default ?? null;
      const set = (v: string) => { nuqsStore.set(key, v); force((n: number) => n + 1); };
      return [value, set];
    },
  };
});

vi.mock('@/app/harness/Select', () => ({
  Select: ({ value, onChange, ariaLabel, options }: {
    value: string; onChange: (v: string) => void; ariaLabel: string;
    options: { value: string; label: string }[];
  }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));

vi.mock('@/app/harness/Checkbox', () => ({
  Checkbox: ({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) => (
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
  ),
}));

import TelemetryTab, { errPct, nextTransportParam } from './TelemetryTab';

const envelope = (payload: unknown) =>
  ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify(payload) }] }) }) as Response;

describe('errPct', () => {
  it('returns 0 for zero calls (no divide by zero)', () => {
    expect(errPct(0, 0)).toBe(0);
    expect(errPct(0, 5)).toBe(0);
  });
  it('computes the error rate as a percentage', () => {
    expect(errPct(10, 1)).toBe(10);
    expect(errPct(4, 1)).toBe(25);
    expect(errPct(3, 3)).toBe(100);
  });
});

describe('nextTransportParam', () => {
  it('adds a transport to an empty filter', () => {
    expect(nextTransportParam('', 'http')).toBe('http');
    expect(nextTransportParam(null, 'mcp')).toBe('mcp');
  });
  it('appends a second transport, preserving the first', () => {
    expect(nextTransportParam('http', 'mcp')).toBe('http,mcp');
  });
  it('removes a transport already in the filter', () => {
    expect(nextTransportParam('http,mcp', 'http')).toBe('mcp');
  });
  it('collapses to "" (no filter) when the last transport is removed', () => {
    expect(nextTransportParam('ipc', 'ipc')).toBe('');
  });
});

describe('<TelemetryTab /> render states + transport filter', () => {
  beforeEach(() => nuqsStore.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  const onRerun = vi.fn();
  beforeEach(() => onRerun.mockClear());

  it('shows the loading placeholder until the fetch resolves', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    render(<TelemetryTab workspaceIds={null} onRerun={onRerun} />);
    expect(screen.getByText('loading…')).toBeTruthy();
  });

  it('renders the error branch on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as Response));
    render(<TelemetryTab workspaceIds={null} onRerun={onRerun} />);
    await waitFor(() => expect(screen.getByText('HTTP 500')).toBeTruthy());
    expect(screen.queryByTestId('grid')).toBeNull();
  });

  it('renders the grid with parsed entries once loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      envelope({ entries: [
        { tool_name: 't1', call_count: 10, error_count: 1, p50_ms: 5, p95_ms: 9, workspaces: ['w1'] },
      ] }),
    ));
    render(<TelemetryTab workspaceIds={null} onRerun={onRerun} />);
    const grid = await screen.findByTestId('grid');
    expect(grid.getAttribute('data-rows')).toBe('1');
  });

  it('toggling a transport checkbox writes the nuqs param and refetches with that transport', async () => {
    const fetchMock = vi.fn(async () => envelope({ entries: [] }));
    vi.stubGlobal('fetch', fetchMock);
    render(<TelemetryTab workspaceIds={null} onRerun={onRerun} />);
    await screen.findByTestId('grid');
    const before = fetchMock.mock.calls.length;

    // Five transport checkboxes: http, mcp, ipc, in_process, unknown — toggle the first (http).
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0]);

    await waitFor(() => expect(nuqsStore.get('transport')).toBe('http'));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
    const body = JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string);
    expect(body.transports).toEqual(['http']);
  });

  it('the clear button appears once a transport is selected and resets the filter', async () => {
    nuqsStore.set('transport', 'http,mcp');
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ entries: [] })));
    render(<TelemetryTab workspaceIds={null} onRerun={onRerun} />);
    await screen.findByTestId('grid');

    const clearBtn = screen.getByRole('button', { name: 'clear' });
    fireEvent.click(clearBtn);
    await waitFor(() => expect(nuqsStore.get('transport')).toBe(''));
    expect(screen.queryByRole('button', { name: 'clear' })).toBeNull();
  });

  it('clicking a row rerun button fires onRerun with the tool + first workspace', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      envelope({ entries: [
        { tool_name: 'tool-x', call_count: 3, error_count: 0, p50_ms: null, p95_ms: null, workspaces: ['ws-1', 'ws-2'] },
      ] }),
    ));
    render(<TelemetryTab workspaceIds={null} onRerun={onRerun} />);
    await screen.findByTestId('grid');
    fireEvent.click(screen.getByRole('button', { name: 'Open in API tab with this tool selected' }));
    expect(onRerun).toHaveBeenCalledWith({ toolName: 'tool-x', workspace: 'ws-1' });
  });
});
