/**
 * plan-start-consult.ts — the plan-start CHECKPOINT consult (plan
 * get-feedback-relevance-consults-2026-08-16, P-010 / D-006).
 *
 * plans:start (the moment plan items fan out into work items) is the first
 * CHECKPOINT consult: a wrong assumption in a plan multiplies across every item
 * and claiming agent, and "about to build what a peer already attempted" is
 * best caught before the fan-out. The existing plans:new similar_exists dedup
 * is only lexical; this runs the P-002 relevance router over the PLAN BODY
 * itself — a system-authored query (the plan is already the ideal query
 * document, which kills checkbox-prompt ritualization).
 *
 * D-006 semantics, exactly:
 *   - What is REQUIRED is the ROUTING, not a wake. By D-003's honesty
 *     invariant the common result is `no_qualified_responder` → the start
 *     proceeds silently at the cost of one embedding search.
 *   - Above-floor matches gate by liveness: any LIVE/parked responder →
 *     `nudge` (the tool layer refuses ONCE with candidates + evidence,
 *     overridable with consulted:false + a stated reason — the proven
 *     similar_exists/force:true shape); ALL responders dead (`ended` /
 *     `recorded`, the same DEAD_RESPONDER_STATES the consult wake gate uses)
 *     → no wake is possible, so inject transcript EXCERPTS instead
 *     (retrieval, not consult) and proceed.
 *   - NUDGE, never a hard block — plan-start must not be hostage to
 *     consult-thread latency. This module never opens a consult thread and
 *     never wakes anyone; it only routes and annotates.
 *
 * Deps are injected (route, getExcerpts) relevance-router-style so the core is
 * unit-testable with a stub route; `fetchTurnExcerpts` is the prod excerpt
 * reader the tool layer wires in. This module deliberately does NOT import the
 * embedder or the presence oracle — the tool layer (plans:start) wires both,
 * mirroring the get_feedback tool's wiring of routeConsult.
 */
import type { Sql } from 'postgres';
import type { ConsultRouteParams, RouteResult, RoutingCandidate, TurnEvidence } from './relevance-router';
import { DEAD_RESPONDER_STATES } from './get-feedback-core';

/** Query cap: the embedder's model window is far smaller than a big plan body,
 * and the query-embed memo keys on the full text — cap keeps both bounded. */
export const PLAN_START_QUERY_MAX_CHARS = 4000;
/** Excerpt size per matched turn (mirrors the interest-watch excerpt cap). */
export const PLAN_START_EXCERPT_CHARS = 240;
/** Max transcript excerpts injected on the dead-context branch. */
export const PLAN_START_EXCERPTS_MAX = 6;

export interface PlanStartExcerpt {
  ownerId: string;
  session_id: string;
  turn_idx: number;
  ts: string | null;
  sim: number;
  excerpt: string;
}

export type PlanStartConsultOutcome =
  /** Below the floor (or degraded instrument) — the start proceeds silently. */
  | {
      outcome: 'proceed';
      verdict: 'no_qualified_responder';
      degraded?: 'embed-unavailable';
    }
  /** Above the floor with at least one wakeable (not-dead) candidate — the
   * tool layer refuses once with these candidates + their evidence. */
  | {
      outcome: 'nudge';
      candidates: RoutingCandidate[];
    }
  /** Above the floor but every qualified candidate's context is dead — inject
   * transcript excerpts (retrieval, not consult) and proceed. */
  | {
      outcome: 'proceed_with_excerpts';
      candidates: RoutingCandidate[];
      excerpts: PlanStartExcerpt[];
    };

export interface PlanStartConsultParams {
  workspaceId: string;
  /** The starting agent — excluded from candidacy by the router. */
  requesterId: string;
  planSlug: string;
  /** The plan's canonical content blob (frontmatter + body) — the
   * system-authored query document. Capped here, callers pass it whole. */
  planContent: string;
}

export interface PlanStartConsultDeps {
  /** The P-002 router, already wired with sql + embedder + liveness oracle. */
  route: (params: ConsultRouteParams) => Promise<RouteResult>;
  /** Excerpt reader for the dead-context branch (prod: fetchTurnExcerpts). */
  getExcerpts: (refs: Array<{ ownerId: string; evidence: TurnEvidence[] }>) => Promise<PlanStartExcerpt[]>;
}

