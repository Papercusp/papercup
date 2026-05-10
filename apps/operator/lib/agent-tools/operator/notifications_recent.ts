/**
 * notifications:recent — list recent toast notifications shown
 * anywhere in the app (errors, warnings, info).
 *
 * Wraps GET /api/toast-log. Mirrors the `notifications.recent`
 * registry def in lib/commands/defs/recent-activity.ts.
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
  name: 'notifications:recent',
  description: 'List recent toast notifications shown in the app (errors, warnings, info, success).',
  capability: 'notifications:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({
    level: z.enum(['default', 'info', 'success', 'warning', 'error', 'loading', 'all']).optional(),
    limit: z.number().int().positive().max(500).optional(),
  }),
  async handler(args) {
    const params = new URLSearchParams();
    if (args.limit) params.set('limit', String(args.limit));
    const r = await fetch(`${operatorBaseUrl()}/api/toast-log?${params}`);
    if (!r.ok) throw new Error(`notifications:recent failed: HTTP ${r.status}`);
    const d = await r.json();
    let toasts: Array<Record<string, unknown>> = d?.toasts ?? [];
    if (args.level && args.level !== 'all') {
      toasts = toasts.filter((t) => t.level === args.level);
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ count: toasts.length, notifications: toasts }) }],
    };
  },
});
