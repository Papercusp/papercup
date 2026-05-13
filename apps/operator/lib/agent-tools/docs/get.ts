/**
 * docs:get tool registration.
 *
 * Fetch one or more pages (batch up to 10) by slug. Optional `heading`
 * slice on single-slug calls. Pure logic lives in get-builder.ts so
 * vitest can exercise it without fumadocs.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { source } from '@/lib/source';
import { getLLMText } from '@/lib/get-llm-text';
import { executeDocsGet, type GetSource } from './get-builder';

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
      .describe(
        '1–10 slugs from docs:outline.pages[].slug, e.g. ["endpoint-system/overview"].',
      ),
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

export default defineTool({
  name: 'docs:get',
  description:
    'Fetch one or more documentation pages by slug. Batch up to 10 in a single call; pass `heading` (single-slug only) to fetch a specific section. Per-slug error envelope — a failed slug does not fail the batch.',
  guidance: {
    when: 'You have one or more slugs from docs:outline and need the page contents. Use `heading` (single-slug only) when the outline showed a multi-heading page and you only need one section.',
    notWhen:
      'You do not yet know the slug — call docs:outline first. For the entire doc corpus in one shot, curl /llms-full.txt directly; no tool needed.',
    chaining:
      'docs:outline → docs:get { slugs } (batch up to 10) → optionally re-fetch with { slugs: [picked], heading } for surgical reads.',
  },
  capability: 'docs:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  rolesQuota: {
    worker: { perChunk: 10 },
    operator: { perRun: 15 },
  },
  args: argsSchema,
  async handler(args, ctx) {
    const response = await executeDocsGet(
      args,
      source as unknown as GetSource,
      (page) => getLLMText(page as never),
    );

    // Emit per-call telemetry signal. Schema:
    //   { requested, found, not_found, truncated, sliced, has_heading,
    //     jsx_literals_present }
    // Persists into harness_shared.tool_invocations.metadata_json
    // (migration 068). Drives Phase 2 trigger predicates documented
    // in apps/operator/docs/plans/docs-retrieval-phase1.md.
    //
    // jsx_literals_present detects raw `<ComponentName>` tags that
    // slipped through remark-mdx-to-markdown — used to monitor for
    // new MDX components that need an UNWRAP_NAMES entry. The regex
    // skips code-fenced JSX (any backticked spans) for accuracy.
    const jsxLiteralsPresent = response.results.some((r) => {
      if (!r.found) return false;
      const stripped = r.content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
      return /<[A-Z][A-Za-z]+\b/.test(stripped);
    });

    ctx.metadata?.({
      requested: response.results.length,
      found: response.results.filter((r) => r.found).length,
      not_found: response.results.filter((r) => !r.found).length,
      truncated: response.results.filter((r) => 'truncated' in r && r.truncated).length,
      sliced: response.results.filter((r) => 'sliced' in r && r.sliced).length,
      has_heading: Boolean(args.heading),
      jsx_literals_present: jsxLiteralsPresent,
    });

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(response) }],
    };
  },
});
