// @vitest-environment jsdom
/**
 * HiveContentPanel (adv:hive-content) — CROSS-MEMBER BROWSE
 * (shared-hive-member-content-federation-2026-06-20 WI-259 P-006, D-010). The
 * explicit cross-member view: a member browses EVERY hive member's federated
 * features + plans in one rollup, member-ORIGIN-labeled, read-only, with a
 * row-click drill into that member (`?harness=<origin>` + `?sel=<id>`).
 *
 * This drives a mocked `useSyncQuery` over the contracted byHive shapes
 * (featuresConsolidated.byHive + plans.byHive) and asserts: the origin-labeled
 * rows, the member count, the tab switch, the ?hcq search filter, the drill
 * (writes ?harness + ?sel), the per-tab empty states, and the no-hive empty
 * state (queries disabled when there's no `?slug=` hive home).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter, type UrlUpdateEvent } from 'nuqs/adapters/testing';
import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';

const { syncResults, syncCalls } = vi.hoisted(() => ({
  syncResults: {} as Record<string, unknown[]>,
  syncCalls: [] as Array<{ queryName: string; enabled?: boolean; args?: unknown }>,
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName: string; enabled?: boolean; args?: unknown }) => {
    syncCalls.push({ queryName: opts.queryName, enabled: opts.enabled, args: opts.args });
    const enabled = opts.enabled !== false;
    return {
      data: enabled ? (syncResults[opts.queryName] ?? []) : [],
      loading: false,
      fetching: false,
      transport: 'sse' as const,
      invalidate: () => {},
      error: null,
    };
  },
}));

import HiveContentPanel from './HiveContentPanel';

afterEach(() => {
  cleanup();
  for (const k of Object.keys(syncResults)) delete syncResults[k];
  syncCalls.length = 0;
});

// Two federated member origins: peer member-a (a feature) + member-b (a feature),
// plus a plan authored by member-a. The hive home is `demo-hive`.
const FEATURES = [
  { featureId: 'F-1', harnessSlug: 'member-a', title: 'cross-member browse', status: 'in_progress', updatedTs: 2 },
  { featureId: 'F-9', harnessSlug: 'member-b', title: 'rekey rotation', status: 'passed', updatedTs: 1 },
];
const PLANS = [
  { slug: 'rekey-2026', title: 'Rekey the hive', status: 'in_progress', harness: 'member-a', updated: null },
];

const api = { setParams: vi.fn(), setTitle: vi.fn(), close: vi.fn() } as unknown as React.ComponentProps<
  typeof HiveContentPanel
>['api'];
const PANEL = { panelId: 'test-panel', panelType: 'adv:hive-content' } as const;

// The dock auto-binds `harnessSlug` (HarnessesDock rebinds it for every panel),
// so that's the param the panel receives live — mirror that here.
function renderPanel(
  searchParams = '',
  onUrlChange?: (e: UrlUpdateEvent) => void,
  panelParams: Record<string, unknown> = { harnessSlug: 'demo-hive' },
) {
  syncResults['featuresConsolidated.byHive'] = FEATURES;
  syncResults['plans.byHive'] = PLANS;
  return render(
    <TooltipProvider>
      <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlChange}>
        <HiveContentPanel {...PANEL} params={panelParams} api={api} />
      </NuqsTestingAdapter>
    </TooltipProvider>,
  );
}

describe('HiveContentPanel (adv:hive-content)', () => {
  it('renders federated features member-origin-labeled, reads the byHive queries for the hive home', async () => {
    renderPanel();

    // Features tab is the default — both members' features render, origin-labeled.
    await waitFor(() => screen.getByText('cross-member browse'));
    expect(screen.getByText('rekey rotation')).toBeTruthy();
    expect(screen.getByText('member-a')).toBeTruthy();
    expect(screen.getByText('member-b')).toBeTruthy();
    expect(screen.getByText('F-1')).toBeTruthy();

    // The member-count headline: two distinct origins across features + plans.
    expect(screen.getByText(/2 members/i)).toBeTruthy();

    // Both byHive queries fired, enabled, scoped to the hive home slug.
    const feat = syncCalls.find((c) => c.queryName === 'featuresConsolidated.byHive');
    const plan = syncCalls.find((c) => c.queryName === 'plans.byHive');
    expect(feat?.enabled).toBe(true);
    expect(feat?.args).toEqual({ hiveHomeSlug: 'demo-hive' });
    expect(plan?.enabled).toBe(true);
    expect(plan?.args).toEqual({ hiveHomeSlug: 'demo-hive' });
  });

  it('switches to the Plans tab and renders federated plans with their origin', async () => {
    renderPanel();
    await waitFor(() => screen.getByText('cross-member browse'));

    fireEvent.click(screen.getByRole('tab', { name: /Plans/i }));
    await waitFor(() => screen.getByText('Rekey the hive'));
    // The plan's origin member is labeled.
    expect(screen.getAllByText('member-a').length).toBeGreaterThan(0);
  });

  it('drills into a member on row click: writes ?harness=<origin> + ?sel=<id>', async () => {
    const updates: UrlUpdateEvent[] = [];
    renderPanel('', (e) => updates.push(e));
    await waitFor(() => screen.getByText('cross-member browse'));

    fireEvent.click(screen.getByText('cross-member browse'));
    await waitFor(() => {
      const sp = updates.at(-1)?.searchParams;
      expect(sp?.get('harness')).toBe('member-a');
      expect(sp?.get('sel')).toBe('F-1');
    });
  });

  it('filters by the ?hcq query — narrows to matching rows', async () => {
    renderPanel('?hcq=rekey');
    // Only the matching feature ("rekey rotation") shows; the other is filtered out.
    await waitFor(() => screen.getByText('rekey rotation'));
    expect(screen.queryByText('cross-member browse')).toBeNull();
  });

  it('also accepts the hive home via params.slug (explicit-open fallback)', async () => {
    renderPanel('', undefined, { slug: 'demo-hive' });
    await waitFor(() => screen.getByText('cross-member browse'));
    const feat = syncCalls.find((c) => c.queryName === 'featuresConsolidated.byHive');
    expect(feat?.enabled).toBe(true);
    expect(feat?.args).toEqual({ hiveHomeSlug: 'demo-hive' });
  });

  it('shows a per-tab empty state when a hive has no federated content yet', async () => {
    syncResults['featuresConsolidated.byHive'] = [];
    syncResults['plans.byHive'] = [];
    render(
      <TooltipProvider>
        <NuqsTestingAdapter searchParams="">
          <HiveContentPanel {...PANEL} params={{ harnessSlug: 'demo-hive' }} api={api} />
        </NuqsTestingAdapter>
      </TooltipProvider>,
    );
    await waitFor(() => screen.getByText(/No federated features in this hive yet/i));
  });

  it('shows the no-hive empty state and disables the queries when there is no hive home slug', async () => {
    render(
      <TooltipProvider>
        <NuqsTestingAdapter searchParams="">
          <HiveContentPanel {...PANEL} params={{}} api={api} />
        </NuqsTestingAdapter>
      </TooltipProvider>,
    );
    await waitFor(() => screen.getByText(/Select a hive/i));
    // Both byHive queries are disabled (no slug) → no fetch fired.
    expect(syncCalls.some((c) => c.queryName === 'featuresConsolidated.byHive' && c.enabled === false)).toBe(true);
    expect(syncCalls.some((c) => c.queryName === 'plans.byHive' && c.enabled === false)).toBe(true);
  });
});
