import { describe, expect, it } from 'vitest';
import { parseSlotSelector, slotSelectorsIn, hasSlotSelector } from './slot-selector';

describe('parseSlotSelector', () => {
  it('parses @role / @wave / @feature / @user', () => {
    expect(parseSlotSelector('@role:scoper')).toEqual({ kind: 'role', ref: 'scoper' });
    expect(parseSlotSelector('@wave:W-03')).toEqual({ kind: 'wave', ref: 'W-03' });
    expect(parseSlotSelector('@feature:F-012')).toEqual({ kind: 'feature', ref: 'F-012' });
    expect(parseSlotSelector('@user:gh:12345')).toEqual({ kind: 'user', ref: 'gh:12345' });
  });

  it('keeps a colon-bearing @user ref intact (everything after @user: is the ref)', () => {
    // The offline-member mailbox address is an actorUserKey, which is itself
    // `gh:<id>` / a userId that may contain a colon — the prefix split must not
    // truncate it at the first inner colon.
    expect(parseSlotSelector('@user:gh:998877')).toEqual({ kind: 'user', ref: 'gh:998877' });
    expect(parseSlotSelector('@user:su-81fe49e5')).toEqual({ kind: 'user', ref: 'su-81fe49e5' });
  });

  it('trims whitespace around the ref', () => {
    expect(parseSlotSelector('@role:  scoper ')).toEqual({ kind: 'role', ref: 'scoper' });
    expect(parseSlotSelector('@user: gh:42 ')).toEqual({ kind: 'user', ref: 'gh:42' });
  });

  it('returns null for non-slot entries (plain ids, broadcast, audience selectors)', () => {
    for (const e of [
      'scoper',
      '*',
      'human',
      '@plan:my-plan',
      '@topic:x',
      '@object:feature:h#1',
      '@file:a.ts',
      '',
    ]) {
      expect(parseSlotSelector(e)).toBeNull();
    }
  });

  it('returns null for a recognised prefix with an empty ref (never an empty-ref park)', () => {
    expect(parseSlotSelector('@role:')).toBeNull();
    expect(parseSlotSelector('@wave:   ')).toBeNull();
    expect(parseSlotSelector('@user:')).toBeNull();
  });
});

describe('slotSelectorsIn', () => {
  it('collects + dedupes slot selectors, ignoring pass-throughs, keeping order', () => {
    const got = slotSelectorsIn(['alice', '@role:worker', '*', '@wave:W-01', '@role:worker', '@plan:p']);
    expect(got).toEqual([
      { kind: 'role', ref: 'worker' },
      { kind: 'wave', ref: 'W-01' },
    ]);
  });

  it('is empty when there are no slot selectors', () => {
    expect(slotSelectorsIn(['alice', '*', '@plan:p', 'human'])).toEqual([]);
  });
});

describe('hasSlotSelector', () => {
  it('detects presence and absence', () => {
    expect(hasSlotSelector(['alice', '@wave:W-2'])).toBe(true);
    expect(hasSlotSelector(['alice', '*', '@topic:t'])).toBe(false);
  });
});
