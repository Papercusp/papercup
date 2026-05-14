/**
 * docs:get — fetch one or more public Papercusp doc pages by slug.
 *
 * Thin wrapper around @papercusp/docs-engine's getDocs. Per-slug error
 * envelope, optional heading slice (single-slug), 50KB cap with
 * truncation tail, Levenshtein-nearest suggestions on miss, and
 * Phase-2.0 ctx.metadata telemetry all live in the engine.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getDocs, fumadocsAdapter, withPreamble } from '@papercusp/docs-engine';
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

const argsSchema = z
  .object({
    slugs: z
      .array(z.string().min(1))
      .min(1)
      .max(10)
      .describe('1–10 slugs from docs:outline.pages[].slug, e.g. ["endpoint-system/overview"].'),
    heading: z
      .string()
      .optional()
      .describe(
        'Heading anchor id (from docs:outline.pages[].headings[].id). Only honored when slugs.length === 1; returns just that section up to the next equal-or-shallower heading.',
      ),
  })
  .refine((v) => !v.heading || v.slugs.length === 1, {
    message: 'heading is only valid when slugs has exactly one entry',
    path: ['heading'],
  });

const baseAdapter = fumadocsAdapter(source as never, { name: 'papercusp-public' });

// Wrap getContent to add the preamble (# title\nURL: ...) so the agent
// response matches the format docs:get has always returned. The engine
// stays preamble-agnostic; surfaces decide their own response shape.
const adapter = {
  ...baseAdapter,
  async getContent(page: Parameters<typeof baseAdapter.getContent>[0]) {
    const body = await baseAdapter.getContent(page);
    return withPreamble(body, { title: page.title, url: page.url, ...(page.description ? { description: page.description } : {}) });
  },
};

export default defineTool({
  name: 'docs:get',
  description:
    'Fetch one or more public Papercusp documentation pages by slug. Batch up to 10 in a single call; pass `heading` (single-slug only) to fetch a specific section. Per-slug error envelope — a failed slug does not fail the batch.',
  guidance: {
    when: 'You have one or more slugs from docs:outline and need the page contents. Use `heading` (single-slug only) when the outline showed a multi-heading page and only one section is relevant.',
    notWhen:
      'You do not yet know the slug — call docs:outline first. For your own harness\'s docs use harness:docs_get. For the entire corpus, curl /llms-full.txt directly.',
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
      signal?: AbortSignal;
      metadata?: (data: Record<string, unknown>) => void;
    };
    const response = await getDocs(adapter, args, {
      ...(ctxAny.signal && { signal: ctxAny.signal }),
      ...(ctxAny.metadata && { metadata: ctxAny.metadata }),
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
  },
});
