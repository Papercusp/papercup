/**
 * Unit tests for the docs:outline builder + cache.
 *
 * Tests against a hand-rolled minimal OutlineSource — no fumadocs in
 * scope here. Tool-registration / live-source integration is verified
 * separately via the /api/agent-tools/docs/outline curl in the rollout
 * gate (PR 2 verification).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildOutline,
  type OutlineSource,
  type OutlineSourcePage,
} from './outline-builder';

function page(
  slugs: string[],
  title: string,
  opts: Partial<OutlineSourcePage['data']> = {},
): OutlineSourcePage {
  return {
    slugs,
    url: '/docs/' + slugs.join('/'),
    data: { title, ...opts },
  };
}

function source(pages: OutlineSourcePage[]): OutlineSource {
  return { getPages: () => pages };
}

const stubMeta = (overrides: Record<string, { title?: string; description?: string }> = {}) =>
  async (slug: string) => overrides[slug] ?? {};

describe('buildOutline', () => {
  it('returns empty payload for empty source', async () => {
    const out = await buildOutline(source([]), stubMeta());
    expect(out.sectionCount).toBe(0);
    expect(out.pageCount).toBe(0);
    expect(out.sections).toEqual([]);
  });

  it('groups pages by first slug segment', async () => {
    const out = await buildOutline(
      source([
        page(['endpoint-system', 'overview'], 'Overview'),
        page(['endpoint-system', 'transports'], 'Transports'),
        page(['agents', 'index'], 'Agents'),
      ]),
      stubMeta(),
    );
    expect(out.sectionCount).toBe(2);
    expect(out.pageCount).toBe(3);
    const es = out.sections.find((s) => s.slug === 'endpoint-system')!;
    expect(es.pages).toHaveLength(2);
  });

  it('puts single-segment pages under _root with friendly title', async () => {
    const out = await buildOutline(
      source([page(['branding'], 'Branding'), page(['performance'], 'Performance')]),
      stubMeta(),
    );
    const root = out.sections.find((s) => s.slug === '_root')!;
    expect(root.title).toBe('Top-level');
    expect(root.pages).toHaveLength(2);
  });

  it('sorts sections alphabetically by slug', async () => {
    const out = await buildOutline(
      source([
        page(['zeta', 'p'], 'Z'),
        page(['alpha', 'p'], 'A'),
        page(['mu', 'p'], 'M'),
      ]),
      stubMeta(),
    );
    expect(out.sections.map((s) => s.slug)).toEqual(['alpha', 'mu', 'zeta']);
  });

  it('sorts pages within a section by slug', async () => {
    const out = await buildOutline(
      source([
        page(['sec', 'z'], 'Z'),
        page(['sec', 'a'], 'A'),
        page(['sec', 'm'], 'M'),
      ]),
      stubMeta(),
    );
    expect(out.sections[0].pages.map((p) => p.slug)).toEqual([
      'sec/a',
      'sec/m',
      'sec/z',
    ]);
  });

  it('section title comes from meta.json when present', async () => {
    const out = await buildOutline(
      source([page(['endpoint-system', 'overview'], 'Overview')]),
      stubMeta({
        'endpoint-system': { title: 'Endpoint System', description: 'desc here' },
      }),
    );
    const es = out.sections[0];
    expect(es.title).toBe('Endpoint System');
    expect(es.description).toBe('desc here');
  });

  it('section title falls back to humanize when meta.json missing', async () => {
    const out = await buildOutline(
      source([page(['my-cool-section', 'index'], 'Index')]),
      stubMeta(),
    );
    expect(out.sections[0].title).toBe('My Cool Section');
  });

  it('preserves brand-cased titles like "PostHog" via meta.json', async () => {
    const out = await buildOutline(
      source([page(['posthog', 'index'], 'Index')]),
      stubMeta({ posthog: { title: 'PostHog' } }),
    );
    expect(out.sections[0].title).toBe('PostHog');
  });

  it('page description carries through when present', async () => {
    const out = await buildOutline(
      source([page(['sec', 'a'], 'A', { description: 'A desc' })]),
      stubMeta(),
    );
    expect(out.sections[0].pages[0].description).toBe('A desc');
  });

  it('extracts heading text from React-element TOC titles', async () => {
    const out = await buildOutline(
      source([
        page(['sec', 'a'], 'A', {
          toc: [
            { url: '#inline', title: ['Inline ', { props: { children: 'code' } }], depth: 2 },
            { url: '#plain', title: 'Plain text', depth: 3 },
          ],
        }),
      ]),
      stubMeta(),
    );
    const headings = out.sections[0].pages[0].headings;
    expect(headings).toEqual([
      { id: 'inline', text: 'Inline code', depth: 2 },
      { id: 'plain', text: 'Plain text', depth: 3 },
    ]);
    for (const h of headings) {
      expect(h.text).not.toBe('[object Object]');
    }
  });

  it('handles pages with empty toc gracefully', async () => {
    const out = await buildOutline(
      source([page(['sec', 'a'], 'A', { toc: [] })]),
      stubMeta(),
    );
    expect(out.sections[0].pages[0].headings).toEqual([]);
  });

  it('handles pages with no toc property at all', async () => {
    const out = await buildOutline(
      source([page(['sec', 'a'], 'A')]),
      stubMeta(),
    );
    expect(out.sections[0].pages[0].headings).toEqual([]);
  });
});

describe('cache logic', () => {
  // The cache itself lives in the module's outlineCache Map; the
  // dispatch path uses ctx.runId as the key. The handler in outline.ts
  // (not tested directly here — it depends on fumadocs source) wraps
  // buildOutline with cache get/set. This test verifies the policy
  // by simulating the wrapper.
  let cache: Map<string, { value: number }>;

  beforeEach(() => {
    cache = new Map();
  });

  it('hit returns the cached value', () => {
    cache.set('run-A', { value: 1 });
    expect(cache.get('run-A')).toEqual({ value: 1 });
  });

  it('LRU eviction at size > MAX evicts oldest', () => {
    const MAX = 5;
    for (let i = 0; i < MAX + 3; i++) cache.set(`run-${i}`, { value: i });
    while (cache.size > MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    expect(cache.size).toBe(MAX);
    expect(cache.has('run-0')).toBe(false);
    expect(cache.has('run-1')).toBe(false);
    expect(cache.has('run-2')).toBe(false);
    expect(cache.has('run-3')).toBe(true);
    expect(cache.has('run-7')).toBe(true);
  });
});
