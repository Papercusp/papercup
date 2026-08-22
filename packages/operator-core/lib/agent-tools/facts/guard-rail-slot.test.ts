/** EI-21154276512983646 — deterministic do-not-repeat facts need a durable slot. */
import { describe, expect, it } from 'vitest';
import { GUARD_RAIL_BODY_PREFIX, GUARD_RAIL_KEY_PREFIX, normalizeGuardRailSlot } from './assert';

describe('normalizeGuardRailSlot', () => {
  it('prefixes key and body onto the guard-rail encoding', () => {
    const r = normalizeGuardRailSlot(
      'd030-already-fired-do-not-refire',
      'D-030 already fired and must not be placed again.',
    );
    expect(r.key).toBe('guard-rail:d030-already-fired-do-not-refire');
    expect(r.body).toBe(`${GUARD_RAIL_BODY_PREFIX}D-030 already fired and must not be placed again.`);
  });

  it('is idempotent — re-asserting the same ruling does not stack markers', () => {
    const once = normalizeGuardRailSlot('d030-do-not-refire', 'already fired.');
    expect(normalizeGuardRailSlot(once.key, once.body)).toEqual(once);
  });

  it('recognizes an already-prefixed key case-insensitively while keeping the body marker exact', () => {
    expect(normalizeGuardRailSlot('GUARD-RAIL:already', 'x').key).toBe('GUARD-RAIL:already');
    expect(normalizeGuardRailSlot('k', `${GUARD_RAIL_BODY_PREFIX}x`).body).toBe(`${GUARD_RAIL_BODY_PREFIX}x`);
  });

  it('keeps the machine-greppable key and visible marker constants stable', () => {
    expect(GUARD_RAIL_KEY_PREFIX).toBe('guard-rail:');
    expect(GUARD_RAIL_BODY_PREFIX).toContain('GUARD RAIL');
  });
});
