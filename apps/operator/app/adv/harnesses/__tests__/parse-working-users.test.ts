/**
 * Phase 8 P-038 — UI read-path normalizer for the canonical
 * `harness_features_consolidated.working_users` BIGINT[] (v5 §0.5 / D-016).
 *
 * The array arrives over the consolidated SSE overlay in whatever shape the
 * transport serializes a BIGINT[] (number[], string[], JSON string, or a
 * Postgres "{1,2}" array literal). parseWorkingUsers normalizes all of them
 * to a clean number[] of positive ids so the FeaturesPanel "working" pill
 * renders the right count + current-worker (workingUsers[0]).
 */

import { describe, expect, it } from 'vitest';
import { parseWorkingUsers } from '../useHarnessData';

describe('parseWorkingUsers', () => {
  it('passes a number[] through', () => {
    expect(parseWorkingUsers([12345, 67890])).toEqual([12345, 67890]);
  });

  it('coerces a string[] to numbers', () => {
    expect(parseWorkingUsers(['12345', '67890'])).toEqual([12345, 67890]);
  });

  it('parses a Postgres array literal {1,2,3}', () => {
    expect(parseWorkingUsers('{1,2,3}')).toEqual([1, 2, 3]);
  });

  it('parses a JSON array string', () => {
    expect(parseWorkingUsers('[42, 43]')).toEqual([42, 43]);
  });

  it('treats empty array forms as undefined (no pill)', () => {
    expect(parseWorkingUsers([])).toBeUndefined();
    expect(parseWorkingUsers('{}')).toBeUndefined();
    expect(parseWorkingUsers('[]')).toBeUndefined();
    expect(parseWorkingUsers('')).toBeUndefined();
  });

  it('treats null/undefined as undefined', () => {
    expect(parseWorkingUsers(null)).toBeUndefined();
    expect(parseWorkingUsers(undefined)).toBeUndefined();
  });

  it('drops non-positive / non-integer ids', () => {
    expect(parseWorkingUsers([0, -1, 'x', 7])).toEqual([7]);
    expect(parseWorkingUsers('{0,-3,9}')).toEqual([9]);
  });

  it('preserves order (workingUsers[0] = current_worker per D-016)', () => {
    expect(parseWorkingUsers(['100', '5', '99'])).toEqual([100, 5, 99]);
  });

  it('returns undefined for unparseable garbage', () => {
    expect(parseWorkingUsers('not-an-array')).toBeUndefined();
    expect(parseWorkingUsers(42)).toBeUndefined();
  });
});
