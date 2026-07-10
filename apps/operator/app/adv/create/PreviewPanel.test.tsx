// @vitest-environment jsdom
//
// PreviewPanel — the create:preview reader that renders whichever selection is
// live (?item → PlanItemPreview, ?other → OtherDetail, else the empty hint).
// Two halves:
//   • PURE openPlanEditor — the exported URL helper that switches ?view=plans +
//     ?plan=<slug> (and sets/clears ?jump) via history.replaceState. Tested by
//     asserting the resulting location.search.
//   • A render-smoke driving the three routing branches with the data hooks +
//     heavy detail children mocked, asserting which child renders and the
//     planSlug/itemId split out of the `slug::id` ?item token.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';

// nuqs: ?item / ?other backed by a per-key store the tests seed.
const nuqs: Record<string, unknown> = { item: null, other: null };
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => {
    const [, force] = React.useReducer((n: number) => n + 1, 0);
    return [
      nuqs[key],
      async (v: unknown) => {
        nuqs[key] = v;
        force();
      },
    ];
  },
  parseAsString: {},
  parseAsInteger: {},
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
}));

// The decision.ledger sync query is irrelevant to ?item/?other routing — stub it.
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: [] }),
}));

vi.mock('./use-create-data', () => ({
  useCreateScope: () => ({ scopeMode: 'self', harnessFilter: null, advActiveSlug: 'h', harnessSlugsForFetch: ['h'] }),
  usePlanListMaps: () => ({ harnessByPlan: new Map([['plan-a', 'harness-x']]) }),
}));

vi.mock('@/app/admin/plans/plans-api', () => ({
  usePlanAttention: () => ({
    data: { groups: [{ items: [{ id: 'oth-1', kind: 'decision' }, { id: 'pi', kind: 'plan-item' }] }] },
    refresh: vi.fn(),
  }),
}));

vi.mock('@/app/admin/plans/PlanItemPreview', () => ({
  default: ({ planSlug, itemId, harnessSlug }: { planSlug: string | null; itemId: string | null; harnessSlug: string | null }) => (
    <div data-testid="item-preview">{`${planSlug}|${itemId}|${harnessSlug}`}</div>
  ),
}));
vi.mock('@/app/admin/plans/PlanOtherList', () => ({
  OtherDetail: ({ item }: { item: { id: string } | null }) => <div data-testid="other-detail">{item?.id ?? 'none'}</div>,
}));

import PreviewPanel, { openPlanEditor } from './PreviewPanel';

beforeEach(() => {
  nuqs.item = null;
  nuqs.other = null;
  window.history.replaceState({}, '', '/');
});
afterEach(() => cleanup());

describe('openPlanEditor', () => {
  it('sets ?view=plans and ?plan=<slug> on the URL', () => {
    openPlanEditor('my-plan');
    const sp = new URL(window.location.href).searchParams;
    expect(sp.get('view')).toBe('plans');
    expect(sp.get('plan')).toBe('my-plan');
    expect(sp.get('jump')).toBeNull();
  });

  it('sets ?jump when a target id is supplied', () => {
    openPlanEditor('my-plan', 'item-42');
    expect(new URL(window.location.href).searchParams.get('jump')).toBe('item-42');
  });

  it('clears a stale ?jump when none is supplied', () => {
    window.history.replaceState({}, '', '/?jump=old');
    openPlanEditor('my-plan');
    expect(new URL(window.location.href).searchParams.get('jump')).toBeNull();
  });
});

describe('<PreviewPanel /> routing', () => {
  it('renders the empty hint when nothing is selected', () => {
    render(<PreviewPanel />);
    expect(screen.getByText(/select an item to see its detail/i)).toBeTruthy();
    expect(screen.queryByTestId('item-preview')).toBeNull();
    expect(screen.queryByTestId('other-detail')).toBeNull();
  });

  it('renders PlanItemPreview for a ?item token, splitting slug::id and resolving the harness', () => {
    nuqs.item = 'plan-a::item-9';
    render(<PreviewPanel />);
    // planSlug=plan-a, itemId=item-9, harnessSlug from harnessByPlan map
    expect(screen.getByTestId('item-preview').textContent).toBe('plan-a|item-9|harness-x');
  });

  it('passes null planSlug/itemId when the ?item token has no :: separator', () => {
    nuqs.item = 'bare-token';
    render(<PreviewPanel />);
    expect(screen.getByTestId('item-preview').textContent).toBe('null|null|null');
  });

  it('renders OtherDetail with the matched non-plan-item for a ?other selection', () => {
    nuqs.other = 'oth-1';
    render(<PreviewPanel />);
    expect(screen.getByTestId('other-detail').textContent).toBe('oth-1');
  });
});
