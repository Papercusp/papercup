/**
 * plans:get — full parsed structure for one plan.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.1.
 * Returns frontmatter, ## Now, items (with both storedStatus AND
 * effectiveStatus), decisions, and raw prose. Resolves both
 * docs/plans/ and docs/plans/archive/ — archived doesn't make a plan
 * unreachable.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readPlanBySlug } from './source';
import { resolveEffectiveStatus } from './effective-status';
import { hashPlanContent } from './content-hash';

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
  slug: z
    .string()
    .min(1)
    .describe('Plan slug (filename without .md). Resolves both docs/plans/ and docs/plans/archive/.'),
});

export default defineTool({
  name: 'plans:get',
  description:
    'Fetch the full parsed structure of one plan by slug: frontmatter, ## Now (state + next), items with effectiveStatus, decisions. Resolves archived plans too.',
  guidance: {
    when: 'You have a slug from plans:list and need the plan contents.',
    notWhen:
      "You don't know the slug — call plans:list first. Item-only queries across plans should use plans:items.",
    chaining: 'plans:list → plans:get { slug } → optionally plans:items for cross-plan picks.',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const result = await readPlanBySlug(args.slug);
    if (!result) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not_found', slug: args.slug }) }],
        isError: true,
      };
    }

    const { parsed, archived } = result;
    ctxAny.metadata?.({ slug: args.slug, archived, legacy: parsed.isLegacy });

    if (parsed.isLegacy) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              slug: parsed.slug,
              archived,
              legacy: true,
              prose: parsed.prose,
              raw: parsed.raw,
              contentHash: hashPlanContent(parsed.raw),
              filename: parsed.filename,
            }),
          },
        ],
      };
    }

    const resolved = resolveEffectiveStatus(parsed);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            slug: parsed.frontmatter.slug ?? parsed.slug,
            archived,
            legacy: false,
            frontmatter: parsed.frontmatter,
            now: parsed.now,
            items: resolved.items,
            decisions: parsed.decisions,
            missingRefs: resolved.missingRefs,
            cycleMembers: resolved.cycleMembers,
            prose: parsed.prose,
            raw: parsed.raw,
            contentHash: hashPlanContent(parsed.raw),
          }),
        },
      ],
    };
  },
});
