import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { fuzzyEnum, nearestByLevenshtein } from './fuzzy-enum';

describe('nearestByLevenshtein', () => {
  it('returns the closest candidate for a near-miss', () => {
    expect(nearestByLevenshtein('green', ['red', 'green', 'blue'])).toEqual(['green']); // exact
    expect(nearestByLevenshtein('gren', ['red', 'green', 'blue'])[0]).toBe('green'); // 1 edit
  });
  it('returns [] for a wildly-wrong value (beyond maxRatio → caller shows the full list)', () => {
    expect(nearestByLevenshtein('zzzzzzzz', ['red', 'green', 'blue'])).toEqual([]);
  });
  it('caps the result at k, nearest-first', () => {
    const out = nearestByLevenshtein('abcd', ['abcd', 'abc', 'ab', 'xyzw'], { k: 2, maxRatio: 1 });
    expect(out.length).toBeLessThanOrEqual(2);
    expect(out[0]).toBe('abcd');
  });
});

describe('fuzzyEnum', () => {
  const parse = (schema: z.ZodType<string>, v: string) => schema.safeParse(v);
  const msgOf = (r: ReturnType<typeof parse>) => (r.success ? '' : r.error.issues[0].message);

  it('accepts a value in the set', () => {
    expect(parse(fuzzyEnum(['red', 'green', 'blue']), 'green').success).toBe(true);
  });

  it('rejects a near-miss with a nearest-match suggestion + the allowed list', () => {
    const r = parse(fuzzyEnum(['red', 'green', 'blue'], { label: 'color' }), 'gren');
    expect(r.success).toBe(false);
    expect(msgOf(r)).toContain('not a valid color');
    expect(msgOf(r)).toContain('Did you mean `green`?');
    expect(msgOf(r)).toContain('Allowed: [red, green, blue]');
  });

  it('rejects a no-match with the full list and NO misleading suggestion', () => {
    const r = parse(fuzzyEnum(['red', 'green', 'blue']), 'zzzzzz');
    expect(r.success).toBe(false);
    expect(msgOf(r)).not.toContain('Did you mean');
    expect(msgOf(r)).toContain('Allowed: [red, green, blue]');
  });

  it('FAILS OPEN when the resolved set is empty (an unavailable resolver never blocks a call)', () => {
    expect(parse(fuzzyEnum([]), 'anything').success).toBe(true);
    expect(parse(fuzzyEnum(() => []), 'anything').success).toBe(true);
  });

  it('supports a SYNC resolver and re-reads it each call (dynamic set)', () => {
    let live = ['a', 'b'];
    const schema = fuzzyEnum(() => live);
    expect(parse(schema, 'a').success).toBe(true);
    expect(parse(schema, 'c').success).toBe(false);
    live = ['c', 'd'];
    expect(parse(schema, 'c').success).toBe(true);
  });

  it('the `applies` predicate scopes validation (out-of-scope values pass untouched)', () => {
    const onlyLocal = fuzzyEnum(['ollama-cc/ornith-a', 'ollama-cc/ornith-b'], {
      applies: (v) => v.startsWith('ollama-cc/'),
      label: 'model',
    });
    expect(parse(onlyLocal, 'opus:high').success).toBe(true); // not a local model → skipped
    const r = parse(onlyLocal, 'ollama-cc/ornith-x'); // local typo → validated
    expect(r.success).toBe(false);
    expect(msgOf(r)).toContain('ollama-cc/ornith-');
  });

  it('normalize maps variant spellings to the canonical candidate (no false reject of a valid model)', () => {
    // The registry stores BARE ids; a leader passes the ollama-cc/-prefixed form.
    const schema = fuzzyEnum(['maxwell1500/ornith-35b:IQ3_M', 'ornith'], {
      applies: (v) => /ornith|ollama/i.test(v),
      normalize: (v) => v.replace(/^ollama(-cc)?\//i, ''),
      label: 'local model',
    });
    // valid prefixed + valid bare both PASS (the bug this guards against)
    expect(parse(schema, 'ollama-cc/maxwell1500/ornith-35b:IQ3_M').success).toBe(true);
    expect(parse(schema, 'ornith').success).toBe(true);
    // a prefixed TYPO is rejected and suggests the canonical (bare) id
    const r = parse(schema, 'ollama-cc/maxwell1500/ornith-35b');
    expect(r.success).toBe(false);
    expect(msgOf(r)).toContain('Did you mean `maxwell1500/ornith-35b:IQ3_M`');
  });

  it('caps the echoed allowed-list to bound the payload', () => {
    const many = Array.from({ length: 40 }, (_, i) => `model-${i}`);
    const r = parse(fuzzyEnum(many, { maxListed: 5 }), 'zzz');
    expect(msgOf(r)).toContain('(+35 more)');
  });

  it('carries structured params { got, nearest } when the schema lib preserves them (bonus channel)', () => {
    const r = parse(fuzzyEnum(['red', 'green', 'blue']), 'gren');
    const issue = r.success ? undefined : (r.error.issues[0] as unknown as { params?: Record<string, unknown> });
    if (issue?.params) {
      expect(issue.params.got).toBe('gren');
      expect(issue.params.nearest).toContain('green');
    }
  });
});
