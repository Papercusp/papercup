import { describe, it, expect } from 'vitest';
import { buildOutline } from '../src/outline';
import { makePage, makeSource } from './_fixture';

describe('buildOutline', () => {
  it('returns empty payload for empty source', async () => {
    const out = await buildOutline(makeSource({ pages: [] }));
    expect(out.sectionCount).toBe(0);
    expect(out.pageCount).toBe(0);
    expect(out.sections).toEqual([]);
  });

  it('groups pages by first slug segment', async () => {
    const pages = [
      makePage({ slug: 'endpoint-system/overview', title: 'Overview' }),
      makePage({ slug: 'endpoint-system/gating', title: 'Gating' }),
      makePage({ slug: 'agents/index', title: 'Agents' }),
    ];
    const out = await buildOutline(makeSource({ pages }));
    expect(out.sectionCount).toBe(2);
    expect(out.pageCount).toBe(3);
    const ep = out.sections.find((s) => s.slug === 'endpoint-system');
    expect(ep?.pages.map((p) => p.slug)).toEqual(['endpoint-system/gating', 'endpoint-system/overview']);
  });

  it('puts root-level pages under _root with title "Top-level"', async () => {
    const pages = [makePage({ slug: 'index', title: 'Index', slugs: ['index'] })];
    const out = await buildOutline(makeSource({ pages }));
    const root = out.sections.find((s) => s.slug === '_root');
    expect(root?.title).toBe('Top-level');
    expect(root?.pages).toHaveLength(1);
  });

  it('uses section meta when available', async () => {
    const pages = [makePage({ slug: 'posthog/index' })];
    const out = await buildOutline(
      makeSource({ pages, sectionMeta: { posthog: { title: 'PostHog', description: 'Analytics' } } }),
    );
    const sec = out.sections.find((s) => s.slug === 'posthog');
    expect(sec?.title).toBe('PostHog');
    expect(sec?.description).toBe('Analytics');
  });

  it('falls back to humanize() when no section meta', async () => {
    const pages = [makePage({ slug: 'endpoint-system/overview' })];
    const out = await buildOutline(makeSource({ pages }));
    const sec = out.sections.find((s) => s.slug === 'endpoint-system');
    expect(sec?.title).toBe('Endpoint System');
  });

  it('sorts sections alphabetically', async () => {
    const pages = [
      makePage({ slug: 'zebra/a' }),
      makePage({ slug: 'apple/a' }),
      makePage({ slug: 'mango/a' }),
    ];
    const out = await buildOutline(makeSource({ pages }));
    expect(out.sections.map((s) => s.slug)).toEqual(['apple', 'mango', 'zebra']);
  });

  it('preserves toc on pages', async () => {
    const pages = [
      makePage({
        slug: 'foo/bar',
        toc: [
          { id: 'intro', text: 'Intro', depth: 2 },
          { id: 'usage', text: 'Usage', depth: 2 },
        ],
      }),
    ];
    const out = await buildOutline(makeSource({ pages }));
    expect(out.sections[0].pages[0].headings).toHaveLength(2);
    expect(out.sections[0].pages[0].headings[0].id).toBe('intro');
  });

  it('includes page description when present', async () => {
    const pages = [makePage({ slug: 'a/b', description: 'A description' })];
    const out = await buildOutline(makeSource({ pages }));
    expect(out.sections[0].pages[0].description).toBe('A description');
  });
});
