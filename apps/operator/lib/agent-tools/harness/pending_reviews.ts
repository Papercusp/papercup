/**
 * harness:pending_reviews — list pending reviews (capability approvals,
 * plan reviews, etc.) for a harness.
 *
 * Wraps GET /api/harness/:slug/reviews. Mirrors the
 * `pending-reviews.list` registry def in lib/commands/defs/harness.ts.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { operatorBaseUrl } from '@/lib/agent-tools/_baseUrl';

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
  name: 'harness:pending_reviews',
  description: 'List pending reviews (capability approvals, plan reviews, etc.) for a harness.',
  capability: 'harness:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({
    slug: z.string().min(1),
    limit: z.number().int().positive().max(200).optional(),
  }),
  async handler(args) {
    const r = await fetch(`${operatorBaseUrl()}/api/harness/${encodeURIComponent(args.slug)}/reviews`);
    if (!r.ok) throw new Error(`harness:pending_reviews failed: HTTP ${r.status}`);
    const d = await r.json();
    const reviews = (d?.reviews ?? []).slice(0, args.limit ?? 20);
    return {
      content: [{ type: 'text', text: JSON.stringify({ count: reviews.length, reviews }) }],
    };
  },
});
