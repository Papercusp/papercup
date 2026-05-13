/**
 * Pure docs:search scoring logic — no fumadocs imports.
 *
 * Substring/keyword scoring over an injectable SearchSource. Title
 * matches weighted 4x, description 2x, body 1x. Returns ranked hits
 * with slug + title + description + excerpt around the first body
 * match.
 *
 * Trade-off: this reads each page's raw body via the injected
 * getText() callback. For ~120 pages that's a few ms even without
 * caching; if the corpus 10x's, swap to a PG tsvector index without
 * changing the dispatch signature.
 */

export interface SearchSourcePage {
  slugs: string[];
  url: string;
  data: {
    title?: string;
    description?: string;
  };
}

export interface SearchSource {
  getPages(): SearchSourcePage[];
}

export type GetPageText = (page: SearchSourcePage) => Promise<string>;

export interface DocsSearchHit {
  slug: string;
  url: string;
  title: string;
  description?: string;
  score: number;
  excerpt: string;
}

export interface DocsSearchResult {
  query: string;
  tokenCount: number;
  hitCount: number;
  hits: DocsSearchHit[];
}

const STOP_TOKEN_RE = /[\s,.;:!?(){}[\]<>"'`/\\]+/;

export function tokenize(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of query.toLowerCase().split(STOP_TOKEN_RE)) {
    if (part.length < 2) continue;
    if (seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!haystack || !needle) return 0;
  const hay = haystack.toLowerCase();
  let n = 0;
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) return n;
    n += 1;
    from = idx + needle.length;
  }
}

function firstMatchIndex(haystack: string, tokens: string[]): number {
  const hay = haystack.toLowerCase();
  let earliest = -1;
  for (const t of tokens) {
    const idx = hay.indexOf(t);
    if (idx === -1) continue;
    if (earliest === -1 || idx < earliest) earliest = idx;
  }
  return earliest;
}

function makeExcerpt(body: string, tokens: string[], window = 120): string {
  const hitAt = firstMatchIndex(body, tokens);
  if (hitAt === -1) {
    return body.slice(0, window * 2).replace(/\s+/g, ' ').trim();
  }
  const start = Math.max(0, hitAt - Math.floor(window / 3));
  const end = Math.min(body.length, start + window * 2);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < body.length ? '…' : '';
  return (prefix + body.slice(start, end) + suffix).replace(/\s+/g, ' ').trim();
}

export async function executeDocsSearch(
  args: { query: string; limit: number },
  src: SearchSource,
  getText: GetPageText,
): Promise<DocsSearchResult> {
  const tokens = tokenize(args.query);
  if (tokens.length === 0) {
    return { query: args.query, tokenCount: 0, hitCount: 0, hits: [] };
  }

  const pages = src.getPages();
  const rendered = await Promise.all(
    pages.map(async (p) => ({ page: p, body: await getText(p) })),
  );

  const scored: DocsSearchHit[] = [];
  for (const { page, body } of rendered) {
    const title = page.data.title ?? '';
    const description = page.data.description ?? '';
    let score = 0;
    for (const t of tokens) {
      score += countOccurrences(title, t) * 4;
      score += countOccurrences(description, t) * 2;
      score += countOccurrences(body, t);
    }
    if (score === 0) continue;

    const slug = page.slugs.join('/') || '_root';
    scored.push({
      slug,
      url: page.url,
      title,
      ...(description && { description }),
      score,
      excerpt: makeExcerpt(body, tokens),
    });
  }

  scored.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
  const hits = scored.slice(0, args.limit);

  return {
    query: args.query,
    tokenCount: tokens.length,
    hitCount: scored.length,
    hits,
  };
}
