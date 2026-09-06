// @vitest-environment node
/**
 * P-003 / D-002 — the LIST-FEED action-retention contract.
 *
 * The `plans.attention` list feed still clips the large body, but it RETAINS the
 * small `actions` array so the selected pane can paint its controls without
 * waiting for the per-item `plans.attentionItem` detail fetch. The field remains
 * optional because legacy snapshots and partial producers can omit it.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM attention-card.test.ts:
 * nothing failed when the original omission bug shipped because every card
 * fixture was fully populated. A hand-written list row would repeat that blind
 * spot, so these tests drive the REAL projection and consume what it emits.
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
      { id: 'open', label: 'Open' },
      { id: 'drop', label: 'Drop' },
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
  it('retains all four action descriptors through the real list projection', () => {
    const row = throughListFeed(producerItem());
    expect(row.actions).toEqual([
      { id: 'mark-done', label: 'Resolve', primary: true },
      { id: 'chat', label: 'Chat' },
      { id: 'open', label: 'Open' },
      { id: 'drop', label: 'Drop' },
    ]);
    expect(row.id).toBe('x');
    expect(row.title).toBe('Title');
  });

  it('turns the projected list row into all four options immediately', () => {
    const row = throughListFeed(producerItem()) as unknown as AttentionItem;
    expect(attentionItemToCardSpec(row).options.map((o) => o.id)).toEqual([
      'mark-done',
      'chat',
      'open',
      'drop',
    ]);
  });

  it('still tolerates a producer that genuinely omits the optional field', () => {
    const row = throughListFeed(producerItem({ actions: undefined })) as unknown as AttentionItem;
    expect(() => attentionItemToCardSpec(row)).not.toThrow();
    expect(attentionItemToCardSpec(row).options).toEqual([]);
  });

  it('expands an escalation action directly from the projected list row', () => {
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
    expect(attentionItemToCardSpec(row).options.map((o) => o.id)).toContain('opt-a');
  });
});

/**
 * COMPILE-TIME half of the guard. `actions` stays OPTIONAL on `AttentionItem`
 * because producer absence remains legal even though the projection now keeps
 * the field whenever it is present.
 */
type ListFeedRow = Omit<AttentionItem, 'actions'>;
export const _actionsMustStayOptional = (row: ListFeedRow): AttentionItem => row;
