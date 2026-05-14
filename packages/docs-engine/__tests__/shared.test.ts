import { describe, it, expect } from 'vitest';
import {
  reactToText,
  escapeRegex,
  humanize,
  levenshtein,
  levenshteinNearest,
  sliceByHeading,
  truncationTail,
  MAX_PAYLOAD_BYTES,
} from '../src/shared';

describe('reactToText', () => {
  it('returns string for strings', () => expect(reactToText('foo')).toBe('foo'));
  it('returns string for numbers', () => expect(reactToText(42)).toBe('42'));
  it('joins arrays', () => expect(reactToText(['a', 'b', 'c'])).toBe('abc'));
  it('unwraps React-element-shaped objects', () => {
    const node = { props: { children: 'inline code' } };
    expect(reactToText(node)).toBe('inline code');
  });
  it('recursively unwraps nested elements', () => {
    const node = { props: { children: ['prefix ', { props: { children: 'inner' } }, ' suffix'] } };
    expect(reactToText(node)).toBe('prefix inner suffix');
  });
  it('returns empty for null/undefined/random', () => {
    expect(reactToText(null)).toBe('');
    expect(reactToText(undefined)).toBe('');
    expect(reactToText({})).toBe('');
  });
});

describe('escapeRegex', () => {
  it('escapes special characters', () => {
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c');
    expect(escapeRegex('()|[]')).toBe('\\(\\)\\|\\[\\]');
  });
});

describe('humanize', () => {
  it('title-cases kebab-case', () => expect(humanize('endpoint-system')).toBe('Endpoint System'));
  it('handles single word', () => expect(humanize('agents')).toBe('Agents'));
  it('handles empty', () => expect(humanize('')).toBe(''));
});

describe('levenshtein', () => {
  it('returns 0 for identical', () => expect(levenshtein('abc', 'abc')).toBe(0));
  it('handles empty strings', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });
  it('basic edits', () => {
    expect(levenshtein('cat', 'cats')).toBe(1);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });
  it('short-circuits oversize inputs', () => {
    expect(levenshtein('a'.repeat(101), 'b')).toBe(Infinity);
  });
});

describe('levenshteinNearest', () => {
  const candidates = ['endpoint-system/overview', 'endpoint-system/gating', 'agents/index', 'plugins/repomix'];

  it('returns near match for typo', () => {
    const hits = levenshteinNearest('endpoint-system/overvew', candidates);
    expect(hits[0]).toBe('endpoint-system/overview');
  });
  it('drops candidates over ratio', () => {
    expect(levenshteinNearest('xyz', ['overview'])).toEqual([]);
  });
  it('respects k', () => {
    const hits = levenshteinNearest('endpoint-system/overview', candidates, { k: 1 });
    expect(hits).toHaveLength(1);
  });
});

describe('sliceByHeading', () => {
  const md = `## First

intro

## Target

target body line 1
target body line 2

## After

next section`;
  const toc = [
    { url: '#first', title: 'First', depth: 2 },
    { url: '#target', title: 'Target', depth: 2 },
    { url: '#after', title: 'After', depth: 2 },
  ];

  it('slices to next heading of same/shallower depth', () => {
    const out = sliceByHeading(md, 'target', toc);
    expect(out).toContain('target body line 1');
    expect(out).toContain('target body line 2');
    expect(out).not.toContain('next section');
  });
  it('returns null when heading id is missing', () => {
    expect(sliceByHeading(md, 'nonexistent', toc)).toBe(null);
  });
  it('returns null when heading line is missing in md', () => {
    const stripped = md.replace('## Target', '');
    expect(sliceByHeading(stripped, 'target', toc)).toBe(null);
  });
});

describe('truncationTail', () => {
  it('includes first-h2 id when available', () => {
    const tail = truncationTail({ firstH2Id: 'foo', h2Count: 3 });
    expect(tail).toContain('foo');
    expect(tail).toContain('3');
    expect(tail).toContain(String(MAX_PAYLOAD_BYTES));
  });
  it('falls back when no h2', () => {
    const tail = truncationTail({ h2Count: 0 });
    expect(tail).toContain('no H2 headings');
  });
});
