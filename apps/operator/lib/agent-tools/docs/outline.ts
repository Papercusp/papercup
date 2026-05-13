/**
 * docs:outline tool registration.
 *
 * Wraps buildOutline (in outline-builder.ts) with the per-run cache
 * and the defineTool projection. Pure logic lives in the builder so
 * vitest can exercise it without fumadocs.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { source } from '@/lib/source';
import { buildOutline, type OutlinePayload, type OutlineSource } from './outline-builder';

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

/** Module-scoped per-run cache. */
export const outlineCache = new Map<string, OutlinePayload>();
export const OUTLINE_CACHE_MAX = 100;

export default defineTool({
  name: 'docs:outline',
  description:
    'Return the project documentation table-of-contents — sections, pages, page descriptions, and per-page heading ids. Call this FIRST when you need design context; the agent then drills in via docs:get. Cached per-run.',
  guidance: {
    when: 'You need design context, architectural rationale, or "how does X work" answers and you have not yet called docs:outline this run.',
    notWhen:
      'You already called docs:outline this run — the cached result has the full TOC, no need to re-fetch. For per-harness specs use harness:markdown_index. For PG-stored prose recall use search:fulltext.',
    chaining:
      'docs:outline → docs:get { slugs: [...] }. Use { slug, heading } form when only one section of a long page is relevant.',
  },
  capability: 'docs:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({}),
  async handler(_args, ctx) {
    const ctxAny = ctx as { runId?: string; spawnId?: string };
    const key = ctxAny.runId ?? ctxAny.spawnId ?? '_anonymous';

    const hit = outlineCache.get(key);
    if (hit) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ...hit, cached: true }) }],
      };
    }

    const payload = await buildOutline(source as unknown as OutlineSource);
    outlineCache.set(key, payload);
    if (outlineCache.size > OUTLINE_CACHE_MAX) {
      const oldest = outlineCache.keys().next().value;
      if (oldest !== undefined) outlineCache.delete(oldest);
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ...payload, cached: false }) }],
    };
  },
});
