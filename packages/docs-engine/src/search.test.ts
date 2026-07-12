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

  it('splits on hyphens — a kebab-case slug is a compound token, not one giant token (EI-10097)', () => {
    expect(tokenize('su-persona-render-and-edit-path')).toEqual([
      'su',
      'persona',
      'render',
      'and',
      'edit',
      'path',
    ]);
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

  it('an exact-slug query hard-hits that doc first even when generic tokens favor other pages (EI-10097)', async () => {
    // Reproduces the filed bug shape: the target doc's title/body words
    // ('persona', 'render', 'edit') are common enough that OTHER pages
    // (here, pages stuffed with those same generic words many times) could
    // outscore it on pure token frequency. A query that IS the doc's own
    // slug must still surface it — the slug match dominates.
    const source = makeSource([
      {
        slug: 'agent-insights/su-persona-render-and-edit-path',
        title: 'su persona render and edit path',
        description: 'How the su persona prompt is rendered and where to edit it',
        body: 'layered projected prompt render edit persona',
      },
      {
        slug: 'plans/persona-render-notes',
        title: 'persona render notes',
        body: 'persona render persona render persona render persona render persona render edit edit edit edit edit',
      },
    ]);
    const res = await searchDocs(source, { query: 'su-persona-render-and-edit-path', limit: 8 });

    expect(res.tokenCount).toBe(6); // hyphenated slug now tokenizes, not one dead token
    expect(res.hits[0]?.slug).toBe('agent-insights/su-persona-render-and-edit-path');
  });

  it('slug bonus also fires on the exact final segment, ignoring the section prefix', async () => {
    const source = makeSource([
      { slug: 'agent-insights/two-tier-scheduler-and-timer-visibility', title: 'the scheduler layer model' },
      { slug: 'other/unrelated', title: 'nope' },
    ]);
    const res = await searchDocs(source, { query: 'two-tier-scheduler-and-timer-visibility' });
    expect(res.hits[0]?.slug).toBe('agent-insights/two-tier-scheduler-and-timer-visibility');
  });

  it('a short/generic query gets no slug bonus (guard against over-matching on <3-char normalized queries)', async () => {
    const source = makeSource([{ slug: 'a/b', title: 'ab' }]);
    const res = await searchDocs(source, { query: 'ab' });
    // 'ab' normalizes to a 2-char slug fragment — below the length guard, so it
    // must be scored purely on token match (2, from title ×... actually 'ab' as
    // a token is dropped by tokenize()'s <2-char rule only at 1 char; 'ab' is
    // kept, so this asserts no slug-bonus inflation, not zero-score).
    expect(res.hits[0]?.score).toBeLessThan(1000);
  });
});
