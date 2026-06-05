import { describe, it, expect } from 'vitest';
import { computeDelta, refOf } from './diff';
import type { Contribution, IndexedEntry } from './types';

function prev(...rows: Array<[string, string, string]>): IndexedEntry<string>[] {
  return rows.map(([sourceId, key, entryId]) => ({ sourceId, key, entryId, entry: entryId }));
}
function next(...rows: Array<[string, string]>): Contribution<string>[] {
  return rows.map(([key, entryId]) => ({ key, entryId, entry: entryId }));
}

describe('refOf', () => {
  it('is stable and distinguishes the three fields', () => {
    expect(refOf('s', 'k', 'e')).toBe(refOf('s', 'k', 'e'));
    expect(refOf('s', 'k', 'e')).not.toBe(refOf('s', 'k', 'e2'));
    expect(refOf('s', 'k', 'e')).not.toBe(refOf('s', 'k2', 'e'));
    expect(refOf('s', 'k', 'e')).not.toBe(refOf('s2', 'k', 'e'));
  });
});

describe('computeDelta', () => {
  it('first index: all contributions are puts, nothing to delete', () => {
    const d = computeDelta('s1', [], next(['topicA', 'd1'], ['topicB', 'd1']));
    expect(d.delete).toEqual([]);
    expect(d.put).toEqual([
      { sourceId: 's1', key: 'topicA', entryId: 'd1', entry: 'd1' },
      { sourceId: 's1', key: 'topicB', entryId: 'd1', entry: 'd1' },
    ]);
  });

  it('unchanged re-index: idempotent puts, no deletes', () => {
    const p = prev(['s1', 'topicA', 'd1']);
    const d = computeDelta('s1', p, next(['topicA', 'd1']));
    expect(d.delete).toEqual([]);
    expect(d.put).toHaveLength(1);
  });

  it('dropped entry: removed entry becomes a delete', () => {
    const p = prev(['s1', 'topicA', 'd1'], ['s1', 'topicA', 'd2']);
    const d = computeDelta('s1', p, next(['topicA', 'd1']));
    expect(d.put.map((x) => x.entryId)).toEqual(['d1']);
    expect(d.delete).toEqual([{ sourceId: 's1', key: 'topicA', entryId: 'd2' }]);
  });

  it('retag: same entryId moved to a new key = delete old key + put new key', () => {
    const p = prev(['s1', 'topicA', 'd1']);
    const d = computeDelta('s1', p, next(['topicB', 'd1']));
    expect(d.delete).toEqual([{ sourceId: 's1', key: 'topicA', entryId: 'd1' }]);
    expect(d.put).toEqual([{ sourceId: 's1', key: 'topicB', entryId: 'd1', entry: 'd1' }]);
  });

  it('only diffs the given source (prev is already source-scoped)', () => {
    const p = prev(['s1', 'topicA', 'd1'], ['s1', 'topicA', 'gone']);
    const d = computeDelta('s1', p, next(['topicA', 'd1']));
    expect(d.delete).toEqual([{ sourceId: 's1', key: 'topicA', entryId: 'gone' }]);
  });

  it('throws on a duplicate (key, entryId) in the projection', () => {
    expect(() => computeDelta('s1', [], next(['topicA', 'd1'], ['topicA', 'd1']))).toThrow(
      /duplicate contribution/,
    );
  });

  it('same entryId under two different keys is NOT a duplicate', () => {
    expect(() => computeDelta('s1', [], next(['topicA', 'd1'], ['topicB', 'd1']))).not.toThrow();
  });
});
