// @vitest-environment jsdom
/**
 * PlanOtherList — the unified Queue list (queue redesign).
 *
 * Covers the unification contract that lets ONE authorizer-grouped list carry
 * BOTH plan-items and the coord/smoke/etc. "Other" surfaces:
 *  1. `includePlanItems` surfaces a needs-human plan-item (authorizer='you') in
 *     the "Needs your call" bucket — with its P-NNN — instead of excluding it.
 *  2. WITHOUT the prop (the legacy/settings use) plan-items are still excluded.
 *  3. A plan-item row routes its click to `?item=` (the shared Vditor preview),
 *     NOT `?other=`; an Other row still routes to `?other=`.
 *
 * Sections are Radix Collapsibles (collapsed by default), so each test expands
 * the target section before asserting/clicking its rows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter, type UrlUpdateEvent } from 'nuqs/adapters/testing';

// Lexicon resolver echoes its key (t('brain') → 'brain') — isolates the routed
// authorizer/why-line copy from the THE_HIVE flag hook (restore-pot-lexicon-public-release P-007).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

import PlanOtherList from './PlanOtherList';
import type { AttentionGroup, AttentionItem } from './plans-api';

afterEach(() => cleanup());

function item(over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 'coord-escalation:e1',
    kind: 'coord-escalation',
    source: 'coord',
    harnessSlug: 'h',
    planSlug: null,
    itemRef: null,
    title: 'A blocking escalation',
    body: '',
    status: 'open',
    importance: 'normal',
    tier: 'alert',
    needsHuman: false,
    ownerAgentId: null,
    ownerLabel: null,
    triageState: 'untriaged',
    triageNote: null,
    triagedBy: null,
    triagedAt: null,
    actions: [],
    ref: { kind: 'coord-escalation' },
    authorizer: null,
    whyGated: null,
    ...over,
  };
}

/** A needs-human plan-item — authorizer='you' → the "Needs your call" bucket. */
function planItem(over: Partial<AttentionItem> = {}): AttentionItem {
  return item({
    id: 'plan-item:plan-alpha::P-003',
    kind: 'plan-item',
    planSlug: 'plan-alpha',
    itemRef: 'P-003',
    title: 'Approve the schema migration',
    status: 'needs-human',
    tier: 'decision',
    needsHuman: true,
    category: 'plan-governance',
    authorizer: 'you',
    whyGated: 'owner-only',
    ref: { kind: 'plan-item' },
    ...over,
  });
}

function group(items: AttentionItem[]): AttentionGroup {
  return { key: 'g', kind: 'plan', planSlug: null, harnessSlug: 'h', title: 'grp', items, maxImportance: 'normal' };
}

const BASE = {
  loading: false,
  error: null as string | null,
  refresh: () => {},
  title: 'Pending',
};

describe('PlanOtherList — Queue unification (includePlanItems)', () => {
  it('surfaces a needs-human plan-item in the "Needs your call" bucket with its P-NNN', () => {
    render(
      <PlanOtherList {...BASE} groups={[group([planItem(), item()])]} groupByAuthorizer includePlanItems />,
      { wrapper: withNuqsTestingAdapter({ searchParams: '' }) },
    );
    // The authorizer bucket the plan-item lands in is visible (collapsed).
    const head = screen.getByRole('button', { name: /Needs your call/ });
    expect(head).toBeTruthy();
    fireEvent.click(head); // expand the section
    expect(screen.getByText('Approve the schema migration')).toBeTruthy();
    expect(screen.getByText('P-003')).toBeTruthy();
  });

  it('without includePlanItems, a plan-item is excluded (legacy behavior preserved)', () => {
    render(<PlanOtherList {...BASE} groups={[group([planItem()])]} groupByAuthorizer />, {
      wrapper: withNuqsTestingAdapter({ searchParams: '' }),
    });
    // The only item was a plan-item, which the default path drops → empty state.
    expect(screen.getByText(/Nothing else needs attention/i)).toBeTruthy();
    expect(screen.queryByText('Approve the schema migration')).toBeNull();
  });

  it('a plan-item row click routes to ?item= (the Vditor preview), not ?other=', async () => {
    let last: URLSearchParams | null = null;
    render(
      <PlanOtherList {...BASE} groups={[group([planItem()])]} groupByAuthorizer includePlanItems />,
      {
        wrapper: withNuqsTestingAdapter({
          searchParams: '',
          onUrlUpdate: (e: UrlUpdateEvent) => {
            last = e.searchParams;
          },
        }),
      },
    );
    fireEvent.click(screen.getByRole('button', { name: /Needs your call/ }));
    fireEvent.click(screen.getByRole('button', { name: /Approve the schema migration/ }));
    await waitFor(() => expect(last).not.toBeNull());
    expect(last!.get('item')).toBe('plan-alpha::P-003');
    expect(last!.get('other')).toBeNull();
  });

  it('an Other (non-plan-item) row click still routes to ?other=', async () => {
    let last: URLSearchParams | null = null;
    render(<PlanOtherList {...BASE} groups={[group([item()])]} groupByAuthorizer includePlanItems />, {
      wrapper: withNuqsTestingAdapter({
        searchParams: '',
        onUrlUpdate: (e: UrlUpdateEvent) => {
          last = e.searchParams;
        },
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: /Alerts & activity/ }));
    fireEvent.click(screen.getByRole('button', { name: /A blocking escalation/ }));
    await waitFor(() => expect(last).not.toBeNull());
    expect(last!.get('other')).toBe('coord-escalation:e1');
    expect(last!.get('item')).toBeNull();
  });
});
