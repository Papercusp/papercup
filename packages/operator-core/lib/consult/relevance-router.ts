/**
 * relevance-router.ts — the get_feedback consult relevance router (plan
 * get-feedback-relevance-consults-2026-08-16, P-002; decisions D-002/D-003/D-008).
 *
 * D-002: experts are DISCOVERED, not authored. The responder is selected by
 * embedding the question over real cross-agent turn history
 * (harness_shared.session_turns — the episodic verbatim transcript index),
 * BLENDED with recency, verification/completion evidence, and authorship of
 * the code in question. Similarity alone ≠ authority.
 *
 * D-003: the router must be able to fail HONESTLY. Below the floor the answer
 * is a first-class `no_qualified_responder`, not an error — and that verdict
 * must stay COMMON in practice. Two floors enforce it:
 *   - simFloor: a HARD similarity sub-floor. Track record (recency /
 *     verification / authorship) can never promote an owner whose transcript
 *     similarity is below it — otherwise a prolific-but-irrelevant agent
 *     outranks honesty, which is exactly the retired costumed-expert failure.
 *   - floor: the blended-score floor a candidate must clear to qualify.
 *   Calibration of both is an OPEN plan item (D-003); the defaults here are
 *   deliberately precision-biased, every route persists the floors + weights
 *   in its snapshot (D-008) so calibration has an audit trail to work from.
 *
 * D-008: the routing snapshot { query, floor, candidates: [{ ownerId, score,
 * signals, evidence, liveness }] } is persisted into consult_state.routing at
 * route time and never recomputed in place. This module RETURNS that snapshot;
 * the get_feedback tool (P-003) writes it.
 *
 * Honesty on degraded instruments: when no embedder is available the router
 * CANNOT measure similarity — it returns `no_qualified_responder` with
 * `degraded: 'embed-unavailable'` rather than hallucinating a responder, and
 * the snapshot says so (cannot-measure ≠ measured-nothing).
 *
 * Dependency seams are injected (sql, embedder, liveness, clock) so the core
 * is testable against a fixture Postgres with a deterministic embedder; the
 * P-003 tool wires the real `buildQueryEmbedder` + presence oracle. This
 * module deliberately does NOT import the embedder (its transitive graph
 * reaches memory/configure, which opens PG at import time).
 */
import type { Sql } from 'postgres';
import { withIterativeScan } from '../agent-tools/search/hnsw-iterative-scan';

/** Same shape as `@papercusp/search`'s Embedder, declared locally to keep this
 * module's import graph free of the search engine (only the TYPE is shared). */
export type ConsultEmbedder = (text: string) => Promise<number[]>;

export interface BlendWeights {
  similarity: number;
  recency: number;
  verification: number;
  authorship: number;
}

/** Deliberately precision-biased defaults (D-003) — see module header. */
export const DEFAULT_SIM_FLOOR = 0.4;
export const DEFAULT_FLOOR = 0.5;
export const DEFAULT_WEIGHTS: BlendWeights = {
  similarity: 0.55,
  recency: 0.15,
  verification: 0.15,
  authorship: 0.15,
};
/** Recency half-life in days: signal = 2^(-age/HALF_LIFE). */
export const RECENCY_HALF_LIFE_DAYS = 14;
/** Verification saturation: c committed completions (90d) → c / (c + K). */
export const VERIFICATION_SATURATION_K = 4;

export interface TurnEvidence {
  session_id: string;
  turn_idx: number;
  ts: string | null;
  sim: number;
}

export interface RoutingCandidate {
  ownerId: string;
  /** Blended score in [0,1]. */
  score: number;
  signals: {
    similarity: number;
    recency: number;
    verification: number;
    authorship: number;
  };
  /** The matched turns that ground this candidacy — the why-you-were-chosen
   * evidence delivered on the responder wake (D-008 §5). */
  evidence: TurnEvidence[];
  /** sessionState from the presence oracle when a getLiveness dep was wired;
   * 'unknown' otherwise. The consult layer owns the liveness GATE (D-008 §5) —
   * the router only annotates. */
  liveness: string;
}

export interface RoutingSnapshot {
  query: string;
  floor: number;
  simFloor: number;
  weights: BlendWeights;
  candidates: RoutingCandidate[];
  computedAt: string;
  /** Set when the instrument itself was degraded — 'embed-unavailable' means
   * similarity could not be measured at all (≠ measured and found nothing). */
  degraded?: 'embed-unavailable';
  /** Min/max responder-selection provenance (consult-min-max-and-rubric-vetting
   * D-001/D-002/D-003) — stamped by the CONSULT layer at selection time and
   * persisted with the snapshot, so the D-003 honesty feed can always
   * distinguish a floor-qualified responder from a best-available minimum
   * fill. Absent on pre-min/max rows and on surfaces that route without
   * selecting (grader discovery). */
  selection?: SnapshotSelection;
}

