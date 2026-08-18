/**
 * get-feedback-core.ts — the requester-side consult workflow (plan
 * get-feedback-relevance-consults-2026-08-16, P-003; decisions D-003/D-005/
 * D-007/D-008). Core/binding split mirrors conversations-core.ts: ALL consult
 * logic lives here behind injected deps (sql, router, conversation-opener,
 * reach/wake) so it is integration-tested against a real consult_state table
 * without the prod singletons; the `consult:get_feedback` tool
 * (agent-tools/consult/get-feedback.ts) binds the prod seams.
 *
 * What this module OWNS (and the router deliberately does not):
 *  - the LIVENESS GATE (D-008 §5): the router only annotates sessionState;
 *    v1 picks the top qualified candidate that is not 'ended'/'recorded'.
 *    All-qualified-dead is an honest no_qualified_responder with
 *    reason 'no_live_responder' + the evidence refs (retrieval fallback —
 *    the requester reads the cited turns via sessions:read).
 *  - SELECTION (consult-min-max-and-rubric-vetting-2026-08-17 D-001/D-005):
 *    min/max responder selection over the router's ranked pool. The per-task
 *    wake budget is REMOVED (D-005: maxResponders is the only per-consult
 *    bound; residual spam guards = per-consult max, the depth cap, and
 *    archive-first dedupe). consult_state.wakes_used keeps being WRITTEN as a
 *    plain stat — it gates nothing.
 *  - PERSISTENCE (D-008 §1): every call — routed or not — opens the
 *    kind='consult' conversation and writes the consult_state row with the
 *    routing snapshot VERBATIM (the D-003 honesty-metric feed needs persisted
 *    no_qualified_responder verdicts too; the PK needs the conversation row).
 *  - the LATENCY CONTRACT (D-005): 'proceed' (default — requester proceeds on
 *    assumption and reconciles) vs 'hard-blocked' (requester parks on the
 *    latched `consult:reply:<conversation_id>` event, emitted by the P-004
 *    reply verbs). expires_at derives from the contract.
 */
import type { Sql } from 'postgres';
import type { RouteResult, RoutingCandidate, SelectionVia } from './relevance-router';
import { DEFAULT_SIM_FLOOR, selectResponders, selectionSnapshot } from './relevance-router';

/** P-006 archive-first retrieval floor: a closed_answered consult whose
 * question similarity clears this is served from the archive (create +
 * instant-close, no wake). Deliberately precision-biased — a
 * silently-wrong cached answer is worse than a wake — and never below the
 * router's own similarity sub-floor. */
export const DEFAULT_ARCHIVE_FLOOR = Math.max(DEFAULT_SIM_FLOOR, 0.8);
/** Latency-contract expiry defaults (D-005 'proceed-after-N'; the N is a
 * policy default here, not owner-pinned — P-005 lifecycle owns the expiry
 * sweep and may recalibrate). */
export const PROCEED_EXPIRY_MS = 4 * 3_600_000; // 4h
export const HARD_BLOCKED_EXPIRY_MS = 30 * 60_000; // 30m
/** sessionStates a v1 consult never wakes (D-008 §5 liveness gate). */
export const DEAD_RESPONDER_STATES: ReadonlySet<string> = new Set(['ended', 'recorded']);
/** Recursion ceiling (D-007 §7) — mirrors the consult_state.depth CHECK (0–2). */
export const MAX_CONSULT_DEPTH = 2;
/** consult-min-max-and-rubric-vetting-2026-08-17 D-003 [owner]: EVERY consult
 * selects at least the best-available LIVE candidate even below the relevance
 * floor (labeled per D-002). The honest no-route verdict survives only where a
 * minimum is physically unfillable: no live candidate at all, or the embedder
 * is down (no ranking exists to pick "best-available" from — D-003 keeps the
 * cannot-measure degrade honest rather than inventing a recency fallback). */
export const DEFAULT_MIN_RESPONDERS = 1;
/** Default cap on the selected cascade menu — the router's historical
 * qualified cap (maxQualified default). Rubric vetting pins 3 explicitly
 * (D-001 §4); other call sites may widen up to the tool-layer bound. */
export const DEFAULT_MAX_RESPONDERS = 3;

