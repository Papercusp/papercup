/**
 * List issues across the workspace. Issues are validator-filed
 * complaints against tasks (per spec §state). Summary returns id +
 * task_id + filed_by; full returns the body.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';

export default defineTool({
  name: 'issues:list',
  profile: 'engineer',
  capability: 'issues:read',
  guidance: {
    when: 'User asks "any open issues?", "what bugs are tracked", "what\'s wrong with X", or "what\'s outstanding?". Pass a slug to scope; omit for cross-harness. The dedicated problem-side view.',
    notWhen: 'For LIVE phase + activity counts (not problems), use `harness:status`. For static facts about the harness, use `harness:get`.',
  },
  args: z.object({
    detail: z.enum(['summary', 'full']).default('summary'),
    taskId: z.string().optional(),
    limit: z.number().int().positive().max(200).default(50),
  }),
  async handler(args, ctx) {
    // Issues live in per-harness schemas (harness_<slug>.issues). v1
    // returns an empty list with degraded:true and a hint pointing the
    // caller at per-harness reads. Full implementation requires a
    // consolidated mirror table or a UNION view; deferred to Phase E.
    return {
      data: [],
      degraded: true,
      degradedReasons: [
        'issues:list reads per-harness; v1 has no cross-harness consolidation. ' +
          'Use harness:status which surfaces recent issues per harness.',
      ],
    };
  },
});
