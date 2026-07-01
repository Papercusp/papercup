/**
 * cross_harness:inbox — read messages addressed to a harness.
 *
 * Mirrors GET /api/harness/:slug/inbox. Optional filters: status
 * (pending|delivered|all, default pending) and role (filter to
 * messages addressed to the role or unaddressed).
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { readInbox } from '../../cross-harness-data';
import { harnessRequiredResult, resolveConcreteHarnessSlug } from '../_harness-scope';

export default defineTool({
  name: 'cross_harness:inbox',
  profile: 'engineer',
  description: 'Read messages addressed to a harness (status pending|all|other; optional role filter).',
  guidance: {
    when: 'You need to see messages addressed TO a specific harness across senders. The cross-harness analog of `messages:inbox`.',
    notWhen: 'For YOUR (the calling principal\'s) inbox, use `messages:inbox`. For sent items, use `cross_harness:outbox`.',
    seeAlso: [
      'cross_harness:outbox (sent items)',
      'messages:inbox (YOUR own principal inbox)',
    ],
  },
  capability: 'cross_harness:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    slug: z.string().optional(),
    status: z.string().optional(),
    role: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(),
  }),
  // Declarative precondition (adopt-event-rules-engines requires:-half): the
  // former in-handler `if (!slug) throw` guard, lifted. A non-empty slug must
  // arrive via the arg or the spawn ctx.
  requires: [
    {
      id: 'harness-slug',
      when: {
        any: [{ 'args.slug': { truthy: true } }, { 'ctx.harnessSlug': { truthy: true } }],
      },
      error: 'cross_harness:inbox — slug required (passed or in spawn ctx)',
    },
  ],
  async handler(args, ctx) {
    // Precondition guarantees a slug arrived, but the operator `'*'` auto-default
    // is truthy and slips past it — route through the fail-loud resolver so `'*'`
    // is rejected, not read as a bogus `'*'` target harness (P-004).
    const slug = resolveConcreteHarnessSlug(args.slug, ctx);
    if (!slug) {
      return harnessRequiredResult('cross_harness:inbox');
    }
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
