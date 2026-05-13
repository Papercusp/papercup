/**
 * Pure docs:get fetch logic — no fumadocs imports.
 *
 * Composes:
 *   - slug lookup against an injectable OutlineSource
 *   - getText() rendering (injected, defaults to lib/get-llm-text.ts)
 *   - heading slicing (single-slug calls only)
 *   - size cap + truncation tail
 *   - fuzzy suggestions on miss
 */

import {
  MAX_PAYLOAD_BYTES,
  levenshteinNearest,
  sliceByHeading,
  truncationTail,
  type TocEntry,
} from './shared';
import type { OutlineSourcePage } from './outline-builder';

export interface GetSource {
  getPages(): OutlineSourcePage[];
  getPage(slugs: string[]): OutlineSourcePage | null | undefined;
}

export type RenderPage = (page: OutlineSourcePage) => Promise<string>;

export type DocsGetResult =
  | { slug: string; found: true; content: string; bytes: number; truncated?: true; sliced?: true }
  | {
      slug: string;
      found: false;
      error: 'not_found' | 'heading_not_found';
      suggestions?: string[];
    };

export interface DocsGetResponse {
  results: DocsGetResult[];
}

export async function executeDocsGet(
  args: { slugs: string[]; heading?: string },
  src: GetSource,
  render: RenderPage,
): Promise<DocsGetResponse> {
  const { slugs, heading } = args;
  const allSlugs = src.getPages().map((p) => p.slugs.join('/'));

  const results: DocsGetResult[] = await Promise.all(
    slugs.map(async (slug): Promise<DocsGetResult> => {
      const page = src.getPage(slug.split('/'));
      if (!page) {
        return {
          slug,
          found: false,
          error: 'not_found',
          suggestions: levenshteinNearest(slug, allSlugs, { maxRatio: 0.3, k: 3 }),
        };
      }

      let body = await render(page);

      if (heading) {
        const toc = (page.data.toc ?? []) as TocEntry[];
        const sliced = sliceByHeading(body, heading, toc);
        if (!sliced) {
          return {
            slug,
            found: false,
            error: 'heading_not_found',
            suggestions: toc
              .map((h) => (h.url ?? '').replace(/^#/, ''))
              .filter(Boolean)
              .slice(0, 5),
          };
        }
        body = sliced;
      }

      const originalBytes = body.length;
      let truncated = false;
      if (body.length > MAX_PAYLOAD_BYTES) {
        const toc = (page.data.toc ?? []) as TocEntry[];
        const firstH2 = toc.find((h) => h.depth === 2);
        const h2Count = toc.filter((h) => h.depth === 2).length;
        body =
          body.slice(0, MAX_PAYLOAD_BYTES) +
          truncationTail({
            firstH2Id: firstH2 ? (firstH2.url ?? '').replace(/^#/, '') : undefined,
            h2Count,
          });
        truncated = true;
      }

      const hit: DocsGetResult = {
        slug,
        found: true,
        content: body,
        bytes: originalBytes,
        ...(truncated && { truncated: true as const }),
        ...(heading && { sliced: true as const }),
      };
      return hit;
    }),
  );

  return { results };
}
