/**
 * Hard fleet-scope assignment admission (agent-operability P-016).
 *
 * A live fleet member may only receive work selected by its authoritative
 * per-member/inherited fleet claim spec. The boundary is enforced at every
 * assignment seam and is independent of the scheduler kill-switch. Existing
 * incompatible claims are quarantined by releasing them in one reconciliation
 * sweep and notifying the fleet leader.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { activeWorkspaceId } from '../workspace-registry';
import type { WorkItem } from '../work-items';
import type { ClaimSpecRecord } from './claim-spec-store';
import { resolveClaimSpecWorkspace } from './claim-spec-workspace';
import {
  matchesClaimSpecFilter,
  matchesWorkItemClaimSpec,
  type ClaimSpecSubject,
} from './claim-spec-match';

export interface FleetScopeContext {
  ownerId: string;
  fleetSlug: string;
  fleetRole: 'member';
  record: ClaimSpecRecord;
}

export type FleetScopeAdmission =
  | { allowed: true; scoped: false }
  | { allowed: true; scoped: true; scope: FleetScopeContext }
  | {
      allowed: false;
      scoped: true;
      code: 'fleet_scope_missing' | 'fleet_scope_violation';
      reason: string;
      scope: FleetScopeContext;
    };

/** Resolve only MEMBER scope. Leaders supervise fleets but do not consume their member lane. */
export async function resolveFleetScopeContext(
  ownerIdOrName: string,
  workspaceId?: string | null,
): Promise<FleetScopeContext | null> {
  // Lazy seams keep assignment-tool unit tests from loading the entire scheduler /
  // coord graph merely because they import a handler. The calls still reuse the
  // canonical stores; only module evaluation is deferred until admission is needed.
  const { latestFleetMembership } = await import('../fleet-membership-store');
  const { listFleetAssignments } = await import('../fleet/assignments');
  const ws = resolveClaimSpecWorkspace(workspaceId);
  // No specific workspace (null / '*' / empty) ⇒ no fleet-member scope to resolve.
  if (!ws) return null;
  let ownerId = ownerIdOrName;
  let membership = await latestFleetMembership(ws, ownerId).catch(() => null);

  // plan_items:assign addresses a stable agent-name. Resolve it through the
  // canonical assignment/presence view before consulting append-only membership.
  if (!membership?.fleetSlug) {
    const rows = await listFleetAssignments({ workspaceId: ws, agent: ownerIdOrName, activeOnly: true }).catch(() => []);
    const row = rows.find((r) => r.agentId && r.fleetSlug && r.fleetRole === 'member');
    if (row?.agentId) {
      ownerId = row.agentId;
      membership = { fleetSlug: row.fleetSlug ?? null, fleetRole: row.fleetRole ?? null };
    }
  }

  if (!membership?.fleetSlug || membership.fleetRole !== 'member') return null;
  const { getClaimSpecRecord } = await import('./claim-spec-store');
  const record = await getClaimSpecRecord({ cupId: ownerId, workspaceId: ws });
  return { ownerId, fleetSlug: membership.fleetSlug, fleetRole: 'member', record };
}

