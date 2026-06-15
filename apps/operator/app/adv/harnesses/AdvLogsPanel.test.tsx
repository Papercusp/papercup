// @vitest-environment jsdom
//
// AdvLogsPanel — the /adv structured-log reader. The valuable logic is the trio
// of pure cell accessors (levelOf / timeText / messageOf), which are extracted +
// exported and tested branch-by-branch (default level, lowercasing, unparseable
// ts → '', the loose message-key fallbacks). A render-smoke then drives the
// no-slug / loading / error / populated branches with the data hook + the heavy
// grid/filter children mocked (RichGrid, ColumnFilterBar, useColumnFilters), so
// the routing is asserted without a live transport or grid internals.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { logs } = vi.hoisted(() => ({
  logs: { events: null as unknown[] | null, loading: false, error: null as string | null },
}));

vi.mock('./useHarnessData', () => ({
  useHarnessLogs: () => ({
    events: logs.events,
    loading: logs.loading,
    error: logs.error,
    refresh: vi.fn(),
  }),
}));

// The generic column-filter system has its own suite — stub it to a passthrough
// (rows unchanged, no active chips) so this test owns only the panel routing.
vi.mock('../../harness/filters', () => ({
  ColumnFilterBar: () => <div data-testid="filter-bar" />,
  useColumnFilters: (_cols: unknown, rows: unknown[]) => ({
    rows,
    controller: {},
    activeChips: [],
    hasActive: false,
    clearAll: vi.fn(),
  }),
}));

// RichGrid (grid-core) renders rows / its `empty` slot — stub to a marker that
// echoes the row count, or the empty node when there are none.
vi.mock('@papercusp/grid-core', () => ({
  RichGrid: ({ rows, empty }: { rows: unknown[]; empty: React.ReactNode }) =>
    rows.length ? <div data-testid="grid">{rows.length} rows</div> : <div data-testid="grid-empty">{empty}</div>,
  usePersistedColumnWidths: () => [{}, vi.fn()],
}));

vi.mock('../../harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import AdvLogsPanel, { levelOf, timeText, messageOf } from './AdvLogsPanel';
import type { HarnessLogEvent } from './useHarnessData';

function ev(over: Partial<HarnessLogEvent> = {}): HarnessLogEvent {
  return { ts: '2026-06-14T12:00:00.000Z', ...over };
}
function mkProps(params: Record<string, unknown>) {
  return { panelId: 'p', panelType: 'adv:logs', params, api: { setParams: vi.fn(), setTitle: vi.fn(), close: vi.fn() } };
}

beforeEach(() => {
  logs.events = null;
  logs.loading = false;
  logs.error = null;
});
afterEach(() => cleanup());

describe('levelOf', () => {
  it('defaults to info when no level is present', () => {
    expect(levelOf(ev())).toBe('info');
  });
  it('lowercases the provided level', () => {
    expect(levelOf(ev({ level: 'ERROR' }))).toBe('error');
  });
});

describe('timeText', () => {
  it('returns a localized clock string for a valid ts', () => {
    expect(timeText(ev({ ts: '2026-06-14T12:00:00.000Z' }))).not.toBe('');
  });
  it('returns "" for an unparseable ts', () => {
    expect(timeText(ev({ ts: 'not-a-date' }))).toBe('');
  });
});

describe('messageOf', () => {
  it('prefers the msg key', () => {
    expect(messageOf(ev({ msg: 'hello' }))).toBe('hello');
  });
  it('falls back to the message key', () => {
    expect(messageOf(ev({ message: 'world' }))).toBe('world');
  });
  it('dumps the non-envelope fields as JSON when neither key is present', () => {
    expect(messageOf(ev({ extra: 1, foo: 'bar' }))).toBe('{"extra":1,"foo":"bar"}');
  });
  it('returns "" when only envelope fields remain', () => {
    expect(messageOf(ev({ source: 'svc', level: 'info' }))).toBe('');
  });
});

describe('<AdvLogsPanel />', () => {
  it('renders the no-slug hint when params carry no slug', () => {
    render(<AdvLogsPanel {...mkProps({})} />);
    expect(screen.getByText(/no harness slug in params/i)).toBeTruthy();
  });

  it('shows the loading state', () => {
    logs.loading = true;
    render(<AdvLogsPanel {...mkProps({ harnessSlug: 'h' })} />);
    expect(screen.getByText(/loading h…/i)).toBeTruthy();
  });

  it('shows the error surface', () => {
    logs.error = 'boom';
    render(<AdvLogsPanel {...mkProps({ harnessSlug: 'h' })} />);
    expect(screen.getByText(/failed: boom/i)).toBeTruthy();
  });

  it('renders the grid with a row per event when loaded', () => {
    logs.events = [ev({ msg: 'a' }), ev({ msg: 'b' })];
    render(<AdvLogsPanel {...mkProps({ harnessSlug: 'h' })} />);
    expect(screen.getByTestId('grid').textContent).toBe('2 rows');
  });

  it('renders the empty slot when there are no events', () => {
    logs.events = [];
    render(<AdvLogsPanel {...mkProps({ harnessSlug: 'h' })} />);
    expect(screen.getByText(/no log events yet/i)).toBeTruthy();
  });
});
