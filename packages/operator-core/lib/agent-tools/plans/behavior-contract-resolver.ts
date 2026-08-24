/**
 * The universal BehaviorContract resolver (P-016, D-012 / D-013).
 *
 * D-012 makes every enforceable promise a view over ONE graph — the existing
 * versioned spec-clause substrate — rather than a family of contract types. D-013
 * settles how applicability is resolved over that graph, and the two rulings
 * together are what this module implements:
 *
 *   plan_slug stays the clause's GROUPING/PROVENANCE namespace only. It is NOT a
 *   scope boundary for applicability. A work item — standalone bugs and changes
 *   included — may link through work_item_spec_revision_edges to any exact
 *   versioned clause regardless of its own source-plan provenance.
 *
 * So the resolution order is: read ALL explicit edges for the work item ACROSS plan
 * namespaces, group by plan_slug, load the exact CURRENT clauses per group, then
 * merge the plan-item-owned clauses named by the source-plan stamp for backward
 * compatibility. That merge is the back-compat leg, not the primary one — inverting
 * them is what confines a standalone item to its own plan and reintroduces the gap
 * this exists to close.
 *
 * ⚠ THIS MODULE REPORTS; IT NEVER ENFORCES. D-013 assigns the report to P-016 and
 * hard enforcement of the same reconciled condition to P-013. `impact.report` is
 * therefore advisory by construction: nothing here returns a refusal, and no caller
 * should treat a populated report as one until P-013 lands. Observation-lane items
 * and unpromoted ideas stay outside enforcement entirely — they are candidate
 * inputs until a promotion creates an active clause/edge (D-012).
 */
import type { SpecClauseRevision } from './spec-clauses-store';
import { listSpecClauses } from './spec-clauses-store';
import type { WorkItemSpecRevisionEdge } from './spec-evidence-store';
import { listWorkItemSpecRevisionEdges } from './spec-evidence-store';

/** The clause lifecycle states that carry an enforceable promise (D-012). */
export const ENFORCEABLE_LIFECYCLE_STATUSES = ['accepted', 'active'] as const;

/**
 * Kinds whose completion can CHANGE observable behavior, and which D-012 therefore
 * requires to resolve affected clauses even with no plan provenance. `task` is
 * excluded deliberately: it is the repo's non-code kind.
 */
export const BEHAVIOR_CHANGING_KINDS = ['bug', 'change'] as const;

export interface WorkItemForContract {
  id: string;
  kind?: string | null;
  harness?: string | null;
  payload?: unknown;
  sourcePlanSlug?: string | null;
  sourcePlanItemIds?: string[] | null;
  /** Observation-lane rows are candidate inputs, never enforceable (D-012). */
  lane?: string | null;
}

export interface PlanStamp {
  planSlug: string;
  harnessSlug: string;
  planItemIds: string[];
}

/**
 * The work item's source-plan provenance, or null when it is standalone.
 *
 * Lives here rather than in the completion gate because provenance is now one INPUT
 * to resolution instead of its precondition — the gate imports it from this module.
 */
export function planStampOf(workItem: WorkItemForContract): PlanStamp | null {
  const payload = workItem.payload;
  const raw =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as { plan_item?: unknown }).plan_item
      : null;
  const stamp = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const stampedPlanSlug =
    typeof stamp?.plan_slug === 'string' && stamp.plan_slug.trim() ? stamp.plan_slug.trim() : null;
  const planSlug = stampedPlanSlug ?? workItem.sourcePlanSlug?.trim();
  if (!planSlug) return null;
  const harnessSlug =
    typeof stamp?.harness_slug === 'string' && stamp.harness_slug.trim()
      ? stamp.harness_slug.trim()
      : workItem.harness?.trim();
  if (!harnessSlug) return null;
  const stampedItemId =
    typeof stamp?.item_id === 'string' && /^P-\d{3,}$/.test(stamp.item_id) ? stamp.item_id : null;
  return {
    planSlug,
    harnessSlug,
    planItemIds: [
      ...new Set([
        ...(stampedItemId ? [stampedItemId] : []),
        ...(workItem.sourcePlanItemIds ?? []).filter((id) => /^P-\d{3,}$/.test(id)),
      ]),
    ],
  };
}

/** One plan namespace's slice of a work item's contract. */
export interface BehaviorContractGroup {
  planSlug: string;
  /** Why this namespace is in scope: an explicit edge, the source-plan stamp, or both. */
  via: 'edge' | 'plan-stamp' | 'edge+plan-stamp';
  edges: WorkItemSpecRevisionEdge[];
  /** Exact CURRENT clauses for this namespace, deduped by specId. */
  clauses: SpecClauseRevision[];
  /**
   * Edges naming a revision that is no longer current. Reported, never dropped: a
   * silently-ignored stale edge is a coverage claim against a promise that has since
   * been revised, which is exactly the case a reader must be able to see.
   */
  staleEdges: Array<{ specId: string; edgeRevision: number; currentRevision: number }>;
}

export interface WorkItemBehaviorContract {
  workItemId: string;
  groups: BehaviorContractGroup[];
  /** Every enforceable clause across all namespaces, deduped by planSlug+specId. */
  enforceable: SpecClauseRevision[];
  impact: {
    /** Whether D-012 requires this item to resolve affected clauses at all. */
    required: boolean;
    resolved: boolean;
    /** Advisory only — P-013 owns turning this into a refusal. Null when nothing to report. */
    report: string | null;
    reason: 'observation-lane' | 'non-behavior-changing' | 'resolved' | 'unresolved';
  };
}