/** The system-authored query: the plan content itself, capped. Prefixed with
 * the slug so even a sparse draft body carries its identifying tokens. */
export function buildPlanStartQuery(planSlug: string, planContent: string): string {
  const text = `plan ${planSlug}\n\n${planContent}`;
  return text.length > PLAN_START_QUERY_MAX_CHARS ? text.slice(0, PLAN_START_QUERY_MAX_CHARS) : text;
}

/**
 * Route the plan body and partition the verdict per D-006. Never throws for
 * routing verdicts (an honest degrade IS a proceed); infrastructure faults
 * (SQL down) do propagate — the tool layer catches and proceeds, because a
 * checkpoint nudge must never block a start.
 */
export async function planStartConsult(
  params: PlanStartConsultParams,
  deps: PlanStartConsultDeps,
): Promise<PlanStartConsultOutcome> {
  const route = await deps.route({
    workspaceId: params.workspaceId,
    requesterId: params.requesterId,
    question: buildPlanStartQuery(params.planSlug, params.planContent),
  });

  if (route.verdict !== 'routed' || route.qualified.length === 0) {
    return {
      outcome: 'proceed',
      verdict: 'no_qualified_responder',
      ...(route.snapshot.degraded ? { degraded: route.snapshot.degraded } : {}),
    };
  }

  const wakeable = route.qualified.filter((c) => !DEAD_RESPONDER_STATES.has(c.liveness));
  if (wakeable.length > 0) {
    // Nudge lists every qualified candidate (dead ones included — their
    // evidence still grounds the "someone attempted this" claim); the tool
    // layer renders liveness per candidate so the caller knows who is
    // actually reachable.
    return { outcome: 'nudge', candidates: route.qualified };
  }

  const excerpts = await deps
    .getExcerpts(route.qualified.map((c) => ({ ownerId: c.ownerId, evidence: c.evidence })))
    .catch(() => [] as PlanStartExcerpt[]);
  return { outcome: 'proceed_with_excerpts', candidates: route.qualified, excerpts };
}

/**
 * Prod excerpt reader: resolve the evidence turns' text from the same
 * transcript index the router matched over. Bounded — at most
 * PLAN_START_EXCERPTS_MAX rows, best-sim first, PLAN_START_EXCERPT_CHARS each.
 */
export async function fetchTurnExcerpts(
  sql: Sql,
  workspaceId: string,
  refs: Array<{ ownerId: string; evidence: TurnEvidence[] }>,
): Promise<PlanStartExcerpt[]> {
  const flat = refs
    .flatMap((r) => r.evidence.map((e) => ({ ownerId: r.ownerId, ...e })))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, PLAN_START_EXCERPTS_MAX);
  if (flat.length === 0) return [];

  const sessionIds = flat.map((f) => f.session_id);
  const turnIdxs = flat.map((f) => f.turn_idx);
  // (session_id, turn_idx) pairwise match via unnest — bounded to ≤ MAX rows.
  const rows = (await sql`
    SELECT t.session_id, t.turn_idx, t.owner,
           COALESCE(t.ts, t.ingested_at) AS ts,
           left(t.text, ${PLAN_START_EXCERPT_CHARS}) AS excerpt
      FROM harness_shared.session_turns t
      JOIN unnest(${sessionIds}::text[], ${turnIdxs}::int[]) AS want(session_id, turn_idx)
        ON t.session_id = want.session_id AND t.turn_idx = want.turn_idx
     WHERE (t.workspace_id = ${workspaceId} OR t.workspace_id = 'default')
  `) as unknown as Array<{
    session_id: string;
    turn_idx: number;
    owner: string | null;
    ts: string | Date | null;
    excerpt: string | null;
  }>;

  const textByKey = new Map(rows.map((r) => [`${r.session_id}\x00${r.turn_idx}`, r]));
  const out: PlanStartExcerpt[] = [];
  for (const f of flat) {
    const hit = textByKey.get(`${f.session_id}\x00${f.turn_idx}`);
    if (!hit || !hit.excerpt) continue;
    out.push({
      ownerId: f.ownerId,
      session_id: f.session_id,
      turn_idx: f.turn_idx,
      ts: f.ts,
      sim: f.sim,
      excerpt: hit.excerpt,
    });
  }
  return out;
}
