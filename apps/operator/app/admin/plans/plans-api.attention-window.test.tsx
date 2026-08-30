// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttentionGroup, AttentionItem } from './plans-api';

const H = vi.hoisted(() => ({
  pages: new Map<number, unknown[]>(),
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({
    args,
    enabled = true,
  }: {
    args?: Record<string, unknown>;
    enabled?: boolean;
  }) => {
    const offset = typeof args?.offset === 'number' ? args.offset : 0;
    return {
      data: enabled ? H.pages.get(offset) ?? [] : [],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
  },
}));

import {
  mergeAttentionGroupPages,
  readAttentionPageMeta,
  usePlanAttention,
} from './plans-api';

function row(id: string): AttentionItem {
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
  } as AttentionItem;
}

function page(
  offset: number,
  ids: string[],
  total: number,
  hasMore: boolean,
  nextOffset: number | null,
): AttentionGroup[] {
  return [
    {
      key: 'alerts:workspace',
      kind: 'alerts',
      title: 'Alerts',
      planSlug: undefined,
      harnessSlug: undefined,
      maxImportance: 'normal',
      items: ids.map(row),
      _meta: {
        total,
        totalCount: total,
        offset,
        limit: ids.length || 2,
        returned: ids.length,
        hasMore,
        nextOffset,
      },
    } as unknown as AttentionGroup,
  ];
}

afterEach(() => {
  H.pages.clear();
});

describe('attention window client contract', () => {
  it('finds metadata after a delta moves the carrier row', () => {
    const groups = [
      { key: 'a', kind: 'alerts', items: [], title: 'A' },
      {
        ...page(2, ['c'], 3, false, null)[0],
        key: 'b',
      },
    ] as unknown as AttentionGroup[];
    expect(readAttentionPageMeta(groups)).toMatchObject({
      total: 3,
      offset: 2,
      returned: 1,
      hasMore: false,
    });
  });

  it('merges pages in offset order and de-duplicates repeated ids', () => {
    const merged = mergeAttentionGroupPages([
      page(0, ['a', 'shared'], 3, true, 2),
      page(2, ['shared', 'c'], 3, false, null),
    ]);
    expect(merged[0]?.items.map((i) => i.id)).toEqual(['a', 'shared', 'c']);
  });

  it('loads a continuation page without replacing the first page', async () => {
    H.pages.set(0, page(0, ['a', 'b'], 3, true, 2));
    H.pages.set(2, page(2, ['c'], 3, false, null));
    const { result } = renderHook(() => usePlanAttention({ pageSize: 2 }));

    expect(result.current.hasMore).toBe(true);
    expect(result.current.totalItemCount).toBe(3);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadedItemCount).toBe(3));

    expect(result.current.data?.groups[0]?.items.map((i) => i.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(result.current.hasMore).toBe(false);
  });
});
