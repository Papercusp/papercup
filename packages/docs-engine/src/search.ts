/**
 * searchDocs — substring/keyword scoring over a DocSource.
 *
 * Title ×4, description ×2, body ×1. Tokenizes on common punctuation,
 * dedupes, ignores tokens shorter than 2 chars. Reads page bodies via
 * source.getContent — fine for ~120 pages, swap to PG tsvector when
 * the corpus 10×s.
 */

import type { DocSource, EngineCtx, SearchArgs, SearchHit, SearchResult } from './types';

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

export async function searchDocs(source: DocSource, args: SearchArgs, ctx: EngineCtx = {}): Promise<SearchResult> {
  const limit = args.limit ?? 8;
  if (ctx.signal?.aborted) throw new Error('cancelled');
  const tokens = tokenize(args.query);
  if (tokens.length === 0) {
    ctx.metadata?.({ query_tokens: 0, hit_count: 0, returned: 0 });
    return { query: args.query, tokenCount: 0, hitCount: 0, hits: [] };
  }

  const pages = await source.listPages();
  if (ctx.signal?.aborted) throw new Error('cancelled');
  ctx.progress?.(10, `searching ${pages.length} pages`);

  // Per-page render, with abort checks at each step. Promise.all keeps
  // the parallelism but every renderer throws on abort so the whole
  // batch unwinds.
  let scanned = 0;
  const rendered = await Promise.all(
    pages.map(async (p) => {
      if (ctx.signal?.aborted) throw new Error('cancelled');
      const body = await source.getContent(p);
      scanned += 1;
      if (scanned % 25 === 0) {
        const pct = 10 + Math.floor((scanned / pages.length) * 70);
        ctx.progress?.(pct, `scored ${scanned}/${pages.length}`);
      }
      return { page: p, body };
    }),
  );
  if (ctx.signal?.aborted) throw new Error('cancelled');
  ctx.progress?.(85, 'ranking');

  const scored: SearchHit[] = [];
  for (const { page, body } of rendered) {
    const title = page.title ?? '';
    const description = page.description ?? '';
    let score = 0;
    for (const t of tokens) {
      score += countOccurrences(title, t) * 4;
      score += countOccurrences(description, t) * 2;
      score += countOccurrences(body, t);
    }
    if (score === 0) continue;

    scored.push({
      slug: page.slug || '_root',
      url: page.url,
      title,
      ...(description ? { description } : {}),
      score,
      excerpt: makeExcerpt(body, tokens),
    });
  }

  scored.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
  const hits = scored.slice(0, limit);

  ctx.metadata?.({ query_tokens: tokens.length, hit_count: scored.length, returned: hits.length });

  return { query: args.query, tokenCount: tokens.length, hitCount: scored.length, hits };
}
