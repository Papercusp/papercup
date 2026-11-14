/** WI-6554700010048903: a leader can deliberately replace a member's spawn binding.
 * The durable lifecycle receipt survives native carry-respawn and presence writes.
 * Ordinary self-claims and declared intent never author this receipt. */
import { z } from 'zod';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import type { ResolvedFleetMemberTarget } from './member-target';

const receiptSchema = z.object({
  schemaVersion: z.literal(1), actorId: z.string().min(1), targetId: z.string().min(1),
  fleet: z.string().min(1), at: z.string().min(1), reason: z.string().min(1),
  workItemId: z.string().min(1), harness: z.string().min(1),
  previousPlanSlug: z.string().min(1).nullable(), planSlug: z.string().min(1).nullable(),
  supersededPlanSlugs: z.array(z.string().min(1)).default([]),
}).strict();
export type ExecutionPlanRebindReceipt = z.infer<typeof receiptSchema>;

export function parseExecutionPlanRebind(value: unknown, ownerId: string): ExecutionPlanRebindReceipt | null {
  if (value == null) return null;
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success || parsed.data.targetId !== ownerId || parsed.data.actorId === ownerId)
    throw new Error('invalid_execution_plan_rebind');
  return parsed.data;
}

export async function readExecutionPlanRebind(sql: Sql, ownerId: string, workspaceId: string) {
  const rows = await sql<Array<{ binding: unknown }>>`
    SELECT control_state #> '{lifecycle,executionPlanBinding}' AS binding
      FROM harness_shared.session_briefs WHERE owner_id=${ownerId} AND workspace_id=${workspaceId}`;
  return parseExecutionPlanRebind(rows[0]?.binding, ownerId);
}

export interface ExecutionPlanRebindInput {
  workItemId: string;
  harness: string;
  expectedPlanSlug: string | null;
  reason: string;
}

