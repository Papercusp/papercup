// @vitest-environment jsdom
/**
 * DetailPanel — prior-attempts panel subscription contract (P-017 slice D).
 *
 * The prior-attempt brief has been computed at claim time since P-010, but it was
 * handed to the claiming agent and discarded, so a human or a compacted successor
 * could only re-obtain it by CLAIMING the item — a write with side effects. Slice D
 * renders the same port read-only.
 *
 * What is pinned here is the part that is expensive to get wrong and invisible in
 * review: the collector behind `workItems.priorAttempts` is MULTI-TABLE under a 2.5s
 * budget, so the section is gated with `useSyncQuery({ enabled })` and must compute
 * NOTHING until a human opens it. A regression that drops the gate does not fail any
 * existing test, does not change the rendered output, and only shows up as every
 * work-item selection silently paying for a multi-table read it never displays.
 *
 * Both directions are asserted together on purpose. "Disabled while closed" alone
 * would pass just as happily if the query were never wired at all, so the open case
 * is the positive control that proves the subscription actually exists.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

type SyncCall = { queryName: string; enabled?: boolean; args?: Record<string, unknown> };
const { syncCalls } = vi.hoisted(() => ({ syncCalls: [] as SyncCall[] }));

const WORK_ITEM = {
  id: 'WI-1',
  harness: 'h1',
  family: 'issue',
  kind: 'bug',
  title: 'a selected work item',
  state: 'open',
};

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: (opts: { queryName: string; enabled?: boolean; args?: Record<string, unknown> }) => {
    syncCalls.push({ queryName: opts.queryName, enabled: opts.enabled, args: opts.args });
    const enabled = opts.enabled !== false;
    // Only the detail query yields a row: the panel needs a selected work item to
    // mount PriorAttemptsSection at all, and every other read is irrelevant here.
    const data = enabled && opts.queryName === 'workItems.detail' ? [WORK_ITEM] : [];
    return {
      data,
      loading: false,
      fetching: false,
      transport: 'sse' as const,
      invalidate: () => {},
      error: null,
    };
  },
}));
vi.mock('./useHarnessData', () => ({
  useHarnessFeature: () => ({ feature: null, loading: false, error: null, patchFeature: vi.fn() }),
  useHarnessIssues: () => ({ issues: [], patchIssue: vi.fn() }),
}));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
vi.mock('@papercusp/papercusp-shared', () => ({ openFeatureChat: vi.fn() }));
vi.mock('../../harness/FeatureEditor', () => ({ default: () => null }));

import DetailPanel from './DetailPanel';

function renderDetail(searchParams: string) {
  return render(
    <NuqsTestingAdapter searchParams={searchParams}>
      <DetailPanel
        panelId={'p1' as never}
        panelType={'detail' as never}
        params={{ harnessSlug: 'h1' } as never}
        api={{ setTitle: vi.fn() } as never}
      />
    </NuqsTestingAdapter>,
  );
}

const priorAttemptCalls = () => syncCalls.filter((c) => c.queryName === 'workItems.priorAttempts');

afterEach(() => {
  cleanup();
  syncCalls.length = 0;
});

describe('DetailPanel prior-attempts section (P-017 slice D)', () => {
  it('subscribes but stays DISABLED while the section is closed', () => {
    renderDetail('?sel=WI-1');

    const calls = priorAttemptCalls();
    // The subscription must EXIST (otherwise the next assertion is vacuous)...
    expect(calls.length, 'the prior-attempts query must be wired on a selected work item').toBeGreaterThan(0);
    // ...and every one of them must be gated off.
    expect(
      calls.every((c) => c.enabled === false),
      'the multi-table collector must not run until a human opens the section',
    ).toBe(true);
  });

  it('ENABLES the query with item-scoped args once the scoped ref opens it', () => {
    // 'h1::WI-1' is encodeScopedRef(slug, id) — the section follows the SELECTED item,
    // so the param carries the harness too rather than a bare id.
    renderDetail('?sel=WI-1&wipa=h1%3A%3AWI-1');

    const enabled = priorAttemptCalls().find((c) => c.enabled !== false);
    expect(enabled, 'opening the section must enable the query').toBeTruthy();
    expect(enabled?.args).toEqual({ harnessSlug: 'h1', workItemId: 'WI-1' });
  });

  it('stays closed when the scoped ref names a DIFFERENT work item', () => {
    // The ref is scoped precisely so a stale param left over from another selection
    // cannot silently open — and pay for — the collector on the item now shown.
    renderDetail('?sel=WI-1&wipa=h1%3A%3AWI-999');

    expect(priorAttemptCalls().every((c) => c.enabled === false)).toBe(true);
  });
});
