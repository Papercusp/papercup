// @vitest-environment jsdom
/**
 * MemoryTab.test.tsx — render-tier coverage for the admin Testing → Memory tab.
 * It polls health/preflight, fetches the check catalog, runs the memory suite,
 * and offers manual probes. We mock the harness primitives (Button/Checkbox/
 * Select) + RouteLink to plain DOM and stub fetch per-URL so we can drive:
 *   - the header + health-loading state
 *   - the populated health strip (pgvector/mem0/embedder pills)
 *   - the "Suite blocked" banner (preflight.ok = false)
 *   - the run-suite button + the check catalog list
 *   - the probe sub-nav (switching actions via ?probe)
 *   - the ?check deep-link selecting a check
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactElement } from 'react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
vi.mock('../../../harness/Button', () => ({
  Button: ({ children, onClick, disabled, type }: any) => (
    <button type={type ?? 'button'} onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));
vi.mock('../../../harness/Checkbox', () => ({
  Checkbox: ({ checked, onChange, ariaLabel }: any) => (
    <input type="checkbox" aria-label={ariaLabel} checked={checked} onChange={(e) => onChange(e.target.checked)} />
  ),
}));
vi.mock('../../../harness/Select', () => ({
  Select: ({ value, onChange, ariaLabel, options }: any) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));
vi.mock('@/app/_components/RouteLink', () => ({
  default: ({ href, children }: any) => <a href={href}>{children}</a>,
}));

import MemoryTab from './MemoryTab';

function renderTab(ui: ReactElement, searchParams = '') {
  return render(<NuqsTestingAdapter searchParams={searchParams}>{ui}</NuqsTestingAdapter>);
}

const HEALTH_OK = {
  pgvector: true, mem0_ready: true, embedder_mode: 'openai', has_anthropic_key: true,
  has_openai_key: true, entry_count_user: 3, entry_count_workspace_shared: 5,
  recent_feedback_24h: 2, blocking_reason: null,
};
const CHECKS = { checks: [{ id: 'remember-recall', label: 'Remember then recall' }] };

/** Per-URL fetch stub. `preflightOk` toggles the blocked banner. */
function stubFetch(opts: { preflightOk?: boolean; health?: typeof HEALTH_OK | null } = {}) {
  const { preflightOk = true, health = HEALTH_OK } = opts;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/memory/health')) return new Response(JSON.stringify(health), { status: 200 });
    if (url.includes('/memory/preflight')) return new Response(JSON.stringify({ ok: preflightOk, reason: preflightOk ? undefined : 'Embedder unavailable.' }), { status: 200 });
    if (url.includes('/memory/checks')) return new Response(JSON.stringify(CHECKS), { status: 200 });
    if (url.includes('/test-runs')) return new Response(JSON.stringify({ runId: 'r1', snapshot: { runId: 'r1', status: 'running', results: [], progressBySuite: {} } }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }));
}

beforeEach(() => {
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MemoryTab', () => {
  it('renders the header + intro', () => {
    renderTab(<MemoryTab />);
    expect(screen.getByRole('heading', { name: /Memory system/i })).toBeTruthy();
  });

  it('shows the health-loading hint before health resolves', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    renderTab(<MemoryTab />);
    expect(screen.getByText(/Loading health…/i)).toBeTruthy();
  });

  it('renders the populated health strip (pgvector / mem0 / embedder pills)', async () => {
    renderTab(<MemoryTab />);
    await waitFor(() => expect(screen.getByText('pgvector')).toBeTruthy());
    expect(screen.getByText('mem0')).toBeTruthy();
    expect(screen.getByText('embedder')).toBeTruthy();
    // embedder pill value reflects the mode.
    expect(screen.getAllByText('openai').length).toBeGreaterThanOrEqual(1);
  });

  it('shows the "Suite blocked" banner when preflight fails', async () => {
    stubFetch({ preflightOk: false });
    renderTab(<MemoryTab />);
    await waitFor(() => expect(screen.getByText(/Suite blocked/i)).toBeTruthy());
    expect(screen.getByText(/Embedder unavailable/i)).toBeTruthy();
  });

  it('renders the run-suite button + the check catalog list', async () => {
    renderTab(<MemoryTab />);
    expect(screen.getByRole('button', { name: /Run memory suite/i })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Remember then recall')).toBeTruthy());
  });

  it('renders the probe sub-nav (remember / search / list / forget / update)', async () => {
    renderTab(<MemoryTab />);
    await waitFor(() => expect(screen.getByText(/Manual probes/i)).toBeTruthy());
    // The probe-action nav buttons. ('remember' also matches the form's submit
    // button when that action is active, so assert ≥1.)
    for (const a of ['remember', 'search', 'list', 'forget', 'update']) {
      expect(screen.getAllByRole('button', { name: a }).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('switching the probe to "search" renders the query input', async () => {
    renderTab(<MemoryTab />);
    await waitFor(() => expect(screen.getByText(/Manual probes/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'search' }));
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/search query/i)).toBeTruthy(),
    );
  });

  it('?check deep-link selects a check (its detail header appears)', async () => {
    renderTab(<MemoryTab />, '?check=remember-recall');
    // With a selected check that hasn't run, the detail pane shows the "hasn't run yet" hint.
    await waitFor(() =>
      expect(screen.getByText(/hasn't run yet in this session/i)).toBeTruthy(),
    );
  });
});
