// @vitest-environment jsdom
//
// PgTab — the Postgres connection / active-query / table-size inspector. The
// pure logic is the two formatters (fmtBytes binary-prefix sizing, fmtDuration
// sub-second → multi-hour), pinned below at their unit boundaries. The
// render-level tests drive the three fetch states for real: the Promise.all of
// three MCP-envelope tool calls (so a wrong unwrap or a single rejected call
// surfaces), the loading gate, the error gate, and the populated connections
// section + both grids — the gating a pure-fn test can't reach.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('@papercusp/grid-core', () => ({
  RichGrid: ({ rows }: { rows: unknown[] }) => (
    <div data-testid="grid" data-rows={rows.length} />
  ),
}));

import PgTab, { fmtBytes, fmtDuration } from './PgTab';

describe('fmtBytes', () => {
  it('renders raw bytes under 1KB', () => {
    expect(fmtBytes(0)).toBe('0B');
    expect(fmtBytes(512)).toBe('512B');
  });
  it('renders KB with one decimal', () => {
    expect(fmtBytes(2048)).toBe('2.0KB');
    expect(fmtBytes(1536)).toBe('1.5KB');
  });
  it('renders MB with one decimal', () => {
    expect(fmtBytes(5 * 1024 * 1024)).toBe('5.0MB');
  });
  it('renders GB with two decimals past a gigabyte', () => {
    expect(fmtBytes(3 * 1024 * 1024 * 1024)).toBe('3.00GB');
  });
});

describe('fmtDuration', () => {
  it('renders sub-second spans in milliseconds', () => { expect(fmtDuration(0.25)).toBe('250ms'); });
  it('renders seconds with one decimal under a minute', () => { expect(fmtDuration(12.5)).toBe('12.5s'); });
  it('renders "Nm Ss" between a minute and an hour', () => { expect(fmtDuration(125)).toBe('2m 5s'); });
  it('renders whole hours past an hour', () => { expect(fmtDuration(2 * 3600 + 100)).toBe('2h'); });
});

describe('<PgTab /> fetch states', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  // The tab fans out three POSTs (pg_health / pg_active_queries / pg_table_sizes),
  // each wrapped in the MCP envelope; route by the URL path.
  const stubFetch = (impl: (path: string) => unknown | Promise<unknown>) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = url.split('?')[0];
      const payload = await impl(path);
      return { ok: true, json: async () => ({ content: [{ text: JSON.stringify(payload) }] }) } as Response;
    }));
  };

  const HEALTH = { version: 'PostgreSQL 16 on x86_64', totalConnections: 7, activeConnections: 2, idleConnections: 5 };

  it('shows the loading placeholder until the fetches resolve', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    render(<PgTab />);
    expect(screen.getByText('loading…')).toBeTruthy();
  });

  it('renders the connections section + both grids once loaded', async () => {
    stubFetch((path) => {
      if (path.endsWith('/pg_health')) return HEALTH;
      if (path.endsWith('/pg_active_queries')) return { queries: [{ pid: 1, state: 'active', query: 'select 1', duration_seconds: 0.1, application_name: 'x', client_addr: null }] };
      if (path.endsWith('/pg_table_sizes')) return { tables: [
        { schema: 'harness_shared', table: 'projects', total_bytes: 2048, index_bytes: 512, rows_estimate: 10 },
        { schema: 'harness_shared', table: 'spawns', total_bytes: 4096, index_bytes: 1024, rows_estimate: 20 },
      ] };
      return {};
    });
    render(<PgTab />);
    await waitFor(() => expect(screen.getByText('Connections')).toBeTruthy());
    // Connection counts surface from the health payload.
    expect(screen.getByText('7')).toBeTruthy(); // total
    // Two grids (active queries + tables) with the parsed row counts.
    const grids = screen.getAllByTestId('grid');
    expect(grids.map((g) => g.getAttribute('data-rows'))).toEqual(['1', '2']);
    // The version header is split on " on ".
    expect(screen.getByText('PostgreSQL 16')).toBeTruthy();
  });

  it('renders the error branch when one of the parallel tool calls fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/pg_table_sizes')) return { ok: false, status: 500 } as Response;
      return { ok: true, json: async () => ({ content: [{ text: JSON.stringify(HEALTH) }] }) } as Response;
    }));
    render(<PgTab />);
    await waitFor(() => expect(screen.getByText('HTTP 500')).toBeTruthy());
    expect(screen.queryByTestId('grid')).toBeNull();
    expect(screen.queryByText('Connections')).toBeNull();
  });
});
