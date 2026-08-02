/**
 * EI-19282401068515102 — the mock-cast-escape detector + ratchet gate.
 *
 * The case that motivated it (WI-6673): fixtures for `readIssueClaimability` were
 * installed via `.mockImplementation((...) => ({...})) as never)`, so adding the
 * required `admitted` field went unnoticed by tsc and took 14 tests down at runtime.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs guard script, no type declarations by design
import { decide, findMatchingParen, findMockCastEscapesInText, maskStringsAndComments } from '../../../../scripts/check-mock-cast-escape.mjs';

describe('maskStringsAndComments', () => {
  it('blanks out line comments but preserves line breaks (so line numbers stay correct)', () => {
    const src = 'const a = 1; // as never) fake\nconst b = 2;';
    const masked = maskStringsAndComments(src);
    expect(masked).not.toContain('as never');
    expect(masked.split('\n')).toHaveLength(2);
  });

  it('blanks out block comments spanning multiple lines', () => {
    const src = '/* a mock call\n   .mockResolvedValue(x as never) */\nreal();';
    const masked = maskStringsAndComments(src);
    expect(masked).not.toContain('mockResolvedValue');
    expect(masked.split('\n')).toHaveLength(3);
  });

  it('blanks out string literal contents but keeps quotes/length', () => {
    const src = `const s = "not a mock(1 as never)";`;
    const masked = maskStringsAndComments(src);
    expect(masked).not.toContain('mock(1 as never)');
    expect(masked.length).toBe(src.length);
  });

  it('blanks template literal text but leaves ${...} interpolation live', () => {
    const src = 'const t = `literal text as never ${real(x as never)}`;';
    const masked = maskStringsAndComments(src);
    expect(masked).not.toContain('literal text as never');
    expect(masked).toContain('real(x as never)');
  });
});

describe('findMatchingParen', () => {
  it('finds the matching close paren across nested parens/braces', () => {
    const text = 'foo(bar({ a: (1 + 2) }), baz())';
    const openIndex = text.indexOf('(');
    const closeIndex = findMatchingParen(text, openIndex);
    expect(text[closeIndex]).toBe(')');
    expect(closeIndex).toBe(text.length - 1);
  });

  it('returns -1 when the call never closes (unbalanced)', () => {
    const text = 'foo(bar(';
    expect(findMatchingParen(text, 3)).toBe(-1);
  });
});

describe('findMockCastEscapesInText', () => {
  it('flags a single-line `.mockResolvedValue(... as never)`', () => {
    const src = `recM.mockResolvedValue(null as never);`;
    const found = findMockCastEscapesInText(src);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ line: 1, verb: 'mockResolvedValue', kind: 'never' });
  });

  it('flags `.mockReturnValue(... as any)`', () => {
    const src = `fn.mockReturnValue(x as any);`;
    const found = findMockCastEscapesInText(src);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('any');
  });

  it('flags a multi-line `.mockImplementation((...) => ({...})) as never)` call', () => {
    const src = [
      'readM.mockImplementation((async (_filter, _opts, readOpts) => ({',
      '  breakdown: BREAKDOWN,',
      '  rows: [],',
      '})) as never);',
    ].join('\n');
    const found = findMockCastEscapesInText(src);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ line: 1, verb: 'mockImplementation', kind: 'never' });
  });

  it('flags `Once` variants too', () => {
    const src = `candM.mockResolvedValueOnce([] as never);`;
    const found = findMockCastEscapesInText(src);
    expect(found).toHaveLength(1);
    expect(found[0].verb).toBe('mockResolvedValueOnce');
  });

  it('does NOT flag a mock call whose argument is properly typed (no cast)', () => {
    const src = `recM.mockResolvedValue(null);`;
    expect(findMockCastEscapesInText(src)).toHaveLength(0);
  });

  it('does NOT flag a cast to a REAL type — only a bare `as never`/`as any`', () => {
    const src = `fn.mockReturnValue(x as any as ReturnType<typeof realFn>);`;
    expect(findMockCastEscapesInText(src)).toHaveLength(0);
  });

  it('does NOT flag `as never` appearing only in a comment or string', () => {
    const src = [
      '// old code used to do: fn.mockReturnValue(x as never)',
      'fn.mockReturnValue(realValue);',
    ].join('\n');
    expect(findMockCastEscapesInText(src)).toHaveLength(0);
  });

  it('counts multiple occurrences across the same file, each with its own line number', () => {
    const src = ['a.mockResolvedValue(1 as never);', 'b.mockReturnValue(2 as any);'].join('\n');
    const found = findMockCastEscapesInText(src);
    expect(found.map((f) => f.line)).toEqual([1, 2]);
  });
});

describe('decide (ratchet-only-down policy)', () => {
  it('fails when the count exceeds the baseline', () => {
    expect(decide({ count: 10, baselineCount: 5 })).toEqual({ verdict: 'fail-exceeds' });
  });

  it('reports ok-below (never auto-locks) when the count drops without --update', () => {
    expect(decide({ count: 3, baselineCount: 5 })).toEqual({ verdict: 'ok-below', belowBy: 2 });
  });

  it('ratchets the baseline down only when --update is explicit', () => {
    expect(decide({ count: 3, baselineCount: 5, updateFlag: true })).toEqual({
      verdict: 'ok-ratchet',
      newBaseline: 3,
    });
  });

  it('is ok when the count exactly equals the baseline', () => {
    expect(decide({ count: 5, baselineCount: 5 })).toEqual({ verdict: 'ok' });
  });
});
