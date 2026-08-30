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
 * ⚠ THE FLOOR ASYMMETRY IS GONE — SUPERSEDED, NOT SOFTENED.
 * unified-responder-selection-critique-and-grading-2026-08-30 D-002 [owner]
 * overturns D-009's grading half. D-009 held that for GRADING, WRONG or
 * CONFLICTED context is the disqualifier and a grader MUST exist, so below-floor
 * minted a FRESH session rather than settle for a confidently-stale grader
 * ("a fresh session agent is better than an agent with THE WRONG context").
 * That ruling is recorded here because it explains the code this module used to
 * contain — it is NOT the live policy. Grading now MINIMUM-FILLS exactly as a
 * consult does: the best-available below-floor candidate is selected, labelled
 * `via:'minimum'`, and woken with honest first-principles copy.
 *
 * D-002 states the cost plainly rather than denying it: a below-floor grader IS
 * the confidently-stale grader D-009 preferred to avoid. What makes it
 * acceptable is that grading is no longer n=1 — under this plan's D-001/D-003
 * the menu is min 1 / max 2 delivered as a cascade, so a minimum-fill pick is
 * normally a SECOND opinion arriving after an above-floor grader, and P-004
 * makes the gate refuse to let a `via:'minimum'` card supersede an above-floor
 * one. Where no above-floor grader exists at all, this is a knowing regression
 * against D-009's intent.
 *
 * WHAT STILL MINTS FRESH: only an EMPTY menu. Nothing to select is not the same
 * epistemic state as selecting weakly — the embedder being unavailable
 * (relevance never measured), a measured-empty non-excluded actor pool, or a
 * pool in which nobody is reachable. A candidate whose context is DEAD
 * (ended/recorded — the shared DEAD_RESPONDER_STATES) cannot be woken to grade,
 * so deadness is the selectability gate passed into the generic selector: it
 * skips dead candidates for BOTH floor picks and minimum fills, which is why an
 * all-dead pool yields an empty menu rather than an unusable pick.
 *
 * SELECTION ITSELF IS NOT WRITTEN HERE. The bounds come from the shared registry
 * (`selection-policies.ts`, key ACCEPTANCE_GRADING_POLICY) and the algorithm is
 * `@papercusp/ranked-selection` — the same two things the critique consult
 * reads (D-001 [owner]: neither step may carry its own copy of the policy).
 *
 * Deps-injected (route, sql) relevance-router style; the plan-acceptance-gate
 * wires the prod embedder + liveness oracle, mirroring get-feedback/plans:start.
 */
import type { Sql } from 'postgres';
import { selectRanked, selectionPolicy, type Selected } from '@papercusp/ranked-selection';
import { COORD_ROLES, canonicalCoordRole } from '../agent-tools/coordination/roles';
import type { ConsultRouteParams, RouteResult, RoutingCandidate, RoutingSnapshot } from './relevance-router';
import { selectionSnapshot } from './relevance-router';
import { DEAD_RESPONDER_STATES } from './get-feedback-core';
import { ACCEPTANCE_GRADING_POLICY } from './selection-policies';

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

/** One selected grader with the provenance of HOW it was selected. `via` is on
 * the record because P-004 has to be able to refuse a `'minimum'` card that
 * would otherwise supersede a `'floor'` one under latest-wins. */
export type SelectedGrader = Selected<RoutingCandidate>;

export interface GraderSelection {
  verdict: 'assigned' | 'fresh';
  /**
   * The ordered grader MENU (non-empty exactly when verdict is 'assigned').
   * CASCADE order, never a parallel-wake set: head is grader 1, and grader k+1
   * is woken only after k replies, declines or expires — carrying k's card
   * (D-003 [owner]). Bounded by the ACCEPTANCE_GRADING_POLICY registry entry,
   * not by a number written here.
   */
  graders: SelectedGrader[];
  /**
   * EXACTLY the routing snapshot to persist on the grading cascade's row — the
   * router's own snapshot with two deliberate adjustments:
   *
   *  - `selection` stamped with this menu's provenance (min/max + per-selectee
   *    via/score/liveness). It is the same `SnapshotSelection` record the
   *    critique consult persists, which is what lets cascade-core advance a
   *    grading cascade with no grading-specific parsing.
   *  - `candidates` narrowed to the COORD-CAPABLE eligible pool. cascade-core's
   *    post-exhaustion refill leg extends the menu from `candidates`, so
   *    persisting the router's unfiltered list would let a refill wake a
   *    principal that `coord:send` cannot reach — a grader selected here can
   *    never be one this module already refused.
   *
   * Absent when the menu is empty (verdict 'fresh'): there is no cascade.
   */
  routing?: RoutingSnapshot;
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
  /**
   * Why the menu came back EMPTY. Renamed from the pre-D-002 set on purpose:
   * the old `no_qualified_non_excluded` / `all_qualified_dead` were statements
   * about the QUALIFIED (above-floor) pool, because above-floor was the only
   * pool that could be selected from. Under minimum-fill the whole eligible
   * pool is selectable, so a name that still said "qualified" would describe a
   * condition that no longer causes a fresh mint at all.
   *
   * 'no_eligible_non_excluded' — measured, and the non-excluded actor pool is
   * empty (the `zero_eligible` escalation). 'all_eligible_unselectable' — the
   * pool is populated but every member is dead (ended/recorded).
   * 'degraded' — relevance was never measured, so there is no ranking to fill
   * from; see the branch comment at the selection site.
   */
  freshReason?: 'no_eligible_non_excluded' | 'all_eligible_unselectable' | 'degraded';
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

  // UNMEASURED is not below-floor. D-002 replaces below-floor fresh-mint with
  // minimum-fill, but a fill is a pick from a RANKING — with no embedder there
  // is no ranking to fill from, only an arbitrary row order. Minting fresh here
  // is the honest outcome, not a survival of the overturned asymmetry.
  if (route.snapshot.degraded === 'embed-unavailable' || route.verdict === 'relevance_unmeasured') {
    return { verdict: 'fresh', graders: [], excluded, eligibility, freshReason: 'degraded' };
  }

  // D-001 [owner]: bounds from the shared registry, algorithm from the shared
  // library. `qualifiedCandidates` are the above-floor picks; `eligibleCandidates`
  // is the full ranked non-excluded pool the minimum-fill reaches into. Deadness
  // is the selectability gate, so an unreachable candidate is skipped for BOTH —
  // an honest short menu beats a grader who can never answer.
  const bounds = selectionPolicy(ACCEPTANCE_GRADING_POLICY);
  const graders = selectRanked<RoutingCandidate>({
    qualified: qualifiedCandidates,
    allCandidates: eligibleCandidates,
    bounds,
    identity: (candidate) => candidate.ownerId,
    isSelectable: (candidate) => !DEAD_RESPONDER_STATES.has(candidate.liveness),
  });

  if (graders.length === 0) {
    return {
      verdict: 'fresh',
      graders: [],
      excluded,
      eligibility,
      ...(escalation ? { escalation } : {}),
      // Two genuinely different empty menus, kept apart because they imply
      // different repairs: nobody to ask at all vs. a populated pool in which
      // nobody is reachable (all ended/recorded).
      freshReason: eligibleCandidates.length === 0 ? 'no_eligible_non_excluded' : 'all_eligible_unselectable',
    };
  }

  return {
    verdict: 'assigned',
    graders,
    routing: {
      ...route.snapshot,
      candidates: eligibleCandidates,
      selection: selectionSnapshot(bounds.min, bounds.max, graders),
    },
    excluded,
    eligibility,
  };
}
