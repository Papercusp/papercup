/**
 * harness:escalation — read escalation.md + supervisor-notes.md for a
 * harness slug.
 *
 * Calls getEscalation() in lib/harness-readers.ts directly — same
 * function the GET /api/harness/:slug/escalation route projects.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { phasePhaseLabel } from '@/lib/harness-phases';
import { getEscalation } from '@/lib/harness-readers';

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
  description: 'Read escalation.md + supervisor-notes.md for a harness slug.',
  capability: 'harness:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({
    slug: z.string().min(1),
    phase: z.string().optional(),
  }),
  async handler(args) {
    const result = await getEscalation(args.slug, phasePhaseLabel(args.phase));
    if (!result.ok) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              hasEscalation: false,
              escalation: null,
              supervisorNotes: null,
              mtimeMs: null,
            }),
          },
        ],
      };
    }
    const { escalation, supervisorNotes, mtimeMs } = result.data;
    const hasEscalation = !!(escalation && String(escalation).trim());
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ hasEscalation, escalation, supervisorNotes, mtimeMs }),
        },
      ],
    };
  },
});
