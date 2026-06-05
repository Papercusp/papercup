/**
 * cross_harness:outbox — read messages a harness sent (scans every
 * harness_*.messages schema for from_slug = the given slug).
 *
 * Mirrors GET /api/harness/:slug/outbox.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readOutbox } from '../../cross-harness-data';

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
  name: 'cross_harness:outbox',
  profile: 'engineer',
  description: 'Read messages a harness sent (cross-schema scan by from_slug).',
  guidance: {
    when: 'You need to see what a specific harness sent — across recipients. Cross-harness analog of `messages:outbox`.',
    notWhen: 'For YOUR outbox, use `messages:outbox`. For incoming, use `cross_harness:inbox`.',
  },
  capability: 'cross_harness:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({
    slug: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(),
  }),
  async handler(args, ctx) {
    const slug = args.slug ?? ctx.harnessSlug ?? '';
    if (!slug) throw new Error('cross_harness:outbox — slug required');
    const messages = await readOutbox(slug, args.limit);
    return { content: [{ type: 'text', text: JSON.stringify({ slug, messages }) }] };
  },
});
