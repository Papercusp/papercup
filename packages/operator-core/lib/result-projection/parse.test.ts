/**
 * parse.ts — the fail-CLOSED half of the projection stage.
 *
 * The load-bearing case is the POSIX bracket expression: it compiles as a JS
 * RegExp, returns rows, and every row is wrong. A test that only checked "bad
 * input is rejected" would pass with that guard deleted, so it is asserted by
 * name here.
 */

import { describe, expect, it } from 'vitest';
import { MAX_PICK_PATHS, MAX_PIPELINE_STAGES, describeProjection, parseProjection } from './parse';

describe('parseProjection', () => {
  it('absent projection is not an error — it is the common path', () => {
    expect(parseProjection(undefined)).toEqual({ ok: true, spec: null });
    expect(parseProjection(null)).toEqual({ ok: true, spec: null });
  });

  it('rejects a non-object, and a spec with neither pick nor pipe', () => {
    expect(parseProjection('grep foo')).toMatchObject({ ok: false });
    expect(parseProjection({})).toMatchObject({ ok: false, error: expect.stringContaining('at least one') });
  });

  describe('grep', () => {
    it('accepts a plain regex and records nothing extra', () => {
      const r = parseProjection({ pipe: [{ op: 'grep', pattern: 'err(or)?' }] });
      expect(r).toEqual({ ok: true, spec: { pipe: [{ op: 'grep', pattern: 'err(or)?' }] } });
    });

    it('REFUSES a POSIX bracket expression — it is valid JS with a different meaning', () => {
      // [[:digit:]] in JS is a character class of [ : d i g t. It matches, and
      // every row it returns is wrong — the one divergence that must be refused
      // rather than reported, because it is invisible in the output.
      const r = parseProjection({ pipe: [{ op: 'grep', pattern: '^[[:digit:]]+ ' }] });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.error).toContain('POSIX');
      expect(r.error).toContain('fixed:true');
    });

    it('catches a POSIX class nested inside a compound bracket expression', () => {
      expect(parseProjection({ pipe: [{ op: 'grep', pattern: '[[:digit:][:alpha:]]' }] }).ok).toBe(false);
    });

    it('allows a POSIX-looking pattern when fixed:true — a literal has no flavor', () => {
      const r = parseProjection({ pipe: [{ op: 'grep', pattern: '[[:digit:]]', fixed: true }] });
      expect(r).toMatchObject({ ok: true });
    });

    it('rejects a pattern that is not a valid JS RegExp, and points at fixed:true', () => {
      const r = parseProjection({ pipe: [{ op: 'grep', pattern: '(unclosed' }] });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.error).toContain('fixed:true');
    });

    it('grep -C expands to both sides, but an explicit -A/-B wins', () => {
      const both = parseProjection({ pipe: [{ op: 'grep', pattern: 'x', context: 3 }] });
      expect(both).toMatchObject({ ok: true, spec: { pipe: [{ before: 3, after: 3 }] } });
      const override = parseProjection({ pipe: [{ op: 'grep', pattern: 'x', context: 3, after: 1 }] });
      expect(override).toMatchObject({ ok: true, spec: { pipe: [{ before: 3, after: 1 }] } });
    });

    it('rejects a negative context width', () => {
      expect(parseProjection({ pipe: [{ op: 'grep', pattern: 'x', after: -1 }] }).ok).toBe(false);
    });
  });

  it('head/tail require a non-negative integer', () => {
    expect(parseProjection({ pipe: [{ op: 'head', n: 20 }] }).ok).toBe(true);
    expect(parseProjection({ pipe: [{ op: 'head', n: 0 }] }).ok).toBe(true);
    expect(parseProjection({ pipe: [{ op: 'head', n: -5 }] }).ok).toBe(false);
    expect(parseProjection({ pipe: [{ op: 'tail', n: 1.5 }] }).ok).toBe(false);
    expect(parseProjection({ pipe: [{ op: 'tail' }] }).ok).toBe(false);
  });

  it('cut fields are 1-indexed and must be present', () => {
    expect(parseProjection({ pipe: [{ op: 'cut', fields: [1, 3] }] }).ok).toBe(true);
    expect(parseProjection({ pipe: [{ op: 'cut', fields: [0] }] }).ok).toBe(false);
    expect(parseProjection({ pipe: [{ op: 'cut', fields: [] }] }).ok).toBe(false);
  });

  it('rejects an unknown operator by name, listing the closed set', () => {
    const r = parseProjection({ pipe: [{ op: 'awk', pattern: 'x' }] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toContain('grep');
  });

  it('bounds the pipeline and the pick list', () => {
    const long = Array.from({ length: MAX_PIPELINE_STAGES + 1 }, () => ({ op: 'head', n: 1 }));
    expect(parseProjection({ pipe: long }).ok).toBe(false);
    const many = Array.from({ length: MAX_PICK_PATHS + 1 }, (_, i) => `a${i}`);
    expect(parseProjection({ pick: many }).ok).toBe(false);
  });

  it('pick entries must be non-empty strings and are trimmed', () => {
    expect(parseProjection({ pick: ['  results[].id  '] })).toEqual({
      ok: true,
      spec: { pick: ['results[].id'] },
    });
    expect(parseProjection({ pick: [''] }).ok).toBe(false);
    expect(parseProjection({ pick: [42] }).ok).toBe(false);
  });
});

describe('describeProjection — the reproducible echo D-041 requires', () => {
  it('renders the pipeline as the shell command it stands in for', () => {
    expect(
      describeProjection({
        pipe: [
          { op: 'grep', pattern: 'error', fixed: true, ignoreCase: true },
          { op: 'sort', unique: true },
          { op: 'head', n: 20 },
        ],
      }),
    ).toBe('grep -F -i "error" | sort -u | head -20');
  });

  it('renders symmetric context as -C and asymmetric as -B/-A', () => {
    expect(describeProjection({ pipe: [{ op: 'grep', pattern: 'x', before: 2, after: 2 }] })).toBe(
      'grep -C2 "x"',
    );
    expect(describeProjection({ pipe: [{ op: 'grep', pattern: 'x', before: 1, after: 4 }] })).toBe(
      'grep -B1 -A4 "x"',
    );
  });

  it('renders pick and count', () => {
    expect(describeProjection({ pick: ['results[].id'], pipe: [{ op: 'count' }] })).toBe(
      'pick results[].id | wc -l',
    );
  });
});
