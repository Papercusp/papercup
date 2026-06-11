/**
 * cross_harness:outbox — read messages a harness sent (scans every
 * harness_*.messages schema for from_slug = the given slug).
 *
 * Mirrors GET /api/harness/:slug/outbox.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { readOutbox } from '../../cross-harness-data';

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
  agentRoles: [...SU_ROLES],
  args: z.object({
    slug: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(),
  }),
  // Declarative precondition (adopt-event-rules-engines requires:-half): the
  // former in-handler `if (!slug) throw` guard, lifted.
  requires: [
    {
      id: 'harness-slug',
      when: {
        any: [{ 'args.slug': { truthy: true } }, { 'ctx.harnessSlug': { truthy: true } }],
      },
      error: 'cross_harness:outbox — slug required (passed or in spawn ctx)',
    },
  ],
  async handler(args, ctx) {
    // Non-empty by the `harness-slug` precondition above.
    const slug = args.slug ?? ctx.harnessSlug ?? '';
    const messages = await readOutbox(slug, args.limit);
    return { content: [{ type: 'text', text: JSON.stringify({ slug, messages }) }] };
  },
});
