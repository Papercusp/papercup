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

// This mock used to be key-aware, defaulting the tier flag to FALSE so a blanket
// `() => true` could not silently un-retire the tier for the whole file (P-011 /
// D-021, the trap D-020 caught). P-068/D-098 DELETED that flag and the component
// no longer reads one, so the blanket form has the opposite meaning now: forcing
// EVERY flag ON makes the absence assertions below a TRIPWIRE — the retired
// deep-link must stay gone in the most permissive flag state reachable.
vi.mock('@/lib/flag-hooks', () => ({
  useFlag: () => true,
}));

import { FLAGS } from '@papercusp/flags';
import PlanOtherList, { OtherDetail } from './PlanOtherList';
import type { AttentionGroup, AttentionItem } from './plans-api';

afterEach(() => cleanup());

function item(over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 'coord-escalation:e1',
    kind: 'coord-escalation',
    source: 'coord',
    harnessSlug: 'h',
    planSlug: undefined,
    itemRef: undefined,
    title: 'A blocking escalation',
    body: '',
    status: 'open',
    importance: 'normal',
    tier: 'alert',
    needsHuman: false,
    ownerAgentId: undefined,
    ownerLabel: undefined,
    triageState: 'untriaged',
    triageNote: undefined,
    triagedBy: undefined,
    triagedAt: undefined,
    actions: [],
    ref: { kind: 'coord-escalation' },
    authorizer: undefined,
    whyGated: undefined,
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
  return { key: 'g', kind: 'plan', planSlug: undefined, harnessSlug: 'h', title: 'grp', items, maxImportance: 'normal' };
}

const BASE = {
  loading: false,
  error: null as string | null,
  refresh: () => {},
  title: 'Pending',
};

/* ── Mug/Kettle retired (retire-mug-kettle-su-only-2026-08-09 P-011 / D-021) ──
 *
 * /admin/plans carries no mug gate of its own, so these two deep-links to
 * /settings/autonomy outlived every gate landed for this plan — an invitation to
 * hand work to a decider that cannot run, pointing at a page that now renders
 * only a retirement notice. Both assertions are PAIRED with a show control: a
 * bare "the link is absent" is equally satisfied by a fixture that never produced
 * the bucket at all, which is a test that passes while measuring nothing.
 */
describe('PlanOtherList — retired Mug deep-links', () => {
  const queenItem = () => item({ id: 'coord-escalation:q1', authorizer: 'queen-eligible' });
  const LINK = /Let the brain handle these/;

  // These two cases used to pair each hide-assertion with a SHOW control, flipping
  // the tier flag ON to prove the query could find the link at all. P-068/D-098
  // deleted that flag, so the ON case is no longer constructible. The vacuity risk
  // it existed to kill is unchanged, so each case now carries a CALIBRATION on a
  // sibling surface instead — the bucket must render for the absence to mean
  // anything — and `useFlag` is stubbed TRUE for every key, so these are tripwires
  // rather than assertions about a default.

  it('never renders the bucket-head deep-link, with every flag forced on', () => {
    render(<PlanOtherList {...BASE} groups={[group([queenItem()])]} groupByAuthorizer />, {
      wrapper: withNuqsTestingAdapter({ searchParams: '' }),
    });
    // CALIBRATION FIRST — the bucket itself must render, or the null below would
    // just mean "the fixture produced nothing". The partition is not what we gate.
    expect(screen.getByText('Automatable — for now')).toBeTruthy();
    expect(screen.queryByText(LINK)).toBeNull();
  });

  it('leaves no anchor pointing at /settings/autonomy anywhere in the queue', () => {
    render(<PlanOtherList {...BASE} groups={[group([queenItem()])]} groupByAuthorizer />, {
      wrapper: withNuqsTestingAdapter({ searchParams: '' }),
    });
    expect(screen.getByText('Automatable — for now')).toBeTruthy(); // calibration
    expect(document.querySelectorAll('a[href="/settings/autonomy"]')).toHaveLength(0);
  });
});