async function featureMatchesRecord(item: WorkItem, record: ClaimSpecRecord): Promise<boolean> {
  const { sql } = getOrgPg();
  const { compileFilter } = await import('./get-next');
  const filter = compileFilter(sql, record.spec.view.filter);
  const rows = await sql<{ matched: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${activeWorkspaceId()}
         AND feature_id = ${item.id}
         AND ${item.harness ? sql`harness_slug = ${item.harness}` : sql`TRUE`}
         AND ${filter}
    ) AS matched`;
  return Boolean(rows[0]?.matched);
}

async function itemMatchesScope(item: WorkItem, scope: FleetScopeContext): Promise<boolean> {
  if (item.family === 'feature') return featureMatchesRecord(item, scope.record);
  return matchesWorkItemClaimSpec(item, scope.record.spec);
}

function denyMissing(scope: FleetScopeContext): FleetScopeAdmission {
  return {
    allowed: false,
    scoped: true,
    code: 'fleet_scope_missing',
    scope,
    reason:
      `fleet member ${scope.ownerId} belongs to '${scope.fleetSlug}' but has no explicit per-member or inherited fleet claim spec; ` +
      'assignment refused instead of falling through to the generic backlog',
  };
}

export async function admitWorkItemForFleetTarget(args: {
  target: string;
  workItemId: string;
  harness?: string;
  workspaceId?: string | null;
}): Promise<FleetScopeAdmission> {
  const scope = await resolveFleetScopeContext(args.target, args.workspaceId);
  if (!scope) return { allowed: true, scoped: false };
  if (scope.record.source === 'default') return denyMissing(scope);
  const { getWorkItem } = await import('../work-items');
  const item = await getWorkItem(args.workItemId, args.harness);
  if (!item) return { allowed: true, scoped: true, scope }; // the claim seam returns not_found
  if (await itemMatchesScope(item, scope)) return { allowed: true, scoped: true, scope };
  return {
    allowed: false,
    scoped: true,
    code: 'fleet_scope_violation',
    scope,
    reason:
      `work-item ${item.id} does not match ${scope.record.spec.specId}@${scope.record.spec.revision} ` +
      `for fleet '${scope.fleetSlug}'`,
  };
}

export async function admitSubjectForFleetTarget(args: {
  target: string;
  subject: ClaimSpecSubject;
  workspaceId?: string | null;
}): Promise<FleetScopeAdmission> {
  const scope = await resolveFleetScopeContext(args.target, args.workspaceId);
  if (!scope) return { allowed: true, scoped: false };
  if (scope.record.source === 'default') return denyMissing(scope);
  if (matchesClaimSpecFilter(args.subject, scope.record.spec.view.filter)) {
    return { allowed: true, scoped: true, scope };
  }
  return {
    allowed: false,
    scoped: true,
    code: 'fleet_scope_violation',
    scope,
    reason:
      `assignment does not match ${scope.record.spec.specId}@${scope.record.spec.revision} ` +
      `for fleet '${scope.fleetSlug}'`,
  };
}

export async function notifyFleetScopeRefusal(
  identity: AgentIdentity,
  admission: Extract<FleetScopeAdmission, { allowed: false }>,
  action: string,
): Promise<void> {
  const { sendMessage } = await import('../agent-tools/coordination/messages');
  await sendMessage(identity, {
    to: [`@fleet-leader:${admission.scope.fleetSlug}`],
    summary: `fleet-scope admission blocked ${action}`,
    body: `${admission.reason}. The assignment was not mutated. Re-steer the member's claim spec or route the work elsewhere.`,
    category: 'fleet-scope-admission',
  }).catch(() => undefined);
}

export interface FleetScopeReconciliation {
  scope: FleetScopeContext | null;
  quarantinedIds: string[];
}

/** Release every incompatible claim in one bounded sweep; never drip one per wake. */
export async function reconcileFleetScopeClaims(args: {
  ownerId: string;
  workspaceId?: string | null;
  identity?: AgentIdentity;
}): Promise<FleetScopeReconciliation> {
  const scope = await resolveFleetScopeContext(args.ownerId, args.workspaceId);
  if (!scope) return { scope: null, quarantinedIds: [] };
  const { listFleetAssignments } = await import('../fleet/assignments');
  const { getWorkItem, releaseWorkItem } = await import('../work-items');
  const rows = await listFleetAssignments({
    workspaceId: resolveClaimSpecWorkspace(args.workspaceId),
    agent: scope.ownerId,
    activeOnly: true,
  });
  const ids = [...new Set(rows.filter((r) => r.source === 'work_item_claim' && r.workItemId).map((r) => r.workItemId as string))];
  const quarantinedIds: string[] = [];
  for (const id of ids) {
    const item = await getWorkItem(id);
    const matches = item && scope.record.source !== 'default' ? await itemMatchesScope(item, scope) : false;
    if (matches) continue;
    const released = await releaseWorkItem(id, { expectedAssignee: scope.ownerId });
    if (released) quarantinedIds.push(id);
  }
  if (quarantinedIds.length > 0 && args.identity) {
    const { sendMessage } = await import('../agent-tools/coordination/messages');
    await sendMessage(args.identity, {
      to: [`@fleet-leader:${scope.fleetSlug}`],
      summary: `quarantined ${quarantinedIds.length} out-of-scope fleet claim(s)`,
      body:
        `Released in one reconciliation sweep from ${scope.ownerId}: ${quarantinedIds.join(', ')}. ` +
        `Authoritative scope is ${scope.record.spec.specId}@${scope.record.spec.revision}; re-steer or reassign deliberately.`,
      category: 'fleet-scope-admission',
    }).catch(() => undefined);
  }
  return { scope, quarantinedIds };
}

export function fleetScopedMiss(scope: FleetScopeContext, quarantinedIds: string[] = []) {
  return {
    ok: false as const,
    error:
      `no claimable work-item matched fleet scope ${scope.record.spec.specId}@${scope.record.spec.revision}; ` +
      'the member was NOT allowed to fall through to the generic backlog',
    fleetScope: {
      fleet: scope.fleetSlug,
      specId: scope.record.spec.specId,
      revision: scope.record.spec.revision,
      source: scope.record.source,
    },
    quarantinedIds,
    windDown: true as const,
    advice:
      'Checkpoint any atomic progress, release remaining lane resources, call loop:end, and report the scoped miss to the fleet leader. Resume only after a claim-spec revision or a new claimable event.',
  };
}