export async function rebindMemberExecutionPlan(target: ResolvedFleetMemberTarget,
  input: ExecutionPlanRebindInput, sql: Sql = getOrgPg().sql) {
  const { callerId, memberOwnerId, workspaceId, slug } = target;
  // SU panes also represent agents: their generic "owner" grade must not let
  // a member approve its own escape from an unstarted plan.
  if (callerId === memberOwnerId || target.fleet.leaderOwnerId !== callerId)
    return { ok: false, error: 'plan_rebind_requires_distinct_fleet_leader' };
  return sql.begin(async tx => {
    // Fragment helpers use the tagged-query interface shared by Sql and TransactionSql.
    const query = tx as unknown as Sql;
    const leaders = await tx<Array<{ leader_owner_id: string | null }>>`
      SELECT leader_owner_id FROM harness_shared.agent_fleets
       WHERE workspace_id=${workspaceId} AND fleet_slug=${slug} FOR UPDATE`;
    if (leaders[0]?.leader_owner_id !== callerId)
      return { ok: false, error: 'plan_rebind_leader_changed' };
    const memberships = await tx<Array<{ fleet_slug: string | null }>>`
      SELECT fleet_slug FROM harness_shared.fleet_membership_events
       WHERE workspace_id=${workspaceId} AND owner_id=${memberOwnerId} ORDER BY id DESC LIMIT 1 FOR SHARE`;
    if (memberships[0]?.fleet_slug !== slug)
      return { ok: false, error: 'plan_rebind_membership_changed' };
    const briefs = await tx<Array<{ current_plan_slug: string | null; control_state: Record<string, any> | null }>>`
      SELECT current_plan_slug,control_state FROM harness_shared.session_briefs
       WHERE owner_id=${memberOwnerId} AND workspace_id=${workspaceId} FOR UPDATE`;
    if (briefs.length !== 1) return { ok: false, error: 'plan_rebind_brief_missing' };
    const brief = briefs[0];
    const prior = parseExecutionPlanRebind(brief.control_state?.lifecycle?.executionPlanBinding, memberOwnerId);
    const sessions = await tx<Array<{ plan_slug: string | null }>>`
      SELECT plan_slug FROM harness_shared.adv_sessions
       WHERE coord_owner_id=${memberOwnerId} AND workspace_id=${workspaceId} AND ended_at IS NULL FOR UPDATE`;
    const displaced = new Set([prior?.previousPlanSlug, ...(prior?.supersededPlanSlugs ?? [])]);
    const currentSessionPlans = [brief.current_plan_slug, brief.control_state?.scope?.plan,
      ...sessions.map(row => row.plan_slug).filter(plan => !prior || !displaced.has(plan))];
    const previous = prior ? [prior.planSlug, ...currentSessionPlans]
      : currentSessionPlans;
    const plans = [...new Set(previous.filter((plan): plan is string => typeof plan === 'string' && !!plan))];
    if (plans.length > 1 || (plans[0] ?? null) !== input.expectedPlanSlug)
      return { ok: false, error: 'plan_rebind_expected_plan_mismatch', observedPlans: plans };
    const { claimHoldExclusionSql } = await import('../../work-items');
    const { admissionHoldExclusionSql } = await import('../../work-items-admission');
    const items = await tx<Array<{ plan_slug: string | null; plan_line_id: string | null; source_plan_slug: string | null }>>`
      SELECT plan_slug,plan_line_id,source_plan_slug FROM harness_shared.work_items
       WHERE workspace_id=${workspaceId} AND harness_slug=${input.harness} AND feature_id=${input.workItemId}
         AND taken_by=${memberOwnerId} AND NOT(status=ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))
         AND (${claimHoldExclusionSql(query, 'payload')}) AND (${admissionHoldExclusionSql(query, 'payload')}) FOR UPDATE`;
    if (items.length !== 1) return { ok: false, error: 'plan_rebind_target_item_not_held_or_admitted' };
    const item = items[0];
    if ((item.plan_slug === null) !== (item.plan_line_id === null))
      return { ok: false, error: 'plan_rebind_target_item_binding_invalid' };
    const receipt: ExecutionPlanRebindReceipt = { schemaVersion: 1, actorId: callerId, targetId: memberOwnerId,
      fleet: slug, at: new Date().toISOString(), reason: input.reason, workItemId: input.workItemId,
      harness: input.harness, previousPlanSlug: input.expectedPlanSlug,
      planSlug: item.plan_slug ?? item.source_plan_slug,
      supersededPlanSlugs: [...new Set([...displaced, input.expectedPlanSlug])]
        .filter((plan): plan is string => typeof plan === 'string') };
    await tx`UPDATE harness_shared.session_briefs SET
      current_plan_slug=${receipt.planSlug}, harness_slug=${receipt.harness},
      control_state=jsonb_set(jsonb_set(COALESCE(control_state,'{}'::jsonb),'{lifecycle}',
        COALESCE(control_state->'lifecycle','{}'::jsonb) ||
          jsonb_build_object('executionPlanBinding',${JSON.stringify(receipt)}::text::jsonb),true),
        '{scope}',COALESCE(control_state->'scope','{}'::jsonb) ||
          jsonb_build_object('plan',${receipt.planSlug}::text,'harness',${receipt.harness}::text),true)
      WHERE owner_id=${memberOwnerId} AND workspace_id=${workspaceId}`;
    await tx`UPDATE harness_shared.adv_sessions SET plan_slug=${receipt.planSlug}
      WHERE coord_owner_id=${memberOwnerId} AND workspace_id=${workspaceId} AND ended_at IS NULL`;
    const stored = await readExecutionPlanRebind(query, memberOwnerId, workspaceId);
    if (!stored || Object.entries(receipt).some(([key,value]) =>
      JSON.stringify(stored[key as keyof typeof stored]) !== JSON.stringify(value)))
      throw new Error('plan_rebind_readback_mismatch');
    return { ok: true, receipt: stored };
  });
}
