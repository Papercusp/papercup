/**
 * @vitest-environment jsdom
 *
 * Harness Tests tab — P-026 of harness-tests-tab-and-tester-promotion-2026-05-26.
 *
 * Covers the harness registry shape (Built-in generalized + Project
 * acceptance) and that <HarnessTestsView> renders <TestingShell> with those
 * two tiers for a harness slug.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import {
  harnessTestingRegistry,
  HARNESS_TESTING_TIER_LABELS,
  ACCEPTANCE_DOMAIN_ID,
} from '@papercusp/operator-core/lib/harness-testing-registry';
import { universalDomains } from '@papercusp/operator-core/lib/testing-domains';
import HarnessTestsView from '../../app/adv/harnesses/HarnessTestsView';

// AcceptancePanel's GET path went through useSyncQuery (data-sync convention,
// AcceptancePanel P-062/P-063 migration off raw fetch) — mock the resolver
// per-test via this mutable slot instead of stubbing global fetch for the GET.
let syncQueryResult: { data: unknown; loading: boolean; error: Error | null } = { data: undefined, loading: true, error: null };
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ ...syncQueryResult, fetching: syncQueryResult.loading, invalidate: vi.fn() }),
}));

import AcceptancePanel from '../../app/adv/harnesses/AcceptancePanel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('harnessTestingRegistry', () => {
  it('is the universal domains plus the Acceptance (Project) domain', () => {
    const ids = harnessTestingRegistry.map((d) => d.id);
    for (const g of universalDomains) expect(ids).toContain(g.id);
    expect(ids).toContain(ACCEPTANCE_DOMAIN_ID);
    expect(harnessTestingRegistry.length).toBe(universalDomains.length + 1);

    const acceptance = harnessTestingRegistry.find((d) => d.id === ACCEPTANCE_DOMAIN_ID);
    expect(acceptance?.tier).toBe('project');
    expect(universalDomains.every((d) => d.tier === 'universal')).toBe(true);
  });

  it('maps the two tiers to Universal / This Harness labels', () => {
    expect(HARNESS_TESTING_TIER_LABELS).toEqual({ universal: 'Universal', project: 'This Harness' });
  });
});

describe('<HarnessTestsView>', () => {
  it('renders TestingShell with Universal + This Harness tiers for a harness slug', async () => {
    // Minimal stub so DomainTestPanel's detail fetch resolves; the nav
    // (tier headings + tabs) comes from the registry and renders regardless.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        async json() {
          if (url.includes('/file-status')) return { statuses: {} };
          if (url.includes('/health-strip')) return null;
          return { id: 'routes', label: 'Routes', description: '', tier: 'universal', sections: [], totalFiles: 0 };
        },
      })) as unknown as typeof fetch,
    );

    render(<HarnessTestsView slug="demo" />, {
      wrapper: withNuqsTestingAdapter({ searchParams: '' }),
    });

    // Both tiers render in the rail…
    await waitFor(() => screen.getByText('Universal'));
    screen.getByText('This Harness');
    // …and the Acceptance tab is present.
    screen.getByText('Acceptance');
  });
  // (The no-slug empty state now lives in AdvHarnessPanelPage — "Select a
  // harness" — not in HarnessTestsView, which is always given a slug.)
});

describe('<AcceptancePanel> (P-062/P-063)', () => {
  const ASSERTIONS = [
    { val_id: 'VAL-demo-001', plan_slug: 'demo', item_id: 'P-001', verify_text: 'GET /x returns 200', status: 'passed', requires_test: true },
    { val_id: 'VAL-demo-002', plan_slug: 'demo', item_id: 'P-001', verify_text: 'button copy reads Download', status: 'todo', requires_test: false },
  ];

  it('lists VAL rows with status + a requires_test toggle', async () => {
    syncQueryResult = { data: ASSERTIONS, loading: false, error: null };
    render(<AcceptancePanel slug="demo" />);
    await waitFor(() => expect(screen.getAllByText('VAL-demo-001').length).toBeGreaterThan(0));
    expect(screen.getAllByText('GET /x returns 200').length).toBeGreaterThan(0);
    expect(screen.getAllByText('VAL-demo-002').length).toBeGreaterThan(0);
    // Two requires_test checkboxes — VAL-001 checked, VAL-002 unchecked.
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(boxes[0].getAttribute('aria-checked')).toBe('true');
    expect(boxes[1].getAttribute('aria-checked')).toBe('false');
  });

  it('PATCHes requires_test when a toggle is flipped', async () => {
    syncQueryResult = { data: ASSERTIONS, loading: false, error: null };
    const fetchMock = vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => ({ assertions: ASSERTIONS }) };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(<AcceptancePanel slug="demo" />);
    await waitFor(() => expect(screen.getAllByText('VAL-demo-001').length).toBeGreaterThan(0));
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    await user.click(boxes[0]); // flip VAL-001 required → exempt
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u, init]) =>
            String(u).includes('/assertions/VAL-demo-001') &&
            (init as { method?: string } | undefined)?.method === 'POST' &&
            String((init as { body?: string } | undefined)?.body).includes('"requires_test":false'),
        ),
      ).toBe(true),
    );
  });

  it('shows an empty state when there are no assertions', async () => {
    syncQueryResult = { data: [], loading: false, error: null };
    render(<AcceptancePanel slug="demo" />);
    await waitFor(() => screen.getByText(/No VAL assertions yet/));
  });
});
