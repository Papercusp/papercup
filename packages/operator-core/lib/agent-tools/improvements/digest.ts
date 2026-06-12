/**
 * improvements:digest — the triage lens over the captured papercusp-improvement
 * backlog (papercusp-self-improvement-loop-2026-06-04, Phase 2).
 *
 * Read-only. Reads every `papercusp-improvement`-tagged work-unit, scores + dedups
 * them, and splits them into the **auto lane** (kind=bug, no protected surface —
 * D-004) vs the **human queue** (the rest). This is "triage only" — nothing is
 * implemented here; it surfaces the backlog for a human (or the later
 * auto-implement loop) to act on. The same read+score path backs the Learning tab's
 * `learning.improvements` sync resolver (operator-learning-tab-2026-06-09) — the
 * backlog is surfaced by PULL there, not pushed to the human inbox.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { readImprovementItems } from '../../harness/improvements/read-items';
import { buildDigest } from '../../harness/improvements/digest';
import { applyHumanQueueRanking } from '../../queue-ranker/human-queue';

export default defineTool({
  name: 'improvements:digest',
  profile: 'engineer',
  description:
    'Triage the captured papercusp-improvement backlog: scores + dedups every improvement work-unit and splits it into the auto-eligible lane (kind=bug, no protected surface) vs the human-review queue. Read-only — surfaces the queue, implements nothing. (P-010) Supports per-Hive scope filtering.',
  guidance: {
    when: 'To review the papercusp self-improvement backlog — what is captured, what is auto-eligible vs needs a human, and which items look like duplicates to merge. The human-facing triage view. (P-010) Pass harnessSlug to filter to a specific Hive\'s ideas.',
    notWhen: 'You want one improvement in full — issues:get { id }. You want to file one — improvements:capture. You want to browse another area — topics:feed { topic }.',
    chaining: 'improvements:digest → issues:get / issues:claim on a queued item → fix it self/inline (or improvements:capture to add more).',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    state: z.enum(['open', 'resolved', 'closed']).optional().describe('restrict the read to one lifecycle state (default: all, so rollups + dedup see resolved too)'),
    limit: z.number().int().positive().max(500).optional(),
    harnessSlug: z.string().min(1).max(80).optional().describe('(P-010) restrict to a specific Hive\'s ideas (default: all)'),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const items = await readImprovementItems({ state: args.state, limit: args.limit, harnessSlug: args.harnessSlug });
    // Human lane ordered by the ONE ranker (frontier P-040; blocking impact is
    // feature #1); same enrichment the Learning tab resolver applies, so the
    // shapes can't drift.
    const digest = await applyHumanQueueRanking(buildDigest(items, { nowMs: Date.now() }), { candidates: items });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, digest }) }] };
  },
});
