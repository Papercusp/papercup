/**
 * docs:outline — public Papercusp documentation outline.
 *
 * Thin wrapper around @papercusp/docs-engine. Per-run cache lives in
 * the engine (RunCache); this file only configures the fumadocs
 * adapter and the tool manifest.
 */

import * as path from 'node:path';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  buildOutline,
  fumadocsAdapter,
  RunCache,
  type OutlinePayload,
} from '@papercusp/docs-engine';
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

const cache = new RunCache<OutlinePayload>();

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
  modality: ['text'],
  args: z.object({}),
  async handler(_args, ctx) {
    const ctxAny = ctx as {
      runId?: string;
      spawnId?: string;
      signal?: AbortSignal;
      metadata?: (d: Record<string, unknown>) => void;
    };
    const hit = cache.get(ctxAny);
    if (hit) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ...hit, cached: true }) }],
      };
    }
    const payload = await buildOutline(adapter, {
      ...(ctxAny.runId !== undefined && { runId: ctxAny.runId }),
      ...(ctxAny.spawnId !== undefined && { spawnId: ctxAny.spawnId }),
      ...(ctxAny.signal && { signal: ctxAny.signal }),
      ...(ctxAny.metadata && { metadata: ctxAny.metadata }),
    });
    cache.set(ctxAny, payload);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ...payload, cached: false }) }],
    };
  },
});
