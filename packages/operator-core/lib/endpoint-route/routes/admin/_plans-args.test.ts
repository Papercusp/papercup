/**
 * Unit tests for the /api/admin/plans/* query→body coercion helper (_plans-args.ts):
 * the explicit boolean/number allowlists and the load-bearing invariant that a
 * free-text value which merely LOOKS boolean/numeric is forwarded verbatim.
 * (whole-app-test-coverage-breadth-2026-06-14.)
 */
import { describe, expect, it } from 'vitest';
import { bodyFromSearchParams, PLANS_BOOLEAN_KEYS, PLANS_NUMBER_KEYS } from './_plans-args';

const body = (qs: string) => bodyFromSearchParams(new URLSearchParams(qs));

describe('bodyFromSearchParams', () => {
  it('forwards a single non-special value verbatim as a string', () => {
    expect(body('slug=my-plan')).toEqual({ slug: 'my-plan' });
    expect(body('foo=')).toEqual({ foo: '' });
  });

  it('collects a repeated key into a string[] (single → string, not array)', () => {
    expect(body('paths=a&paths=b')).toEqual({ paths: ['a', 'b'] });
    expect(body('paths=a')).toEqual({ paths: 'a' });
  });

  it('coerces an allowlisted boolean key from true/false; drops garbage', () => {
    expect(body('includeArchived=true')).toEqual({ includeArchived: true });
    expect(body('actionable=false')).toEqual({ actionable: false });
    expect(body('needsHuman=yes')).toEqual({}); // garbage for a boolean key → dropped
  });

  it('coerces an allowlisted number key; drops non-finite garbage', () => {
    expect(body('limit=25')).toEqual({ limit: 25 });
    expect(body('limit=1.5')).toEqual({ limit: 1.5 });
    expect(body('limit=abc')).toEqual({}); // non-numeric → dropped (tool default kicks in)
  });

  it('does NOT coerce a free-text value that merely LOOKS boolean/numeric (load-bearing)', () => {
    // `query` is not in the allowlists — a search for the literal word "true" must stay a string,
    // or Zod's z.string().min(1) on plans:search rejects the rewritten boolean.
    expect(body('query=true')).toEqual({ query: 'true' });
    expect(body('query=42')).toEqual({ query: '42' });
  });

  it('handles a mix of all forms in one query', () => {
    expect(body('slug=p1&includeArchived=true&limit=5&paths=x&paths=y&query=false')).toEqual({
      slug: 'p1',
      includeArchived: true,
      limit: 5,
      paths: ['x', 'y'],
      query: 'false',
    });
  });

  it('returns an empty object for an empty query', () => {
    expect(body('')).toEqual({});
  });
});

describe('the coercion allowlists', () => {
  it('PLANS_BOOLEAN_KEYS lists exactly the z.boolean() args', () => {
    expect([...PLANS_BOOLEAN_KEYS].sort()).toEqual([
      'actionable',
      'includeArchived',
      'includeHistory',
      'includeLegacy',
      'needsHuman',
    ]);
  });

  it('PLANS_NUMBER_KEYS lists exactly the z.number() args', () => {
    expect([...PLANS_NUMBER_KEYS].sort()).toEqual([
      'audit_rows',
      'debug_max_chars',
      'files_back',
      'limit',
      'notes_max_chars',
    ]);
  });
});
