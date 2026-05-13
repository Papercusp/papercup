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
  type TocEntry,
} from './shared';

describe('levenshtein', () => {
  it('returns 0 for identical', () => {
    expect(levenshtein('foo', 'foo')).toBe(0);
  });
  it('handles single edit', () => {
    expect(levenshtein('cat', 'cats')).toBe(1);
    expect(levenshtein('cat', 'bat')).toBe(1);
    expect(levenshtein('cat', 'ca')).toBe(1);
  });
  it('handles empty strings', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
  });
  it('short-circuits on length > 100', () => {
    expect(levenshtein('a'.repeat(101), 'b')).toBe(Infinity);
  });
});

describe('levenshteinNearest', () => {
  const corpus = [
    'endpoint-system/overview',
    'endpoint-system/transports',
    'agents/prompt-assembly',
    'plugins/runtime',
  ];

  it('finds a near-match within ratio', () => {
    const out = levenshteinNearest('endpoint-system/overvew', corpus);
    expect(out[0]).toBe('endpoint-system/overview');
  });
  it('returns [] for a target too far from any candidate', () => {
    // 'xyz' vs 'overview' → ratio = 8/8 = 1.0, > 0.3
    expect(levenshteinNearest('xyz', ['overview'])).toEqual([]);
  });
  it('respects k cap', () => {
    expect(levenshteinNearest('abc', ['abcd', 'abce', 'abcf', 'abcg'], { k: 2 })).toHaveLength(2);
  });
  it('respects maxRatio', () => {
    // 'abc' vs 'abcde' → ratio = 2/5 = 0.4. Within 0.4, outside 0.3.
    expect(levenshteinNearest('abc', ['abcde'], { maxRatio: 0.3 })).toEqual([]);
    expect(levenshteinNearest('abc', ['abcde'], { maxRatio: 0.4 })).toEqual(['abcde']);
  });
  it('orders by distance', () => {
    const out = levenshteinNearest('overview', ['overvie', 'overvi', 'overview']);
    expect(out[0]).toBe('overview');
    expect(out[1]).toBe('overvie');
  });
});

describe('reactToText', () => {
  it('handles strings and numbers', () => {
    expect(reactToText('hello')).toBe('hello');
    expect(reactToText(42)).toBe('42');
  });
  it('flattens arrays', () => {
    expect(reactToText(['a', 'b', 'c'])).toBe('abc');
  });
  it('walks React-element-shaped objects', () => {
    // <code>foo</code> → { props: { children: 'foo' } }
    const node = { props: { children: 'foo' } };
    expect(reactToText(node)).toBe('foo');
  });
  it('walks mixed arrays with elements', () => {
    const node = ['Inline ', { props: { children: 'code' } }];
    expect(reactToText(node)).toBe('Inline code');
  });
  it('handles nested elements', () => {
    const node = { props: { children: { props: { children: 'deep' } } } };
    expect(reactToText(node)).toBe('deep');
  });
  it('returns empty string for null/undefined', () => {
    expect(reactToText(null)).toBe('');
    expect(reactToText(undefined)).toBe('');
  });
  it('does NOT return [object Object]', () => {
    const node = { props: { children: 'safe' } };
    expect(reactToText(node)).not.toBe('[object Object]');
  });
});

describe('escapeRegex', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c');
    expect(escapeRegex('(foo)')).toBe('\\(foo\\)');
  });
});

describe('humanize', () => {
  it('title-cases kebab slug', () => {
    expect(humanize('endpoint-system')).toBe('Endpoint System');
    expect(humanize('agents')).toBe('Agents');
  });
});

describe('sliceByHeading', () => {
  const md = `# Title

intro text

## First Section

first body

## Second Section

second body

### Subsection

sub body

## Last Section

last body
`;
  const toc: TocEntry[] = [
    { url: '#first-section', title: 'First Section', depth: 2 },
    { url: '#second-section', title: 'Second Section', depth: 2 },
    { url: '#subsection', title: 'Subsection', depth: 3 },
    { url: '#last-section', title: 'Last Section', depth: 2 },
  ];

  it('returns null on missing id', () => {
    expect(sliceByHeading(md, 'nonexistent', toc)).toBeNull();
  });
  it('slices to next equal-or-shallower heading', () => {
    const out = sliceByHeading(md, 'first-section', toc);
    expect(out).toContain('## First Section');
    expect(out).toContain('first body');
    expect(out).not.toContain('Second Section');
  });
  it('subsection slices to next H2 (shallower)', () => {
    const out = sliceByHeading(md, 'subsection', toc);
    expect(out).toContain('### Subsection');
    expect(out).toContain('sub body');
    expect(out).not.toContain('Last Section');
  });
  it('slices to EOF when target is last heading', () => {
    const out = sliceByHeading(md, 'last-section', toc);
    expect(out).toContain('## Last Section');
    expect(out).toContain('last body');
  });
  it('handles regex metacharacters in heading text', () => {
    const mdSpecial = `## How "endpoint" works\n\nbody\n\n## next\n`;
    const tocSpecial: TocEntry[] = [
      { url: '#how-endpoint-works', title: 'How "endpoint" works', depth: 2 },
      { url: '#next', title: 'next', depth: 2 },
    ];
    const out = sliceByHeading(mdSpecial, 'how-endpoint-works', tocSpecial);
    expect(out).toContain('How "endpoint" works');
    expect(out).toContain('body');
  });
  it('walks React-element title to find heading line', () => {
    const mdInline = `## Inline code section\n\nbody\n`;
    const tocInline: TocEntry[] = [
      {
        url: '#inline-code-section',
        title: ['Inline ', { props: { children: 'code' } }, ' section'],
        depth: 2,
      },
    ];
    expect(sliceByHeading(mdInline, 'inline-code-section', tocInline)).toContain(
      '## Inline code section',
    );
  });
});

describe('truncationTail', () => {
  it('mentions byte cap and first H2', () => {
    const tail = truncationTail({ firstH2Id: 'getting-started', h2Count: 5 });
    expect(tail).toContain(String(MAX_PAYLOAD_BYTES));
    expect(tail).toContain('getting-started');
    expect(tail).toContain('5 H2 headings');
  });
  it('falls back when no H2 available', () => {
    const tail = truncationTail({ h2Count: 0 });
    expect(tail).toContain('no H2 headings');
  });
});
