/**
 * @vitest-environment jsdom
 *
 * Harness Tests tab — P-026 of harness-tests-tab-and-tester-promotion-2026-05-26.
 *
 * Covers the harness registry shape (Built-in generalized + Project
 * acceptance) and that <AdvTestsPanel> renders <TestingShell> with those
 * two tiers from a dock `harnessSlug` param.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import {
  harnessTestingRegistry,
  HARNESS_TESTING_TIER_LABELS,
  ACCEPTANCE_DOMAIN_ID,
} from '../harness-testing-registry';
import { generalizedRegistry } from '../testing-domains';
import AdvTestsPanel from '../../app/adv/harnesses/AdvTestsPanel';
import AcceptancePanel from '../../app/adv/harnesses/AcceptancePanel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Full PanelComponentProps for the dock-mounted panel (only `params` is read). */
const panelProps = (params: Record<string, unknown>) => ({
  panelId: 'test-panel',
  panelType: 'adv:tests',
  params,
  api: { setParams: () => {}, setTitle: () => {}, close: () => {} },
});

describe('harnessTestingRegistry', () => {
  it('is the generalized (Built-in) domains plus the Acceptance (Project) domain', () => {
    const ids = harnessTestingRegistry.map((d) => d.id);
    for (const g of generalizedRegistry) expect(ids).toContain(g.id);
    expect(ids).toContain(ACCEPTANCE_DOMAIN_ID);
    expect(harnessTestingRegistry.length).toBe(generalizedRegistry.length + 1);

    const acceptance = harnessTestingRegistry.find((d) => d.id === ACCEPTANCE_DOMAIN_ID);
    expect(acceptance?.tier).toBe('project');
    expect(generalizedRegistry.every((d) => d.tier === 'generalized')).toBe(true);
  });

  it('maps the two tiers to Built-in / Project labels', () => {
    expect(HARNESS_TESTING_TIER_LABELS).toEqual({ generalized: 'Built-in', project: 'Project' });
  });
});

describe('<AdvTestsPanel>', () => {
  it('renders TestingShell with Built-in + Project tiers from the harnessSlug param', async () => {
    // Minimal stub so DomainTestPanel's detail fetch resolves; the nav
    // (tier headings + tabs) comes from the registry and renders regardless.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        async json() {
          if (url.includes('/file-status')) return { statuses: {} };
          if (url.includes('/health-strip')) return null;
          return { id: 'test-runs', label: 'Test Runs', description: '', tier: 'generalized', sections: [], totalFiles: 0 };
        },
      })) as unknown as typeof fetch,
    );

    render(<AdvTestsPanel {...panelProps({ harnessSlug: 'demo' })} />, {
      wrapper: withNuqsTestingAdapter({ searchParams: '' }),
    });

    // Both tiers render in the rail…
    await waitFor(() => screen.getByText('Built-in'));
    screen.getByText('Project');
    // …and the Acceptance tab is present.
    screen.getByText('Acceptance');
  });

  it('shows an empty state when no harnessSlug is in params', () => {
    render(<AdvTestsPanel {...panelProps({})} />, {
      wrapper: withNuqsTestingAdapter({ searchParams: '' }),
    });
    screen.getByText('No harness slug in params.');
  });
});

describe('<AcceptancePanel> (P-062/P-063)', () => {
  const ASSERTIONS = [
    { val_id: 'VAL-demo-001', plan_slug: 'demo', item_id: 'P-001', verify_text: 'GET /x returns 200', status: 'passed', requires_test: true },
    { val_id: 'VAL-demo-002', plan_slug: 'demo', item_id: 'P-001', verify_text: 'button copy reads Download', status: 'todo', requires_test: false },
  ];

  it('lists VAL rows with status + a requires_test toggle', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ assertions: ASSERTIONS }) })) as unknown as typeof fetch,
    );
    render(<AcceptancePanel slug="demo" />);
    await waitFor(() => screen.getByText('VAL-demo-001'));
    screen.getByText('GET /x returns 200');
    screen.getByText('VAL-demo-002');
    // Two requires_test checkboxes — VAL-001 checked, VAL-002 unchecked.
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
  });

  it('PATCHes requires_test when a toggle is flipped', async () => {
    const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => ({ assertions: ASSERTIONS }) };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(<AcceptancePanel slug="demo" />);
    await waitFor(() => screen.getByText('VAL-demo-001'));
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ assertions: [] }) })) as unknown as typeof fetch,
    );
    render(<AcceptancePanel slug="demo" />);
    await waitFor(() => screen.getByText(/No VAL assertions yet/));
  });
});
