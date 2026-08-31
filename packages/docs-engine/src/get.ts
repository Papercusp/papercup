/**
 * getDocs — source-agnostic batch page fetch.
 *
 * - 1..10 slugs per call (zod enforces upstream; caller may still
 *   pass an empty array which we tolerate by returning {results: []})
 * - Optional heading slice on single-slug calls
 * - 50KB cap per result with truncation tail
 * - Levenshtein-nearest suggestions on miss
 * - Engine emits identical ctx.metadata across surfaces.
 */

import type {
  DocSource,
  EngineCtx,
  GetArgs,
  GetEntry,
  GetResult,
} from './types';
import {
  MAX_PAYLOAD_BYTES,
  levenshteinNearest,
  sliceByHeading,
  truncationTail,
} from './shared';
import { evaluateOkfTrust, okfTrustBanner, okfTrustIsNotable } from './okf';

export async function getDocs(source: DocSource, args: GetArgs, ctx: EngineCtx = {}): Promise<GetResult> {
  const { slugs, heading } = args;
  // Only meaningful for a single document — a batch has no one byte stream to be
  // at an offset into. Same single-slug rule `heading` follows.
  const offset =
    slugs.length === 1 && Number.isFinite(args.offset) && (args.offset ?? 0) > 0 ? Math.trunc(args.offset as number) : 0;
  // ONE clock for the whole batch — two docs in the same call must never disagree
  // about whether "today" has crossed a stale_after boundary mid-response.
  const now = ctx.now ?? new Date();
  if (ctx.signal?.aborted) throw new Error('cancelled');
  if (slugs.length === 0) {
    ctx.metadata?.({ requested: 0, found: 0, not_found: 0, truncated: 0, sliced: 0, has_heading: !!heading });
    return { results: [] };
  }

  const allPages = await source.listPages();
  if (ctx.signal?.aborted) throw new Error('cancelled');
  const allSlugs = allPages.map((p) => p.slug);

  const results: GetEntry[] = await Promise.all(
    slugs.map(async (slug): Promise<GetEntry> => {
      if (ctx.signal?.aborted) throw new Error('cancelled');
      const page = await source.getPage(slug);
      if (!page) {
        return {
          slug,
          found: false,
          error: 'not_found',
          suggestions: levenshteinNearest(slug, allSlugs),
        };
      }

      let body = await source.getContent(page);
      const onlyHeading = heading && slugs.length === 1 ? heading : undefined;

      if (onlyHeading) {
        // sliceByHeading expects TocEntry shape: { url: '#id', title, depth }
        const tocEntries = page.toc.map((h) => ({ url: `#${h.id}`, title: h.text, depth: h.depth }));
        const sliced = sliceByHeading(body, onlyHeading, tocEntries);
        if (!sliced) {
          return {
            slug,
            found: false,
            error: 'heading_not_found',
            suggestions: page.toc.slice(0, 5).map((h) => h.id),
          };
        }
        body = sliced;
      }

      // OKF read-time trust (P-005). The banner is prepended BEFORE the truncation
      // cap so a stale warning is never the thing that gets cut off the end of a
      // long doc (`bytes` then measures the content actually returned, banner included).
      const trust = evaluateOkfTrust(page.okf, now);
      const banner = okfTrustBanner(trust);
      if (banner) body = banner + body;

      const originalBytes = body.length;
      // `offset` resumes a clipped read; `bytes` stays the WHOLE document's length
      // so a caller can always see how much of it this window covers.
      const start = Math.min(offset, originalBytes);
      let truncated = false;
      let nextOffset: number | undefined;
      if (start > 0) body = body.slice(start);
      if (body.length > MAX_PAYLOAD_BYTES) {
        const h2s = page.toc.filter((h) => h.depth === 2);
        const firstH2 = h2s[0];
        nextOffset = start + MAX_PAYLOAD_BYTES;
        body = body.slice(0, MAX_PAYLOAD_BYTES) + truncationTail({
          ...(firstH2 ? { firstH2Id: firstH2.id } : {}),
          h2Count: h2s.length,
          nextOffset,
        });
        truncated = true;
      }

      return {
        slug,
        found: true,
        content: body,
        bytes: originalBytes,
        ...(truncated ? { truncated: true as const } : {}),
        ...(start > 0 ? { offset: start } : {}),
        ...(nextOffset !== undefined ? { nextOffset } : {}),
        ...(onlyHeading ? { sliced: true as const } : {}),
        ...(okfTrustIsNotable(trust) ? { trust } : {}),
      };
    }),
  );

  const found = results.filter((r) => r.found).length;
  const notFound = results.length - found;
  const truncatedCount = results.filter((r) => 'truncated' in r && r.truncated).length;
  const slicedCount = results.filter((r) => 'sliced' in r && r.sliced).length;
  // Heuristic: presence of mdxJsxFlowElement-style tokens that survived the
  // JSX-cleanup remark pass. Strip code blocks first so fenced code samples
  // containing JSX (e.g. doc snippets) don't false-positive.
  const jsxLiteralsPresent = results.some((r) => {
    if (!r.found) return false;
    const stripped = r.content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
    return /<[A-Z][A-Za-z0-9]*[\s/>]/.test(stripped);
  });
  ctx.metadata?.({
    requested: slugs.length,
    found,
    not_found: notFound,
    truncated: truncatedCount,
    sliced: slicedCount,
    has_heading: !!heading,
    jsx_literals_present: jsxLiteralsPresent,
  });

  return { results };
}

/** Re-export for adapters / tests that need the constant. */
export { MAX_PAYLOAD_BYTES };
