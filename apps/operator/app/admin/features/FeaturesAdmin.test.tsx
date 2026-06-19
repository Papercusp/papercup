// @vitest-environment jsdom
/**
 * FeaturesAdmin.test.tsx — render-tier coverage for the feature-flag console.
 * Branches: the loading spinner, the error card (a failed bootstrap fetch), the
 * ok shell (presets row, testingFeatures master switch on/off, per-flag list),
 * and the disabled per-flag toggles when testingFeatures is off. Fetch is
 * stubbed per-URL so we drive each state; SSE / Tooltip / sonner / lexicon are
 * mocked. `@papercusp/flags` is mocked to a tiny deterministic flag set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
vi.mock('@papercusp/sse', () => ({
  // Return an object with a no-op close(); the handlers are never auto-fired.
  createResilientEventSource: () => ({ close: vi.fn() }),
}));
vi.mock('@/app/harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
vi.mock('@papercusp/flags', () => {
  const FLAGS = { TESTING: 'papercusp-testing', DESIGN: 'papercusp-design' } as const;
  return { FLAGS, ALL_FLAG_KEYS: [FLAGS.TESTING, FLAGS.DESIGN] };
});

import FeaturesAdmin from './FeaturesAdmin';

/** Stub fetch keyed by URL. testingFeatures controls the master switch. */
function stubFetch(opts: { testingFeatures?: boolean; flags?: Record<string, boolean>; failBootstrap?: boolean } = {}) {
  const { testingFeatures = true, flags = {}, failBootstrap = false } = opts;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/flags/testing-features')) {
      return new Response(JSON.stringify({ testingFeatures, source: '~/.papercusp/posthog.json' }), { status: 200 });
    }
    if (url.includes('/api/flags/bootstrap')) {
      if (failBootstrap) return new Response('nope', { status: 500 });
      return new Response(JSON.stringify({ flags }), { status: 200 });
    }
    // preset/set/testing-features POST endpoints
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

describe('FeaturesAdmin', () => {
  it('shows the loading state before the flag fetches resolve', () => {
    // A fetch that never resolves keeps the component in `loading`.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<FeaturesAdmin />);
    expect(screen.getByText(/Loading…/i)).toBeTruthy();
  });

  it('shows the error card when the bootstrap fetch fails', async () => {
    stubFetch({ failBootstrap: true });
    render(<FeaturesAdmin />);
    await waitFor(() => expect(screen.getByText(/Failed to load:/i)).toBeTruthy());
  });

  it('renders the presets, master switch, and per-flag list when loaded (testingFeatures on)', async () => {
    stubFetch({ testingFeatures: true, flags: { 'papercusp-testing': true, 'papercusp-design': false } });
    render(<FeaturesAdmin />);
    await waitFor(() => expect(screen.getByText('V1 Production')).toBeTruthy());
    expect(screen.getByText('Full testing')).toBeTruthy();
    expect(screen.getByText('testingFeatures')).toBeTruthy();
    // The two mocked flags render in the per-flag list (by their key).
    expect(screen.getByText('papercusp-testing')).toBeTruthy();
    expect(screen.getByText('papercusp-design')).toBeTruthy();
  });

  it('per-flag toggles are enabled when testingFeatures is on', async () => {
    stubFetch({ testingFeatures: true, flags: {} });
    const { container } = render(<FeaturesAdmin />);
    await waitFor(() => expect(screen.getByText('papercusp-testing')).toBeTruthy());
    // The per-flag toggle buttons live inside .fa-flag rows; they are NOT disabled.
    const flagToggles = Array.from(container.querySelectorAll<HTMLButtonElement>('.fa-flag .fa-toggle'));
    expect(flagToggles.length).toBe(2);
    expect(flagToggles.every((b) => !b.disabled)).toBe(true);
  });

  it('disables the per-flag toggles + shows the hint when testingFeatures is off', async () => {
    stubFetch({ testingFeatures: false, flags: {} });
    const { container } = render(<FeaturesAdmin />);
    await waitFor(() => expect(screen.getByText('papercusp-testing')).toBeTruthy());
    expect(screen.getByText(/turn it on first/i)).toBeTruthy();
    // Every per-flag toggle inside a .fa-flag row is disabled when off.
    const flagToggles = Array.from(container.querySelectorAll<HTMLButtonElement>('.fa-flag .fa-toggle'));
    expect(flagToggles.length).toBe(2);
    expect(flagToggles.every((b) => b.disabled)).toBe(true);
  });

  it('clicking a preset POSTs to /api/flags/preset', async () => {
    stubFetch({ testingFeatures: false, flags: {} });
    render(<FeaturesAdmin />);
    await waitFor(() => expect(screen.getByText('Full testing')).toBeTruthy());
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();
    fireEvent.click(screen.getByText('Full testing').closest('button')!);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/flags/preset'))).toBe(true),
    );
  });
});
