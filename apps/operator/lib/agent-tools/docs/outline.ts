/**
 * docs:outline — public Papercusp documentation outline.
 *
 * Thin wrapper around @papercusp/docs-engine's buildOutline. The engine
 * owns sectioning, heading extraction, and metadata; this file only
 * configures the fumadocs adapter, the per-run cache, and the tool
 * manifest (role gating, capability, guidance).
 */

import * as path from 'node:path';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { buildOutline, fumadocsAdapter, type OutlinePayload } from '@papercusp/docs-engine';
import { source } from '@/lib/source';

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

/** Per-run cache, module-scoped. Keyed by runId ?? spawnId. */
export const outlineCache = new Map<string, OutlinePayload>();
export const OUTLINE_CACHE_MAX = 100;

const adapter = fumadocsAdapter(source as never, {
  name: 'papercusp-public',
  contentRoot: path.join(process.cwd(), 'content', 'docs'),
});

export default defineTool({
  name: 'docs:outline',
  description:
    'Return the public Papercusp documentation table-of-contents — sections, pages, page descriptions, and per-page heading ids. Call this FIRST when you need design context; drill in via docs:get. Cached per-run.',
  guidance: {
    when: 'You need design context, architectural rationale, or "how does X work" answers about Papercusp itself and have not yet called docs:outline this run.',
    notWhen:
      'You already called docs:outline this run. For your own harness\'s docs (specs, plans, project files) use harness:docs_outline / harness:docs_get. For PG-stored prose recall use search:fulltext.',
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
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...hit, cached: true }) }] };
    }

    const payload = await buildOutline(adapter);
    outlineCache.set(key, payload);
    if (outlineCache.size > OUTLINE_CACHE_MAX) {
      const oldest = outlineCache.keys().next().value;
      if (oldest !== undefined) outlineCache.delete(oldest);
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...payload, cached: false }) }] };
  },
});
