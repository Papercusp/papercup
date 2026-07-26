import { describe, it, expect } from 'vitest';
import { parseWorkRefs } from './parse-work-refs';

describe('parseWorkRefs (chat-ref-pills-2026-07-26 P-001)', () => {
  it('extracts a single WI- ref with correct positions and uppercased id', () => {
    const text = 'see WI-5927 for detail';
    const refs = parseWorkRefs(text);
    expect(refs).toEqual([{ kind: 'work-item', id: 'WI-5927', start: 4, end: 11 }]);
    expect(text.slice(refs[0].start, refs[0].end)).toBe('WI-5927');
  });

  it('extracts EI-, F-, and P- refs with the right kind split', () => {
    const text = 'EI-42 blocks F-100 which blocks P-001';
    const refs = parseWorkRefs(text);
    expect(refs).toEqual([
      { kind: 'work-item', id: 'EI-42', start: 0, end: 5 },
      { kind: 'work-item', id: 'F-100', start: 13, end: 18 },
      { kind: 'plan-item', id: 'P-001', start: 32, end: 37 },
    ]);
  });

  it('returns matches sorted by position regardless of kind grouping', () => {
    const text = 'P-002 then WI-1 then F-3';
    const refs = parseWorkRefs(text);
    expect(refs.map((r) => r.id)).toEqual(['P-002', 'WI-1', 'F-3']);
    expect(refs.map((r) => r.start)).toEqual([0, 11, 21]);
  });

  it('reports every occurrence, not just the first', () => {
    const refs = parseWorkRefs('WI-1 ... WI-1 again');
    expect(refs).toHaveLength(2);
    expect(refs[0].start).not.toBe(refs[1].start);
  });

  it('returns [] for empty/falsy input', () => {
    expect(parseWorkRefs('')).toEqual([]);
  });

  describe('non-matches: mid-word', () => {
    it('does not match a ref glued to a preceding letter', () => {
      expect(parseWorkRefs('XWI-123 is not a ref')).toEqual([]);
    });

    it('does not match a ref glued to a trailing letter/digit', () => {
      expect(parseWorkRefs('WI-123abc is not a ref')).toEqual([]);
      expect(parseWorkRefs('see WI-1234x')).toEqual([]);
    });

    it('is case-sensitive — lowercase prefixes are not refs', () => {
      expect(parseWorkRefs('wi-123 ei-42 f-9 p-001')).toEqual([]);
    });

    it('requires >=3 digits for a plan-item id (P-01 is not a real shape)', () => {
      expect(parseWorkRefs('P-01 is too short')).toEqual([]);
      expect(parseWorkRefs('P-1 is too short')).toEqual([]);
    });

    it('matches when preceded/followed by punctuation, not letters', () => {
      const refs = parseWorkRefs('(WI-5927), see also [F-3].');
      expect(refs.map((r) => r.id)).toEqual(['WI-5927', 'F-3']);
    });
  });

  describe('non-matches: inline code', () => {
    it('does not match inside a single-backtick code span', () => {
      expect(parseWorkRefs('call `parseWorkRefs("WI-123")` please')).toEqual([]);
    });

    it('does not match inside a multi-backtick code span containing a backtick', () => {
      expect(parseWorkRefs('``code with a ` backtick and WI-9`` end')).toEqual([]);
    });

    it('still matches prose outside the code span', () => {
      const refs = parseWorkRefs('WI-1 then `code WI-2` then WI-3');
      expect(refs.map((r) => r.id)).toEqual(['WI-1', 'WI-3']);
    });
  });

  describe('non-matches: fenced code blocks', () => {
    it('does not match inside a fenced block', () => {
      const text = ['before WI-1', '```ts', 'const x = "WI-2";', '```', 'after WI-3'].join('\n');
      const refs = parseWorkRefs(text);
      expect(refs.map((r) => r.id)).toEqual(['WI-1', 'WI-3']);
    });

    it('treats an unterminated fence as fenced to end of text', () => {
      const text = 'before WI-1\n```\nunterminated WI-2 stays hidden';
      const refs = parseWorkRefs(text);
      expect(refs.map((r) => r.id)).toEqual(['WI-1']);
    });
  });

  describe('non-matches: inside an existing markdown link', () => {
    it('does not match a ref used as the link label', () => {
      expect(parseWorkRefs('[WI-123](https://example.com/x)')).toEqual([]);
    });

    it('does not match a ref inside the link URL', () => {
      expect(parseWorkRefs('[see it](https://example.com/WI-123)')).toEqual([]);
    });

    it('does not match inside an image reference', () => {
      expect(parseWorkRefs('![WI-123](https://example.com/x.png)')).toEqual([]);
    });

    it('still matches prose outside the link', () => {
      const refs = parseWorkRefs('WI-1 see [details](https://x) WI-2');
      expect(refs.map((r) => r.id)).toEqual(['WI-1', 'WI-2']);
    });
  });
});
