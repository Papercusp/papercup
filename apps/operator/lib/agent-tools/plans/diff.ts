/**
 * plans:diff — raw unified diff for one commit touching a plan file.
 *
 * Q3 of plans-admin-ui-2026-05-20 (companion to plans:history).
 *
 * Reads `git diff <hash>^! -- <path>` (the same range as `<hash>^
 * <hash>`). Slug + hash are regex-validated before reaching git's
 * argv (execFile is shell-less). Missing file (untracked plan) returns
 * an empty diff string rather than an error.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readPlanDiff } from './git-history';

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
  hash: z
    .string()
    .min(4)
    .describe('Commit hash (4–40 hex chars). The hash of the commit whose changes you want.'),
  archived: z
    .boolean()
    .optional()
    .describe('Read from docs/plans/archive/ instead of docs/plans/. Default false.'),
});

export default defineTool({
  name: 'plans:diff',
  description:
    'Unified diff for one commit touching a plan file. Returns the raw `git diff <hash>^!` text — empty string when the plan file is untracked.',
  guidance: {
    when: 'You have a commit hash from plans:history and want the patch — what exactly changed in that commit, side-by-side with surrounding context.',
    notWhen:
      'You want a list of commits — that is plans:history. You want the current contents — plans:get.',
    chaining: 'plans:history → plans:diff { hash } for any commit.',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const result = await readPlanDiff(args.slug, args.hash, { archived: args.archived });
    if (!result.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: result.code, message: result.message, slug: args.slug }),
          },
        ],
        isError: true,
      };
    }
    ctxAny.metadata?.({ slug: args.slug, diffBytes: result.diff.length });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ diff: result.diff }) }],
    };
  },
});
