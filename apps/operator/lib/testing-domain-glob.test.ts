/**
 * Coverage for the pure glob engine in testing-domain-glob: splitPrefix (longest
 * literal prefix vs regex-eligible remainder) and remainderToRegex (the
 * *, **, ?, special-char-escape translation + unsupported-pattern guard). The
 * fs walk (expandGlob/walk) is out of scope here.
 */
import { describe, expect, it } from 'vitest';
import { splitPrefix, remainderToRegex } from './testing-domain-glob';

describe('splitPrefix', () => {
  it('returns the whole path + empty remainder when there is no metachar', () => {
    expect(splitPrefix('a/b/c.ts')).toEqual(['a/b/c.ts', '']);
  });
  it('splits at the path boundary before the first metachar', () => {
    expect(splitPrefix('a/b/*.ts')).toEqual(['a/b', '*.ts']);
    expect(splitPrefix('a/**/*.ts')).toEqual(['a', '**/*.ts']);
  });
  it('returns empty prefix when the metachar is in the first segment', () => {
    expect(splitPrefix('*.ts')).toEqual(['', '*.ts']);
    expect(splitPrefix('**/foo.ts')).toEqual(['', '**/foo.ts']);
    expect(splitPrefix('[abc]/x')).toEqual(['', '[abc]/x']);
  });
});

describe('remainderToRegex', () => {
  it('* matches within a segment but not across /', () => {
    const re = remainderToRegex('*.ts');
    expect(re.test('foo.ts')).toBe(true);
    expect(re.test('a/foo.ts')).toBe(false); // * is [^/]*
  });

  it('** matches across path segments', () => {
    const re = remainderToRegex('**/*.spec.ts');
    expect(re.test('foo.spec.ts')).toBe(true);
    expect(re.test('a/b/foo.spec.ts')).toBe(true);
    expect(re.test('a/b/foo.ts')).toBe(false);
  });

  it('? matches exactly one non-slash char', () => {
    const re = remainderToRegex('a?c');
    expect(re.test('abc')).toBe(true);
    expect(re.test('a/c')).toBe(false);
    expect(re.test('ac')).toBe(false);
  });

  it('escapes regex special chars so they match literally', () => {
    const re = remainderToRegex('a.b+c');
    expect(re.test('a.b+c')).toBe(true);
    expect(re.test('aXbXc')).toBe(false); // . and + are literal, not regex
  });

  it('is fully anchored (^...$)', () => {
    const re = remainderToRegex('foo.ts');
    expect(re.test('foo.ts')).toBe(true);
    expect(re.test('xfoo.ts')).toBe(false);
    expect(re.test('foo.tsx')).toBe(false);
  });

  it('throws on brace alternation and extglob', () => {
    expect(() => remainderToRegex('{a,b}.ts')).toThrow(/brace alternation/);
    expect(() => remainderToRegex('!(x).ts')).toThrow(/unsupported extglob/);
    expect(() => remainderToRegex('@(a|b).ts')).toThrow(/unsupported extglob/);
  });
});
