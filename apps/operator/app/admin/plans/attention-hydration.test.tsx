// @vitest-environment jsdom
/**
 * `useHydratedAttentionItem` — the client half of the attention list/detail
 * split (slim-plans-attention-sync-payload-2026-07-26 P-005).
 *
 * The `plans.attention` list feed is slimmed at the sync boundary (body clipped
 * to 280, action descriptors retained), so `OtherDetail` paints actions from
 * the list row and merges the full item back over it. Everything that can go
 * wrong with that merge is here:
 *
 *   - the pane must PAINT from the list row immediately (no spinner), so the
 *     hook returns the list row while the detail is in flight;
 *   - `actionsReady` is true immediately for a current list row and remains
 *     false for a legacy/partial row until the full row lands;
 *   - a detail response for a DIFFERENT id must never be merged: selection can
 *     change while a fetch is in flight, and merging the previous item's body
 *     onto the new row is a silent, plausible-looking corruption;
 *   - a failed/empty detail fetch degrades to the list row rather than blanking.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';

const H = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown[]; loading: boolean; error: unknown; invalidate: () => void }>,
}));
const blank = () => ({ data: [] as unknown[], loading: false, error: null as unknown, invalidate: () => {} });
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: ({ queryName, enabled }: { queryName: string; enabled?: boolean }) =>
    enabled === false ? blank() : (H.results[queryName] ?? blank()),
}));

import { useHydratedAttentionItem, type AttentionItem } from './plans-api';

const listRow = (over: Partial<AttentionItem> = {}): AttentionItem =>
  ({
    id: 'a1',
    kind: 'coord-escalation',
    title: 'Needs a decision',
    // The slimmed list shape: clipped body. Callers opt into an actions array.
    body: 'clipped preview…',
    bodyTruncated: true,
    ...over,
  }) as unknown as AttentionItem;

const detailRow = (over: Partial<AttentionItem> = {}): AttentionItem =>
  ({
    id: 'a1',
    kind: 'coord-escalation',
    title: 'Needs a decision',
    body: 'the full untruncated body of the escalation',
    actions: [{ id: 'resolve', label: 'Resolve' }],
    ref: { kind: 'coord-escalation', options: [{ id: 'x' }] },
  }) as unknown as AttentionItem;

const setDetail = (rows: unknown[]) => {
  H.results['plans.attentionItem'] = { ...blank(), data: rows };
};

afterEach(() => {
  cleanup();
  H.results = {};
});

describe('useHydratedAttentionItem', () => {
  it('returns the list row unhydrated while the detail fetch is in flight', () => {
    setDetail([]);
    const { result } = renderHook(() => useHydratedAttentionItem(listRow()));
    expect(result.current.hydrated).toBe(false);
    expect(result.current.actionsReady).toBe(false);
    // Paints immediately from the list row — no null/blank pane.
    expect(result.current.item?.title).toBe('Needs a decision');
    expect(result.current.item?.body).toBe('clipped preview…');
  });

  it('marks retained list actions ready before the detail response lands', () => {
    setDetail([]);
    const { result } = renderHook(() =>
      useHydratedAttentionItem(
        listRow({ actions: [{ id: 'resolve', label: 'Resolve' }] }),
      ),
    );
    expect(result.current.hydrated).toBe(false);
    expect(result.current.actionsReady).toBe(true);
    expect(result.current.item?.actions).toHaveLength(1);
  });

  it('merges the full row over the list row once it lands', () => {
    setDetail([detailRow()]);
    const { result } = renderHook(() => useHydratedAttentionItem(listRow()));
    expect(result.current.hydrated).toBe(true);
    expect(result.current.actionsReady).toBe(true);
    expect(result.current.item?.body).toBe('the full untruncated body of the escalation');
    expect(result.current.item?.actions).toHaveLength(1);
    expect(result.current.item?.ref).toBeTruthy();
  });

  it('keeps list-only fields the detail row happens to omit', () => {
    // The merge is list-row-first so a field the list computes (or a server
    // that predates a field) is not blanked by the detail response.
    setDetail([detailRow()]);
    const { result } = renderHook(() =>
      useHydratedAttentionItem(listRow({ triageNote: 'operator note' } as Partial<AttentionItem>)),
    );
    expect((result.current.item as unknown as { triageNote: string }).triageNote).toBe('operator note');
  });

  it('IGNORES a detail response for a different id (selection changed mid-flight)', () => {
    // The dangerous case: merging would show item a1's body under item a2.
    setDetail([detailRow({ id: 'a1' })]);
    const { result } = renderHook(() => useHydratedAttentionItem(listRow({ id: 'a2' })));
    expect(result.current.hydrated).toBe(false);
    expect(result.current.actionsReady).toBe(false);
    expect(result.current.item?.id).toBe('a2');
    expect(result.current.item?.body).toBe('clipped preview…');
  });

  it('degrades to the list row when the detail fetch returns nothing', () => {
    setDetail([]);
    const { result } = renderHook(() => useHydratedAttentionItem(listRow()));
    expect(result.current.item).not.toBeNull();
    expect(result.current.hydrated).toBe(false);
    expect(result.current.actionsReady).toBe(false);
  });

  it('handles a null selection without fetching', () => {
    setDetail([detailRow()]);
    const { result } = renderHook(() => useHydratedAttentionItem(null));
    expect(result.current.item).toBeNull();
    expect(result.current.hydrated).toBe(false);
    expect(result.current.actionsReady).toBe(false);
  });
});
