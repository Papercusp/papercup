// @vitest-environment jsdom
/**
 * AcceptancePanel.test.tsx — the harness Tests-tab "Acceptance" view. Loads VAL
 * assertions, renders them in a grid, and toggles per-VAL requires_test with an
 * optimistic flip that reverts on a failed POST. Covers loading / error / empty
 * / populated, the toggle POST body, and the revert-on-failure path.
 *
 * Seams: @papercusp/grid-core RichGrid stubbed to render each column's cell (so
 * the real Checkbox + toggle wiring runs), Checkbox stubbed to a native input,
 * fetch stubbed per method/url.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('@papercusp/grid-core', () => ({
  RichGrid: ({ rows, columns, getRowId }: {
    rows: Record<string, unknown>[];
    columns: { key: string; render?: (a: { row: Record<string, unknown> }) => unknown }[];
    getRowId: (r: Record<string, unknown>) => string;
  }) => (
    <table data-testid="grid"><tbody>
      {rows.map((r) => (
        <tr key={getRowId(r)} data-testid={`row-${getRowId(r)}`}>
          {columns.map((c) => <td key={c.key}>{c.render ? c.render({ row: r }) : null}</td>)}
        </tr>
      ))}
    </tbody></table>
  ),
}));
vi.mock('@/app/harness/Checkbox', () => ({
  Checkbox: ({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: () => void }) => (
    <input type="checkbox" checked={checked} disabled={disabled} onChange={() => onChange()} />
  ),
}));
vi.mock('@/lib/use-workspace-id', () => ({ useWorkspaceId: () => 'ws-test' }));
const { syncState, invalidateSpy } = vi.hoisted(() => ({
  syncState: { data: [] as Assertion[], loading: false, error: null as Error | null },
  invalidateSpy: vi.fn(),
}));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ ...syncState, fetching: false, invalidate: invalidateSpy }),
}));

import AcceptancePanel from './AcceptancePanel';

interface Assertion { val_id: string; plan_slug: string; item_id: string; verify_text: string; status: string; requires_test: boolean }
function A(over: Partial<Assertion> & { val_id: string }): Assertion {
  return { plan_slug: 'p', item_id: 'P-1', verify_text: 'must work', status: 'todo', requires_test: true, ...over };
}

let toggleOk = true;
let fetchCalls: Array<{ url: string; method: string; body?: unknown }>;
function stubFetch() {
  fetchCalls = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    fetchCalls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (method === 'POST') return Promise.resolve({ ok: toggleOk, status: toggleOk ? 200 : 500 } as Response);
    return Promise.resolve({ ok: true, status: 200 } as Response);
  }));
}

beforeEach(() => {
  toggleOk = true;
  Object.assign(syncState, { data: [], loading: false, error: null });
  invalidateSpy.mockClear();
  stubFetch();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AcceptancePanel', () => {
  it('shows the loading state before assertions resolve', () => {
    syncState.loading = true;
    render(<AcceptancePanel slug="alpha" />);
    expect(screen.getByText(/Loading acceptance criteria/i)).toBeTruthy();
  });

  it('shows an error when the assertions fetch fails', async () => {
    syncState.error = new Error('HTTP 500');
    render(<AcceptancePanel slug="alpha" />);
    expect(await screen.findByText(/Could not load acceptance criteria: HTTP 500/i)).toBeTruthy();
  });

  it('shows the empty state when there are no VALs', async () => {
    syncState.data = [];
    render(<AcceptancePanel slug="alpha" />);
    expect(await screen.findByText(/No VAL assertions yet/i)).toBeTruthy();
  });

  it('renders a row per VAL with its verify text + status', async () => {
    syncState.data = [A({ val_id: 'VAL-1', verify_text: 'login works', status: 'passed' })];
    render(<AcceptancePanel slug="alpha" />);
    const row = await screen.findByTestId('row-VAL-1');
    expect(within(row).getByText('login works')).toBeTruthy();
    expect(within(row).getByText('passed')).toBeTruthy();
  });

  it('optimistically flips requires_test and POSTs the new value', async () => {
    syncState.data = [A({ val_id: 'VAL-1', requires_test: true })];
    render(<AcceptancePanel slug="alpha" />);
    const row = await screen.findByTestId('row-VAL-1');
    const box = within(row).getByRole('checkbox') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(fetchCalls.some((c) => c.method === 'POST')).toBe(true));
    const post = fetchCalls.find((c) => c.method === 'POST')!;
    expect(post.url).toContain('/assertions/VAL-1');
    expect(post.body).toEqual({ requires_test: false });
    expect(invalidateSpy).toHaveBeenCalledOnce();
    expect((within(row).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it('reverts the optimistic flip when the POST fails', async () => {
    toggleOk = false;
    syncState.data = [A({ val_id: 'VAL-1', requires_test: true })];
    render(<AcceptancePanel slug="alpha" />);
    const row = await screen.findByTestId('row-VAL-1');
    fireEvent.click(within(row).getByRole('checkbox'));
    // ends back at checked after the failed POST reverts
    await waitFor(() => expect((within(row).getByRole('checkbox') as HTMLInputElement).checked).toBe(true));
  });
});
