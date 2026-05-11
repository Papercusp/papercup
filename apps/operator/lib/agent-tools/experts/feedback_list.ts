/**
 * experts:feedback_list — list feedback conversations (open + verdicted)
 * for an expert instance.
 *
 * Calls listExpertFeedback() in lib/experts-data.ts directly — same
 * function the GET /api/harness/:slug/experts/:expertId/feedback route
 * projects.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listExpertFeedback } from '@/lib/experts-data';

const ALL_ROLES = [
  'scoper', 'architect', 'worker', 'validator', 'reviewer', 'debugger',
  'operator', 'documenter', 'curator',
] as const;

export default defineTool({
  name: 'experts:feedback_list',
  guidance: {
    when: 'Read collected expert feedback / verdicts — useful for "what did the validators say?", "any expert complaints?".',
    notWhen: 'For YOUR audit log, use `audit:list`. For expert DEFINITIONS, use `experts:list`. feedback_list is the output side.',
  },
  description: 'List feedback conversations for an expert instance (id, persona, ended, verdict).',
  capability: 'experts:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({ slug: z.string().min(1), expertId: z.string().min(1) }),
  async handler(args) {
    const result = await listExpertFeedback(args.slug, args.expertId);
    if (!result.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }] };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ count: result.data.feedback.length, feedback: result.data.feedback }),
      }],
    };
  },
});
