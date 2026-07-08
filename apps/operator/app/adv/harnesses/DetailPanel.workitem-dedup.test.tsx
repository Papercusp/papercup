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

  it('subscribes to workItems.byHarness with the grid page size so the queries dedup', () => {
    render(
      <NuqsTestingAdapter searchParams="?sel=WI-1">
        <DetailPanel
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
