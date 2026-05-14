/**
 * docs:get — context-aware doc page fetch.
 *
 * Same routing as docs:outline: harness-context callers get their
 * harness's docs; everyone else gets Papercusp engineering reference.
 */

import * as path from 'node:path';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  getDocs,
  fumadocsAdapter,
  harnessFsAdapter,
  withPreamble,
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

const engineeringBase = fumadocsAdapter(internalSource as never, {
  name: 'papercusp-engineering',
  contentRoot: path.join(process.cwd(), 'content', 'internal-docs'),
});

function wrapWithPreamble(base: DocSource): DocSource {
  return {
    ...base,
    async getContent(page) {
      const body = await base.getContent(page);
      return withPreamble(body, {
        title: page.title,
        url: page.url,
        ...(page.description ? { description: page.description } : {}),
      });
    },
  };
}

async function resolveAdapter(harnessSlug: string | undefined): Promise<{
  adapter: DocSource;
  surface: 'harness' | 'engineering';
  error?: { code: string; slug?: string };
}> {
  if (!harnessSlug) {
    return { adapter: wrapWithPreamble(engineeringBase), surface: 'engineering' };
  }
  const reg = await loadHarnessRegistry();
  const project = reg.projects.find((p) => p.slug === harnessSlug);
  if (!project) {
    return {
      adapter: wrapWithPreamble(engineeringBase),
      surface: 'engineering',
      error: { code: 'harness_not_registered', slug: harnessSlug },
    };
  }
  return {
    adapter: wrapWithPreamble(harnessFsAdapter(project.path, { name: `harness:${harnessSlug}` })),
    surface: 'harness',
  };
}

const argsSchema = z
  .object({
    slugs: z
      .array(z.string().min(1))
      .min(1)
      .max(10)
      .describe('1–10 slugs from docs:outline.pages[].slug (e.g. ["endpoint-system/overview"]).'),
    heading: z
      .string()
      .optional()
      .describe('Heading anchor id (from docs:outline.pages[].headings[].id). Only honored when slugs.length === 1.'),
  })
  .refine((v) => !v.heading || v.slugs.length === 1, {
    message: 'heading is only valid when slugs has exactly one entry',
    path: ['heading'],
  });

export default defineTool({
  name: 'docs:get',
  description:
    "Fetch documentation pages by slug — your harness's docs if you're in a harness, otherwise the Papercusp framework reference. Batch up to 10; pass `heading` (single-slug only) for a section slice. Per-slug error envelope.",
  guidance: {
    when: 'You have slugs from docs:outline and need page contents. Use `heading` (single-slug) when only one section of a long page is relevant.',
    notWhen:
      'You do not yet know the slug — call docs:outline first. To fetch another harness\'s docs from outside, use cross_harness:docs_get.',
    chaining:
      'docs:outline → docs:get { slugs } (batch up to 10) → optionally re-fetch with { slugs: [picked], heading } for surgical reads.',
  },
  capability: 'docs:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  modality: ['text'],
  rolesQuota: {
    worker: { perChunk: 10 },
    operator: { perRun: 15 },
  },
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as {
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

    const response = await getDocs(resolved.adapter, args, {
      ...(ctxAny.signal && { signal: ctxAny.signal }),
      ...(ctxAny.metadata && { metadata: ctxAny.metadata }),
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...response, surface: resolved.surface }) }] };
  },
});

export { resolveAdapter as __resolveAdapterForTesting };
