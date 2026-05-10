/**
 * actions:recent — list recent long-running user-initiated actions for
 * a harness (replan, cleanup, snapshot).
 *
 * Wraps GET /api/user-actions/:slug. Mirrors the
 * `actions.recent` registry def in
 * apps/operator/lib/commands/defs/recent-activity.ts.
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
  name: 'actions:recent',
  description: 'List recent long-running user-initiated actions for a harness (replan, cleanup, snapshot).',
  capability: 'actions:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({
    slug: z.string().min(1),
    limit: z.number().int().positive().max(500).optional(),
  }),
  async handler(args) {
    const params = new URLSearchParams();
    if (args.limit) params.set('limit', String(args.limit));
    const r = await fetch(`${operatorBaseUrl()}/api/user-actions/${encodeURIComponent(args.slug)}?${params}`);
    if (!r.ok) {
      if (r.status === 404) {
        return { content: [{ type: 'text', text: JSON.stringify({ count: 0, actions: [] }) }] };
      }
      throw new Error(`actions:recent failed: HTTP ${r.status}`);
    }
    const d = await r.json();
    const actions = (d?.actions ?? []).slice(0, args.limit ?? 20);
    return {
      content: [{ type: 'text', text: JSON.stringify({ count: actions.length, actions }) }],
    };
  },
});