/** The latched park/reply key for a consult conversation — the ONE format every
 * emitter (P-004 reply verbs, P-005 expiry sweep) and awaiter shares. */
export function consultParkKey(conversationId: string): string {
  return `consult:reply:${conversationId}`;
}

export type LatencyContract = 'proceed' | 'hard-blocked';

export interface GetFeedbackRequest {
  workspaceId: string;
  requesterId: string;
  question: string;
  tried?: string;
  observed?: string;
  decisionAtStake?: string;
  latencyContract?: LatencyContract;
  /** Explicit origin task ref; undefined ⇒ default to the requester's most
   * recently progressed wip work-item (fail-soft: none ⇒ null). */
  originTaskRef?: string | null;
  /** Exclude owners from candidacy — e.g. exhausted-menu decliners on a FRESH
   * re-route (the cascade itself is server-driven now, D-005/P-013: declines
   * and expiries advance the selected menu without a re-call). */
  excludeOwners?: string[];
  /** P-005 recursion lineage: set when this consult is opened from WITHIN a
   * consult turn (the responder consulting onward) — the parent consult's
   * conversation_id. depth = parent.depth+1, refused past MAX_CONSULT_DEPTH;
   * the lineage's participants are folded into the router's excludeOwners so
   * a cycle (A→B→A, D-005) can never form by construction. */
  parentConsultId?: string | null;
  topics?: string[];
  harnessSlug?: string;
  /** P-006 archive floor override (default DEFAULT_ARCHIVE_FLOOR). Raise past
   * 1 (e.g. 2) to force fresh routing when an archived answer did not fit;
   * tests use 0 / unreachable as falsifiability controls. */
  archiveFloor?: number;
  /** D-001 §1 / D-003: select at least this many responders even when the
   * routing floors filter everyone out (best-available fill, labeled
   * via:'minimum'). Default DEFAULT_MIN_RESPONDERS (1). Pass 0 to restore
   * pure-floor selection. */
  minResponders?: number;
  /** D-001 §1: hard cap on the selected cascade menu. Default
   * DEFAULT_MAX_RESPONDERS (3). Delivery remains single-wake cascade. */
  maxResponders?: number;
}

/** P-005 creation-side refusals — structural, BEFORE any conversation/row is
 * written (a depth/cycle refusal is a pre-flight arg problem, not a routing
 * verdict, so it does not enter the D-003 honesty feed). */
export type GetFeedbackError =
  | { error: 'parent_consult_not_found'; parent_consult_id: string; hint: string }
  | { error: 'consult_depth_exceeded'; depth: number; max_depth: number; hint: string }
  | { error: 'consult_cycle'; lineage: string[]; hint: string };

export interface GetFeedbackDeps {
  getSql: () => Sql;
  route: (params: {
    workspaceId: string;
    requesterId: string;
    question: string;
    excludeOwners?: string[];
  }) => Promise<RouteResult>;
  /** Opens the kind='consult' conversation (bound to openConversation in prod). */
  open: (input: {
    kind: 'consult';
    title: string;
    body: string;
    topics?: string[];
    harness_slug?: string;
    direct_to: string[];
  }) => Promise<{ conversation_id: string; thread_id: string; delivered: number }>;
  /** Directed ping + wake on the conversation (bound to notifyAgents in prod). */
  reach: (opts: {
    responder: string;
    conversationId: string;
    summary: string;
    body: string;
  }) => Promise<{ woke: number }>;
  now?: () => Date;
}

