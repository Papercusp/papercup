/**
 * Tests for the search tokenizer (the pure half of searchDocs).
 * Run with: npx vitest run packages/docs-engine/src/search.test.ts
 */
import { describe, expect, it } from 'vitest';
import { tokenize } from './search';

describe('tokenize', () => {
  it('lowercases and splits on punctuation/whitespace', () => {
    expect(tokenize('Feature Flags')).toEqual(['feature', 'flags']);
    expect(tokenize('sync,resolver;query.layer')).toEqual(['sync', 'resolver', 'query', 'layer']);
  });

  it('drops tokens shorter than 2 chars', () => {
    expect(tokenize('a I/O x')).toEqual([]);
    expect(tokenize('go to db')).toEqual(['go', 'to', 'db']);
  });

  it('dedupes while preserving first-seen order', () => {
    expect(tokenize('sync sync resolver sync')).toEqual(['sync', 'resolver']);
  });

  it('splits on the full punctuation class', () => {
    expect(tokenize('foo(bar)/baz<qux>')).toEqual(['foo', 'bar', 'baz', 'qux']);
  });

  it('returns [] for an empty or all-stopchar query', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('  .,;:  ')).toEqual([]);
  });
});
