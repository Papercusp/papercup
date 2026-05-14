/**
 * harness:docs_get — fetch pages from THIS harness's documentation.
 *
 * Mirrors docs:get for harness-local files. Per-slug error envelope,
 * optional heading slice (single-slug), 50KB cap, fuzzy suggestions
 * on miss.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getDocs, harnessFsAdapter } from '@papercusp/docs-engine';
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

const argsSchema = z
  .object({
    slugs: z
      .array(z.string().min(1))
      .min(1)
      .max(10)
      .describe('1–10 slugs from harness:docs_outline (e.g. ["docs/architecture", "harness-state/SPEC"]).'),
    heading: z
      .string()
      .optional()
      .describe('Heading anchor id (from outline). Only honored when slugs.length === 1.'),
  })
  .refine((v) => !v.heading || v.slugs.length === 1, {
    message: 'heading is only valid when slugs has exactly one entry',
    path: ['heading'],
  });

export default defineTool({
  name: 'harness:docs_get',
  description:
    "Fetch one or more pages from THIS harness's documentation by slug (from harness:docs_outline). Batch up to 10; pass `heading` (single-slug only) for a section slice. Per-slug error envelope.",
  guidance: {
    when: 'You have slugs from harness:docs_outline and need the content. Use `heading` (single-slug only) to fetch one section of a long page.',
    notWhen:
      'You do not yet know the slug — call harness:docs_outline first. For Papercusp framework docs use docs:get.',
    chaining:
      'harness:docs_outline → harness:docs_get { slugs } (batch up to 10) → optionally re-fetch with { slugs: [picked], heading } for surgical reads.',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  rolesQuota: {
    worker: { perChunk: 10 },
    operator: { perRun: 15 },
  },
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { harnessSlug?: string; metadata?: (data: Record<string, unknown>) => void };
    const slug = ctxAny.harnessSlug;
    if (!slug) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ error: 'no_harness_context' }) },
        ],
        isError: true,
      };
    }
    const reg = await loadHarnessRegistry();
    const project = reg.projects.find((p) => p.slug === slug);
    if (!project) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'harness_not_registered', slug }) }],
        isError: true,
      };
    }
    const adapter = harnessFsAdapter(project.path, { name: `harness:${slug}` });
    const response = await getDocs(adapter, args, { metadata: ctxAny.metadata });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...response, harnessSlug: slug }) }] };
  },
});