export interface GetFeedbackResult {
  ok: true;
  verdict: 'routed' | 'no_qualified_responder' | 'served_from_archive';
  /** Only on no_qualified_responder — WHY, honestly (D-003: distinct causes
   * must stay distinguishable). */
  reason?: 'below_floor' | 'no_live_responder' | 'embed_unavailable';
  conversation_id: string;
  thread_id: string;
  /** 'served_from_archive' is a TS-surface state only — the DB row reuses
   * state='closed_answered' with outcome.source='archive' (P-006; no enum
   * widening in migration 834's CHECK). */
  state: 'awaiting_responder' | 'no_qualified_responder' | 'served_from_archive';
  responder: RoutingCandidate | null;
  /** How the responder entered the selected set (D-002): 'floor' = cleared the
   * routing floors; 'minimum' = best-available fill below them (weigh the
   * reply as a first-principles review). Null when no responder. */
  responder_via: SelectionVia | null;
  /** The rest of the SELECTED cascade menu, best first. The SERVER drains
   * this menu itself (D-005 always-advance: reply/decline/expiry wake the
   * next selectee); returned as retrieval refs, not a re-call worklist. On
   * no_live_responder it falls back to the (dead) floor-qualified candidates
   * so the retrieval path keeps its refs. */
  remaining_candidates: Array<{ ownerId: string; score: number; liveness: string; via: SelectionVia }>;
  origin_task_ref: string | null;
  latency_contract: LatencyContract;
  expires_at: string | null;
  wake: {
    attempted: boolean;
    woke: number;
  };
  /** Latched park key for a hard-blocked requester (P-004 reply verbs emit). */
  park_key: string | null;
  /** P-006 archive-serve provenance — present only on served_from_archive. */
  archive?: {
    source_conversation_id: string;
    responder_id: string | null;
    closed_at: string | null;
    sim: number;
    /** The source consult's structured outcome VERBATIM (D-001 shape:
     * { answer?, confidence?, evidence?, reason? }). */
    answer: unknown;
  };
  degraded?: 'embed-unavailable';
  hint: string;
}

/** One archive-candidate row from the P-006 retrieval lookup. */
interface ConsultArchiveRow {
  conversation_id: string;
  responder_id: string | null;
  outcome: unknown;
  closed_at: string | Date | null;
  sim: number;
}

function consultTitle(question: string): string {
  const q = question.replace(/\s+/g, ' ').trim();
  return `consult: ${q.length > 90 ? `${q.slice(0, 90)}…` : q}`;
}

function consultBody(req: GetFeedbackRequest): string {
  const parts = [req.question.trim()];
  if (req.tried?.trim()) parts.push(`## Tried\n${req.tried.trim()}`);
  if (req.observed?.trim()) parts.push(`## Observed\n${req.observed.trim()}`);
  if (req.decisionAtStake?.trim()) parts.push(`## Decision at stake\n${req.decisionAtStake.trim()}`);
  parts.push(`_latency contract: ${req.latencyContract ?? 'proceed'}_`);
  return parts.join('\n\n');
}

/** Compact why-you-were-chosen evidence for the wake body (D-008 §5) — refs
 * resolvable via sessions:read, so relevance validation is a cheap check. */
function evidenceLine(c: RoutingCandidate): string {
  return c.evidence
    .map((e) => `${e.session_id}#${e.turn_idx} (sim ${e.sim.toFixed(2)})`)
    .join('; ');
}

/**
 * Did anyone actually CRITIQUE this consult?
 *
 * (consult-min-max-and-rubric-vetting-2026-08-17 P-004; tightened by
 * EI-20821478338037350.) scorecards:emit validates a `vettingConsult` before
 * stamping it, because the acceptance gate trusts the stamp rather than
 * re-querying. The original predicate was a bare `consult_state` EXISTENCE
 * check, which validated LINKAGE ("the consult row is real") and was read
 * downstream as VETTING ("critique happened") — so a consult that was opened
 * and never answered satisfied the ship gate. That is the vacuous-green shape
 * the vetting gate exists to prevent, one level up.
 *
 * A CRITIQUE POST here is one authored by a KNOWN third party — neither the
 * emitter attesting the vetting nor the consult's own requester, whose posts
 * are the ask, not the answer — with a kind other than 'decline'. Two
 * deliberate exclusions:
 *  - 'decline' ("my context does not cover this") is the documented
 *    no-responder path, not critique; counting it would rebuild the same hole
 *    one rung lower.
 *  - a NULL author_id cannot be attributed to a third party, so it cannot
 *    evidence external critique.
 * Every other kind counts: a `clarifying_question` from a live reviewer is
 * genuine engagement with the rubric, and being stricter than that just pushes
 * honest authors onto the waiver path.
 *
 * Deps-injected `sql` like everything else in this module, so callers bind
 * their own seam.
 */
