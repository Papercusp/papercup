/**
 * Engineering docs adapter — Starlight content collection on disk.
 *
 * Reads from apps/operator-docs/src/content/docs/ (the Astro/Starlight
 * content tree). The fumadocs adapter was removed at the F10 cutover —
 * see apps/operator/docs/plans/fumadocs-to-starlight-2026-05-20.md
 * (F11 agent insight has the full migration history).
 *
 * The content root is resolved relative to the repo root (not
 * process.cwd(), which is apps/operator at runtime) — see _repo-paths.
 */

import {
  humanize,
  okfFromObject,
  parseFrontmatterBlock,
  renderMdxToMarkdown,
  starlightContentAdapter,
  type DocPage,
  type DocSource,
} from '@papercusp/docs-engine';
import { DOCS_CONTENT_ROOT } from './_repo-paths';
import { listAuthoredDocContents } from '../../harness/docs/doc-record';

type InvalidatableDocSource = DocSource & { invalidate?: () => void };

interface CanonicalDoc {
  docId: string;
  page: DocPage;
  body: string;
  raw: string;
  rendered?: string;
}

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

function slugFromDocId(docId: string): string {
  return docId.replace(/^\.\//, '').replace(/\.(?:md|mdx)$/i, '');
}

function extractHeadings(content: string): DocPage['toc'] {
  const out: DocPage['toc'] = [];
  for (const line of content.split('\n')) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const text = match[2].trim();
    if (!text) continue;
    out.push({ id: text.replace(/[^A-Za-z0-9]/g, '-'), text, depth: match[1].length });
    if (out.length >= 100) break;
  }
  return out;
}

function canonicalDoc(
  docId: string,
  raw: string,
  fallback: DocPage | undefined,
): CanonicalDoc | null {
  const slug = slugFromDocId(docId);
  if (!slug) return null;
  const frontmatter = parseFrontmatterBlock(raw, { dates: 'string' });
  const meta = frontmatter.ok ? (frontmatter.data ?? {}) : {};
  const body = raw.replace(FRONTMATTER_RE, '');
  const title =
    (typeof meta.title === 'string' && meta.title.trim()) || fallback?.title || humanize(slug.split('/').at(-1) ?? 'index');
  const description =
    (typeof meta.description === 'string' && meta.description.trim()) || fallback?.description;
  const searchable =
    meta.searchable !== undefined
      ? meta.searchable === false || meta.searchable === 'false'
        ? false
        : undefined
      : fallback?.searchable;
  const okf = okfFromObject(meta) ?? fallback?.okf;
  const page: DocPage = {
    slug,
    slugs: slug.split('/'),
    url: fallback?.url ?? `/internal/docs/${slug}`,
    title,
    ...(description ? { description } : {}),
    ...(searchable === false ? { searchable: false as const } : {}),
    ...(okf ? { okf } : {}),
    toc: extractHeadings(body),
  };
  return { docId, page, body, raw };
}

/**
 * Overlay populated harness_docs.content on a filesystem DocSource.
 *
 * Authored docs are PG-canonical, while the Starlight projection can live in a
 * different checkout from the operator process. The overlay makes the canonical
 * row authoritative for list/get/content without changing the filesystem adapter
 * used for all other pages. The reader is cached per process and explicitly
 * invalidated by docs:author after it writes a canonical row.
 */
export function overlayCanonicalDocs(
  base: InvalidatableDocSource,
  readCanonical: (harnessSlug: string) => Promise<Map<string, string>>,
  harnessSlug: string,
): InvalidatableDocSource {
  let canonicalCache: Promise<Map<string, CanonicalDoc>> | null = null;

  async function loadCanonical(basePages?: DocPage[]): Promise<Map<string, CanonicalDoc>> {
    if (canonicalCache) return canonicalCache;
    const fallbackPages = new Map((basePages ?? (await base.listPages())).map((page) => [page.slug, page]));
    canonicalCache = readCanonical(harnessSlug).then((contents) => {
      const pages = new Map<string, CanonicalDoc>();
      for (const [docId, raw] of contents) {
        const page = canonicalDoc(docId, raw, fallbackPages.get(slugFromDocId(docId)));
        if (page) pages.set(page.page.slug, page);
      }
      return pages;
    });
    return canonicalCache;
  }

  return {
    name: base.name,
    async listPages(): Promise<DocPage[]> {
      const basePages = await base.listPages();
      const canonical = await loadCanonical(basePages);
      const pages = basePages.map((page) => canonical.get(page.slug)?.page ?? page);
      const baseSlugs = new Set(basePages.map((page) => page.slug));
      for (const entry of canonical.values()) {
        if (!baseSlugs.has(entry.page.slug)) pages.push(entry.page);
      }
      return pages;
    },
    async getPage(slug: string): Promise<DocPage | null> {
      const canonical = await loadCanonical();
      const page = canonical.get(slug)?.page;
      return page ?? base.getPage(slug);
    },
    async getContent(page: DocPage): Promise<string> {
      const canonical = await loadCanonical();
      const entry = canonical.get(page.slug);
      if (!entry) return base.getContent(page);
      if (entry.rendered === undefined) {
        entry.rendered = /\.mdx$/i.test(entry.docId)
          ? await renderMdxToMarkdown(entry.body, `${DOCS_CONTENT_ROOT}/${entry.docId}`)
          : entry.body;
      }
      return entry.rendered;
    },
    ...(base.getSectionMeta
      ? { getSectionMeta: (sectionSlug: string) => base.getSectionMeta!(sectionSlug) }
      : {}),
    invalidate(): void {
      canonicalCache = null;
      base.invalidate?.();
    },
  };
}

const engineeringBase = starlightContentAdapter({
  name: 'papercusp-engineering',
  contentRoot: DOCS_CONTENT_ROOT,
  baseUrl: '/internal/docs',
});

let engineeringAdapterRevision = 0;

export const engineeringAdapter: InvalidatableDocSource = overlayCanonicalDocs(
  engineeringBase,
  listAuthoredDocContents,
  'papercusp',
);

/** Changes whenever docs:author invalidates the process-lifetime engineering source. */
export function getEngineeringAdapterRevision(): number {
  return engineeringAdapterRevision;
}

/**
 * docs:author projects the canonical row into this adapter's source tree. The
 * adapter is a process-lifetime singleton for read performance, so the author
 * must drop its page + rendered-body caches after a successful write.
 */
export function invalidateEngineeringAdapter(): void {
  engineeringAdapterRevision += 1;
  engineeringAdapter.invalidate?.();
}
