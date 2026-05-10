/**
 * harness:escalation — get escalation + supervisor notes for a harness.
 *
 * Wraps GET /api/harness/:slug/escalation. Mirrors the
 * `escalations.get` registry def in lib/commands/defs/harness.ts.
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
  name: 'harness:escalation',
  description: 'Get escalation + supervisor notes (if any) for a harness. { hasEscalation, escalation, supervisorNotes, mtimeMs }.',
  capability: 'harness:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({
    slug: z.string().min(1),
  }),
  async handler(args) {
    const r = await fetch(`${operatorBaseUrl()}/api/harness/${encodeURIComponent(args.slug)}/escalation`);
    if (!r.ok) {
      if (r.status === 404) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ hasEscalation: false, escalation: null, supervisorNotes: null, mtimeMs: null }),
          }],
        };
      }
      throw new Error(`harness:escalation failed: HTTP ${r.status}`);
    }
    const d = await r.json();
    const hasEscalation = !!(d?.escalation && String(d.escalation).trim());
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          hasEscalation,
          escalation: d?.escalation ?? null,
          supervisorNotes: d?.supervisorNotes ?? null,
          mtimeMs: d?.mtimeMs ?? null,
        }),
      }],
    };
  },
});