export interface VettingConsultCritique {
  /** false ⇒ no consult_state row: a dangling link, not an unanswered consult. */
  exists: boolean;
  /** The consult's fine-grained lifecycle state, for a refusal that can say WHY. */
  state: string | null;
  /** Third-party posts that constitute critique (see the kind rules above). */
  critiquePosts: number;
  /** Third-party 'decline' posts — reviewers who explicitly could not help. */
  declinePosts: number;
  /** Distinct authors of the critique posts, so the stamp can name the critics. */
  critics: string[];
}

export async function readVettingConsultCritique(
  sql: Sql,
  workspaceId: string,
  conversationId: string,
  emitterId: string,
): Promise<VettingConsultCritique> {
  const stateRows = (await sql`
    SELECT state, requester_id
      FROM harness_shared.consult_state
     WHERE workspace_id = ${workspaceId} AND conversation_id = ${conversationId}
     LIMIT 1
  `) as unknown as { state: string; requester_id: string }[];
  const stateRow = stateRows[0];
  if (!stateRow) {
    return { exists: false, state: null, critiquePosts: 0, declinePosts: 0, critics: [] };
  }
  const postRows = (await sql`
    SELECT kind, author_id
      FROM harness_shared.consult_post_meta
     WHERE workspace_id = ${workspaceId}
       AND conversation_id = ${conversationId}
       AND author_id IS NOT NULL
       AND author_id <> ${emitterId}
       AND author_id <> ${stateRow.requester_id}
  `) as unknown as { kind: string; author_id: string }[];

  const critics = new Set<string>();
  let critiquePosts = 0;
  let declinePosts = 0;
  for (const post of postRows) {
    if (post.kind === 'decline') {
      declinePosts += 1;
      continue;
    }
    critiquePosts += 1;
    critics.add(post.author_id);
  }
  return {
    exists: true,
    state: stateRow.state,
    critiquePosts,
    declinePosts,
    critics: [...critics].sort(),
  };
}

/** Walk the parent_consult_id chain collecting every lineage participant —
 * bounded: the depth CHECK caps a legal chain at MAX_CONSULT_DEPTH+1 rows.
 * Null ⇒ the named parent does not exist in this workspace. */
async function readConsultLineage(
  sql: Sql,
  workspaceId: string,
  parentConsultId: string,
): Promise<{ parentDepth: number; owners: Set<string> } | null> {
  const owners = new Set<string>();
  let parentDepth: number | null = null;
  let cursor: string | null = parentConsultId;
  for (let hop = 0; cursor && hop <= MAX_CONSULT_DEPTH; hop += 1) {
    const rows = (await sql`
      SELECT requester_id, responder_id, depth, parent_consult_id
        FROM harness_shared.consult_state
       WHERE workspace_id = ${workspaceId} AND conversation_id = ${cursor}
    `) as unknown as Array<{
      requester_id: string;
      responder_id: string | null;
      depth: number;
      parent_consult_id: string | null;
    }>;
    const row = rows[0];
    if (!row) break;
    if (hop === 0) parentDepth = row.depth;
    owners.add(row.requester_id);
    if (row.responder_id) owners.add(row.responder_id);
    cursor = row.parent_consult_id;
  }
  return parentDepth == null ? null : { parentDepth, owners };
}

