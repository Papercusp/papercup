/**
 * harness:escalation — read escalation + supervisor-notes for a harness.
 *
 * Reads from harness_escalations (PG-canonical, written by TS orchestrator
 * + bash run.sh), then harness_text_artifacts, then disk fallback.
 * Calls getEscalation() in lib/harness-readers.ts.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { phasePhaseLabel } from '../../harness-phases';
import { getEscalation } from '../../harness-readers';

// + overwatch (overwatch-role-2026-06-15 B-01): reads aging escalations to nudge/escalate.
const ALL_ROLES = [...SU_ROLES, 'sentinel', 'overwatch'] as const;

export default defineTool({
  name: 'harness:escalation',
  profile: 'engineer',
  description: 'Read escalation + supervisor-notes for a harness (PG-canonical; falls back to disk).',
  guidance: {
    when: 'User asks "what\'s flagged?", "what got escalated to the supervisor?", or you need to see the supervisor\'s notes on a harness.',
    notWhen: 'For general "what\'s wrong with X" (open issues), use `issues:list`. Escalation files are a specific, narrower view than the issue list.',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
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
