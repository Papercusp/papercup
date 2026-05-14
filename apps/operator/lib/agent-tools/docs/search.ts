/**
 * docs:search — context-aware keyword search.
 *
 * Same routing as docs:outline: harness-context callers get their
 * harness's docs; everyone else gets Papercusp engineering reference.
 */

import * as path from 'node:path';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  searchDocs,
  fumadocsAdapter,
  harnessFsAdapter,
  type DocSource,
} from '@papercusp/docs-engine';
import { internalSource } from '@/lib/source';
import { loadHarnessRegistry } from '@/lib/harness-registry';

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

const engineeringAdapter = fumadocsAdapter(internalSource as never, {
  name: 'papercusp-engineering',
  contentRoot: path.join(process.cwd(), 'content', 'internal-docs'),
});

export async function resolveAdapter(harnessSlug: string | undefined): Promise<{
  adapter: DocSource;
  surface: 'harness' | 'engineering';
  error?: { code: string; slug?: string };
}> {
  if (!harnessSlug) return { adapter: engineeringAdapter, surface: 'engineering' };
  const reg = await loadHarnessRegistry();
  const project = reg.projects.find((p) => p.slug === harnessSlug);
  if (!project) {
    return {
      adapter: engineeringAdapter,
      surface: 'engineering',
      error: { code: 'harness_not_registered', slug: harnessSlug },
    };
  }
  return {
    adapter: harnessFsAdapter(project.path, { name: `harness:${harnessSlug}` }),
    surface: 'harness',
  };
}

const argsSchema = z.object({
  query: z.string().min(2).max(200).describe('Keyword query. Whitespace-separated tokens; tokens <2 chars dropped.'),
  limit: z.number().int().min(1).max(20).default(8).describe('Max hits returned. Default 8.'),
});

export default defineTool({
  name: 'docs:search',
  description:
    "Keyword search across your context's documentation — your harness's docs if you're in a harness, otherwise the Papercusp framework reference. Returns ranked hits (slug, title, description, excerpt).",
  guidance: {
    when: 'You have specific terminology in mind (a function name, concept, or component) and want to find which doc page covers it. Faster than scanning the outline when the section name is non-obvious.',
    notWhen:
      'You do not know what to search for — call docs:outline first. For PG-stored prose (chats, escalations) use search:fulltext. To search another harness from outside, use cross_harness:docs_search.',
    chaining:
      'docs:search → docs:get { slugs: [top-hit] } (or { slug, heading } if the hit excerpt names a specific heading).',
  },
  capability: 'docs:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  modality: ['text'],
  rolesQuota: {
    worker: { perChunk: 8 },
    operator: { perRun: 20 },
  },
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as {
      harnessSlug?: string;
      signal?: AbortSignal;
      metadata?: (d: Record<string, unknown>) => void;
      progress?: (pct: number, msg: string) => void;
    };
    const resolved = await resolveAdapter(ctxAny.harnessSlug);
    if (resolved.error) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ error: resolved.error.code, slug: resolved.error.slug }) },
        ],
        isError: true,
      };
    }
    ctxAny.metadata?.({ surface: resolved.surface, ...(ctxAny.harnessSlug ? { harness_slug: ctxAny.harnessSlug } : {}) });

    const response = await searchDocs(resolved.adapter, args, {
      ...(ctxAny.signal && { signal: ctxAny.signal }),
      ...(ctxAny.metadata && { metadata: ctxAny.metadata }),
      ...(ctxAny.progress && { progress: ctxAny.progress }),
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...response, surface: resolved.surface }) }] };
  },
});
