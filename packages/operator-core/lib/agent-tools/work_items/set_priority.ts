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
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): steer ONE item inline
 * ({ workItem, priority?|position? }) or MANY (items:[{ workItem, priority?, position?,
 * harness?, decision? }]) → { ok, results:[{ ok, workItem, mode, … | error }], counts }.
 * Each item independently picks read/set/bump and arms its own auto-revert tripwire;
 * one not-found item never fails the rest. Results self-describe by `workItem`.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { setWorkItemPriority, getWorkItemPriority, bumpWorkItemPriority } from '../../work-items';
import { planWorkItemArm, commitWorkItemArm } from './arm-reversible-work-item';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';

const decisionSpec = z
  .object({
    riskTier: z.enum(['trivial', 'low', 'moderate', 'high', 'critical']).optional(),
    authority: z.enum(['system', 'owner']).optional(),
  })
  .optional();

const itemSpec = z.object({
  workItem: z.string().min(1).max(120).describe('The work-item id to (re)prioritize (F-/WI-/EI-).'),
  harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default)'),
  priority: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe('Explicit backlog order (feature_order) — LOWER = claimed sooner; null clears. Overrides position.'),
  position: z.enum(['top', 'bottom']).optional().describe("Bump to head ('top') / tail ('bottom') of the backlog."),
  // P-114: an AUTONOMOUS agent declares the action's risk/authority so the auto-revert
  // tripwire arms faithfully. Absent ⇒ fail-safe `critical`. Ignored for human callers.
  decision: decisionSpec,
});

type Spec = z.infer<typeof itemSpec>;

