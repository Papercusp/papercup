// @vitest-environment node
/**
 * WI-6551 — the LIST-FEED SHAPE regression.
 *
 * The `plans.attention` list feed is slimmed at the sync boundary: it DROPS
 * `actions`, which is re-supplied only when the per-item `plans.attentionItem`
 * detail fetch lands. Between first paint and that fetch, every consumer sees an
 * item with NO `actions` — and `attentionItemToCardSpec` iterated it unguarded,
 * threw, and React replaced the ENTIRE HUD tab with an error panel
 * ("undefined is not an object (evaluating 'item.actions')", owner-visible).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM attention-card.test.ts:
 * nothing failed when that bug shipped. Every existing fixture — including
 * `item()` in attention-card.test.ts — is FULLY POPULATED (`actions: []`), so no
 * test had ever rendered the list-feed shape. A fixture that hand-omits the field
 * would be an improvement but still just an assertion about a hand-written
 * object; if the projection later dropped a DIFFERENT field, the fixture would
 * happily keep passing.
 *
 * So these tests drive the REAL projection (`projectPlansReadForUi`, the same
 * function the sync boundary calls) and consume WHAT IT ACTUALLY EMITS. The
 * fixture is the producer shape; the projection decides what reaches the UI.
 */
import { describe, expect, it } from 'vitest';
import { projectPlansReadForUi } from '@papercusp/operator-core/lib/agent-tools/plans/ui-read-projection';

import { attentionItemToCardSpec } from './attention-card';
import type { AttentionItem } from './plans-api';

/** The PRODUCER shape — what the adapters emit, before the sync boundary slims it. */
function producerItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 'x',
    kind: 'plan-item',
    source: 'plan',
    harnessSlug: 'h',
    planSlug: 'p',
    itemRef: 'P-7',
    title: 'Title',
    body: 'Body text',
    status: 'needs-human',
    importance: 'normal',
    tier: 'decision',
    needsHuman: true,
    ownerAgentId: undefined,
    ownerLabel: undefined,
    triageState: 'untriaged',
    triageNote: undefined,
    triagedBy: undefined,
    triagedAt: undefined,
    actions: [
      { id: 'mark-done', label: 'Resolve', primary: true },
      { id: 'chat', label: 'Chat' },
    ],
    ref: { kind: 'plan-item' },
    ...overrides,
  };
}

/** Push a producer item through the REAL list-feed projection and get the row back. */
function throughListFeed(item: AttentionItem): Record<string, unknown> {
  const projected = projectPlansReadForUi('attention', {
    groups: [{ planSlug: 'p', items: [item] }],
  }) as { groups: { items: Record<string, unknown>[] }[] };
  return projected.groups[0].items[0];
}

describe('the plans.attention LIST feed shape', () => {
  it('really does drop `actions` (guards this whole file against going vacuous)', () => {
    // If the projection ever stops dropping `actions`, every test below would
    // still pass while testing NOTHING — they would be handed a fully-populated
    // item. This asserts the precondition the rest of the file depends on.
    const row = throughListFeed(producerItem());
    expect('actions' in row).toBe(false);
    expect(row.actions).toBeUndefined();
    // …and that it is a slim of a REAL item, not an empty object.
    expect(row.id).toBe('x');
    expect(row.title).toBe('Title');
  });

  it('the projected row is genuinely the CRASHING shape (non-vacuity)', () => {
    // The tests below assert "does not throw". That is only meaningful if the
    // input would throw under the ORIGINAL unguarded code — otherwise they pass
    // while proving nothing, which is precisely how the outage shipped green.
    // Reproduce the original `for (const a of item.actions)` here: it MUST still
    // throw on this row. If it ever stops, the fixture has drifted off the real
    // list-feed shape and every "does not throw" below has quietly gone vacuous.
    const row = throughListFeed(producerItem());
    expect(() => {
      for (const _a of row.actions as unknown as Iterable<unknown>) {
        /* the exact unguarded read that took down the HUD tab */
      }
    }).toThrow();
  });

  it('attentionItemToCardSpec does not throw on a list-feed row (the HUD crash)', () => {
    const row = throughListFeed(producerItem()) as unknown as AttentionItem;
    expect(() => attentionItemToCardSpec(row)).not.toThrow();
  });

  it('a list-feed row yields no action-derived options, rather than crashing', () => {
    const row = throughListFeed(producerItem()) as unknown as AttentionItem;
    const spec = attentionItemToCardSpec(row);
    // The producer had 2 actions; post-projection they are simply not here yet.
    // Correct behaviour is an empty/actionless card, NOT an exception.
    const ids = spec.options.map((o) => o.id);
    expect(ids).not.toContain('mark-done');
    expect(ids).not.toContain('chat');
  });

  it('the SAME item hydrated (detail fetch landed) does produce its actions', () => {
    // The complement of the test above: proves the empty result is a property of
    // the LIST shape, not of attentionItemToCardSpec being broken for everyone.
    const spec = attentionItemToCardSpec(producerItem());
    expect(spec.options.map((o) => o.id)).toContain('chat');
  });

  it('survives an escalation row whose actions the feed dropped', () => {
    // The escalation path expands `resolve`/`mark-done` into per-option buttons,
    // a second read of `actions` — regression-cover it on the list shape too.
    const row = throughListFeed(
      producerItem({
        kind: 'coord-escalation',
        ref: {
          kind: 'coord-escalation',
          msgId: 'm1',
          options: [{ id: 'opt-a', label: 'Option A' }],
        },
      }),
    ) as unknown as AttentionItem;
    expect(() => attentionItemToCardSpec(row)).not.toThrow();
  });
});

/**
 * COMPILE-TIME half of the guard. `actions` must stay OPTIONAL on `AttentionItem`:
 * the moment it goes back to required, a list-feed row (which lacks it) stops
 * being a valid `AttentionItem` and this function fails to typecheck — which is
 * exactly the type lie that let the original crash through tsc unnoticed.
 */
type ListFeedRow = Omit<AttentionItem, 'actions'>;
export const _actionsMustStayOptional = (row: ListFeedRow): AttentionItem => row;
