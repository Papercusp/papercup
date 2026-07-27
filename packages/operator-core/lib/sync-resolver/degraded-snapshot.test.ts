import { describe, expect, it } from 'vitest';
import {
  classifyReadFailure,
  degraded,
  degradedBecause,
  isUnavailable,
  isUndefinedTable,
  REASON_MAX,
  reasonOf,
} from './degraded-snapshot';

describe('isUndefinedTable', () => {
  it('matches only SQLSTATE 42P01', () => {
    expect(isUndefinedTable(Object.assign(new Error('x'), { code: '42P01' }))).toBe(true);
    expect(isUndefinedTable(Object.assign(new Error('x'), { code: '42703' }))).toBe(false);
    expect(isUndefinedTable(new Error('x'))).toBe(false);
    expect(isUndefinedTable(null)).toBe(false);
    expect(isUndefinedTable(undefined)).toBe(false);
  });
});

describe('reasonOf', () => {
  it('prefers the Error message, stringifies anything else', () => {
    expect(reasonOf(new Error('permission denied'))).toBe('permission denied');
    expect(reasonOf('raw string')).toBe('raw string');
  });

  it('never yields an empty reason — an unavailability with no cause is the bug', () => {
    expect(reasonOf(new Error(''))).toBe('unknown read failure');
    expect(reasonOf(undefined)).toBe('undefined');
  });

  it('clamps to REASON_MAX', () => {
    expect(reasonOf(new Error('x'.repeat(5000)))).toHaveLength(REASON_MAX);
  });
});

describe('classifyReadFailure', () => {
  it('separates the pre-migration case from a genuine read failure', () => {
    expect(classifyReadFailure(Object.assign(new Error('nope'), { code: '42P01' }))).toEqual({
      kind: 'pre-migration',
      reason: 'nope',
    });
    expect(classifyReadFailure(Object.assign(new Error('denied'), { code: '42501' }))).toEqual({
      kind: 'read-failed',
      reason: 'denied',
    });
  });
});

describe('degraded', () => {
  it('preserves the empty shape EXACTLY so existing consumers keep working', () => {
    const out = degraded({ hives: [], generatedAt: 'T' }, new Error('boom'));
    expect(out.hives).toEqual([]);
    expect(out.generatedAt).toBe('T');
  });

  it('is distinguishable from the bare empty it wraps — the whole point of WI-6382', () => {
    const empty = { hives: [] };
    expect(degraded(empty, new Error('boom'))).not.toEqual(empty);
  });

  it('carries the cause verbatim (a bare "unavailable" is a dead end for the reader)', () => {
    const out = degraded({ rows: [] }, new Error('Cannot find package mem0ai/node_modules/uuid'));
    expect(out.unavailable).toBe(true);
    expect(out.unavailableKind).toBe('read-failed');
    expect(out.unavailableReason).toBe('Cannot find package mem0ai/node_modules/uuid');
  });

  it('does not mutate the empty it was handed (shared EMPTY_* constants are module-level)', () => {
    // Several resolvers pass a SHARED constant (EMPTY_EKG_SNAPSHOT,
    // EMPTY_MTTSH_VITALS, …). Tagging one in place would permanently poison
    // every later healthy read that returns the same object.
    const SHARED = Object.freeze({ rows: [] as unknown[] });
    const out = degraded(SHARED, new Error('boom'));
    expect(out.unavailable).toBe(true);
    expect(SHARED).not.toHaveProperty('unavailable');
  });
});

describe('degradedBecause', () => {
  it('states a non-throw cause the resolver can see directly', () => {
    const out = degradedBecause({ rows: [] }, 'no pots registered in this workspace');
    expect(out.unavailable).toBe(true);
    expect(out.unavailableReason).toBe('no pots registered in this workspace');
    expect(out.unavailableKind).toBe('read-failed');
  });

  it('accepts an explicit kind', () => {
    expect(degradedBecause({ rows: [] }, 'table absent', 'pre-migration').unavailableKind).toBe(
      'pre-migration',
    );
  });
});

describe('isUnavailable', () => {
  it('is true ONLY for a degraded snapshot, never for an observed empty', () => {
    expect(isUnavailable({ hives: [] })).toBe(false);
    expect(isUnavailable(degraded({ hives: [] }, new Error('boom')))).toBe(true);
    expect(isUnavailable(null)).toBe(false);
    expect(isUnavailable(undefined)).toBe(false);
  });
});
