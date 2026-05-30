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
