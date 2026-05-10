/**
 * harness:health — fast health snapshot for a harness (alive,
 * escalated, feature-status counts).
 *
 * Single fast call instead of harness:status + harness:escalation
 * separately. Wraps GET /api/harness/:slug/health.
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
  name: 'harness:health',
  description: 'Fast health snapshot for a harness — alive/escalated/feature_counts/lastRunMs in one call.',
  capability: 'harness:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({
    slug: z.string().min(1),
  }),
  async handler(args) {
    const r = await fetch(`${operatorBaseUrl()}/api/harness/${encodeURIComponent(args.slug)}/health`);
    if (!r.ok) throw new Error(`harness:health failed: HTTP ${r.status}`);
    const d = await r.json();
    return { content: [{ type: 'text', text: JSON.stringify(d) }] };
  },
});
