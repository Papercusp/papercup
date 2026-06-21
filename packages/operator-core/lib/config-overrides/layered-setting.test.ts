/**
 * layered-setting.test.ts — the generalized user-over-base merge (P-038).
 *
 * Asserts the helper is concern-agnostic (works for ANY declared override-key set, not just
 * voice) and preserves the exact null/undefined-is-unset, false/0/'' -is-a-value rule that
 * voice-prefs depends on.
 *
 * Run: cd packages/operator-core && npx vitest run lib/config-overrides/layered-setting.test.ts
 */
import { describe, expect, it } from 'vitest';
import { mergeLayered } from './layered-setting';

describe('mergeLayered (generalized layered-setting)', () => {
  it('returns the base unchanged when the override layer is empty', () => {
    const base = { a: 1, b: 'x', c: true };
    expect(mergeLayered(base, {}, ['a', 'b', 'c'])).toEqual(base);
  });

  it('overrides only allowlisted keys; ignores keys outside the set', () => {
    const base = { a: 1, b: 2 };
    const merged = mergeLayered(base, { a: 9, b: 9, rogue: 'nope' }, ['a']);
    expect(merged.a).toBe(9);
    expect(merged.b).toBe(2); // b not in allowlist
    expect((merged as Record<string, unknown>).rogue).toBeUndefined();
  });

  it('treats null and undefined as "not set" — falls through to base', () => {
    const base = { a: 5, b: 6 };
    expect(mergeLayered(base, { a: null }, ['a', 'b']).a).toBe(5);
    expect(mergeLayered(base, { b: undefined }, ['a', 'b']).b).toBe(6);
  });

  it('honors false, 0, and "" as real overriding values', () => {
    const base = { flag: true, count: 5, label: 'default' };
    const merged = mergeLayered(base, { flag: false, count: 0, label: '' }, ['flag', 'count', 'label']);
    expect(merged).toEqual({ flag: false, count: 0, label: '' });
  });

  it('works for an arbitrary (non-voice) concern shape', () => {
    // Demonstrates the generalization: a rate-limit-shaped base + per-user override.
    const base = { maxSimultaneousAgents: 8, concurrencyFloor: 1 };
    const merged = mergeLayered(base, { maxSimultaneousAgents: 2 }, ['maxSimultaneousAgents', 'concurrencyFloor']);
    expect(merged).toEqual({ maxSimultaneousAgents: 2, concurrencyFloor: 1 });
  });

  it('does not mutate the base object', () => {
    const base = { a: 1 };
    mergeLayered(base, { a: 2 }, ['a']);
    expect(base.a).toBe(1);
  });
});