export async function getFeedbackCore(
  req: GetFeedbackRequest,
  deps: GetFeedbackDeps,
): Promise<GetFeedbackResult | GetFeedbackError> {
  const sql = deps.getSql();
  const now = deps.now ? deps.now() : new Date();
  const latency: LatencyContract = req.latencyContract ?? 'proceed';

  // 0) Recursion lineage (P-005, D-005 / D-007 §7): a consult opened from
  //    within a consult carries parent depth+1 (structural refusal past the
  //    ceiling — never let the DB CHECK be the error surface), and its
  //    lineage's participants are excluded from routing so a cycle cannot
  //    form by construction.
  let depth = 0;
  let lineageOwners: string[] = [];
  if (req.parentConsultId) {
    const lineage = await readConsultLineage(sql, req.workspaceId, req.parentConsultId);
    if (!lineage) {
      return {
        error: 'parent_consult_not_found',
        parent_consult_id: req.parentConsultId,
        hint: 'parent_consult_id must name an existing consult conversation in this workspace — pass the conversation_id of the consult you are answering.',
      };
    }
    depth = lineage.parentDepth + 1;
    if (depth > MAX_CONSULT_DEPTH) {
      return {
        error: 'consult_depth_exceeded',
        depth,
        max_depth: MAX_CONSULT_DEPTH,
        hint: `Consult recursion is capped at depth ${MAX_CONSULT_DEPTH} (D-007 §7) — answer from your own context, or close/decline and let the requester cascade.`,
      };
    }
    lineageOwners = [...lineage.owners];
  }

  // 1) Origin task ref — explicit wins; undefined defaults to the requester's
  //    most recently progressed wip item (task-attribution stat; the D-005
  //    budget that once aggregated on it is removed).
  let originRef: string | null = req.originTaskRef !== undefined ? req.originTaskRef : null;
  if (req.originTaskRef === undefined) {
    const rows = (await sql`
      SELECT feature_id FROM harness_shared.work_items
       WHERE taken_by = ${req.requesterId} AND status = 'wip'
    ORDER BY COALESCE(last_progress_at, taken_at) DESC NULLS LAST
       LIMIT 1
    `) as unknown as Array<{ feature_id: string }>;
    originRef = rows[0]?.feature_id ?? null;
  }

  // 2) Route (one embedding + bounded SQL; snapshot comes back for persisting).
  //    The caller's explicit exclusions (e.g. a fresh route after an
  //    exhausted cascade) and the recursion lineage fold into ONE
  //    excludeOwners set (P-005 cycle refusal rides P-002's arg).
  const excludeOwners = [...new Set([...(req.excludeOwners ?? []), ...lineageOwners])];
  const route = await deps.route({
    workspaceId: req.workspaceId,
    requesterId: req.requesterId,
    question: req.question,
    ...(excludeOwners.length ? { excludeOwners } : {}),
  });

  // 2b) Archive-first retrieval (P-006, D-005/D-006 "retrieval, not consult"):
  //     BEFORE any wake or insert, check whether a CLOSED consult already
  //     answered a highly similar question. A hit is served as a create +
  //     instant-close: the consult row is written state='closed_answered' with
  //     outcome.source='archive' and the source's outcome verbatim — no wake.
  //     Archive-served rows are excluded from candidacy
  //     (outcome->>'source' predicate) so no copy-of-copy chains can form.
  //     The SELECT doubles as the capability probe: pgvector absent / column
  //     not migrated throws, and the leg degrades to normal routing (the
  //     per-source degrade contract) — the INSERT then also skips the column.
  const archiveFloor = req.archiveFloor ?? DEFAULT_ARCHIVE_FLOOR;
  const qVecStr = route.queryVec && route.queryVec.length > 0 ? JSON.stringify(route.queryVec) : null;
  let embeddingColumnOk = false;
  let archiveHit: ConsultArchiveRow | null = null;
  if (qVecStr) {
    try {
      const rows = (await sql`
        SELECT conversation_id, responder_id, outcome, closed_at,
               1 - (query_embedding <=> ${qVecStr}::vector) AS sim
          FROM harness_shared.consult_state
         WHERE workspace_id = ${req.workspaceId}
           AND state = 'closed_answered'
           AND query_embedding IS NOT NULL
           AND (outcome->>'source' IS DISTINCT FROM 'archive')
      ORDER BY query_embedding <=> ${qVecStr}::vector
         LIMIT 3
      `) as unknown as ConsultArchiveRow[];
      embeddingColumnOk = true;
      const top = rows[0];
      if (top && Number(top.sim) >= archiveFloor) archiveHit = { ...top, sim: Number(top.sim) };
    } catch {
      embeddingColumnOk = false;
    }
  }
  // ⚠ jsonb params in this module go through sql.json(), never a hand
  // JSON.stringify + ::jsonb: under prepare:true (postgres-js default; the
  // integration fixture) PG describes $n::jsonb as a jsonb param and the
  // driver's jsonb serializer stringifies AGAIN — the row lands as a jsonb
  // STRING scalar whose ->>'key' is NULL, silently breaking the archive
  // exclusion predicate. Prod (buildClient, prepare:false) sends text and
  // single-encodes either way; sql.json() single-encodes under BOTH modes.
  if (archiveHit) {
    const opened = await deps.open({
      kind: 'consult',
      title: consultTitle(req.question),
      body: consultBody(req),
      ...(req.topics?.length ? { topics: req.topics } : {}),
      ...(req.harnessSlug ? { harness_slug: req.harnessSlug } : {}),
      direct_to: [],
    });
    const closedAtIso = archiveHit.closed_at ? new Date(archiveHit.closed_at as string).toISOString() : null;
    const outcome = {
      source: 'archive',
      source_conversation_id: archiveHit.conversation_id,
      source_responder_id: archiveHit.responder_id,
      source_closed_at: closedAtIso,
      sim: archiveHit.sim,
      answer: archiveHit.outcome,
    };
    await sql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question,
         latency_contract, origin_task_ref, routing, outcome, closed_at, wakes_used,
         depth, parent_consult_id, query_embedding)
      VALUES
        (${req.workspaceId}, ${opened.conversation_id}, ${req.requesterId},
         ${archiveHit.responder_id}, 'closed_answered', ${req.question}, ${latency},
         ${originRef}, ${sql.json(route.snapshot as never)},
         ${sql.json(outcome as never)}, ${now.toISOString()}::timestamptz, 0,
         ${depth}, ${req.parentConsultId ?? null}, ${qVecStr}::vector)
    `;
    return {
      ok: true,
      verdict: 'served_from_archive',
      conversation_id: opened.conversation_id,
      thread_id: opened.thread_id,
      state: 'served_from_archive',
      responder: null,
      responder_via: null,
      remaining_candidates: route.qualified.map((c) => ({
        ownerId: c.ownerId,
        score: c.score,
        liveness: c.liveness,
        via: 'floor' as SelectionVia,
      })),
      origin_task_ref: originRef,
      latency_contract: latency,
      expires_at: null,
      wake: {
        attempted: false,
        woke: 0,
      },
      park_key: null,
      archive: {
        source_conversation_id: archiveHit.conversation_id,
        responder_id: archiveHit.responder_id,
        closed_at: closedAtIso,
        sim: archiveHit.sim,
        answer: archiveHit.outcome,
      },
      hint:
        `Served from the archive: consult ${archiveHit.conversation_id}` +
        `${archiveHit.responder_id ? ` (answered by ${archiveHit.responder_id}` : ' (closed'}${closedAtIso ? ` ${closedAtIso}` : ''})` +
        ` settled a highly similar question (sim ${archiveHit.sim.toFixed(2)} ≥ floor ${archiveFloor}). ` +
        'The structured answer + provenance are in `archive` — no one was woken. ' +
        'RECONCILE if your context differs: the archived answer predates your current state; ' +
        'if it does not fit, re-call with archiveFloor: 2 to force fresh routing.',
    };
  }

  // 3) D-001 §1 selection (min/max, liveness-gated per D-008 §5): every
  //    selectable floor-qualified candidate best-first up to max; fewer than
  //    min ⇒ best-available fill from the full ranked pool, labeled
  //    via:'minimum' (D-002 — labeled, never silent). The selected set IS the
  //    cascade menu; delivery stays single-wake. The selection provenance is
  //    stamped into the routing snapshot BEFORE it is persisted, so the D-003
  //    honesty feed can always tell floor-qualified from minimum-fill.
  const minResponders = Math.max(0, req.minResponders ?? DEFAULT_MIN_RESPONDERS);
  const maxResponders = Math.max(1, req.maxResponders ?? DEFAULT_MAX_RESPONDERS);
  const selected = selectResponders({
    qualified: route.qualified,
    allCandidates: route.snapshot.candidates,
    min: minResponders,
    max: maxResponders,
    isSelectable: (c) => !DEAD_RESPONDER_STATES.has(c.liveness),
  });
  route.snapshot.selection = selectionSnapshot(minResponders, maxResponders, selected);
  const chosenSel = selected[0] ?? null;
  const chosen = chosenSel?.candidate ?? null;
  const chosenVia: SelectionVia | null = chosenSel?.via ?? null;

  // Belt + braces for the cycle rule (D-005): the excludeOwners fold means the
  // router can never hand back a lineage owner — but a future direct-responder
  // path might. Refuse structurally rather than trusting every route impl.
  if (chosen && lineageOwners.includes(chosen.ownerId)) {
    return {
      error: 'consult_cycle',
      lineage: lineageOwners,
      hint: "The resolved responder is already in this consult's lineage (A→B→A, D-005) — a cycle is refused. Re-call excluding them, or proceed on your own judgment.",
    };
  }
  // With a minimum in play (D-003 default 1), an empty selection means the
  // minimum was UNFILLABLE — the distinct causes stay distinguishable (D-003):
  // instrument down ⇒ embed_unavailable; a pool that only LIVENESS kept out
  // (qualified-but-dead, or a min>0 fill pool that was all dead) ⇒
  // no_live_responder; nothing selectable in the first place (no match at
  // all, or pure-floor min:0 with nothing above the floor) ⇒ below_floor —
  // a live below-floor pool under min:0 is a FLOOR verdict, not a liveness one.
  const reason: GetFeedbackResult['reason'] = chosen
    ? undefined
    : route.snapshot.degraded === 'embed-unavailable'
      ? 'embed_unavailable'
      : route.qualified.length > 0 || (minResponders > 0 && route.snapshot.candidates.length > 0)
        ? 'no_live_responder'
        : 'below_floor';

  // 4) Wake gating is selection/liveness ONLY — the per-task wake budget is
  //    REMOVED (D-005: maxResponders is the only per-consult bound; residual
  //    spam guards = per-consult max, the depth cap, archive-first dedupe).
  const willWake = Boolean(chosen);

  // 5) Open the conversation — ALWAYS (D-003 honesty feed + the PK row).
  const opened = await deps.open({
    kind: 'consult',
    title: consultTitle(req.question),
    body: consultBody(req),
    ...(req.topics?.length ? { topics: req.topics } : {}),
    ...(req.harnessSlug ? { harness_slug: req.harnessSlug } : {}),
    direct_to: chosen ? [chosen.ownerId] : [],
  });

  // 6) Persist consult_state (snapshot VERBATIM — D-008; never recomputed).
  const state: GetFeedbackResult['state'] = chosen ? 'awaiting_responder' : 'no_qualified_responder';
  const expiresAt = chosen
    ? new Date(now.getTime() + (latency === 'hard-blocked' ? HARD_BLOCKED_EXPIRY_MS : PROCEED_EXPIRY_MS)).toISOString()
    : null;
  // query_embedding is stored whenever the column exists (embeddingColumnOk —
  // proven by the archive probe) and this route produced a vector: every
  // consult forward-fills the P-006 retrieval cache, hit or miss.
  if (embeddingColumnOk && qVecStr) {
    await sql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question,
         latency_contract, origin_task_ref, routing, expires_at, wakes_used,
         depth, parent_consult_id, query_embedding)
      VALUES
        (${req.workspaceId}, ${opened.conversation_id}, ${req.requesterId},
         ${chosen?.ownerId ?? null}, ${state}, ${req.question}, ${latency},
         ${originRef}, ${sql.json(route.snapshot as never)}, ${expiresAt},
         ${willWake ? 1 : 0}, ${depth}, ${req.parentConsultId ?? null}, ${qVecStr}::vector)
    `;
  } else {
    await sql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question,
         latency_contract, origin_task_ref, routing, expires_at, wakes_used,
         depth, parent_consult_id)
      VALUES
        (${req.workspaceId}, ${opened.conversation_id}, ${req.requesterId},
         ${chosen?.ownerId ?? null}, ${state}, ${req.question}, ${latency},
         ${originRef}, ${sql.json(route.snapshot as never)}, ${expiresAt},
         ${willWake ? 1 : 0}, ${depth}, ${req.parentConsultId ?? null})
    `;
  }

  // 7) Wake the responder. A floor-qualified pick gets the why-you-were-chosen
  //    evidence body (D-008 §5); a minimum-fill pick gets the HONEST
  //    best-available body (D-002): first-principles review requested, no
  //    pretence their transcript covers it, and no reflexive lack-of-context
  //    decline (that protocol line would otherwise make every minimum consult
  //    a designed decline — a burned wake).
  let woke = 0;
  if (willWake && chosen) {
    const r = await deps.reach({
      responder: chosen.ownerId,
      conversationId: opened.conversation_id,
      summary: `🧭 consult from ${req.requesterId}: ${req.question.replace(/\s+/g, ' ').slice(0, 72)}`,
      body:
        chosenVia === 'minimum'
          ? `Selected as BEST-AVAILABLE reviewer (blended score ${chosen.score.toFixed(2)}, sim ${chosen.signals.similarity.toFixed(2)} — BELOW the relevance floor; no better-matched live peer exists, and this consult carries a minimum of ${minResponders}).\n` +
            `This is a FIRST-PRINCIPLES review request, not a claim your transcript covers it — do NOT decline solely for lack of context. Review the question on its merits and state plainly what you can and cannot ground.\n` +
            `Reply in conversation ${opened.conversation_id} with consult:reply { kind } (answer requires evidence — labeled first-principles reasoning is admissible here); ` +
            `consult:decline { reason } only if you genuinely cannot add value; consult:close { outcome } when settled. Untyped conversations:post is refused.`
          : `Routed to you by transcript relevance (score ${chosen.score.toFixed(2)}, sim ${chosen.signals.similarity.toFixed(2)}).\n` +
            `Why you: ${evidenceLine(chosen)} — sessions:read resolves the refs.\n` +
            `Validate relevance FIRST; decline cheaply if your context doesn't cover it. Answer FROM your transcript, citing evidence. ` +
            `Reply in conversation ${opened.conversation_id} with consult:reply { kind } (answer requires evidence); ` +
            `consult:decline { reason } if it's not your area; consult:close { outcome } when settled. Untyped conversations:post is refused.`,
    });
    woke = r.woke;
  }

  const parkKey = chosen && latency === 'hard-blocked' ? consultParkKey(opened.conversation_id) : null;
  const viaNote =
    chosenVia === 'minimum'
      ? ' ⚠ Best-available pick BELOW the relevance floor (minimum-fill, D-001) — weigh the reply as a first-principles review, not grounded expertise.'
      : '';
  const hint = chosen
    ? latency === 'hard-blocked'
      ? `Routed + woke ${chosen.ownerId}. Park on events:await { event: '${parkKey}' } and end your turn — the reply wakes you (latched). Expires ${expiresAt}.${viaNote}`
      : `Routed + woke ${chosen.ownerId}; the reply lands in conversation ${opened.conversation_id}. PROCEED on your own judgment meanwhile and reconcile when it arrives. Declines/expiries advance the cascade SERVER-side (the next selectee is woken with the feedback so far, D-005) — no re-call needed unless the whole menu exhausts.${viaNote}`
    : reason === 'embed_unavailable'
      ? 'The embedder is unavailable on this host — similarity could NOT be measured, so there is no ranking to fill a minimum from (cannot-measure ≠ measured-nothing). Proceed on your own judgment; retry later if the answer matters.'
      : reason === 'no_live_responder'
        ? 'Matching candidates exist but none is LIVE — no wake is possible and the minimum could not be filled with a reachable reviewer. remaining_candidates lists them; read their transcripts via sessions:read / sessions:search (retrieval fallback) and proceed.'
        : "No transcript cleared this question's relevance floor (and no minimum-fill applied — either min 0 was requested or nothing matched at all): there is no best-available reviewer to route to. Proceed on your own judgment (first-class honest verdict, not an error).";

  return {
    ok: true,
    verdict: chosen ? 'routed' : 'no_qualified_responder',
    ...(reason ? { reason } : {}),
    conversation_id: opened.conversation_id,
    thread_id: opened.thread_id,
    state,
    responder: chosen,
    responder_via: chosenVia,
    remaining_candidates: (selected.length > 0
      ? selected.slice(1)
      : route.qualified.map((c) => ({ candidate: c, via: 'floor' as SelectionVia }))
    ).map((s) => ({
      ownerId: s.candidate.ownerId,
      score: s.candidate.score,
      liveness: s.candidate.liveness,
      via: s.via,
    })),
    origin_task_ref: originRef,
    latency_contract: latency,
    expires_at: expiresAt,
    wake: {
      attempted: willWake,
      woke,
    },
    park_key: parkKey,
    ...(route.snapshot.degraded ? { degraded: route.snapshot.degraded } : {}),
    hint,
  };
}
