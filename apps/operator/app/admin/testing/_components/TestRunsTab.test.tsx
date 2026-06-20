// @vitest-environment jsdom
/**
 * TestRunsTab.test.tsx — the admin suite-runner tab. Covers the three exported
 * pure helpers (formatCounts, formatMs, groupResultsBySuite) and the component:
 * the suite grid + run buttons, selecting a suite (nuqs), starting a run (POST
 * body + suiteId / all-safe), the empty live-log, and a start error.
 *
 * Seams: nuqs via NuqsTestingAdapter, RichGrid + Button stubbed, the
 * admin-test-suites-shared constants mocked, fetch stubbed per route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

vi.mock('@papercusp/grid-core', () => ({
  RichGrid: ({ rows, getRowId }: { rows: { id: string }[]; getRowId: (r: { id: string }) => string }) => (
    <div data-testid="grid">{rows.map((r) => <div key={getRowId(r)} />)}</div>
  ),
}));
vi.mock('../../../harness/Button', () => ({
  Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: (e: unknown) => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));
vi.mock('@papercusp/operator-core/lib/admin-test-suites-shared', () => ({
  ADMIN_TEST_SUITES: [
    { id: 'desktop-health', label: 'Desktop health', hint: 'h1', description: 'd1', runner: 'tauri', estimatedSeconds: 10, safeDefault: true, tags: ['a'] },
    { id: 'perf', label: 'Perf', hint: 'h2', description: 'd2', runner: 'host', estimatedSeconds: 20, safeDefault: false, tags: ['b'] },
  ],
  ADMIN_TEST_SUITE_IDS: ['desktop-health', 'perf'],
}));

import TestRunsTab, { formatCounts, formatMs, groupResultsBySuite } from './TestRunsTab';

describe('TestRunsTab pure helpers', () => {
  it('formatCounts renders the pass/warn/fail/skip tally', () => {
    expect(formatCounts({ pass: 2, warn: 1, fail: 0, skip: 3 } as never)).toBe('2 pass · 1 warn · 0 fail · 3 skip');
  });
  it('formatMs handles non-positive, sub-second, and second durations', () => {
    expect(formatMs(0)).toBe('0ms');
    expect(formatMs(-5)).toBe('0ms');
    expect(formatMs(Number.NaN)).toBe('0ms');
    expect(formatMs(500)).toBe('500ms');
    expect(formatMs(1500)).toBe('1.5s');
  });
  it('groupResultsBySuite buckets by suiteId, sorted by label', () => {
    const grouped = groupResultsBySuite([
      { suiteId: 'a', label: 'Zebra', id: '1' },
      { suiteId: 'a', label: 'Apple', id: '2' },
      { suiteId: 'b', label: 'X', id: '3' },
    ] as never);
    expect(grouped.a.map((r) => r.label)).toEqual(['Apple', 'Zebra']);
    expect(grouped.b.map((r) => r.label)).toEqual(['X']);
  });
});

const DONE = { runId: 'r1', status: 'done', results: [], summaries: {}, progressBySuite: {}, logs: [], selection: 'desktop-health', finishedAt: 1_700_000_000_000 };
let startImpl: () => { ok: boolean; status?: number; body: unknown };
let calls: Array<{ url: string; method: string; body?: Record<string, unknown> }>;
function stubFetch() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (method === 'POST' && url.includes('/test-runs') && !url.includes('/cancel')) {
      const r = startImpl();
      return Promise.resolve({ ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), json: async () => r.body, text: async () => 'boom' } as Response);
    }
    // GET refresh
    return Promise.resolve({ ok: true, status: 200, json: async () => DONE, text: async () => '' } as Response);
  }));
}

describe('TestRunsTab component', () => {
  function renderTab(searchParams = '', onUrlUpdate?: (e: unknown) => void) {
    return render(<NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}><TestRunsTab /></NuqsTestingAdapter>);
  }
  beforeEach(() => { startImpl = () => ({ ok: true, body: { runId: 'r1', snapshot: DONE } }); stubFetch(); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('renders the header, the suite cards, and the run buttons', () => {
    renderTab();
    expect(screen.getByText('Test Runs')).toBeTruthy();
    expect(screen.getAllByText('Desktop health').length).toBeGreaterThan(0); // card + selection label
    expect(screen.getByText('Perf')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run selected suite' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run all safe suites' })).toBeTruthy();
    expect(screen.getByText('No run started yet.')).toBeTruthy();
  });

  it('selects a suite when its card is clicked', async () => {
    const onUrlUpdate = vi.fn();
    renderTab('', onUrlUpdate);
    fireEvent.click(screen.getByText('Perf'));
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    const ev = onUrlUpdate.mock.calls.at(-1)![0] as { searchParams: URLSearchParams };
    expect(ev.searchParams.get('suite')).toBe('perf');
  });

  it('starts the selected suite with the right POST body', async () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Run selected suite' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toContain('/api/admin/testing/test-runs');
    expect(post.body!.suiteId).toBe('desktop-health');
  });

  it('starts all-safe suites', async () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Run all safe suites' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body!.suiteId).toBe('all-safe');
  });

  it('surfaces a start error', async () => {
    startImpl = () => ({ ok: false, status: 500, body: {} });
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Run selected suite' }));
    expect(await screen.findByText(/Error:/i)).toBeTruthy();
  });
});
