// @vitest-environment jsdom
//
// SqlTab — the read-only SQL playground. Its grid renders raw result cells via
// renderCell, the one pure helper carrying display behavior (null sentinel,
// boolean/number stringify, 200-char truncation, JSON fallback), pinned below.
// The render-level tests drive the Run flow for real: the initial empty state,
// the busy gate (button disabled + "Running…" while the POST is in flight), the
// success path (stats line + result grid / "No rows returned"), the error
// branches (server-returned error payload + a thrown fetch), and the role
// Select toggling the request body — handler wiring renderCell can't reach.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Monaco loads via the router-compat dynamic shim; stub it to a null component
// so the editor stack never mounts.
vi.mock('@/lib/router-compat/dynamic', () => ({ default: () => () => null }));

vi.mock('@papercusp/grid-core', () => ({
  VirtualGrid: ({ rows }: { rows: unknown[] }) => (
    <div data-testid="grid" data-rows={rows.length} />
  ),
}));

const { nuqsStore } = vi.hoisted(() => ({ nuqsStore: new Map<string, string>() }));
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => {
  const React = require('react');
  return {
    ...nuqsParsers,
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

import SqlTab, { renderCell } from './SqlTab';

describe('renderCell', () => {
  it('renders ∅ for null and undefined', () => {
    expect(renderCell(null)).toBe('∅');
    expect(renderCell(undefined)).toBe('∅');
  });
  it('stringifies booleans and numbers', () => {
    expect(renderCell(true)).toBe('true');
    expect(renderCell(false)).toBe('false');
    expect(renderCell(42)).toBe('42');
    expect(renderCell(0)).toBe('0');
  });
  it('passes short strings through unchanged', () => {
    expect(renderCell('hello')).toBe('hello');
  });
  it('truncates strings longer than 200 chars to 197 + ellipsis', () => {
    const out = renderCell('z'.repeat(300));
    expect(out).toBe('z'.repeat(197) + '…');
    expect(out.length).toBe(198);
  });
  it('JSON-stringifies objects and arrays', () => {
    expect(renderCell({ a: 1 })).toBe('{"a":1}');
    expect(renderCell([1, 2])).toBe('[1,2]');
  });
  it('truncates long JSON output too', () => {
    const out = renderCell({ k: 'q'.repeat(300) });
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(198);
  });
});

describe('<SqlTab /> run flow', () => {
  afterEach(() => { cleanup(); nuqsStore.clear(); vi.unstubAllGlobals(); });

  const ok = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

  it('starts with the empty "run a query" prompt and no result grid', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<SqlTab />);
    expect(screen.getByText('Run a query to see results.')).toBeTruthy();
    expect(screen.queryByTestId('grid')).toBeNull();
  });

  it('disables the Run button and shows "Running…" while the query is in flight', async () => {
    let resolve!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => { resolve = res; })));
    render(<SqlTab />);
    const runBtn = screen.getByRole('button', { name: '▶ Run' });
    fireEvent.click(runBtn);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Running…' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Running…' }).hasAttribute('disabled')).toBe(true);
    resolve(ok({ columns: ['a'], rows: [{ a: 1 }], rowCount: 1, durationMs: 3 }));
    await waitFor(() => expect(screen.getByRole('button', { name: '▶ Run' })).toBeTruthy());
  });

  it('renders the result grid + stats line on a successful query', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      ok({ columns: ['slug'], rows: [{ slug: 'a' }, { slug: 'b' }], rowCount: 2, durationMs: 12 }),
    ));
    render(<SqlTab />);
    fireEvent.click(screen.getByRole('button', { name: '▶ Run' }));
    const grid = await screen.findByTestId('grid');
    expect(grid.getAttribute('data-rows')).toBe('2');
    expect(screen.getByText(/2 rows · 12ms/)).toBeTruthy();
  });

  it('renders "No rows returned." when the query succeeds with an empty set', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ columns: ['x'], rows: [], rowCount: 0, durationMs: 1 })));
    render(<SqlTab />);
    fireEvent.click(screen.getByRole('button', { name: '▶ Run' }));
    await waitFor(() => expect(screen.getByText('No rows returned.')).toBeTruthy());
    expect(screen.queryByTestId('grid')).toBeNull();
  });

  it('renders the server-returned error payload (with its sqlState summary)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      ok({ error: 'syntax error at or near "slect"', sqlState: '42601' }),
    ));
    render(<SqlTab />);
    fireEvent.click(screen.getByRole('button', { name: '▶ Run' }));
    await waitFor(() => expect(screen.getByText(/syntax error at or near/)).toBeTruthy());
    expect(screen.getByText('[42601] error')).toBeTruthy();
    expect(screen.queryByTestId('grid')).toBeNull();
  });

  it('captures a thrown fetch as an error result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    render(<SqlTab />);
    fireEvent.click(screen.getByRole('button', { name: '▶ Run' }));
    await waitFor(() => expect(screen.getByText('network down')).toBeTruthy());
  });

  it('the role Select toggles the role sent in the request body', async () => {
    const fetchMock = vi.fn(async () => ok({ columns: [], rows: [], rowCount: 0, durationMs: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<SqlTab />);
    // Default role is admin.
    fireEvent.click(screen.getByRole('button', { name: '▶ Run' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).role).toBe('admin');

    // Switch to app, run again.
    fireEvent.change(screen.getByLabelText('SQL role'), { target: { value: 'app' } });
    expect(nuqsStore.get('sqlRole')).toBe('app');
    fireEvent.click(screen.getByRole('button', { name: '▶ Run' }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string).role).toBe('app');
  });
});
