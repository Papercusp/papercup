/**
 * docs:search tool registration.
 *
 * Keyword search across the project docs. Title weighted 4x,
 * description 2x, body 1x. Ranked hits with slug, url, title,
 * description, score, and excerpt around the first match.
 *
 * Uses page.data.getText('raw') (not the remark-processed markdown)
 * to keep search cheap — body matches against original MDX. JSX
 * component names will appear in the body and will match, which is
 * acceptable: a search for "Callout" should find pages that use it.
 *
 * Pairs with docs:outline (discovery) and docs:get (read). Use when
 * keyword matters more than navigation — e.g. "where is replay buffer
 * documented?" rather than "what's in endpoint-system?".
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { source } from '@/lib/source';
import {
  executeDocsSearch,
  type SearchSource,
  type SearchSourcePage,
} from './search-builder';

const ALL_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

const argsSchema = z.object({
  query: z
    .string()
    .min(2)
    .max(200)
    .describe('Keyword query. Whitespace-separated tokens; tokens <2 chars dropped.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(8)
    .describe('Max hits returned. Default 8.'),
});

export default defineTool({
  name: 'docs:search',
  description:
    'Keyword search across the project documentation. Returns ranked hits (slug, title, description, excerpt). Use when you have a specific term to look up; prefer docs:outline for browsing.',
  guidance: {
    when: 'You have specific terminology in mind (a function name, concept, or component) and want to find which doc page covers it. Faster than scanning the outline when the section name is non-obvious.',
    notWhen:
      'You do not know what to search for — call docs:outline first to see the section taxonomy. For PG-stored prose recall (escalations, chats) use search:fulltext.',
    chaining:
      'docs:search → docs:get { slugs: [top-hit] } (or { slug, heading } if the hit excerpt names a specific heading).',
  },
  capability: 'docs:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  rolesQuota: {
    worker: { perChunk: 8 },
    operator: { perRun: 20 },
  },
  args: argsSchema,
  async handler(args, ctx) {
    const response = await executeDocsSearch(
      args,
      source as unknown as SearchSource,
      async (page) => {
        // Cast away the InferPageType narrowing; SearchSource only needs the
        // public slugs/url/data shape we declare in the builder. getText is
        // a fumadocs-mdx DocMethod hung off page.data.
        const inner = (page as unknown as { data: { getText: (k: 'raw' | 'processed') => Promise<string> } }).data;
        return inner.getText('raw');
      },
    );

    ctx.metadata?.({
      query_token_count: response.tokenCount,
      hit_count: response.hitCount,
      returned: response.hits.length,
      top_score: response.hits[0]?.score ?? 0,
    });

    // SearchSourcePage shape is exactly what fumadocs gives us minus the
    // private fields. Cast is purely a type-narrowing aid.
    void (null as unknown as SearchSourcePage);

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(response) }],
    };
  },
});
