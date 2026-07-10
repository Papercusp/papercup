import { describe, it, expect } from 'vitest';
import { fingerprintIdList, idListUnchanged, rowKey } from './orient-list-delta';

describe('fingerprintIdList / idListUnchanged', () => {
  it('fingerprints an ordered id list as-is', () => {
    expect(fingerprintIdList(['a', 'b'])).toEqual({ ids: ['a', 'b'] });
  });

  it('unchanged: identical ordered ids ⇒ true', () => {
    expect(idListUnchanged({ ids: ['a', 'b'] }, ['a', 'b'])).toBe(true);
  });

  it('changed: different membership ⇒ false', () => {
    expect(idListUnchanged({ ids: ['a', 'b'] }, ['a', 'c'])).toBe(false);
  });

  it('changed: different length ⇒ false', () => {
    expect(idListUnchanged({ ids: ['a'] }, ['a', 'b'])).toBe(false);
  });

  it('changed: same membership, different order ⇒ false (conservative/safe direction)', () => {
    expect(idListUnchanged({ ids: ['a', 'b'] }, ['b', 'a'])).toBe(false);
  });

  it('both empty ⇒ true (nothing to deliver, nothing new)', () => {
    expect(idListUnchanged({ ids: [] }, [])).toBe(true);
  });

  it('fail-open: null committed ⇒ false (treat as changed/baseline, never silently skip)', () => {
    expect(idListUnchanged(null, ['a'])).toBe(false);
  });

  it('fail-open: unrecognizable committed shape ⇒ false', () => {
    expect(idListUnchanged({ ids: 'not-an-array' } as never, ['a'])).toBe(false);
    expect(idListUnchanged({ foo: 'bar' } as never, ['a'])).toBe(false);
  });
});

describe('rowKey', () => {
  it('prefers msg_id when present', () => {
    expect(rowKey({ msg_id: 'm1', ts: '2026-01-01T00:00:00Z' })).toBe('m1');
  });

  it('falls back to a ts|plan_slug|detail composite when msg_id is absent', () => {
    expect(rowKey({ ts: '2026-01-01T00:00:00Z', plan_slug: 'p1', detail: 'P-001' })).toBe(
      '2026-01-01T00:00:00Z|p1|P-001',
    );
  });

  it('falls back to summary when detail is absent', () => {
    expect(rowKey({ ts: '2026-01-01T00:00:00Z', summary: 'hi' })).toBe('2026-01-01T00:00:00Z||hi');
  });

  it('is stable/deterministic for the same row twice', () => {
    const row = { msg_id: 'm1' };
    expect(rowKey(row)).toBe(rowKey({ ...row }));
  });

  it('degrades gracefully for a non-object row', () => {
    expect(rowKey('opaque')).toBe(JSON.stringify('opaque'));
    expect(rowKey(null)).toBe(JSON.stringify(null));
  });
});
