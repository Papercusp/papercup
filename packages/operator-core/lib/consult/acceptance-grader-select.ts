/**
 * acceptance-grader-select.ts — router-driven grader DISCOVERY for the plan
 * acceptance gate (get-feedback-relevance-consults-2026-08-16, P-011 / D-009).
 *
 * The acceptance gate's grader-≠-implementer rule had an unsolved discovery
 * problem: WHO grades, concretely, was ad-hoc. Checkpoint #3 (after plan-start,
 * D-006 — earned because it replaces an existing mandatory ad-hoc step rather
 * than adding a ritual): route the plan + acceptance rubric through the P-002
 * relevance router with an EXCLUSION SET — implementers and heavy consult
 * participants on the plan's threads are excluded EVEN WHEN ABOVE-FLOOR
 * (independence outranks familiarity).
 *
 * THE FLOOR ASYMMETRY (D-009, the principle that makes launch-fresh right here
 * and wrong elsewhere): for CONSULTS, MISSING context is the disqualifier —
 * below-floor NEVER launches a fresh agent (a fresh session has nothing to
 * consult FROM; correct below-floor result is "proceed yourself", D-003). For
 * GRADING, WRONG or CONFLICTED context is the disqualifier and a grader MUST
 * exist (the gate requires one) — so below-floor mints FRESH instead of
 * stalling the gate or settling for a confidently-stale grader. Owner's line,
 * policy-grade: "a fresh session agent is better than an agent with THE WRONG
 * context."
 *
 * Agent-proposed refinement (ratify at review, like D-009's own refinements):
 * a top candidate whose context is DEAD (ended/recorded — the shared
 * DEAD_RESPONDER_STATES) cannot be woken to grade, so dead candidates are
 * skipped toward the next non-dead qualified one; ALL dead ⇒ fresh. An
 * unreachable grader stalls the gate exactly like no grader — and the fresh
 * session that replaces it is precisely the cold reader the owner rule prefers.
 *
 * Deps-injected (route, sql) relevance-router style; the plan-acceptance-gate
 * wires the prod embedder + liveness oracle, mirroring get-feedback/plans:start.
 */
import type { Sql } from 'postgres';
import { COORD_ROLES, canonicalCoordRole } from '../agent-tools/coordination/roles';
import type { ConsultRouteParams, RouteResult, RoutingCandidate } from './relevance-router';
import { DEAD_RESPONDER_STATES } from './get-feedback-core';

export const GRADER_QUERY_MAX_CHARS = 4000;

export interface GraderSelectParams {
  workspaceId: string;
  planSlug: string;
  /** The plan's canonical content (query document half 1). */
  planContent: string;
  /** Rubric title + criteria prompts (query document half 2). */
  rubricText: string;
  /** Owners excluded beyond the computed set — the rubric author and the
   * shipper at minimum (the gate passes them). */
  extraExclusions?: Array<string | null | undefined>;
}

export interface GraderSelectDeps {
  getSql: () => Sql;
  /** The P-002 router, wired with sql + embedder + liveness oracle. */
  route: (params: ConsultRouteParams) => Promise<RouteResult>;
  /** Resolve the durable role for every routed owner in the plan workspace. */
  getCandidateRoles: (workspaceId: string, ownerIds: string[]) => Promise<ReadonlyMap<string, string | null>>;
}

export interface GraderSelection {
  verdict: 'assigned' | 'fresh';
  /** The selected grader (verdict 'assigned'). */
  grader?: RoutingCandidate;
  /** The full exclusion set applied — the D-009 independence audit trail. */
  excluded: string[];
  /**
   * What the router could measure after applying the independence exclusions.
   * `eligibleCount` is the known non-excluded actor pool; `qualifiedCount` is
   * the subset that cleared the semantic floors. Keeping both counts makes an
   * empty actor pool distinguishable from a populated pool whose context simply
   * did not qualify.
   */
  eligibility: GraderEligibility;
  /** A structured escalation for a measured empty non-excluded actor pool. */
  escalation?: GraderEscalation;
  /** Why fresh. 'no_qualified_non_excluded' folds below-floor and all-excluded
   * (D-009 treats them identically); 'all_qualified_dead' is the liveness
   * refinement; 'degraded' = the embedder was unavailable (cannot measure). */
  freshReason?: 'no_qualified_non_excluded' | 'all_qualified_dead' | 'degraded';
}

export interface GraderEligibility {
  /** Number of known non-excluded candidates in the router snapshot. */
  eligibleCount: number;
  /** Number of known candidates that cleared both routing floors. */
  qualifiedCount: number;
  /** False when semantic qualification could not be measured. */
  measured: boolean;
  /** Present only when a measured route found no known non-excluded actor. */
  reason?: 'zero_eligible';
}

export interface GraderEscalation {
  /** No known non-excluded actor can perform either vetting or grading. */
  code: 'zero_eligible';
}

/**
 * coord:send is role-gated by COORD_ROLES. A router candidate without a
 * durable role (or with a role intentionally outside that allowlist, such as
 * judge) cannot receive the blocking grading request, so selection must fail
 * closed rather than parking the gate on an unreadable principal.
 */
function isCoordCapableRole(role: string | null | undefined): boolean {
  if (!role) return false;
  return COORD_ROLES.includes(canonicalCoordRole(role) as (typeof COORD_ROLES)[number]);
}

export function filterCoordCapableCandidates(
  candidates: RoutingCandidate[],
  roles: ReadonlyMap<string, string | null>,
): RoutingCandidate[] {
  return candidates.filter((candidate) => isCoordCapableRole(roles.get(candidate.ownerId)));
}

/** The system-authored grader-discovery query: rubric first (the definition of
 * done IS what the grader must know), then the plan, capped. */