/** How a responder entered the selected set (D-002): 'floor' = cleared both
 * routing floors (the pre-min/max notion of qualified); 'minimum' = did NOT
 * clear the floors but was selected as best-available to honor the caller's
 * minResponders (D-001 §1 / D-003 — labeled, never silent). */
export type SelectionVia = 'floor' | 'minimum';

export interface SelectedResponder {
  candidate: RoutingCandidate;
  via: SelectionVia;
}

export interface SnapshotSelection {
  min: number;
  max: number;
  selected: Array<{ ownerId: string; via: SelectionVia; score: number; similarity: number; liveness: string }>;
}

export interface ResponderSelectionParams {
  /** Candidates clearing BOTH floors, best first (RouteResult.qualified). */
  qualified: RoutingCandidate[];
  /** ALL ranked candidates, best first (RoutingSnapshot.candidates) — the
   * minimum-fill pool. A superset of `qualified`. */
  allCandidates: RoutingCandidate[];
  /** Select at least this many even when the floors filter everyone out
   * (D-001 §1; global default 1 per D-003). Clamped to [0, max]. */
  min: number;
  /** Hard cap on the selected set (the cascade menu). */
  max: number;
  /** Caller-owned selectability gate (the consult layer passes its liveness
   * gate). A candidate failing it is skipped for BOTH floor picks and fills —
   * a minimum that can only be filled by the unreachable stays unfilled
   * (honest no_live_responder beats a dead pick). */
  isSelectable?: (c: RoutingCandidate) => boolean;
}

/**
 * D-001 §1 selection: every selectable floor-qualified candidate best-first up
 * to `max`; when fewer than `min` result, fill with the best-scoring remaining
 * selectable candidates (labeled via:'minimum'). Deterministic, pure, shared
 * by every selecting surface (get_feedback, plan-start) so the semantics
 * cannot drift between call sites. Delivery stays a CASCADE regardless — the
 * result is an ordered menu, never a parallel-wake set.
 */
export function selectResponders(params: ResponderSelectionParams): SelectedResponder[] {
  const selectable = params.isSelectable ?? ((): boolean => true);
  const max = Math.max(0, Math.floor(params.max));
  const min = Math.min(Math.max(0, Math.floor(params.min)), max);
  const picked: SelectedResponder[] = [];
  const seen = new Set<string>();
  for (const c of params.qualified) {
    if (picked.length >= max) break;
    if (seen.has(c.ownerId) || !selectable(c)) continue;
    picked.push({ candidate: c, via: 'floor' });
    seen.add(c.ownerId);
  }
  if (picked.length < min) {
    for (const c of params.allCandidates) {
      if (picked.length >= min) break;
      if (seen.has(c.ownerId) || !selectable(c)) continue;
      picked.push({ candidate: c, via: 'minimum' });
      seen.add(c.ownerId);
    }
  }
  return picked;
}

/** The SnapshotSelection record for a selected set — the persisted provenance
 * half of selectResponders (D-002: labeled, never silent). */
export function selectionSnapshot(min: number, max: number, selected: SelectedResponder[]): SnapshotSelection {
  return {
    min,
    max,
    selected: selected.map((s) => ({
      ownerId: s.candidate.ownerId,
      via: s.via,
      score: s.candidate.score,
      similarity: s.candidate.signals.similarity,
      liveness: s.candidate.liveness,
    })),
  };
}

export interface RouteResult {
  verdict: 'routed' | 'no_qualified_responder';
  /** Candidates clearing BOTH floors, best first (≤ maxQualified). */
  qualified: RoutingCandidate[];
  snapshot: RoutingSnapshot;
  /** The question embedding this route was computed from (null on
   * embed-unavailable degrade). P-006: the consult layer stores it on the
   * consult_state row (retrieval-cache forward-fill) and runs the
   * archive-first lookup with it — computed ONCE here, never re-embedded. */
  queryVec: number[] | null;
}

export interface ConsultRouteParams {
  workspaceId: string;
  /** The asking agent — excluded from candidacy ("no one knows more than you
   * do" must be reachable, D-003). */
  requesterId: string;
  question: string;
  /** Additional owners excluded from candidacy — D-007(7) manual cascade: a
   * decliner is excluded on the requester's re-call, never auto-cascaded. */
  excludeOwners?: string[];
  floor?: number;
  simFloor?: number;
  weights?: Partial<BlendWeights>;
  /** Max candidates recorded in the snapshot (default 8). */
  maxCandidates?: number;
  /** Max qualified responders returned (default 3; v1 delivery uses the top one). */
  maxQualified?: number;
  /** Turn rows fetched from the index (default 200). */
  turnLimit?: number;
  /** Evidence turns kept per candidate (default 3). */
  evidencePerOwner?: number;
}

