// @vitest-environment jsdom
/**
 * TableAdmin.test.tsx — the Drizzle CRUD admin factory. Thoroughly covers the
 * two exported pure helpers (coerceColumnValue's nullable/default/type coercion,
 * renderCell's display formatting) and the component: the table sidebar + auto-
 * select, the rows grid + actions, the "+ New row" create modal (coerced POST
 * body), and the delete confirm/cancel flow.
 *
 * Seams: sonner toast, the admin css, useConfirmDialog, RichGrid (stubbed to
 * render each column's cell so action buttons appear), fetch stubbed per route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../admin-tables.css', () => ({}));
let confirmResult = true;
vi.mock('@/app/harness/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: async () => confirmResult, element: null }) }));
vi.mock('@papercusp/grid-core', () => ({
  RichGrid: ({ rows, columns }: { rows: Record<string, unknown>[]; columns: { key: string; render?: (a: { row: Record<string, unknown> }) => unknown }[] }) => (
    <table data-testid="grid"><tbody>
      {rows.map((r, i) => (
        <tr key={i} data-testid={`row-${i}`}>{columns.map((c) => <td key={c.key}>{c.render ? c.render({ row: r }) : null}</td>)}</tr>
      ))}
    </tbody></table>
  ),
}));

import TableAdmin, { coerceColumnValue, renderCell, type ColumnSummary } from './TableAdmin';

const col = (over: Partial<ColumnSummary> = {}): ColumnSummary => ({
  name: 'c', dataType: '', columnType: 'PgText', notNull: false, primary: false, hasDefault: false, default: null, isUnique: false, generated: false, ...over,
});

describe('coerceColumnValue', () => {
  it('maps blank to null (nullable) or undefined (has default)', () => {
    expect(coerceColumnValue(col({ notNull: false }), '')).toBeNull();
    expect(coerceColumnValue(col({ notNull: true, hasDefault: true }), '')).toBeUndefined();
  });
  it('coerces integer columns to numbers (blank → null)', () => {
    expect(coerceColumnValue(col({ columnType: 'PgInteger' }), '5')).toBe(5);
    expect(coerceColumnValue(col({ columnType: 'PgInteger', notNull: true }), '')).toBeNull();
  });
  it('keeps numeric/decimal types as strings', () => {
    expect(coerceColumnValue(col({ columnType: 'PgNumeric', notNull: true }), '1.50')).toBe('1.50');
  });
  it('coerces booleans from true/1', () => {
    expect(coerceColumnValue(col({ columnType: 'PgBoolean', notNull: true }), 'true')).toBe(true);
    expect(coerceColumnValue(col({ columnType: 'PgBoolean', notNull: true }), '1')).toBe(true);
    expect(coerceColumnValue(col({ columnType: 'PgBoolean', notNull: true }), 'false')).toBe(false);
  });
  it('parses jsonb, falling back to the raw string on bad JSON', () => {
    expect(coerceColumnValue(col({ columnType: 'PgJsonb', notNull: true }), '{"a":1}')).toEqual({ a: 1 });
    expect(coerceColumnValue(col({ columnType: 'PgJsonb', notNull: true }), 'oops')).toBe('oops');
  });
  it('passes text through', () => {
    expect(coerceColumnValue(col({ columnType: 'PgText' }), 'hi')).toBe('hi');
  });
});

describe('renderCell', () => {
  it('formats null/undefined, booleans, numbers, and strings', () => {
    expect(renderCell(null)).toBe('∅');
    expect(renderCell(undefined)).toBe('∅');
    expect(renderCell(true)).toBe('true');
    expect(renderCell(false)).toBe('false');
    expect(renderCell(42)).toBe('42');
    expect(renderCell('hi')).toBe('hi');
  });
  it('truncates long strings and objects at ~200 chars', () => {
    expect(renderCell('x'.repeat(250))).toBe('x'.repeat(197) + '…');
    expect(renderCell({ a: 1 })).toBe('{"a":1}');
  });
  it('falls back to String() when JSON.stringify throws', () => {
    expect(renderCell(10n)).toBe('10');
  });
});

const ENTRY = { exportName: 'users', label: 'Users', schema: 'public', name: 'users', editableColumns: null, allowDelete: true };
const DETAIL = {
  exportName: 'users', schema: 'public', name: 'users', qualifiedName: 'public.users', primaryKey: ['id'],
  columns: [col({ name: 'id', columnType: 'PgInteger', notNull: true, primary: true }), col({ name: 'name', columnType: 'PgText' })],
};
const ROWS = { rows: [{ id: 1, name: 'Ada' }, { id: 2, name: 'Bob' }], total: 2, limit: 50, offset: 0 };

let createImpl: () => { ok: boolean; body: unknown };
let calls: Array<{ url: string; method: string; body?: Record<string, unknown> }>;
function stubFetch() {
  calls = [];
  const json = (body: unknown, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 400, statusText: '', json: async () => body } as Response);
  vi.stubGlobal('fetch', vi.fn((url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (url === '/api/admin/tables' && method === 'GET') return json({ tables: [ENTRY] });
    if (url.includes('/api/dev/tables/')) return json(DETAIL);
    if (method === 'POST') { const r = createImpl(); return json(r.body, r.ok); }
    if (method === 'DELETE') return json({ ok: true });
    return json(ROWS); // GET rows
  }));
}

describe('TableAdmin component', () => {
  beforeEach(() => { confirmResult = true; createImpl = () => ({ ok: true, body: { ok: true } }); stubFetch(); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('lists tables, auto-selects the first, and renders its header + rows', async () => {
    render(<TableAdmin />);
    expect(await screen.findByText('Users')).toBeTruthy();
    // The header qualified-name + the grid rows load from the table-detail/rows
    // fetches AFTER the sidebar — await them (findBy) instead of querying
    // synchronously, or the assertions race the fetch (flaky under green-checkpoint
    // load). The header is `{qualifiedName} · PK: {pk}` (split across text nodes),
    // so match the element's whitespace-normalized textContent, not a single node.
    expect(
      await screen.findByText(
        (_content, el) =>
          el?.classList.contains('pc-admin-header-qualified') === true &&
          el.textContent?.replace(/\s+/g, ' ').trim() === 'public.users · PK: id',
      ),
    ).toBeTruthy();
    expect(await screen.findByText('Ada')).toBeTruthy();
    expect(screen.getByText('Bob')).toBeTruthy();
    expect(screen.getAllByText('Edit').length).toBe(2);
  });

  it('opens the create modal from + New row', async () => {
    render(<TableAdmin />);
    await screen.findByText('Users');
    // '+ New row' lives in the toolbar that renders with the table detail (loads
    // after the sidebar) — await it (findByRole) or it races the fetch under load.
    fireEvent.click(await screen.findByRole('button', { name: '+ New row' }));
    expect(screen.getByText('+ New users')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy();
  });

  it('submits a create with the coerced body', async () => {
    render(<TableAdmin />);
    await screen.findByText('Users');
    // '+ New row' lives in the toolbar that renders with the table detail (loads
    // after the sidebar) — await it (findByRole) or it races the fetch under load.
    fireEvent.click(await screen.findByRole('button', { name: '+ New row' }));
    const inputs = screen.getAllByRole('textbox'); // [id, name]
    fireEvent.change(inputs[1], { target: { value: 'Charlie' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ name: 'Charlie' });
  });

  it('deletes a row after confirmation', async () => {
    render(<TableAdmin />);
    await screen.findByText('Users');
    // Del buttons live in the grid, which loads after the sidebar — await them
    // (findAllBy) rather than querying synchronously (raced the fetch → flaky).
    fireEvent.click((await screen.findAllByText('Del'))[0]);
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });

  it('does not delete when the confirm is cancelled', async () => {
    confirmResult = false;
    render(<TableAdmin />);
    await screen.findByText('Users');
    fireEvent.click((await screen.findAllByText('Del'))[0]);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});
