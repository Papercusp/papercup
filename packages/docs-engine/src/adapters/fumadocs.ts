/**
 * fumadocsAdapter — wrap a fumadocs `loader()` result as a DocSource.
 *
 * The fumadocs source's `getPages()` is sync; we project it onto the
 * engine's async DocSource interface. Section metadata is read from
 * `<contentRoot>/<section>/meta.json` when the caller passes a
 * contentRoot; otherwise getSectionMeta returns {} (humanize fallback).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { reactToText, humanize } from '../shared';
import { renderMdxToMarkdown } from '../render-mdx';
import type { DocPage, DocSource, SectionMeta } from '../types';

/** Loose shape of the fumadocs page record we depend on. */
interface FumaPage {
  slugs: string[];
  url: string;
  absolutePath: string;
  data: {
    title?: string;
    description?: string;
    toc?: Array<{ url?: string; title?: unknown; depth?: number }>;
    getText: (kind: 'raw' | 'processed') => Promise<string>;
  };
}

interface FumaSource {
  getPages(): FumaPage[];
  getPage(slugs: string[]): FumaPage | null | undefined;
}

export interface FumadocsAdapterOptions {
  /** Stable identifier for cache namespacing + telemetry. */
  name?: string;
  /**
   * Absolute directory under which sections live (e.g.
   * `apps/operator/content/docs`). When set, getSectionMeta reads
   * `<contentRoot>/<section>/meta.json`. Optional — when omitted,
   * section titles fall back to humanize(slug).
   */
  contentRoot?: string;
}

function projectPage(p: FumaPage): DocPage {
  const slug = p.slugs.join('/');
  return {
    slug,
    slugs: [...p.slugs],
    url: p.url,
    title: p.data.title ?? humanize(p.slugs.join('-') || 'index'),
    ...(p.data.description ? { description: p.data.description } : {}),
    toc: (p.data.toc ?? []).map((h) => ({
      id: (h.url ?? '').replace(/^#/, ''),
      text: reactToText(h.title),
      depth: h.depth ?? 2,
    })),
  };
}

export function fumadocsAdapter(src: FumaSource, opts: FumadocsAdapterOptions = {}): DocSource {
  const name = opts.name ?? 'fumadocs';
  const pageCache = new WeakMap<DocPage, FumaPage>();

  return {
    name,
    async listPages(): Promise<DocPage[]> {
      const out: DocPage[] = [];
      for (const fp of src.getPages()) {
        const dp = projectPage(fp);
        pageCache.set(dp, fp);
        out.push(dp);
      }
      return out;
    },
    async getPage(slug: string): Promise<DocPage | null> {
      const parts = slug ? slug.split('/') : [];
      const fp = src.getPage(parts);
      if (!fp) return null;
      const dp = projectPage(fp);
      pageCache.set(dp, fp);
      return dp;
    },
    async getContent(page: DocPage): Promise<string> {
      const fp = pageCache.get(page) ?? src.getPage(page.slugs);
      if (!fp) throw new Error(`fumadocsAdapter: page ${page.slug} not found in source`);
      const raw = await fp.data.getText('raw');
      return await renderMdxToMarkdown(raw, fp.absolutePath);
    },
    async getSectionMeta(sectionSlug: string): Promise<SectionMeta> {
      if (!opts.contentRoot) return {};
      try {
        const raw = await fs.readFile(
          path.join(opts.contentRoot, sectionSlug, 'meta.json'),
          'utf-8',
        );
        const parsed = JSON.parse(raw) as { title?: string; description?: string };
        return {
          ...(parsed.title ? { title: parsed.title } : {}),
          ...(parsed.description ? { description: parsed.description } : {}),
        };
      } catch {
        return {};
      }
    },
  };
}
