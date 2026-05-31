/**
 * Coverage for the shared operator form validators (slug + semver) and the
 * fieldError helper. These rules are duplicated as a server-side backstop, so
 * locking the grammar here guards against client/server drift.
 */
import { describe, expect, it } from 'vitest';
import { slugSchema, semverSchema, fieldError } from './validators';

describe('slugSchema', () => {
  it.each(['foo', 'f', 'foo-bar', 'a.b_c', 'pkg123', '@owner/name', '@ab/b.c-d'])(
    'accepts %j',
    (s) => {
      expect(slugSchema.safeParse(s).success).toBe(true);
    },
  );

  it.each([
    ['', 'empty'],
    ['Foo', 'uppercase'],
    ['-leading', 'leading punctuation'],
    ['.dot', 'leading dot'],
    ['foo/bar', 'unscoped slash'],
    ['@Owner/name', 'uppercase in scope'],
    ['@owner', 'scope without name'],
    ['@a/bc', 'single-char scope (scoped form requires >=2 each side)'],
  ])('rejects %j (%s)', (s) => {
    expect(slugSchema.safeParse(s).success).toBe(false);
  });

  it('trims surrounding whitespace before validating', () => {
    expect(slugSchema.safeParse('  foo  ').success).toBe(true);
  });
});

describe('semverSchema', () => {
  it.each(['0.1.0', '1.2.3', '10.20.30', '1.2.3-beta.1', '1.0.0-rc-1'])('accepts %j', (s) => {
    expect(semverSchema.safeParse(s).success).toBe(true);
  });

  it.each(['1.2', 'v1.0.0', '1.2.3.4', '1.2.3-BETA', 'x.y.z', ''])('rejects %j', (s) => {
    expect(semverSchema.safeParse(s).success).toBe(false);
  });
});

describe('fieldError', () => {
  it('returns null for a valid value', () => {
    expect(fieldError(slugSchema, 'ok-slug')).toBeNull();
  });

  it('returns the first issue message for an invalid value', () => {
    expect(fieldError(semverSchema, '1.2')).toBe('semver, e.g. 0.1.0');
  });

  it('surfaces the required message for empty input', () => {
    expect(fieldError(slugSchema, '')).toBe('required');
  });
});
