/**
 * coord:plan-events — read the plan-event history feed.
 *
 * agent-coordination-architecture-v2 §8. plan_event records live on the
 * `plan-events` surface of the CoordEventLog (Postgres), NOT the
 * `messages` surface — so coord:inbox does not surface them. This tool is the read surface the
 * OMP turn-start extension uses to assemble the "plans changed since
 * you last read" reminder section (scoped by the watermark's
 * plan_events_since_ts pointer).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../roles';
import { readPlanEvents } from '../plan-events';

export default defineTool({
  name: 'coord:plan-events',
  description:
    "Read the plan-event history — created / now_updated / decision_added / item_added / item_status_changed / promoted events across all plans. Optional `since_ts` returns only events strictly later than that ISO timestamp; `plan_slug` narrows to one plan. Distinct from coord:inbox (which scans messages, not plan-events).",
  guidance: {
    when: 'Turn start — the OMP coordination extension calls this to show which plans changed since the agent last read. Also ad-hoc, to review recent plan activity.',
    notWhen: 'For messages / notifies / handoffs addressed to you — use coord:inbox.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    since_ts: z.string().optional(),
    plan_slug: z.string().optional(),
    files_back: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Read only the most-recent N monthly rotation files.'),
  }),
  async handler(args) {
    const events = await readPlanEvents({
      since_ts: args.since_ts,
      planSlugs: args.plan_slug ? [args.plan_slug] : undefined,
      filesBack: args.files_back,
    });
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ events }) },
      ],
    };
  },
});
