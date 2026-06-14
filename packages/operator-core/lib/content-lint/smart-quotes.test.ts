import { describe, it, expect } from 'vitest';
import { CURLY, curlyLabel, findCodePositionCurlyQuotes } from './smart-quotes';

describe('CURLY regex', () => {
  it('matches each curly quote variant', () => {
    for (const ch of ['‘', '’', '“', '”']) {
      expect(CURLY.test(ch)).toBe(true);
    }
  });
  it('does not match straight ASCII quotes', () => {
    expect(CURLY.test(`'"`)).toBe(false);
    expect(CURLY.test('plain ascii code()')).toBe(false);
  });
});

describe('curlyLabel', () => {
  it('labels each curly variant with its codepoint', () => {
    expect(curlyLabel('‘')).toBe('U+2018 ‘');
    expect(curlyLabel('’')).toBe('U+2019 ’');
    expect(curlyLabel('“')).toBe('U+201C “');
    expect(curlyLabel('”')).toBe('U+201D ”');
  });
  it('falls back to a generic label for an unknown char', () => {
    expect(curlyLabel('x')).toBe('curly quote');
  });
});

describe('findCodePositionCurlyQuotes', () => {
  it('returns [] for a clean ASCII file (fast path, never parsed)', () => {
    expect(findCodePositionCurlyQuotes('a.ts', 'const x = 1;\nexport { x };')).toEqual([]);
  });

  it('does NOT flag a curly quote inside a string literal (zero false positive)', () => {
    // U+2019 apostrophe inside a normal double-quoted string parses cleanly.
    const text = 'const s = "it’s fine";\n';
    expect(findCodePositionCurlyQuotes('a.ts', text)).toEqual([]);
  });

  it('does NOT flag a curly quote inside a line comment', () => {
    const text = '// it’s a “comment”\nconst x = 1;\n';
    expect(findCodePositionCurlyQuotes('a.ts', text)).toEqual([]);
  });

  it('flags a curly quote used in code position (a parse error)', () => {
    // A curly double-quote cannot delimit a TS string → invalid-character diagnostic.
    const hits = findCodePositionCurlyQuotes('a.ts', 'const s = “hello”;');
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(CURLY.test(h.ch)).toBe(true);
      expect(h.line).toBeGreaterThanOrEqual(1);
      expect(h.col).toBeGreaterThanOrEqual(1);
    }
  });

  it('reports 1-based line/col for a code-position hit on a later line', () => {
    const hits = findCodePositionCurlyQuotes('a.ts', 'const x = 1;\nconst s = “bad”;');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.line).toBe(2);
  });

  it('parses .tsx with the TSX script kind and still detects code-position curlies', () => {
    const hits = findCodePositionCurlyQuotes('a.tsx', 'const s = “bad”;');
    expect(hits.length).toBeGreaterThan(0);
  });
});
