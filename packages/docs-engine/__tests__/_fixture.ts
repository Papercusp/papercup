/**
 * Mock DocSource fixture for engine tests. No fumadocs, no filesystem.
 */

import type { DocPage, DocSource, SectionMeta } from '../src/types';

export function makePage(p: Partial<DocPage> & { slug: string }): DocPage {
  const slugs = p.slugs ?? p.slug.split('/').filter(Boolean);
  return {
    slug: p.slug,
    slugs,
    url: p.url ?? `/docs/${p.slug}`,
    title: p.title ?? p.slug,
    ...(p.description ? { description: p.description } : {}),
    toc: p.toc ?? [],
  };
}

export interface FixtureOpts {
  pages?: DocPage[];
  contents?: Record<string, string>;
  sectionMeta?: Record<string, SectionMeta>;
}

export function makeSource(opts: FixtureOpts = {}): DocSource {
  const pages = opts.pages ?? [];
  const contents = opts.contents ?? {};
  const sectionMeta = opts.sectionMeta ?? {};
  const bySlug = new Map(pages.map((p) => [p.slug, p]));

  return {
    name: 'fixture',
    async listPages() {
      return pages;
    },
    async getPage(slug: string) {
      return bySlug.get(slug) ?? null;
    },
    async getContent(page: DocPage) {
      return contents[page.slug] ?? `# ${page.title}\n\n(body)`;
    },
    async getSectionMeta(slug: string) {
      return sectionMeta[slug] ?? {};
    },
  };
}