export function buildGraderQuery(planSlug: string, rubricText: string, planContent: string): string {
  const text = `acceptance grading for plan ${planSlug}\n\n${rubricText}\n\n${planContent}`;
  return text.length > GRADER_QUERY_MAX_CHARS ? text.slice(0, GRADER_QUERY_MAX_CHARS) : text;
}

/**
 * The D-009 exclusion set, computed mechanically:
 *  - IMPLEMENTERS: terminal_owner / assignee / taken_by of any work-item sourced
 *    from the plan (the fan-out population);
 *  - HEAVY CONSULT PARTICIPANTS on the plan's threads: every requester (they
 *    asked from inside the work), and responders whose thread actually carried
 *    content (active / closed_answered / graduated — a decline or no-show does
 *    NOT contaminate; "heavy" means they contributed, not that they were asked).
 * Thread scope: consult_state.origin_task_ref = the plan slug itself or any
 * work-item id sourced from the plan.
 */
export async function computeGraderExclusions(
  sql: Sql,
  workspaceId: string,
  planSlug: string,
  extra: Array<string | null | undefined> = [],
): Promise<string[]> {
  const rows = (await sql`
    SELECT DISTINCT x.owner FROM (
      SELECT terminal_owner AS owner FROM harness_shared.work_items
       WHERE source_plan_slug = ${planSlug} AND terminal_owner IS NOT NULL
      UNION
      SELECT assignee FROM harness_shared.work_items
       WHERE source_plan_slug = ${planSlug} AND assignee IS NOT NULL
      UNION
      SELECT taken_by FROM harness_shared.work_items
       WHERE source_plan_slug = ${planSlug} AND taken_by IS NOT NULL
      UNION
      SELECT cs.requester_id FROM harness_shared.consult_state cs
       WHERE cs.workspace_id = ${workspaceId}
         AND (cs.origin_task_ref = ${planSlug}
           OR cs.origin_task_ref IN (SELECT feature_id FROM harness_shared.work_items WHERE source_plan_slug = ${planSlug}))
      UNION
      SELECT cs.responder_id FROM harness_shared.consult_state cs
       WHERE cs.workspace_id = ${workspaceId}
         AND cs.responder_id IS NOT NULL
         AND cs.state IN ('active', 'closed_answered', 'graduated')
         AND (cs.origin_task_ref = ${planSlug}
           OR cs.origin_task_ref IN (SELECT feature_id FROM harness_shared.work_items WHERE source_plan_slug = ${planSlug}))
    ) x
    WHERE x.owner IS NOT NULL
  `) as unknown as Array<{ owner: string }>;
  const set = new Set<string>(rows.map((r) => r.owner));
  for (const e of extra) if (e) set.add(e);
  return [...set];
}

/**
 * Select the acceptance grader per D-009. Router verdicts are handled honestly
 * (a degrade is a fresh, not an error); infrastructure faults propagate — the
 * gate catches and falls back to its generic message (discovery is a service,
 * never a new failure mode for shipping).
 */
export async function selectAcceptanceGrader(
  params: GraderSelectParams,
  deps: GraderSelectDeps,
): Promise<GraderSelection> {
  const sql = deps.getSql();
  const excluded = await computeGraderExclusions(
    sql,
    params.workspaceId,
    params.planSlug,
    params.extraExclusions ?? [],
  );

  const route = await deps.route({
    workspaceId: params.workspaceId,
    // Synthetic requester: the gate itself asks, and no real owner carries this
    // id, so the router's requester exclusion excludes nobody real. The REAL
    // exclusions (implementers, participants, author, shipper) ride excludeOwners.
    requesterId: `acceptance-gate:${params.planSlug}`,
    question: buildGraderQuery(params.planSlug, params.rubricText, params.planContent),
    excludeOwners: excluded,
  });

  const candidateOwners = [...new Set(route.snapshot.candidates.map((candidate) => candidate.ownerId))];
  const candidateRoles = candidateOwners.length
    ? await deps.getCandidateRoles(params.workspaceId, candidateOwners)
    : new Map<string, string | null>();
  // Filter both pools. The router's qualified list is a subset of its
  // snapshot, but keeping the filtering explicit prevents a future router
  // change from allowing an incompatible candidate through the assignment
  // path while eligibility still counts the safe pool.
  const eligibleCandidates = filterCoordCapableCandidates(route.snapshot.candidates, candidateRoles);
  const qualifiedCandidates = filterCoordCapableCandidates(route.qualified, candidateRoles);

  const eligibility: GraderEligibility = {
    eligibleCount: eligibleCandidates.length,
    qualifiedCount: qualifiedCandidates.length,
    measured: route.snapshot.degraded === undefined,
    ...(route.snapshot.degraded === undefined && eligibleCandidates.length === 0
      ? { reason: 'zero_eligible' as const }
      : {}),
  };
  const escalation: GraderEscalation | undefined = eligibility.reason
    ? { code: eligibility.reason }
    : undefined;

  if (route.snapshot.degraded === 'embed-unavailable') {
    return { verdict: 'fresh', excluded, eligibility, freshReason: 'degraded' };
  }
  if (route.verdict !== 'routed' || qualifiedCandidates.length === 0) {
    return {
      verdict: 'fresh',
      excluded,
      eligibility,
      ...(escalation ? { escalation } : {}),
      freshReason: 'no_qualified_non_excluded',
    };
  }
  const reachable = qualifiedCandidates.find((c) => !DEAD_RESPONDER_STATES.has(c.liveness));
  if (!reachable) {
    return {
      verdict: 'fresh',
      excluded,
      eligibility,
      freshReason: 'all_qualified_dead',
    };
  }
  return { verdict: 'assigned', grader: reachable, excluded, eligibility };
}