export interface ConsultRouteDeps {
  getSql: () => Sql;
  /** null = no embedder available this host right now (honest degrade). */
  embed: ConsultEmbedder | null;
  /** Presence oracle: ownerId → sessionState. Optional; default 'unknown'. */
  getLiveness?: (ownerIds: string[]) => Promise<Record<string, string>>;
  now?: () => Date;
}

/** Path-ish tokens ("code in question", D-002 authorship signal): anything
 * with a slash that looks like a repo path. Capped so the SQL stays bounded. */
export function extractPathTokens(question: string, cap = 4): string[] {
  const matches = question.match(/(?:[\w@.-]+\/)+[\w.-]+/g) ?? [];
  const seen = new Set<string>();
  for (const m of matches) {
    // Trim trailing punctuation a sentence contributes ("...in foo/bar.ts.")
    const t = m.replace(/[.,;:!?)]+$/, '');
    if (t.includes('/') && t.length >= 3) seen.add(t);
    if (seen.size >= cap) break;
  }
  return [...seen];
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Route a consult question to qualified responders. One embedding + at most
 * three bounded SQL reads; returns the D-008 snapshot for the caller to
 * persist into consult_state.routing.
 */
export async function routeConsult(
  params: ConsultRouteParams,
  deps: ConsultRouteDeps,
): Promise<RouteResult> {
  const now = deps.now ? deps.now() : new Date();
  const floor = params.floor ?? DEFAULT_FLOOR;
  const simFloor = params.simFloor ?? DEFAULT_SIM_FLOOR;
  const weights: BlendWeights = { ...DEFAULT_WEIGHTS, ...params.weights };
  const maxCandidates = params.maxCandidates ?? 8;
  const maxQualified = params.maxQualified ?? 3;
  const turnLimit = params.turnLimit ?? 200;
  const evidencePerOwner = params.evidencePerOwner ?? 3;

  const base: Omit<RoutingSnapshot, 'candidates'> = {
    query: params.question,
    floor,
    simFloor,
    weights,
    computedAt: now.toISOString(),
  };

  const vec = deps.embed ? await deps.embed(params.question).catch(() => null) : null;
  if (!vec || vec.length === 0) {
    return {
      verdict: 'no_qualified_responder',
      qualified: [],
      snapshot: { ...base, candidates: [], degraded: 'embed-unavailable' },
      queryVec: null,
    };
  }

  const sql = deps.getSql();
  const qVec = JSON.stringify(vec);

  // 1) Top-K turns by cosine similarity over the cross-agent transcript index.
  //    - `workspace_id = $ws OR 'default'`: the operational corpus lives at
  //      'default' (the session ingesters are workspace-blind); this is the
  //      same predicate the session_turn SearchSource uses.
  //    - machine-surface turns (orient payloads, injected briefs) are excluded:
  //      every agent receives near-identical injected boilerplate, so matches
  //      there measure the injector, not the agent's engagement. NULL verdict
  //      (not yet classified) passes — over-filtering starves the router.
  //    - withIterativeScan: without it the HNSW scan stops at hnsw.ef_search
  //      and silently under-returns (WI-37603).
  const turnRows = (await withIterativeScan(sql as never, (s) => (s as unknown as Sql)`
    SELECT owner, session_id, turn_idx,
           COALESCE(ts, ingested_at) AS ts,
           1 - (text_embedding <=> ${qVec}::vector) AS sim
      FROM harness_shared.session_turns
     WHERE (workspace_id = ${params.workspaceId} OR workspace_id = 'default')
       AND text_embedding IS NOT NULL
       AND owner IS NOT NULL
       AND owner <> ALL(${[params.requesterId, ...(params.excludeOwners ?? [])]}::text[])
       AND (turn_origin_verdict IS NULL OR turn_origin_verdict <> 'machine-surface')
  ORDER BY text_embedding <=> ${qVec}::vector
     LIMIT ${turnLimit}
  `)) as unknown as Array<{
    owner: string;
    session_id: string;
    turn_idx: number;
    ts: string | Date | null;
    sim: number;
  }>;

  if (turnRows.length === 0) {
    return {
      verdict: 'no_qualified_responder',
      qualified: [],
      snapshot: { ...base, candidates: [] },
      queryVec: vec,
    };
  }

  // 2) Aggregate per owner: max similarity, newest evidence turn, top evidence.
  const byOwner = new Map<string, { sims: number[]; newestTs: number | null; evidence: TurnEvidence[] }>();
  for (const r of turnRows) {
    let o = byOwner.get(r.owner);
    if (!o) {
      o = { sims: [], newestTs: null, evidence: [] };
      byOwner.set(r.owner, o);
    }
    const sim = Number(r.sim);
    o.sims.push(sim);
    const tsMs = r.ts ? new Date(r.ts as string).getTime() : null;
    if (tsMs !== null && (o.newestTs === null || tsMs > o.newestTs)) o.newestTs = tsMs;
    if (o.evidence.length < evidencePerOwner) {
      o.evidence.push({
        session_id: r.session_id,
        turn_idx: r.turn_idx,
        ts: tsMs !== null ? new Date(tsMs).toISOString() : null,
        sim,
      });
    }
  }
  const owners = [...byOwner.keys()];

  // 3) Verification: committed completions in the last 90 days per owner.
  //    authority='committed' is the evidence-backed close — a bare "done"
  //    assertion lands 'proposed' and does not count (D-002: earned, not
  //    asserted).
  //
  //    ⚠ The column is `authority`, NOT `completion_authority`, and the date
  //    column is `closed_ts` (bigint epoch-ms), NOT `closed_at` (EI-20816404371786180).
  //    Both wrong names were live here and killed EVERY consult:get_feedback call
  //    with `column "completion_authority" does not exist` — which, because the
  //    acceptance-rubric VETTING gate requires a consult, meant no plan in the
  //    workspace could ship. The name is misleading on purpose-of-record:
  //    678-rename-authority-to-completion-authority.sql is named for that rename
  //    but is COMMENT-ONLY — the rename was ABANDONED (D-009), because the column
  //    is exposed through the consolidated views and is therefore rename-proof.
  //    Do not "restore" the longer name here; change the schema first or not at all.
  //    (`closed_at` DOES exist on harness_shared.consult_state — that is why the
  //    other consult modules use it correctly and only this query was wrong.)
  const verRows = (await sql`
    SELECT terminal_owner AS owner, count(*)::int AS c
      FROM harness_shared.work_items
     WHERE terminal_owner = ANY(${owners}::text[])
       AND authority = 'committed'
       AND closed_ts >= ${now.getTime() - 90 * 24 * 3600 * 1000}
  GROUP BY terminal_owner
  `) as unknown as Array<{ owner: string; c: number }>;
  const verByOwner = new Map(verRows.map((r) => [r.owner, r.c]));

  // 4) Authorship: only when the question names code paths. Matches the
  //    candidate owners' completed work-items' recorded paths.
  const pathTokens = extractPathTokens(params.question);
  const authByOwner = new Map<string, number>();
  if (pathTokens.length > 0) {
    const patterns = pathTokens.map((t) => `%${t}%`);
    const authRows = (await sql`
      SELECT terminal_owner AS owner, count(DISTINCT feature_id)::int AS c
        FROM harness_shared.work_items w,
             LATERAL jsonb_array_elements_text(w.payload->'paths') AS p(path)
       WHERE terminal_owner = ANY(${owners}::text[])
         AND jsonb_typeof(w.payload->'paths') = 'array'
         AND p.path ILIKE ANY(${patterns}::text[])
    GROUP BY terminal_owner
    `) as unknown as Array<{ owner: string; c: number }>;
    for (const r of authRows) authByOwner.set(r.owner, r.c);
  }

  // 5) Liveness annotation (never a gate here — D-008 §5).
  let livenessByOwner: Record<string, string> = {};
  if (deps.getLiveness) {
    livenessByOwner = await deps.getLiveness(owners).catch(() => ({}));
  }

  // 6) Blend.
  const candidates: RoutingCandidate[] = owners.map((ownerId) => {
    const o = byOwner.get(ownerId)!;
    const similarity = clamp01(Math.max(...o.sims));
    const ageDays = o.newestTs === null ? Infinity : (now.getTime() - o.newestTs) / 86_400_000;
    const recency = o.newestTs === null ? 0 : clamp01(Math.pow(2, -ageDays / RECENCY_HALF_LIFE_DAYS));
    const c = verByOwner.get(ownerId) ?? 0;
    const verification = clamp01(c / (c + VERIFICATION_SATURATION_K));
    const authorship = clamp01((authByOwner.get(ownerId) ?? 0) / 2);
    const score = clamp01(
      weights.similarity * similarity +
        weights.recency * recency +
        weights.verification * verification +
        weights.authorship * authorship,
    );
    return {
      ownerId,
      score,
      signals: { similarity, recency, verification, authorship },
      evidence: o.evidence,
      liveness: livenessByOwner[ownerId] ?? 'unknown',
    };
  });
  candidates.sort((a, b) => b.score - a.score);
  const snapshotCandidates = candidates.slice(0, maxCandidates);

  const qualified = snapshotCandidates
    .filter((cand) => cand.signals.similarity >= simFloor && cand.score >= floor)
    .slice(0, maxQualified);

  return {
    verdict: qualified.length > 0 ? 'routed' : 'no_qualified_responder',
    qualified,
    snapshot: { ...base, candidates: snapshotCandidates },
    queryVec: vec,
  };
}
