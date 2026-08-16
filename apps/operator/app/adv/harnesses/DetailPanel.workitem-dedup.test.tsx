// @vitest-environment jsdom
/**
 * DetailPanel — work-item detail dedup guard.
 *
 * The detail pane's `workItems.byHarness` subscription MUST use the SAME `limit`
 * as the WorkItemsPanel grid (the shared WORK_ITEMS_PAGE constant) so the two
 * share one React Query key `['sync','workItems.byHarness',args]` and dedup into
 * a single stream — the pane then reads the grid's already-loaded rows on
 * selection instead of firing a SECOND request.
 *
 * Regression (owner report 2026-07-08, Windows-only): the pane hardcoded
 * `limit: 300` vs the grid's 500, forking the key into a fresh on-click fetch
 * that starves under the desktop webview's ~6-connection-per-host cap on
 * Windows/WebView2 (the IPC bypass hides it on mac/linux WebKit) — the detail
 * pane sat on "Loading …" forever while the grid loaded fine.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { WORK_ITEMS_PAGE } from './WorkItemsPanel';
import { resolveSelectionKind } from './DetailPanel';

type SyncCall = { queryName: string; enabled?: boolean; args?: Record<string, unknown> };
const { syncCalls } = vi.hoisted(() => ({ syncCalls: [] as SyncCall[] }));

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: (opts: { queryName: string; enabled?: boolean; args?: Record<string, unknown> }) => {
    syncCalls.push({ queryName: opts.queryName, enabled: opts.enabled, args: opts.args });
    const enabled = opts.enabled !== false;
    return {
      data: enabled ? [] : [],
      loading: false,
      fetching: false,
      transport: 'sse' as const,
      invalidate: () => {},
      error: null,
    };
  },
}));
vi.mock('./useHarnessData', () => ({
  useHarnessFeatures: () => ({ features: [], patchFeature: vi.fn() }),
  useHarnessIssues: () => ({ issues: [], patchIssue: vi.fn() }),
}));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
vi.mock('@papercusp/papercusp-shared', () => ({ openFeatureChat: vi.fn() }));
// FeatureEditor pulls a rich editor at import — not needed for the empty/not-found
// branch this test renders; stub it so module load stays jsdom-light.
vi.mock('../../harness/FeatureEditor', () => ({ default: () => null }));

import DetailPanel from './DetailPanel';

afterEach(() => {
  cleanup();
  syncCalls.length = 0;
});

describe('DetailPanel work-item detail subscription', () => {
  it('routes a WI- selection to the workItem kind', () => {
    expect(resolveSelectionKind('WI-42')).toBe('workItem');
  });

  it('EI-19917451944474469: the no-selection empty state renders under a stable, addressable class', () => {
    // Regression guard for the second, independent defect filed on
    // EI-19917451944474469: adv-dep-graph-interlock.spec.ts asserted the
    // "Pick a work item…" placeholder INSIDE `.pc-adv-detail`, but that root
    // only mounts once something is selected — DetailPanel early-returns
    // `<Empty>` before it, so the assertion could never pass. The fix gives
    // `Empty` its own stable class (`pc-adv-detail__empty`) instead of
    // nesting the placeholder under a root that structurally cannot exist
    // yet. This test pins BOTH halves of that contract at the component
    // level, cheaper and faster than the full Playwright mount.
    const { container } = render(
      <NuqsTestingAdapter searchParams="">
        <DetailPanel
          panelId={'p1' as never}
          panelType={'detail' as never}
          params={{ harnessSlug: 'h1' } as never}
          api={{ setTitle: vi.fn() } as never}
        />
      </NuqsTestingAdapter>,
    );
    // `.pc-adv-detail` must NOT exist with nothing selected — its presence/absence
    // is itself a signal other code (and this same work item's live-webview
    // measurement) relies on to mean "something is selected".
    expect(container.querySelector('.pc-adv-detail')).toBeNull();
    const empty = container.querySelector('.pc-adv-detail__empty');
    expect(empty, 'the empty state must render under .pc-adv-detail__empty').toBeTruthy();
    expect(empty!.textContent).toBe('Pick a work item from the list to inspect.');
  });

  it('subscribes to workItems.byHarness with the grid page size so the queries dedup', () => {
    render(
      <NuqsTestingAdapter searchParams="?sel=WI-1">
        <DetailPanel
          panelId={'p1' as never}
          panelType={'detail' as never}
          params={{ harnessSlug: 'h1' } as never}
          api={{ setTitle: vi.fn() } as never}
        />
      </NuqsTestingAdapter>,
    );
    const wi = syncCalls.find((c) => c.queryName === 'workItems.byHarness' && c.enabled !== false);
    expect(wi, 'detail must enable workItems.byHarness for a WI- selection').toBeTruthy();
    // The exact invariant: same args as the grid → shared React Query key → dedup.
    expect(wi!.args).toMatchObject({ harnessSlug: 'h1', limit: WORK_ITEMS_PAGE });
  });
});
