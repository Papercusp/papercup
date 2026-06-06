/**
 * work_items:reorder — the per-assignee work-list REORDER (local-hive-orchestration
 * Phase 2, P-020 / D-004 / D-008).
 *
 * Each assigned work-item carries a per-assignee `rank` — the externalized, ordered
 * version of the bee's invisible TodoWrite. This tool MOVES one item to a `rank` within
 * its assignee's queue (insert-at-rank: peers shift down). It is:
 *   • bee-authored by DEFAULT (a bee resequences its own list / slots a discovery in) —
 *     writer 'bee';
 *   • Queen-writable (inject at a rank, rebalance) — writer 'queen'.
 *
 * `writer` is the propose/dispose AUDIT (D-008): the Queen PROPOSES (writer 'queen'); the
 * bee DISPOSES (owns its actual sequencing, writer 'bee'). The Queen-vs-bee write balance
 * is governed by the EXISTING automation/commit tier (the operator's tier-table +
 * auto-accept threshold, P-022) — NOT a new dial. A Queen-overlay reorder is an operator
 * suggestion subject to that threshold; a bee's own resequencing is cheap and direct.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { reorderWorkItem, RANK_WRITERS } from '../../work-items';

export default defineTool({
  name: 'work_items:reorder',
  profile: 'engineer',
  description:
    "Move a work-item to a position (`rank`, 0-based, 0 = head-of-line) within its assignee's ordered work-list — peers shift down to make room. This is the externalized per-agent queue the Queen reads for placement decisions. `writer`='bee' (default) for a bee resequencing its own list; `writer`='queen' for a Queen overlay (inject/rebalance) — the propose/dispose audit.",
  guidance: {
    when: "You are a bee resequencing your own work-list (move a just-discovered task up, push a blocked one down) OR the Queen injecting/rebalancing a bee's queue. Claim the item first — rank is per-assignee.",
    notWhen:
      'You only want to START an item (work_items:claim) or change its lifecycle state (work_items:set_state). Reorder changes ORDER, not ownership or state.',
    chaining:
      'work_items:claim (take it) → work_items:reorder (place it in your list) → fleet:assignments { agent } to see the ordered queue. The Queen: fleet:assignments (read load + head-of-line) → work_items:reorder { writer:"queen" }.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).describe('Work-item id (WI-/F-/EI-).'),
    rank: z
      .number()
      .int()
      .min(0)
      .describe("Target position in the assignee's queue (0 = head-of-line; clamped to the queue length)."),
    writer: z
      .enum([...RANK_WRITERS] as [string, ...string[]])
      .optional()
      .describe("Propose/dispose author (D-008): 'bee' (default — a bee owns its sequencing) | 'queen' (Queen overlay)."),
    harness: z.string().max(80).optional(),
  }),
  async handler(args, ctx) {
    // Identity isn't strictly needed (rank is keyed on the item's assignee), but resolving
    // it keeps the per-edit liveness heartbeat + audit attribution consistent with peers.
    resolveAgentIdentity(ctx);
    const result = await reorderWorkItem(args.id, args.rank, {
      writer: (args.writer as 'bee' | 'queen' | undefined) ?? 'bee',
      harness: args.harness,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify('error' in result ? { ok: false, ...result } : { ok: true, ...result }),
        },
      ],
    };
  },
});
