/**
 * Tests for the pure docs:* utilities (no fumadocs loader needed).
 * Run with: npx vitest run packages/docs-engine/src/shared.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  reactToText,
  escapeRegex,
  humanize,
  levenshtein,
  levenshteinNearest,
  sliceByHeading,
  truncationTail,
  MAX_PAYLOAD_BYTES,
  type TocEntry,
} from './shared';

describe('reactToText', () => {
  it('passes through strings and numbers', () => {
    expect(reactToText('hi')).toBe('hi');
    expect(reactToText(42)).toBe('42');
  });

  it('concatenates arrays', () => {
    expect(reactToText(['a', 1, 'b'])).toBe('a1b');
  });

  it('recurses into React-element-shaped { props: { children } }', () => {
    expect(reactToText({ props: { children: 'x' } })).toBe('x');
    expect(reactToText({ props: { children: ['a', { props: { children: 'b' } }] } })).toBe('ab');
  });

  it('returns "" for null/undefined/plain objects', () => {
    expect(reactToText(null)).toBe('');
    expect(reactToText(undefined)).toBe('');
    expect(reactToText({})).toBe('');
  });
});

describe('escapeRegex', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeRegex('a.b*c+d?')).toBe('a\\.b\\*c\\+d\\?');
    expect(escapeRegex('(x)[y]{z}')).toBe('\\(x\\)\\[y\\]\\{z\\}');
  });

  it('leaves ordinary characters untouched', () => {
    expect(escapeRegex('plain text 123')).toBe('plain text 123');
  });

  it('round-trips as a literal in a RegExp', () => {
    const lit = 'a.b';
    expect(new RegExp(`^${escapeRegex(lit)}$`).test('a.b')).toBe(true);
    expect(new RegExp(`^${escapeRegex(lit)}$`).test('aXb')).toBe(false);
  });
});

describe('humanize', () => {
  it('title-cases a kebab slug', () => {
    expect(humanize('feature-flags')).toBe('Feature Flags');
    expect(humanize('a-b-c')).toBe('A B C');
  });

  it('handles a single word', () => {
    expect(humanize('overview')).toBe('Overview');
  });

  it('preserves empty segments from a double hyphen', () => {
    expect(humanize('a--b')).toBe('A  B');
  });
});

describe('levenshtein', () => {
  it('is 0 for equal strings', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
  });

  it('equals the other length when one side is empty', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('counts single edits', () => {
    expect(levenshtein('a', 'b')).toBe(1); // substitute
    expect(levenshtein('ab', 'abc')).toBe(1); // insert
    expect(levenshtein('abc', 'ab')).toBe(1); // delete
  });

  it('matches the classic kitten→sitting = 3', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });

  it('short-circuits to Infinity over the length bound (100)', () => {
    expect(levenshtein('x'.repeat(101), 'y')).toBe(Infinity);
  });
});

describe('levenshteinNearest', () => {
  it('returns candidates within the default ratio, sorted by distance', () => {
    const near = levenshteinNearest('color', ['colour', 'colors', 'completely-different', 'xyz']);
    expect(near).toContain('colour');
    expect(near).toContain('colors');
    expect(near).not.toContain('xyz');
    expect(near).not.toContain('completely-different');
  });

  it('respects the k cap', () => {
    const near = levenshteinNearest('color', ['colour', 'colors', 'colon'], { k: 1 });
    expect(near).toHaveLength(1);
  });

  it('returns [] when nothing is within the ratio', () => {
    expect(levenshteinNearest('color', ['zzzzzzzz', 'wholly-other'])).toEqual([]);
  });
});

describe('sliceByHeading', () => {
  const md = '# Title\n\n## Section A\n\ncontent A\n\n## Section B\n\ncontent B';
  const toc: TocEntry[] = [
    { url: '#section-a', title: 'Section A', depth: 2 },
    { url: '#section-b', title: 'Section B', depth: 2 },
  ];

  it('slices from a heading to the next equal-depth heading', () => {
    expect(sliceByHeading(md, 'section-a', toc)).toBe('## Section A\n\ncontent A');
  });

  it('slices the last section to EOF', () => {
    expect(sliceByHeading(md, 'section-b', toc)).toBe('## Section B\n\ncontent B');
  });

  it('returns null for a missing TOC entry', () => {
    expect(sliceByHeading(md, 'no-such-id', toc)).toBeNull();
  });

  it('returns null when the heading text is absent from the markdown', () => {
    const badToc: TocEntry[] = [{ url: '#ghost', title: 'Ghost Heading', depth: 2 }];
    expect(sliceByHeading(md, 'ghost', badToc)).toBeNull();
  });
});

describe('truncationTail', () => {
  it('points at the first H2 id when there is one', () => {
    const tail = truncationTail({ firstH2Id: 'intro', h2Count: 5 });
    expect(tail).toContain('heading="intro"');
    expect(tail).toContain('5 H2 headings');
    expect(tail).toContain(String(MAX_PAYLOAD_BYTES));
  });

  it('explains there is nothing to slice on when there are no H2s', () => {
    const tail = truncationTail({ h2Count: 0 });
    expect(tail).toContain('no H2 headings');
  });
});
