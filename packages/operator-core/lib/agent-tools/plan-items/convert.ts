/**
 * plan_items:convert — convert-at-pickup (project-centric-harness-rethink D-015).
 *
 * "Working a plan item = convert it to a work_item first — no untracked
 * self-item." This is THE pickup verb: one call takes the policy-checked
 * plan-item lease, mints (or resumes) the work_item execution record with the
 * caller as assignee, and links it back to the plan item. The plan-item status
 * flip (todo→wip) and the claim broadcast both ride `emits:` — and the
 * work_item's later lifecycle reflects back onto the plan item via
 * ../../plan-items/reflect-rules.ts (complete→done, release→todo).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePlanScope } from '../plans/source';
import { bestEffortOwnerUser, resolveAdoptedName } from '../../plan-items/agent-names';
import { convertPlanItem, type ConvertPlanItemResult } from '../../plan-items/convert';
import { WORK_ITEM_KINDS, type WorkItemKind } from '../../work-items';

/** The flattened success payload the emits rules read off the event. */
interface ConvertEventData {
  ok: boolean;
  status?: string;
  workItem?: { id?: string; harness?: string | null };
  planItem?: { plan?: string; item?: string; status?: string | null };
}

function dataOf(e: { result?: { data?: unknown } }): ConvertEventData {
  return (e.result?.data ?? {}) as ConvertEventData;
}

export default defineTool({
  name: 'plan_items:convert',
  description:
    'Convert-at-pickup (D-015): pick up a plan item by converting it to a work_item in one call — takes the policy-checked plan-item lease, mints (or idempotently resumes) the work_item with you as assignee, links it back (`implements` edge + payload stamp), and auto-flips the plan item to wip. The work_item is then your execution record: work_items:complete on it reflects the plan item to done.',
  guidance: {
    when: 'You are picking up a plan item to work it — this replaces a bare plan_items:claim: every worked item gets a tracked work_item (no untracked self-item).',
    notWhen:
      'You only want the lease without an execution record (rare; plan_items:claim). The item is already converted and you hold it — just keep working; re-converting is a harmless resume.',
    chaining:
      'plans:items { actionable:true } → plan_items:convert { plan, item } → work → work_items:complete { id, completion } (reflects the plan item to done) or work_items:release (returns it to todo).',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  emits: [
    // Pickup broadcast (lifecycle claim category — peers see "taking X" without prose).
    {
      fire: 'coord:emit',
      when: (e) => {
        const d = dataOf(e);
        return d.ok === true && Boolean(d.workItem?.id);
      },
      render: (e) => {
        const d = dataOf(e);
        const verb = d.status === 'resumed' ? 'resumed' : 'converted →';
        return {
          category: 'claim',
          summary: `⛏ ${d.planItem?.plan}#${d.planItem?.item} ${verb} ${d.workItem?.id} — picked up${
            e.ctx.uiClientId ? ` (${e.ctx.uiClientId})` : ''
          }`,
          ...(d.planItem?.plan ? { plan_slug: d.planItem.plan } : {}),
          to: ['*'],
        };
      },
    },
    // Pickup flips the plan item todo → wip (through the real plans:set-status,
    // so the flip gets the plan lock + revision + plan-event for free).
    {
      fire: 'plans:set-status',
      when: (e) => {
        const d = dataOf(e);
        return (
          d.ok === true &&
          Boolean(d.workItem?.id) &&
          d.planItem?.status === 'todo' &&
          typeof d.planItem?.item === 'string' &&
          /^P-\d{3,}$/.test(d.planItem.item)
        );
      },
      render: (e) => {
        const d = dataOf(e);
        const a = e.args as { harness?: string };
        return {
          harness: a.harness ?? 'all',
          slug: d.planItem!.plan,
          itemId: d.planItem!.item,
          status: 'wip',
          note: `→ ${d.workItem!.id}`,
        };
      },
    },
  ],
  args: z.object({
    plan: z.string().min(1).describe('plan slug'),
    item: z.string().min(1).describe('plan-item id (P-NNN)'),
    harness: z.string().max(120).optional().describe('harness the plan lives in (default: papercup)'),
    kind: z
      .enum([...WORK_ITEM_KINDS] as [string, ...string[]])
      .optional()
      .describe(
        "work_item kind to mint (default 'task' — the generic execution record; pick feature/bug/… when the item warrants a pipeline-shaped unit)",
      ),
    title: z.string().max(200).optional().describe('override the work-item title (default: the plan-item text)'),
    brief: z
      .string()
      .max(2000)
      .optional()
      .describe(
        "per-lane situational overlay persisted on the work-item's payload.brief — the context the placed bee is MISSING, not a restatement of the item (queen-wave-dispatch P-021; carried from a `## Promote` lane's brief: field)",
      ),
    intent: z.string().max(400).optional().describe('one line on what you are doing'),
    mode: z
      .enum(['availability', 'activity'])
      .optional()
      .describe('force the lease liveness mode (default: resolved from the harness)'),
    ttl_sec: z.number().int().positive().max(7200).optional().describe('lease TTL seconds'),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const { workspaceId, harnessSlug } = await resolvePlanScope({ harnessSlug: args.harness });
    const ownerName = await resolveAdoptedName(workspaceId, id.ownerId);
    const result: ConvertPlanItemResult = await convertPlanItem({
      workspaceId,
      harnessSlug,
      planSlug: args.plan,
      itemId: args.item,
      kind: args.kind as WorkItemKind | undefined,
      title: args.title,
      brief: args.brief,
      owner: id.ownerId,
      ownerLabel: id.ownerLabel,
      ownerName,
      ownerUser: bestEffortOwnerUser(ctx),
      intent: args.intent,
      livenessMode: args.mode,
      ttlSec: args.ttl_sec,
    });
    const ok = result.status === 'converted' || result.status === 'resumed';
    // Flattened so the emits rules (and callers) read fields off one object.
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok, ...result }) }] };
  },
});
