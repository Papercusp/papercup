/**
 * Tests for the search tokenizer (the pure half of searchDocs) and the
 * searchDocs ranking/truncation contract.
 * Run with: npx vitest run packages/docs-engine/src/search.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { searchDocs, tokenize } from './search';
import type { DocPage, DocSource } from './types.js';

/**
 * Minimal in-memory DocSource for ranking tests. Each spec is
 * [slug, title, description, body]; url defaults to `/${slug}`.
 */
type PageSpec = { slug: string; title?: string; description?: string; body?: string };

function makeSource(specs: PageSpec[]): DocSource {
  const bodies = new Map<string, string>();
  const pages: DocPage[] = specs.map((s) => {
    bodies.set(s.slug, s.body ?? '');
    return {
      slug: s.slug,
      slugs: s.slug ? s.slug.split('/') : [],
      url: `/${s.slug}`,
      title: s.title ?? '',
      ...(s.description ? { description: s.description } : {}),
      toc: [],
    };
  });
  return {
    name: 'test-source',
    listPages: async () => pages,
    getPage: async (slug) => pages.find((p) => p.slug === slug) ?? null,
    getContent: async (page) => bodies.get(page.slug) ?? '',
  };
}

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

describe('searchDocs', () => {
  it('reports the full pre-truncation match total in hitCount while truncating hits to limit (Gap 2)', async () => {
    // Contract: hitCount = how many pages matched even if not all are returned,
    // so the model can detect that results were truncated. hits.length is capped
    // at limit; hitCount stays at the full scored.length (5 here, not 2).
    const source = makeSource([
      { slug: 'p1', title: 'foo' },
      { slug: 'p2', title: 'foo' },
      { slug: 'p3', title: 'foo' },
      { slug: 'p4', title: 'foo' },
      { slug: 'p5', title: 'foo' },
    ]);
    const metadata = vi.fn();
    const res = await searchDocs(source, { query: 'foo', limit: 2 }, { metadata });

    expect(res.hitCount).toBe(5); // full match total, NOT truncated
    expect(res.hits).toHaveLength(2); // returned set is capped at limit
    expect(res.hitCount).toBeGreaterThan(res.hits.length); // truncation signal
    expect(metadata).toHaveBeenCalledWith(
      expect.objectContaining({ hit_count: 5, returned: 2 }),
    );
  });

  it('breaks score ties by slug ascending, not insertion order (Gap 1)', async () => {
    // Both pages: title 'foo', identical bodies → identical score (4). Inserted
    // z-page first, a-page second. The `|| a.slug.localeCompare(b.slug)` tie-break
    // must sort them slug-ascending → ['a-page', 'z-page']. Dropping the
    // localeCompare leg would leave insertion order and fail this assertion.
    const source = makeSource([
      { slug: 'z-page', title: 'foo', body: 'shared body' },
      { slug: 'a-page', title: 'foo', body: 'shared body' },
    ]);
    const res = await searchDocs(source, { query: 'foo' });

    expect(res.hits.map((h) => h.slug)).toEqual(['a-page', 'z-page']);
    expect(res.hits[0].score).toBe(res.hits[1].score); // genuinely tied on score
  });

  it('weights title ×4 over body, and falls back to slug order when weighted scores tie (Gap 3)', async () => {
    // title-hit scores 4 (1×4); a body with 'foo foo foo' scores 3 (3×1) → title first.
    // A body with 'foo foo foo foo' scores 4 → ties the single title hit, so the
    // tie-break is slug ascending. Slugs chosen so insertion order ≠ slug order.
    const source = makeSource([
      { slug: 'body3', title: 'nope', body: 'foo foo foo' }, // score 3
      { slug: 'm-title', title: 'foo', body: 'nope' }, // score 4 (title ×4)
      { slug: 'a-body4', title: 'nope', body: 'foo foo foo foo' }, // score 4 (body ×1 ×4)
    ]);
    const res = await searchDocs(source, { query: 'foo' });

    // Scores: a-body4=4, m-title=4, body3=3. Top two tie at 4 → slug ascending
    // ('a-body4' before 'm-title'); body3 (score 3) last.
    expect(res.hits.map((h) => h.slug)).toEqual(['a-body4', 'm-title', 'body3']);
    expect(res.hits.map((h) => h.score)).toEqual([4, 4, 3]);
  });
});
