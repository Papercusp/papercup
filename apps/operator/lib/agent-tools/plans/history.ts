/**
 * plans:history — recent git commits for one plan file.
 *
 * Q3 of plans-admin-ui-2026-05-20: promotes the git-history surface
 * from the Plans-tab-only route handler to a `plans:*` tool, so SU
 * agents can read what changed when ("when did P-001 flip done?").
 *
 * Reads `git log --follow` over `docs/plans/<slug>.md` (or
 * `…/archive/<slug>.md` when archived=true). Slug is regex-validated
 * before reaching git's argv (execFile is shell-less). A plan with no
 * git history yet — untracked, brand-new — returns an empty list, not
 * an error.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readPlanHistory } from './git-history';

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
    .describe('Plan slug (filename stem). Resolves docs/plans/ + docs/plans/archive/.'),
  archived: z
    .boolean()
    .optional()
    .describe('Read from docs/plans/archive/ instead of docs/plans/. Default false.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Max commits to return. Default 50, max 200.'),
});

export default defineTool({
  name: 'plans:history',
  description:
    'Recent git commits touching a plan file. Returns hash / author / ISO date / subject per commit. Empty list when the plan has no tracked history yet.',
  guidance: {
    when: 'You need to know what changed in a plan and when — "what was P-001 yesterday", "who set the Now block this week", recovering recent decisions.',
    notWhen:
      'You want the current contents — call plans:get. You want the diff of a specific commit — chain to plans:diff with the hash from this tool.',
    chaining: 'plans:history → plans:diff { hash } for the patch text of any commit.',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const result = await readPlanHistory(args.slug, {
      archived: args.archived,
      limit: args.limit,
    });
    if (!result.ok) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: result.code, message: result.message, slug: args.slug }) }],
        isError: true,
      };
    }
    ctxAny.metadata?.({ slug: args.slug, commitCount: result.commits.length });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ commits: result.commits }) }],
    };
  },
});