export interface ResolveBehaviorContractDeps {
  listEdges?: typeof listWorkItemSpecRevisionEdges;
  listClauses?: typeof listSpecClauses;
}

function isEnforceable(clause: SpecClauseRevision): boolean {
  return (ENFORCEABLE_LIFECYCLE_STATUSES as readonly string[]).includes(clause.lifecycleStatus);
}

/**
 * Resolve every behavior clause a work item is on the hook for, across plan namespaces.
 *
 * Returns a REPORT. See the module header: no result of this function is a refusal.
 */
export async function resolveWorkItemBehaviorContract(
  workItem: WorkItemForContract,
  deps: ResolveBehaviorContractDeps = {},
): Promise<WorkItemBehaviorContract> {
  const listEdges = deps.listEdges ?? listWorkItemSpecRevisionEdges;
  const listClauses = deps.listClauses ?? listSpecClauses;
  const stamp = planStampOf(workItem);
  const harnessSlug = stamp?.harnessSlug ?? workItem.harness?.trim() ?? undefined;

  // PRIMARY LEG (D-013): all explicit edges, every namespace. Unscoped by plan_slug
  // on purpose — scoping it here is what made a standalone item invisible.
  const edges = await listEdges({ harnessSlug, workItemId: workItem.id });

  const byPlan = new Map<string, WorkItemSpecRevisionEdge[]>();
  for (const edge of edges) {
    const list = byPlan.get(edge.planSlug);
    if (list) list.push(edge);
    else byPlan.set(edge.planSlug, [edge]);
  }
  // BACK-COMPAT LEG: the source-plan stamp contributes its namespace even with no edge,
  // so plan-item-owned clauses authored before edges existed still resolve.
  if (stamp && !byPlan.has(stamp.planSlug)) byPlan.set(stamp.planSlug, []);

  const groups = await Promise.all(
    [...byPlan.entries()].map(async ([planSlug, planEdges]): Promise<BehaviorContractGroup> => {
      const edgeSpecIds = [...new Set(planEdges.map((edge) => edge.specId))];
      const isStampPlan = stamp?.planSlug === planSlug;
      const [edgeClauses, itemClauses] = await Promise.all([
        edgeSpecIds.length
          ? listClauses({ harnessSlug, planSlug, specIds: edgeSpecIds })
          : Promise.resolve([] as SpecClauseRevision[]),
        // Only the STAMPED namespace merges plan-item-owned clauses. A namespace reached
        // purely by an edge contributes exactly the clauses that edge names — pulling in
        // its plan items too would make one edge drag in an unrelated plan's whole contract.
        isStampPlan && stamp.planItemIds.length
          ? listClauses({ harnessSlug, planSlug, planItemIds: stamp.planItemIds })
          : Promise.resolve([] as SpecClauseRevision[]),
      ]);

      const clauses = [
        ...new Map([...itemClauses, ...edgeClauses].map((clause) => [clause.specId, clause])).values(),
      ];
      const currentBySpec = new Map(clauses.map((clause) => [clause.specId, clause]));
      const staleEdges = planEdges.flatMap((edge) => {
        const clause = currentBySpec.get(edge.specId);
        if (!clause || clause.revision === edge.specRevision) return [];
        return [{ specId: edge.specId, edgeRevision: edge.specRevision, currentRevision: clause.revision }];
      });

      return {
        planSlug,
        via: planEdges.length === 0 ? 'plan-stamp' : isStampPlan ? 'edge+plan-stamp' : 'edge',
        edges: planEdges,
        clauses,
        staleEdges,
      };
    }),
  );

  groups.sort((a, b) => a.planSlug.localeCompare(b.planSlug));
  const enforceable = groups.flatMap((group) => group.clauses.filter(isEnforceable));

  // Applicability is BEHAVIOR-owned, not plan-owned (D-012).
  const lane = workItem.lane?.trim().toLowerCase();
  const kind = workItem.kind?.trim().toLowerCase();
  if (lane === 'observation') {
    return {
      workItemId: workItem.id,
      groups,
      enforceable,
      impact: { required: false, resolved: enforceable.length > 0, report: null, reason: 'observation-lane' },
    };
  }
  if (!kind || !(BEHAVIOR_CHANGING_KINDS as readonly string[]).includes(kind)) {
    return {
      workItemId: workItem.id,
      groups,
      enforceable,
      impact: { required: false, resolved: enforceable.length > 0, report: null, reason: 'non-behavior-changing' },
    };
  }

  const resolved = enforceable.length > 0;
  return {
    workItemId: workItem.id,
    groups,
    enforceable,
    impact: {
      required: true,
      resolved,
      reason: resolved ? 'resolved' : 'unresolved',
      report: resolved
        ? null
        : `${workItem.id} is a behavior-changing ${kind} that resolves no active behavior clause. ` +
          `D-012 expects a behavior-changing item to name the clauses it affects — link one with ` +
          `plans:set-spec-evidence, or promote a new clause with plans:set-specs. ` +
          `Reported, not enforced (P-016 reports; P-013 turns this into a hard gate).`,
    },
  };
}
