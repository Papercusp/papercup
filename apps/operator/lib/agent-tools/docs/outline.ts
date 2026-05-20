/**
 * docs:outline — context-aware doc outline.
 *
 * Resolves the source by caller context:
 *   - ctx.harnessSlug set → that harness's docs (the harnessFsAdapter)
 *   - otherwise          → Papercusp engineering reference
 *                          (fumadocsAdapter against internalSource)
 *
 * Same tool, same shape — the agent doesn't need to learn two surfaces.
 * Workers/scopers in a harness get their harness's docs; SU and
 * operator/oracle/documenter agents working on Papercusp itself get
 * the framework engineering reference. Cross-harness lookups (an
 * engineer wanting harness X's docs from outside) use
 * cross_harness:docs_outline.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  buildOutline,
  harnessFsAdapter,
  RunCache,
  type DocSource,
  type OutlinePayload,
} from '@papercusp/docs-engine';
import { loadHarnessRegistry } from '@/lib/harness-registry';
import { engineeringAdapter } from './_engineering-adapter';

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

export async function resolveAdapter(harnessSlug: string | undefined): Promise<{
  adapter: DocSource;
  scope: string;
  surface: 'harness' | 'engineering';
  error?: { code: string; slug?: string };
}> {
  if (!harnessSlug) {
    return { adapter: engineeringAdapter, scope: '_engineering', surface: 'engineering' };
  }
  const reg = await loadHarnessRegistry();
  const project = reg.projects.find((p) => p.slug === harnessSlug);
  if (!project) {
    return {
      adapter: engineeringAdapter,
      scope: '_engineering',
      surface: 'engineering',
      error: { code: 'harness_not_registered', slug: harnessSlug },
    };
  }
  return {
    adapter: harnessFsAdapter(project.path, { name: `harness:${harnessSlug}` }),
    scope: harnessSlug,
    surface: 'harness',
  };
}

export default defineTool({
  name: 'docs:outline',
  description:
    'Return the documentation table-of-contents for your context — your harness\'s docs if you\'re in a harness, otherwise the Papercusp framework engineering reference. Cached per run. Call this FIRST when you need design context; drill in via docs:get.',
  guidance: {
    when: 'You need design context, architectural rationale, or "how does X work" answers and have not yet called docs:outline this run.',
    notWhen:
      'You already called docs:outline this run — cached. For prose recall (chats, escalations, brainstorms) use search:fulltext. To explore another harness from outside, use cross_harness:docs_outline.',
    chaining:
      'docs:outline → docs:get { slugs: [...] }. Use { slug, heading } when only one section of a long page is relevant.',
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
      harnessSlug?: string;
      signal?: AbortSignal;
      metadata?: (d: Record<string, unknown>) => void;
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

    const hit = cache.get(ctxAny, resolved.scope);
    if (hit) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ...hit, cached: true, surface: resolved.surface }) }],
      };
    }
    const payload = await buildOutline(resolved.adapter, {
      ...(ctxAny.runId !== undefined && { runId: ctxAny.runId }),
      ...(ctxAny.spawnId !== undefined && { spawnId: ctxAny.spawnId }),
      ...(ctxAny.signal && { signal: ctxAny.signal }),
      ...(ctxAny.metadata && { metadata: ctxAny.metadata }),
    });
    cache.set(ctxAny, payload, resolved.scope);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ...payload, cached: false, surface: resolved.surface }) }],
    };
  },
});

