/**
 * cross_harness:inbox — read messages addressed to a harness.
 *
 * Mirrors GET /api/harness/:slug/inbox. Optional filters: status
 * (pending|delivered|all, default pending) and role (filter to
 * messages addressed to the role or unaddressed).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readInbox } from '../../cross-harness-data';

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

export default defineTool({
  name: 'cross_harness:inbox',
  profile: 'engineer',
  description: 'Read messages addressed to a harness (status pending|all|other; optional role filter).',
  guidance: {
    when: 'You need to see messages addressed TO a specific harness across senders. The cross-harness analog of `messages:inbox`.',
    notWhen: 'For YOUR (the calling principal\'s) inbox, use `messages:inbox`. For sent items, use `cross_harness:outbox`.',
  },
  capability: 'cross_harness:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({
    slug: z.string().optional(),
    status: z.string().optional(),
    role: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(),
  }),
  async handler(args, ctx) {
    const slug = args.slug ?? ctx.harnessSlug ?? '';
    if (!slug) throw new Error('cross_harness:inbox — slug required');
    const messages = await readInbox(slug, {
      status: args.status,
      role: args.role ?? null,
      limit: args.limit,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ slug, status: args.status ?? 'pending', role: args.role ?? null, messages }) }],
    };
  },
});
