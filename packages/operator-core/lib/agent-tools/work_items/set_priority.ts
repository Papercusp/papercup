/**
 * work_items:set_priority — the Queen's steer-don't-dispatch lever for the SHARED backlog
 * (autoloop-pot-operator-rebuild B7 / decentralized-dispatch-scaling D-003/D-004, P-009/P-010).
 *
 * Set a feature-family work-item's BACKLOG PRIORITY — `feature_order`, the column the
 * decentralized claim path (`claimNextWorkItem`) orders by (ASC NULLS LAST, so LOWER =
 * claimed sooner). This is how the Queen "sets priorities" reading the rolled-up change
 * feed (`curation:change-feed`): she reorders the backlog the fleet claims against, never
 * assigning work item-by-item. Three shapes:
 *   - explicit  { workItem, priority }              — set an exact order (or `priority: null` to clear).
 *   - bump      { workItem, position: 'top'|'bottom' } — move to head (most urgent) / tail of the backlog.
 *   - read      { workItem }                          — report the current backlog priority, no write.
 *
 * DISTINCT from `work_items:reorder`, which ranks ONE bee's already-CLAIMED work-list
 * (a per-assignee queue, post-claim). This sets the GLOBAL backlog order (pre-claim).
 * Feature-family only — issue-family items (bugs/changes) aren't the dispatched backlog,
 * so a set on one is a no-op returning `applicable: false`.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { setWorkItemPriority, getWorkItemPriority, bumpWorkItemPriority } from '../../work-items';

const json = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }] });

export default defineTool({
  name: 'work_items:set_priority',
  profile: 'engineer',
  description:
    "The Queen's steer-don't-dispatch lever: set a work-item's BACKLOG priority — the order the decentralized claim layer pulls against (lower = claimed sooner). Set an explicit { priority } integer, bump to { position:'top'|'bottom' }, clear with { priority:null }, or read with just { workItem }. Distinct from work_items:reorder, which ranks one bee's already-claimed work-list.",
  guidance: {
    when: "You are the Queen steering the SHARED backlog after reading the rolled-up change feed (curation:change-feed) + the frontier (work_items:list): promote/demote what the fleet should claim next. Use position:'top'/'bottom' for the common 'make this most/least urgent', or an explicit priority integer for fine control.",
    notWhen:
      "Ranking a single bee's already-claimed work-list (work_items:reorder — per-assignee), pinning work to a Swarm (work_items:co_locate), or changing lifecycle state (work_items:set_state). This sets the GLOBAL backlog order, not a per-bee queue, and applies to feature-family items only.",
    chaining:
      "curation:change-feed (what shipped / where momentum is) + work_items:list (the backlog) → work_items:set_priority { workItem, position:'top' } → the next claim_next pulls it first.",
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    workItem: z.string().min(1).max(120).describe('The work-item id to (re)prioritize (F-/WI-/EI-).'),
    harness: z.string().max(80).optional().describe('Harness the work-item lives in.'),
    priority: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe('Explicit backlog order (feature_order) — LOWER = claimed sooner; null clears (sorts last). Overrides position.'),
    position: z
      .enum(['top', 'bottom'])
      .optional()
      .describe("Bump to head ('top', most urgent) or tail ('bottom') of this harness's backlog — computed relative to the current extreme."),
  }),
  async handler(args) {
    const opt = { harness: args.harness };

    // Read mode — no directive → report the current backlog priority.
    if (args.priority === undefined && !args.position) {
      const cur = await getWorkItemPriority(args.workItem, opt);
      if (!cur) return json({ ok: false, error: `work-item ${args.workItem} not found` });
      return json({ ok: true, mode: 'read', workItem: cur.id, priority: cur.priority, applicable: cur.applicable });
    }

    // Explicit mode — caller named the order (or null to clear); overrides position.
    if (args.priority !== undefined) {
      const set = await setWorkItemPriority(args.workItem, args.priority, opt);
      if (!set) return json({ ok: false, error: `work-item ${args.workItem} not found` });
      return json({
        ok: true,
        mode: 'set',
        workItem: set.id,
        priority: set.priority,
        applicable: set.applicable,
        action: args.priority === null ? 'clear' : 'set',
      });
    }

    // Bump mode — move to the head/tail of the backlog relative to the current extreme.
    const set = await bumpWorkItemPriority(args.workItem, args.position!, opt);
    if (!set) return json({ ok: false, error: `work-item ${args.workItem} not found` });
    return json({
      ok: true,
      mode: 'bump',
      workItem: set.id,
      priority: set.priority,
      applicable: set.applicable,
      action: args.position,
    });
  },
});
