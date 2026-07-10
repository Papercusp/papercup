// @vitest-environment jsdom
//
// AuditTab — the operator audit-log grid. It is mostly an effect-only fetch
// shell over RichGrid; the one bit of pure display logic worth pinning is the
// compact details preview (fmtAuditDetails: JSON, 100-char cap, '—' for empty).
// The render-level tests drive the loading / error / populated branches for
// real and exercise the time-window Select, asserting it writes the nuqs param
// AND triggers a refetch with the new `hours` in the request body — the kind of
// handler wiring a pure-fn test can't reach.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@papercusp/grid-core', () => ({
  RichGrid: ({ rows }: { rows: unknown[] }) => (
    <div data-testid="grid" data-rows={rows.length} />
  ),
}));

// Stateful nuqs mock: a module-scoped store keyed by param name lets the Select
// onChange actually re-render the component with the new value (driving the
// refetch effect), which the [null, () => {}] stub could never do.
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
      const set = (v: string) => {
        nuqsStore.set(key, v);
        force((n: number) => n + 1);
      };
      return [value, set];
    },
  };
});

// Real <select> so onChange fires through to setHoursParam.
vi.mock('@/app/harness/Select', () => ({
  Select: ({ value, onChange, ariaLabel, options }: {
    value: string;
    onChange: (v: string) => void;
    ariaLabel: string;
    options: { value: string; label: string }[];
  }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));

import AuditTab, { fmtAuditDetails } from './AuditTab';

const envelope = (payload: unknown) =>
  ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify(payload) }] }) }) as Response;

describe('fmtAuditDetails', () => {
  it('renders an em dash for null / undefined / empty details', () => {
    expect(fmtAuditDetails(null)).toBe('—');
    expect(fmtAuditDetails(undefined)).toBe('—');
    expect(fmtAuditDetails('')).toBe('—');
    expect(fmtAuditDetails(0)).toBe('—');
  });
  it('JSON-stringifies an object payload', () => {
    expect(fmtAuditDetails({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
  });
  it('caps the preview at 100 chars', () => {
    const out = fmtAuditDetails({ k: 'z'.repeat(300) });
    expect(out.length).toBe(100);
  });
});

describe('<AuditTab /> render states + window control', () => {
  beforeEach(() => nuqsStore.clear());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the loading placeholder until the fetch resolves', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    render(<AuditTab workspaceIds={null} />);
    expect(screen.getByText('loading…')).toBeTruthy();
  });

  it('renders the grid with parsed entries once loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      envelope({ entries: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }] }),
    ));
    render(<AuditTab workspaceIds={null} />);
    const grid = await screen.findByTestId('grid');
    expect(grid.getAttribute('data-rows')).toBe('3');
  });

  it('surfaces the error branch on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as Response));
    render(<AuditTab workspaceIds={null} />);
    await waitFor(() => expect(screen.getByText('HTTP 500')).toBeTruthy());
    expect(screen.queryByTestId('grid')).toBeNull();
  });

  it('defaults the window to 24h and sends hours:24 in the request', async () => {
    const fetchMock = vi.fn(async () => envelope({ entries: [] }));
    vi.stubGlobal('fetch', fetchMock);
    render(<AuditTab workspaceIds={null} />);
    await screen.findByTestId('grid');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.hours).toBe(24);
  });

  it('changing the window writes the nuqs param and refetches with the new hours', async () => {
    const fetchMock = vi.fn(async () => envelope({ entries: [] }));
    vi.stubGlobal('fetch', fetchMock);
    render(<AuditTab workspaceIds={null} />);
    await screen.findByTestId('grid');
    const calls0 = fetchMock.mock.calls.length;

    fireEvent.change(screen.getByLabelText('Audit log time window'), { target: { value: '168' } });

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(calls0));
    expect(nuqsStore.get('auditHours')).toBe('168');
    const lastBody = JSON.parse(
      (fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string,
    );
    expect(lastBody.hours).toBe(168); // 7 days
  });
});
