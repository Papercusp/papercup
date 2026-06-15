import { describe, it, expect } from 'vitest';
import { admitConflictFree } from './admit-conflict-free';

const t = (id: string, files?: string[]) => ({ id, files });

describe('admitConflictFree', () => {
  it('admits all disjoint tasks', () => {
    const { admitted, deferred } = admitConflictFree([t('a', ['x']), t('b', ['y']), t('c', ['z'])]);
    expect(admitted.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(deferred).toEqual([]);
  });

  it('defers a task whose files overlap a running (in-use) file', () => {
    const { admitted, deferred } = admitConflictFree([t('a', ['foo.ts'])], ['foo.ts']);
    expect(admitted).toEqual([]);
    expect(deferred.map((x) => x.id)).toEqual(['a']);
  });

  it('defers the lower-priority of two siblings sharing a file (input order = priority)', () => {
    const { admitted, deferred } = admitConflictFree([t('hi', ['shared.ts']), t('lo', ['shared.ts'])]);
    expect(admitted.map((x) => x.id)).toEqual(['hi']);
    expect(deferred.map((x) => x.id)).toEqual(['lo']);
  });

  it('always admits a task with no declared touch-set (file-lock backstop)', () => {
    const { admitted, deferred } = admitConflictFree([t('none'), t('empty', [])], ['anything.ts']);
    expect(admitted.map((x) => x.id)).toEqual(['none', 'empty']);
    expect(deferred).toEqual([]);
  });

  it('an admitted task blocks a later sibling overlapping any of its files', () => {
    const { admitted, deferred } = admitConflictFree([
      t('a', ['p.ts', 'q.ts']),
      t('b', ['q.ts']), // overlaps a's q.ts
      t('c', ['r.ts']),
    ]);
    expect(admitted.map((x) => x.id)).toEqual(['a', 'c']);
    expect(deferred.map((x) => x.id)).toEqual(['b']);
  });

  it('is pure — does not mutate its inputs', () => {
    const tasks = [t('a', ['x'])];
    const inUse = ['y'];
    admitConflictFree(tasks, inUse);
    expect(tasks).toHaveLength(1);
    expect(inUse).toEqual(['y']);
  });
});