describe('PlanOtherList — Queue unification (includePlanItems)', () => {
  it('shows a bounded-feed notice and exposes the continuation action', () => {
    const loadMore = vi.fn();
    render(
      <PlanOtherList
        {...BASE}
        groups={[group([item()])]}
        hasMore
        totalCount={5}
        loadedCount={2}
        loadMore={loadMore}
      />,
      { wrapper: withNuqsTestingAdapter({ searchParams: '' }) },
    );
    expect(screen.getByTestId('attention-window-notice').textContent).toContain('2 of 5');
    fireEvent.click(screen.getByTestId('attention-load-more'));
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

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

describe('OtherDetail — host action placement', () => {
  it('uses the fixed-height fallback after the body when a legacy row has no actions field', () => {
    render(
      <OtherDetail
        item={item({ body: 'Full owner-visible description', actions: undefined })}
        actionsPlacement="after-body"
        onResolved={() => {}}
      />,
    );

    const body = document.querySelector('.pc-items__detail-body');
    const loading = screen.getByTestId('detail-actions-loading');
    expect(body).toBeTruthy();
    expect(body?.contains(loading)).toBe(true);
    expect(body?.textContent).toContain('Full owner-visible description');
    expect(body?.lastElementChild).toBe(loading);
  });

  it('renders all list-carried actions immediately without waiting for detail hydration', () => {
    render(
      <OtherDetail
        item={item({
          actions: [
            { id: 'resolve', label: 'Resolve' },
            { id: 'chat', label: 'Chat' },
            { id: 'open', label: 'Open' },
            { id: 'drop', label: 'Drop' },
          ],
        })}
        actionsPlacement="after-body"
        onResolved={() => {}}
      />,
    );
    expect(screen.queryByTestId('detail-actions-loading')).toBeNull();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Resolve',
      'Chat',
      'Open',
      'Drop',
    ]);
  });
});

describe('OtherDetail — host why-line placement', () => {
  const needsOwner = () => item({ authorizer: 'you', whyGated: 'owner-only' });

  it('keeps the why-line in the shared card by default', () => {
    render(<OtherDetail item={needsOwner()} onResolved={() => {}} />);
    expect(document.querySelector('.pc-items__why-line')?.textContent).toBe(
      'needs you · your ratification',
    );
  });

  it('omits the duplicate when a host renders the why-line in its own head', () => {
    render(<OtherDetail item={needsOwner()} whyPlacement="host" onResolved={() => {}} />);
    expect(document.querySelector('.pc-items__why-line')).toBeNull();
  });
});

describe('OtherDetail — item-open body presentation', () => {
  it('preserves paragraphs, marks inline tokens as code, and renders structured trailing facts', () => {
    render(
      <OtherDetail
        item={item({
          body: [
            'Call `plans:migrate-acceptance-bars`; server-side tools:invoke dispatch is required.',
            'The second paragraph stays separate.',
            'Tool: plans:migrate-acceptance-bars\nClear server mismatch: true',
          ].join('\n\n'),
        })}
        bodyPresentation="item-open"
        onResolved={() => {}}
      />,
    );
    const copy = screen.getByTestId('inbox-detail-body-copy');
    expect(copy.querySelectorAll(':scope > p')).toHaveLength(2);
    expect(Array.from(copy.querySelectorAll('code')).map((node) => node.textContent)).toEqual([
      'plans:migrate-acceptance-bars',
      'tools:invoke',
      'plans:migrate-acceptance-bars',
    ]);
    const facts = screen.getByTestId('inbox-detail-facts');
    expect(Array.from(facts.querySelectorAll('dt')).map((node) => node.textContent)).toEqual([
      'Tool',
      'Clear server mismatch',
    ]);
    expect(Array.from(facts.querySelectorAll('dd')).map((node) => node.textContent)).toEqual([
      'plans:migrate-acceptance-bars',
      'true',
    ]);
  });

  it('keeps the shared plain-text question presentation by default', () => {
    render(<OtherDetail item={item({ body: 'Use tools:invoke.' })} onResolved={() => {}} />);
    expect(document.querySelector('.ask-choice-question')?.tagName).toBe('P');
    expect(screen.queryByTestId('inbox-detail-body-copy')).toBeNull();
  });
});

/* ── inbox-three-column-resolver-states-2026-09-06 P-008 / D-003 ────────────
   The Resolution Inbox's split-page aside re-homes the card's six chips as a
   labelled metadata rail beside the body, so it asks the card NOT to render
   its own chip toolbar. The default (the Queue) is unchanged. */
describe('OtherDetail — host metadata placement (P-008)', () => {
  it('omits the chip toolbar when the host owns the metadata, keeping the body and its after-body actions', () => {
    render(
      <OtherDetail
        item={item({
          body: 'Full owner-visible description',
          category: 'deploy',
          importance: 'high',
          actions: undefined,
        })}
        actionsPlacement="after-body"
        metadataPlacement="host"
        onResolved={() => {}}
      />,
    );
    expect(document.querySelector('.pc-items__detail')?.getAttribute('data-metadata-placement')).toBe('host');
    expect(document.querySelector('.pc-items__detail-toolbar')).toBeNull();
    for (const chip of ['.pc-tier', '.pc-kind', '.pc-category', '.pc-count', '.pc-imp', '.pc-pill--harness']) {
      expect(document.querySelector(chip)).toBeNull();
    }
    const body = document.querySelector('.pc-items__detail-body');
    expect(body?.textContent).toContain('Full owner-visible description');
    expect(body?.contains(screen.getByTestId('detail-actions-loading'))).toBe(true);
  });

  it('keeps the toolbar for toolbar-placed actions even when the chips move to the host', () => {
    render(
      <OtherDetail
        item={item({ actions: undefined })}
        metadataPlacement="host"
        onResolved={() => {}}
      />,
    );
    const toolbar = document.querySelector('.pc-items__detail-toolbar');
    expect(toolbar).toBeTruthy();
    expect(toolbar?.querySelector('.pc-tier')).toBeNull();
    expect(toolbar?.querySelector('.pc-kind')).toBeNull();
    expect(toolbar?.contains(screen.getByTestId('detail-actions-loading'))).toBe(true);
  });

  it('default placement is unchanged — the chips render in the card toolbar', () => {
    render(<OtherDetail item={item({ category: 'deploy' })} onResolved={() => {}} />);
    expect(document.querySelector('.pc-items__detail')?.getAttribute('data-metadata-placement')).toBe('toolbar');
    const toolbar = document.querySelector('.pc-items__detail-toolbar');
    expect(toolbar?.querySelector('.pc-tier')?.textContent).toBe('Alerts');
    expect(toolbar?.querySelector('.pc-kind')?.textContent).toBe('escalation');
    expect(toolbar?.querySelector('.pc-category')?.textContent).toBe('deploy');
    expect(toolbar?.querySelector('.pc-count')?.textContent).toBe('open');
    expect(toolbar?.querySelector('.pc-pill--harness')?.textContent).toBe('h');
  });
});
