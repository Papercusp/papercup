import { describe, it, expect } from 'vitest';
import { InMemoryProjectionStore } from './in-memory-store';
import type { IndexedEntry } from './types';

type E = { label: string };
function row(
  sourceId: string,
  key: string,
  entryId: string,
  extra: Partial<IndexedEntry<E>> = {},
): IndexedEntry<E> {
  return { sourceId, key, entryId, entry: { label: entryId }, ...extra };
}

describe('InMemoryProjectionStore', () => {
  it('applyDelta upserts puts and removes deletes', async () => {
    const s = new InMemoryProjectionStore<E>();
    await s.applyDelta('s1', { put: [row('s1', 'k', 'a'), row('s1', 'k', 'b')], delete: [] });
    expect(s.size()).toBe(2);
    await s.applyDelta('s1', {
      put: [row('s1', 'k', 'a', { sortKey: 9 })], // upsert existing
      delete: [{ sourceId: 's1', key: 'k', entryId: 'b' }],
    });
    const rows = await s.byKey('k');
    expect(rows.map((r) => r.entryId)).toEqual(['a']);
    expect(rows[0].sortKey).toBe(9);
  });

  it('contributionsOf is scoped to one source', async () => {
    const s = new InMemoryProjectionStore<E>();
    await s.applyDelta('s1', { put: [row('s1', 'k', 'a')], delete: [] });
    await s.applyDelta('s2', { put: [row('s2', 'k', 'b')], delete: [] });
    expect((await s.contributionsOf('s1')).map((r) => r.entryId)).toEqual(['a']);
    expect((await s.contributionsOf('s2')).map((r) => r.entryId)).toEqual(['b']);
  });

  it('byKey filters by kind', async () => {
    const s = new InMemoryProjectionStore<E>();
    await s.applyDelta('s1', {
      put: [
        row('s1', 'k', 'a', { kind: 'decision' }),
        row('s1', 'k', 'b', { kind: 'insight' }),
        row('s1', 'k', 'c'), // no kind → excluded when a kinds filter is set
      ],
      delete: [],
    });
    expect((await s.byKey('k', { kinds: ['decision'] })).map((r) => r.entryId)).toEqual(['a']);
    expect((await s.byKey('k', { kinds: ['decision', 'insight'] })).map((r) => r.entryId).sort()).toEqual(
      ['a', 'b'],
    );
    expect((await s.byKey('k')).length).toBe(3); // no filter → all three
  });

  it('byKey sorts by sortKey asc/desc with undefined last, and is deterministic on ties', async () => {
    const s = new InMemoryProjectionStore<E>();
    await s.applyDelta('s1', {
      put: [
        row('s1', 'k', 'b', { sortKey: 2 }),
        row('s1', 'k', 'a', { sortKey: 1 }),
        row('s1', 'k', 'z'), // no sortKey
        row('s1', 'k', 'c', { sortKey: 2 }), // tie with b → tiebreak by identity
      ],
      delete: [],
    });
    expect((await s.byKey('k', { order: 'asc' })).map((r) => r.entryId)).toEqual(['a', 'b', 'c', 'z']);
    expect((await s.byKey('k', { order: 'desc' })).map((r) => r.entryId)).toEqual(['b', 'c', 'a', 'z']);
  });

  it('byKey applies limit after sort', async () => {
    const s = new InMemoryProjectionStore<E>();
    await s.applyDelta('s1', {
      put: [row('s1', 'k', 'a', { sortKey: 1 }), row('s1', 'k', 'b', { sortKey: 2 }), row('s1', 'k', 'c', { sortKey: 3 })],
      delete: [],
    });
    expect((await s.byKey('k', { limit: 2 })).map((r) => r.entryId)).toEqual(['a', 'b']);
    expect((await s.byKey('k', { order: 'desc', limit: 1 })).map((r) => r.entryId)).toEqual(['c']);
  });

  it('returned rows are clones — mutating them does not corrupt the store', async () => {
    const s = new InMemoryProjectionStore<E>();
    await s.applyDelta('s1', { put: [row('s1', 'k', 'a', { kind: 'decision' })], delete: [] });
    const [r] = await s.byKey('k');
    r.kind = 'tampered';
    r.key = 'tampered';
    expect((await s.byKey('k'))[0].kind).toBe('decision');
  });

  it('keys() and clear() introspection', async () => {
    const s = new InMemoryProjectionStore<E>();
    await s.applyDelta('s1', { put: [row('s1', 'k1', 'a'), row('s1', 'k2', 'b')], delete: [] });
    expect(s.keys().sort()).toEqual(['k1', 'k2']);
    s.clear();
    expect(s.size()).toBe(0);
  });

  // PI1 (PINNED — non-bug): the ref encoding uses a NUL separator, so two
  // contributions whose key/entryId fields differ only across a space boundary do
  // NOT overwrite each other in the Map. Both must persist as distinct rows.
  it('space-boundary keys persist as distinct rows (no silent overwrite)', async () => {
    const s = new InMemoryProjectionStore<E>();
    await s.applyDelta('s1', {
      put: [row('s1', 'topic a', 'd1'), row('s1', 'topic', 'a d1')],
      delete: [],
    });
    expect(s.size()).toBe(2);
    expect((await s.byKey('topic a')).map((r) => r.entryId)).toEqual(['d1']);
    expect((await s.byKey('topic')).map((r) => r.entryId)).toEqual(['a d1']);
  });

  // PI2 (PINNED): limit clamps to >=0, so 0 and negatives both yield [].
  it('byKey limit clamps non-positive values to an empty result', async () => {
    const s = new InMemoryProjectionStore<E>();
    await s.applyDelta('s1', {
      put: [row('s1', 'k', 'a', { sortKey: 1 }), row('s1', 'k', 'b', { sortKey: 2 })],
      delete: [],
    });
    expect(await s.byKey('k', { limit: 0 })).toEqual([]);
    expect(await s.byKey('k', { limit: -3 })).toEqual([]);
    // sanity: a positive limit still returns rows (clamp is non-positive only)
    expect((await s.byKey('k', { limit: 1 })).map((r) => r.entryId)).toEqual(['a']);
  });

  // PI2 (PINNED — documented caller error): a key mixing number and string sortKeys
  // has no well-defined cross-type order; JS `<`/`>` coerce, so the result is
  // deterministic-but-arbitrary. Callers must supply a homogeneous sortKey per key
  // (per the Contribution.sortKey contract). This pins that it does not throw and
  // is stable, NOT that the cross-type order is meaningful.
  it('mixed-type sortKey within a key does not throw and is stable (caller error)', async () => {
    const s = new InMemoryProjectionStore<E>();
    await s.applyDelta('s1', {
      put: [row('s1', 'k', 'num', { sortKey: 2 }), row('s1', 'k', 'str', { sortKey: 'apple' })],
      delete: [],
    });
    const first = (await s.byKey('k', { order: 'asc' })).map((r) => r.entryId);
    const second = (await s.byKey('k', { order: 'asc' })).map((r) => r.entryId);
    expect(first).toEqual(second); // deterministic across calls
    expect(first.sort()).toEqual(['num', 'str']); // both present, none dropped
  });
});
