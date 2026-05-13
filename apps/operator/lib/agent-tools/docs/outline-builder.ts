/**
 * Pure outline-build logic — no fumadocs imports.
 *
 * Split from outline.ts so vitest can exercise the builder without
 * pulling in the fumadocs MDX collection (which vitest's vite config
 * can't transform without an MDX plugin).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { reactToText, humanize } from './shared';

export interface HeadingEntry {
  id: string;
  text: string;
  depth: number;
}

export interface PageEntry {
  slug: string;
  title: string;
  description?: string;
  headings: HeadingEntry[];
}

export interface SectionEntry {
  slug: string;
  title: string;
  description?: string;
  pages: PageEntry[];
}

export interface OutlinePayload {
  generatedAt: string;
  sectionCount: number;
  pageCount: number;
  sections: SectionEntry[];
}

/** Minimal page shape we depend on. Loose to keep tests free of fumadocs. */
export interface OutlineSourcePage {
  slugs: string[];
  url: string;
  data: {
    title?: string;
    description?: string;
    toc?: Array<{ url?: string; title?: unknown; depth?: number }>;
  };
}

export interface OutlineSource {
  getPages(): OutlineSourcePage[];
}

export interface SectionMetaReader {
  (sectionSlug: string): Promise<{ title?: string; description?: string }>;
}

export const CONTENT_DOCS_DIR = path.join(process.cwd(), 'content', 'docs');

export const defaultMetaReader: SectionMetaReader = async (sectionSlug) => {
  try {
    const raw = await fs.readFile(
      path.join(CONTENT_DOCS_DIR, sectionSlug, 'meta.json'),
      'utf-8',
    );
    const parsed = JSON.parse(raw) as { title?: string; description?: string };
    return { title: parsed.title, description: parsed.description };
  } catch {
    return {};
  }
};

export async function buildOutline(
  src: OutlineSource,
  readMeta: SectionMetaReader = defaultMetaReader,
): Promise<OutlinePayload> {
  const pages = src.getPages();

  const bySection = new Map<string, PageEntry[]>();
  for (const page of pages) {
    const sectionSlug = page.slugs.length > 1 ? page.slugs[0] : '_root';

    const headings: HeadingEntry[] = (page.data.toc ?? []).map((h) => ({
      id: (h.url ?? '').replace(/^#/, ''),
      text: reactToText(h.title),
      depth: h.depth ?? 2,
    }));

    const entry: PageEntry = {
      slug: page.slugs.join('/') || '_root',
      title: page.data.title ?? humanize(page.slugs.join('-') || 'index'),
      ...(page.data.description && { description: page.data.description }),
      headings,
    };

    const arr = bySection.get(sectionSlug) ?? [];
    arr.push(entry);
    bySection.set(sectionSlug, arr);
  }

  const sectionSlugs = [...bySection.keys()].sort((a, b) => a.localeCompare(b));
  const sections: SectionEntry[] = await Promise.all(
    sectionSlugs.map(async (slug) => {
      const meta = slug === '_root' ? {} : await readMeta(slug);
      const entries = (bySection.get(slug) ?? []).sort((a, b) =>
        a.slug.localeCompare(b.slug),
      );
      const title = meta.title ?? (slug === '_root' ? 'Top-level' : humanize(slug));
      return {
        slug,
        title,
        ...(meta.description && { description: meta.description }),
        pages: entries,
      };
    }),
  );

  return {
    generatedAt: new Date().toISOString(),
    sectionCount: sections.length,
    pageCount: pages.length,
    sections,
  };
}
