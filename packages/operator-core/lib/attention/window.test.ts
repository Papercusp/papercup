import { describe, expect, it } from 'vitest';
import { paginateAttentionGroups } from './window';
import type { AttentionGroup } from './group';
import type { AttentionItem } from './types';

function item(
  id: string,
  over: Partial<AttentionItem> = {},
): AttentionItem {
  return {
    id,
    kind: 'coord-message',
    source: 'test',
    title: id,
    body: id,
    status: 'open',
    importance: 'normal',
    tier: 'activity',
    needsHuman: false,
    ref: { kind: 'coord-message' },
    triageState: 'untriaged',
    ...over,
  } as AttentionItem;
}

function group(key: string, items: AttentionItem[]): AttentionGroup {
  return {
    key,
    kind: 'alerts',
    planSlug: null,
    harnessSlug: null,
    title: key,
    items,
    maxImportance: 'normal',
  };
}

describe('paginateAttentionGroups', () => {
  it('orders by tier, importance, recency, and stable id before slicing', () => {
    const result = paginateAttentionGroups([
      group('alerts:workspace', [
        item('old-decision', {
          tier: 'decision',
          needsHuman: true,
          importance: 'low',
          occurredAt: '2026-08-01T00:00:00.000Z',
        }),
        item('urgent-alert', {
          tier: 'alert',
          importance: 'urgent',
          occurredAt: '2026-08-30T00:00:00.000Z',
        }),
        item('new-decision', {
          tier: 'decision',
          needsHuman: true,
          importance: 'urgent',
          occurredAt: '2026-08-02T00:00:00.000Z',
        }),
        item('activity', { occurredAt: '2026-08-31T00:00:00.000Z' }),
      ]),
    ], { limit: 2 });

    expect(result.groups[0]?.items.map((row) => row.id)).toEqual([
      'new-decision',
      'old-decision',
    ]);
    expect(result.meta).toMatchObject({
      total: 4,
      totalCount: 4,
      offset: 0,
      limit: 2,
      returned: 2,
      hasMore: true,
      nextOffset: 2,
    });
  });

  it('de-duplicates ids across synthetic groups and keeps group metadata', () => {
    const result = paginateAttentionGroups([
      group('alerts:a', [
        item('shared', { tier: 'alert', importance: 'high' }),
        item('a-only'),
      ]),
      group('alerts:b', [
        item('shared', { tier: 'alert', importance: 'high' }),
        item('b-only'),
      ]),
    ], { limit: null });

    expect(result.meta).toMatchObject({
      total: 3,
      returned: 3,
      hasMore: false,
      nextOffset: null,
      limit: null,
    });
    expect(result.groups.map((row) => [row.key, row.items.map((i) => i.id)])).toEqual([
      ['alerts:a', ['shared', 'a-only']],
      ['alerts:b', ['b-only']],
    ]);
  });

  it('normalizes hostile bounds and reports exhaustion for an empty page', () => {
    const result = paginateAttentionGroups([group('g', [item('a')])], {
      limit: 0,
      offset: 1_000_001,
    });
    expect(result.groups).toEqual([]);
    expect(result.meta).toEqual({
      total: 1,
      totalCount: 1,
      offset: 1_000_000,
      limit: 1,
      returned: 0,
      hasMore: false,
      nextOffset: null,
    });
  });
});