export default defineTool({
  name: 'work_items:set_priority',
  profile: 'engineer',
  description:
    "The Queen's steer-don't-dispatch lever: set one or many work-items' BACKLOG priority — the order the decentralized claim layer pulls against (lower = claimed sooner). Single: { workItem, priority?|position? }. Many: items:[{ workItem, priority?, position?, harness?, decision? }]. Set an explicit { priority } integer, bump { position:'top'|'bottom' }, clear with { priority:null }, or read with just { workItem }. Distinct from work_items:reorder (one bee's claimed work-list). Returns { ok, results:[{ ok, workItem, mode, written, … | error }], counts }. IMPORTANT: `ok:true` only means the request was processed — check `written` to confirm feature_order actually PERSISTED (false for a non-lease-holder proposal or an inapplicable issue-family item; both return ok:true but write nothing).",
  guidance: {
    when: "You are the Queen steering the SHARED backlog (read curation:change-feed + work_items:list): promote/demote what the fleet claims next via position:'top'/'bottom' or an explicit integer; reprioritize several via items:[…]. Multi-Swarm: only the steering-lease holder commits — others get proposed:true for the holder to dispose.",
    notWhen:
      "Ranking a single bee's already-claimed work-list (work_items:reorder — per-assignee), pinning work to a Swarm (work_items:co_locate), or changing lifecycle state (work_items:set_state). GLOBAL backlog order, feature-family only.",
    chaining:
      "curation:change-feed + work_items:list (the backlog) → work_items:set_priority { workItem, position:'top' } → the next claim_next pulls it first.",
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      workItem: z.string().min(1).max(120).optional().describe('single shorthand: the work-item id to (re)prioritize (F-/WI-/EI-).'),
      harness: z.string().max(80).optional().describe('default harness for the inline workItem / items that omit one.'),
      priority: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe('single shorthand: explicit backlog order (feature_order) — LOWER = claimed sooner; null clears. Overrides position.'),
      position: z
        .enum(['top', 'bottom'])
        .optional()
        .describe("single shorthand: bump to head ('top', most urgent) or tail ('bottom') of this harness's backlog."),
      // P-114: an AUTONOMOUS agent declares the action's risk/authority so the
      // auto-revert tripwire arms faithfully (the verb has no inherent item risk).
      // Absent ⇒ fail-safe `critical`. Ignored for human callers.
      decision: decisionSpec,
      items: z
        .array(itemSpec)
        .min(1)
        .max(100)
        .optional()
        .describe('reprioritize many work-items at once — each { workItem, priority?, position?, harness?, decision? }'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || Boolean(a.workItem), {
      message: 'pass { workItem, priority?|position? } for one, or items:[{ workItem, … }] for many',
    }),
  async handler(args, ctx) {
    const items: Spec[] = args.items?.length
      ? args.items
      : [{ workItem: args.workItem as string, harness: args.harness, priority: args.priority, position: args.position, decision: args.decision }];

    const env = await runBulk(
      items,
      async (it): Promise<BulkItemResult & { workItem: string }> => {
        const harness = it.harness ?? args.harness;
        const opt = { harness };
        const decision = it.decision ?? args.decision;

        // Read mode — no directive → report the current backlog priority. No write, no arming.
        if (it.priority === undefined && !it.position) {
          const cur = await getWorkItemPriority(it.workItem, opt);
          if (!cur) return { ok: false, workItem: it.workItem, error: `work-item ${it.workItem} not found` };
          return { ok: true, workItem: cur.id, mode: 'read', priority: cur.priority, applicable: cur.applicable };
        }

        // P-114 arm-call-site: gate-FIRST (before the write) so the captured prior-priority
        // handle is faithful. `null` on the common path (human caller / disarmed / never-auto
        // = today's whole population, D-007); committed only when the write actually LANDS —
        // a non-lease-holder proposal (set.proposed) changed nothing, so it is never armed.
        const armPlan = await planWorkItemArm(
          ctx,
          'work_items:set_priority',
          'priority',
          it.workItem,
          harness,
          decision,
        ).catch(() => null);

        // WI-1376: the TRUTHFUL "did feature_order actually persist?" signal. `ok:true` only
        // means the request was processed without error — a steering-lease PROPOSAL (proposed:
        // this Swarm isn't the lease holder) and an inapplicable issue-family item (applicable:
        // false, scheduler-issues-claimable OFF) BOTH return ok:true yet write NOTHING. Callers
        // / bulk re-prioritizers must gate on `written`, not `ok`, or they silently miss the
        // no-op (the exact failure the report hit). `written` also gates the auto-revert arm —
        // never arm a revert for a write that never landed.
        const wroteResult = (r: { applicable: boolean; proposed?: boolean }) => r.applicable === true && !r.proposed;

        // Explicit mode — caller named the order (or null to clear); overrides position.
        if (it.priority !== undefined) {
          const set = await setWorkItemPriority(it.workItem, it.priority, opt);
          if (!set) return { ok: false, workItem: it.workItem, error: `work-item ${it.workItem} not found` };
          const written = wroteResult(set);
          if (armPlan && written) await commitWorkItemArm(armPlan).catch(() => {});
          return {
            ok: true,
            workItem: set.id,
            mode: 'set',
            priority: set.priority,
            applicable: set.applicable,
            written,
            action: it.priority === null ? 'clear' : 'set',
            // P-011 steering lease (D-004): proposed=true ⇒ this Swarm is not the
            // lease holder — the write was NOT committed; a proposal was recorded
            // for the holding Queen (steeringHolder) to dispose.
            ...(set.proposed ? { proposed: true, steeringHolder: set.steeringHolder } : {}),
          };
        }

        // Bump mode — move to the head/tail of the backlog relative to the current extreme.
        const set = await bumpWorkItemPriority(it.workItem, it.position!, opt);
        if (!set) return { ok: false, workItem: it.workItem, error: `work-item ${it.workItem} not found` };
        const written = wroteResult(set);
        if (armPlan && written) await commitWorkItemArm(armPlan).catch(() => {});
        return {
          ok: true,
          workItem: set.id,
          mode: 'bump',
          priority: set.priority,
          applicable: set.applicable,
          written,
          action: it.position,
          ...(set.proposed ? { proposed: true, steeringHolder: set.steeringHolder } : {}),
        };
      },
      { keyOf: (it) => ({ workItem: it.workItem }) },
    );
    return bulkContent(env);
  },
});
