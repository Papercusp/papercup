/**
 * Unit coverage for the /api/admin/plans/* argument-coercion helper.
 *
 * `bodyFromSearchParams` projects a browser GET's query string into
 * the JSON body the plans:* tools expect (they register POST-only and
 * read args from `req.body`). The coercion gate is subtle enough to
 * have shipped a real bug — searching the literal word "true" via
 * plans:search was being rewritten to the boolean `true` — so it gets
 * its own focused regression test.
 */
import { describe, expect, it } from 'vitest';
import {
  bodyFromSearchParams,
  PLANS_BOOLEAN_KEYS,
} from '../routes/admin/_plans-args';

const sp = (q: string) => new URLSearchParams(q);

describe('bodyFromSearchParams', () => {
  it('forwards string args verbatim', () => {
    expect(bodyFromSearchParams(sp('slug=my-plan-2026-05-20'))).toEqual({
      slug: 'my-plan-2026-05-20',
    });
  });

  it('coerces true/false for boolean-keyed args', () => {
    expect(bodyFromSearchParams(sp('includeArchived=true'))).toEqual({
      includeArchived: true,
    });
    expect(bodyFromSearchParams(sp('includeLegacy=false'))).toEqual({
      includeLegacy: false,
    });
    expect(bodyFromSearchParams(sp('actionable=true&needsHuman=false'))).toEqual({
      actionable: true,
      needsHuman: false,
    });
  });

  it('does NOT coerce a free-text query that happens to equal "true"', () => {
    // Regression: `query` is not a boolean key. A search for the word
    // "true" must stay a string or Zod (z.string().min(1)) rejects it.
    expect(bodyFromSearchParams(sp('query=true'))).toEqual({ query: 'true' });
    expect(bodyFromSearchParams(sp('query=false'))).toEqual({ query: 'false' });
  });

  it('does not coerce true/false for non-boolean keys generally', () => {
    expect(bodyFromSearchParams(sp('status=true'))).toEqual({ status: 'true' });
    expect(bodyFromSearchParams(sp('owner=false'))).toEqual({ owner: 'false' });
  });

  it('collapses repeated keys into an array', () => {
    expect(bodyFromSearchParams(sp('paths=a&paths=b&paths=c'))).toEqual({
      paths: ['a', 'b', 'c'],
    });
  });

  it('drops a boolean-keyed arg whose value is neither true nor false', () => {
    // Garbage in → key omitted, so the tool falls back to its default.
    expect(bodyFromSearchParams(sp('includeArchived=maybe'))).toEqual({});
  });

  it('keeps an empty-string value for a non-boolean key', () => {
    expect(bodyFromSearchParams(sp('slug='))).toEqual({ slug: '' });
  });

  it('returns an empty object for an empty query string', () => {
    expect(bodyFromSearchParams(sp(''))).toEqual({});
  });

  it('handles a realistic plans:list query', () => {
    expect(
      bodyFromSearchParams(sp('status=active&includeArchived=true&includeLegacy=false')),
    ).toEqual({ status: 'active', includeArchived: true, includeLegacy: false });
  });

  it('exposes exactly the five known boolean keys', () => {
    expect([...PLANS_BOOLEAN_KEYS].sort()).toEqual(
      ['actionable', 'includeArchived', 'includeHistory', 'includeLegacy', 'needsHuman'],
    );
  });
});
