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
});
