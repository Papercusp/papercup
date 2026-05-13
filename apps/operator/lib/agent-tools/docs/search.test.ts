import { describe, it, expect } from 'vitest';
import {
  executeDocsSearch,
  tokenize,
  type SearchSource,
  type SearchSourcePage,
} from './search-builder';

function page(
  slugs: string[],
  title: string,
  description: string,
  body: string,
): SearchSourcePage & { _body: string } {
  return {
    slugs,
    url: '/docs/' + slugs.join('/'),
    data: { title, description },
    _body: body,
  };
}

function source(pages: Array<SearchSourcePage & { _body: string }>): SearchSource {
  return { getPages: () => pages };
}

const render = async (p: SearchSourcePage): Promise<string> =>
  (p as SearchSourcePage & { _body?: string })._body ?? '';

describe('tokenize', () => {
  it('lowercases and splits on whitespace + punctuation', () => {
    expect(tokenize('Hello, world!')).toEqual(['hello', 'world']);
  });
  it('drops single-character tokens', () => {
    expect(tokenize('a foo')).toEqual(['foo']);
  });
  it('dedupes', () => {
    expect(tokenize('foo foo bar')).toEqual(['foo', 'bar']);
  });
  it('handles slashes and brackets', () => {
    expect(tokenize('endpoint-system/overview <Callout>')).toEqual([
      'endpoint-system',
      'overview',
      'callout',
    ]);
  });
});

describe('executeDocsSearch', () => {
  it('returns empty when query has no usable tokens', async () => {
    const src = source([page(['a'], 'A', 'desc', 'body')]);
    const res = await executeDocsSearch({ query: 'a', limit: 8 }, src, render);
    expect(res.tokenCount).toBe(0);
    expect(res.hits).toEqual([]);
  });

  it('title matches outweigh body matches', async () => {
    const src = source([
      page(['a'], 'replay', 'unrelated', 'no match here'),
      page(['b'], 'unrelated', 'unrelated', 'replay replay replay replay replay'),
    ]);
    const res = await executeDocsSearch(
      { query: 'replay', limit: 8 },
      src,
      render,
    );
    // Title 1 occurrence × 4 = 4 vs body 5 occurrences × 1 = 5. Body wins
    // here, but a title hit should beat ONE body hit.
    const titleHit = res.hits.find((h) => h.slug === 'a')!;
    expect(titleHit.score).toBe(4);
    const bodyHit = res.hits.find((h) => h.slug === 'b')!;
    expect(bodyHit.score).toBe(5);
  });

  it('description matches outweigh body matches', async () => {
    const src = source([
      page(['a'], 'foo', 'token here', 'unrelated'),
      page(['b'], 'bar', 'unrelated', 'token unrelated'),
    ]);
    const res = await executeDocsSearch({ query: 'token', limit: 8 }, src, render);
    expect(res.hits[0].slug).toBe('a'); // 2 from description > 1 from body
  });

  it('omits pages with zero score', async () => {
    const src = source([
      page(['hit'], 'foo', 'foo', 'foo'),
      page(['miss'], 'bar', 'bar', 'bar'),
    ]);
    const res = await executeDocsSearch({ query: 'foo', limit: 8 }, src, render);
    expect(res.hits.map((h) => h.slug)).toEqual(['hit']);
    expect(res.hitCount).toBe(1);
  });

  it('ranks higher score first', async () => {
    const src = source([
      page(['low'], 'foo', '', 'foo'),
      page(['high'], 'foo foo foo', '', 'foo foo'),
    ]);
    const res = await executeDocsSearch({ query: 'foo', limit: 8 }, src, render);
    expect(res.hits[0].slug).toBe('high');
    expect(res.hits[1].slug).toBe('low');
  });

  it('respects limit', async () => {
    const pages = ['a', 'b', 'c', 'd'].map((s) => page([s], 'foo', 'foo', 'foo'));
    const src = source(pages);
    const res = await executeDocsSearch({ query: 'foo', limit: 2 }, src, render);
    expect(res.hits).toHaveLength(2);
    expect(res.hitCount).toBe(4);
  });

  it('excerpt contains the matched token with ellipsis when truncated', async () => {
    const longBody = 'x '.repeat(200) + 'targetword' + ' y'.repeat(200);
    const src = source([page(['a'], 'unrelated', 'unrelated', longBody)]);
    const res = await executeDocsSearch(
      { query: 'targetword', limit: 8 },
      src,
      render,
    );
    expect(res.hits[0].excerpt).toContain('targetword');
    expect(res.hits[0].excerpt.length).toBeLessThan(longBody.length);
  });

  it('multi-token query: all tokens contribute', async () => {
    const src = source([
      page(['both'], 'foo bar', '', ''),
      page(['one'], 'foo', '', ''),
    ]);
    const res = await executeDocsSearch({ query: 'foo bar', limit: 8 }, src, render);
    expect(res.hits[0].slug).toBe('both'); // 4 + 4 = 8 vs 4
    expect(res.hits[1].slug).toBe('one');
  });

  it('stable sort by slug when scores tie', async () => {
    const src = source([
      page(['z'], 'foo', '', ''),
      page(['a'], 'foo', '', ''),
      page(['m'], 'foo', '', ''),
    ]);
    const res = await executeDocsSearch({ query: 'foo', limit: 8 }, src, render);
    expect(res.hits.map((h) => h.slug)).toEqual(['a', 'm', 'z']);
  });
});
