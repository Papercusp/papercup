/**
 * harness:list_features — list features in the harness queue,
 * filterable by status.
 *
 * Mirrors the `harness.list-features` registry def. Hits
 * /api/harness/:slug/status and projects to
 * { id, title, status, claims, attempts }.
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
  name: 'harness:list_features',
  description: 'List features in the harness queue (filterable by status). Returns id/title/status/claims/attempts only.',
  capability: 'harness:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({
    slug: z.string().min(1),
    status: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(),
    phase: z.enum(['staging', 'testing', 'production']).optional(),
  }),
  async handler(args) {
    const phase = args.phase ?? 'staging';
    const r = await fetch(
      `${operatorBaseUrl()}/api/harness/${encodeURIComponent(args.slug)}/status?phase=${phase}`,
    );
    if (!r.ok) throw new Error(`harness:list_features failed: HTTP ${r.status}`);
    const d = await r.json();
    let features: Array<Record<string, unknown>> = Array.isArray(d?.features) ? d.features : [];
    if (args.status) features = features.filter((f) => f.status === args.status);
    const limit = args.limit ?? 50;
    features = features.slice(0, limit);
    const projected = features.map((f) => ({
      id: f.id,
      title: f.title,
      status: f.status,
      claims: f.claims,
      attempts: f.attempts,
    }));
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ slug: args.slug, count: projected.length, features: projected }),
      }],
    };
  },
});
