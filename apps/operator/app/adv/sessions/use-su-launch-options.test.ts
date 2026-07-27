/**
 * use-su-launch-options — WI-6321.
 *
 * Covers the part the launcher tests stub out: turning psu's options endpoint
 * payload into picker rows, and staying usable when that endpoint is unavailable.
 * `normalizeAccountChoices` is pure, so it is tested directly rather than through
 * a rendered component.
 */
import { describe, expect, it } from 'vitest';
import { normalizeAccountChoices } from './use-su-launch-options';

describe('normalizeAccountChoices (WI-6321)', () => {
  it('accepts the bare-array shape', () => {
    expect(normalizeAccountChoices([{ id: 'a1', label: 'One' }])).toEqual([
      { id: 'a1', label: 'One', detail: null },
    ]);
  });

  it("accepts psu's { pool: [...] } shape — the form promptAccount receives", () => {
    // Both shapes appear across the account-routing work; assuming one would make
    // the whole picker vanish against the other.
    expect(normalizeAccountChoices({ pool: [{ id: 'a2' }] }).map((a) => a.id)).toEqual(['a2']);
  });

  it('accepts plain string ids', () => {
    expect(normalizeAccountChoices(['a3']).map((a) => a.id)).toEqual(['a3']);
  });

  it('takes `value` as the id when `id` is absent', () => {
    expect(normalizeAccountChoices([{ value: 'a4' }]).map((a) => a.id)).toEqual(['a4']);
  });

  it('drops rows with no resolvable id rather than rendering a blank option', () => {
    expect(normalizeAccountChoices([{ label: 'nameless' }, { id: 'ok' }]).map((a) => a.id)).toEqual([
      'ok',
    ]);
  });

  it('degrades to an empty list for a missing/unexpected payload, never throwing', () => {
    // Fail-soft is the contract: a launcher that will not open because the pool
    // list came back odd is worse than one offering just the default account.
    expect(normalizeAccountChoices(undefined)).toEqual([]);
    expect(normalizeAccountChoices(null)).toEqual([]);
    expect(normalizeAccountChoices('nonsense')).toEqual([]);
    expect(normalizeAccountChoices({ unexpected: true })).toEqual([]);
  });
});
