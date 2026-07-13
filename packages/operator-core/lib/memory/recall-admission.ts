/**
 * recall-admission.ts — the gates a recall hit must pass to REACH a consumer (EI-10666).
 *
 * A backend `search()` returning rows does not mean an agent received anything. Between the
 * store and the agent sit three gates, each of which can discard a hit:
 *
 *   backend rows → [relevance floor] → [queen-loop withhold] → [aggregate char budget] → admitted
 *
 * **A GATE'S DECISION IS NOT AN EVENT.** Probing what the backend *returned* tells you nothing
 * about what the consumer *received* — the failure the memory recall canary exists to catch can
 * live entirely in the decision made about a perfectly healthy retrieval. That is not
 * hypothetical: EI-10372 was exactly this. The backend returned 5 rows, orient's relevance floor
 * discarded all 5, and every agent's recall fold was silently EMPTY (`hits: []`,
 * `filteredLowScore: 5`) while `search`'s own metrics looked fine.
 *
 * WHY THIS IS A SHARED MODULE AND NOT A COPY: the canary must probe THE PATH THE CONSUMER
 * ACTUALLY TAKES. A canary that re-implements these gates is testing a pipeline nobody runs —
 * it would drift from the real one and go green while production went dark, which is the very
 * class of defect it exists to detect (see agent-insights/prove-it-discriminates-before-it-acts,
 * Shape 4). So `orient` and `recall-canary` call THIS function, and there is exactly one of it.
 *
 * Pure: no I/O, no imports of the tool/coordination layer. The queen-loop withhold is INJECTED
 * (`withhold`) rather than imported, both to keep this module dependency-free and because it is
 * a caller-policy filter, not a property of recall.
 */
import type { GateDecision } from '../gates/decision';

/**
 * The minimum shape a hit needs to run the gates. Callers keep their own richer types (the
 * generic preserves them through admission).
 *
 * `id`/`score` are `unknown` on purpose: these hits arrive off the wire from `memory:search`, so
 * neither is guaranteed. The gates below typeof-CHECK before they compare — a hit with a
 * non-numeric score must FAIL OPEN (admitted), never be silently floored on a bad cast.
 */
export interface AdmissibleHit {
  id?: unknown;
  memory?: string;
  score?: unknown;
}

/**
 * D-008 COMPACT bound: per-hit text cap in the folded payload. It lives here, with the gates,
 * because the char BUDGET below is charged against the TRUNCATED text — anything modelling what
 * a consumer receives (the canary) has to truncate identically or its costs, and therefore its
 * recall@10, silently drift from the real fold.
 */
export const MEMORY_TEXT_CAP = 200;

/**
 * P-004 (fleet-member-dx, EI-9017): drop near-zero-relevance hits — a degraded embedder (quota
 * outage → lexical fallback) returns hits scored 0.01–0.03 that are pure noise yet still cost
 * fold tokens on EVERY orient. A hit with NO numeric score passes (fail-open).
 *
 * ⚠ DEGRADED-REGIME ONLY (orient-recall-quality-2026-07-12). A HEALTHY hybrid response returns
 * RRF rank-fusion scores on the SAME 0.01–0.03 band (rank-1 both-legs ≈ 2/61 ≈ 0.0328 — a STRONG
 * hit), so this floor applies ONLY when the response carries the EI-9031 `degraded` marker. A
 * blanket value floor silently emptied orient's entire fold on hybrid configs. Anything that
 * applies this floor unconditionally — including a canary modelling the consumer — re-creates
 * EI-10372 wherever it runs.
 */
export const MEMORY_SCORE_FLOOR = 0.05;

/**
 * P-002 (orient-recall-quality-2026-07-12): AGGREGATE char budget over the folded hits — the belt
 * over the count(≤10) × per-hit(200) caps, so N unusually-large hits can't compound. Admission is
 * in relevance order and the FIRST hit is ALWAYS admitted (a budget smaller than one hit must not
 * blank the fold — which is why the budget alone can never produce a zero-hit). Env-tunable;
 * `<= 0` disables.
 */
export function orientMemoryBudgetChars(): number {
  const raw = Number(process.env.PAPERCUSP_ORIENT_MEMORY_BUDGET_CHARS);
  if (Number.isFinite(raw)) return raw > 0 ? raw : Number.POSITIVE_INFINITY;
  return 1_600;
}

/**
 * P-008 (WI-4538): near-duplicate COLLAPSE. A limited recall budget was being spent on the
 * SAME fact under multiple ids — coord:orient returned one owner directive 3× (ids
 * f928834a/a88e504f/b048739a) and claim-recall returned the "save the age benchmark"
 * directive twice verbatim (dd421ac7/8b5a6542) — crowding distinct facts out of the budget
 * and then reporting "the memory budget is full". This is a READ-SIDE collapse: no store
 * mutation, fully reversible via the threshold, run BEFORE the budget so a dupe never eats a
 * slot. TEXT-based on purpose — this module is pure (no embeddings) and the dominant real
 * case is verbatim / near-verbatim repetition. The HIGHEST-RANKED copy of each cluster
 * survives (callers pass hits in relevance order), so collapsing only ever drops a
 * lower-ranked near-identical twin.
 */
export const MEMORY_DEDUP_JACCARD_DEFAULT = 0.82;

/**
 * Word-token Jaccard threshold for the FUZZY near-duplicate test. Exact-normalized-equality
 * ALWAYS collapses regardless of this (an identical memory under two ids is pure waste); the
 * threshold gates only the paraphrase case. Env `PAPERCUSP_ORIENT_MEMORY_DEDUP_JACCARD`; set
 * `>= 1` to keep ONLY exact-equality collapse (fuzzy off), never below the conservative
 * default without evidence (a low threshold risks collapsing distinct owner directives that
 * share boilerplate).
 */
export function orientMemoryDedupThreshold(): number {
  const raw = Number(process.env.PAPERCUSP_ORIENT_MEMORY_DEDUP_JACCARD);
  return Number.isFinite(raw) ? raw : MEMORY_DEDUP_JACCARD_DEFAULT;
}

/** Normalize for comparison: lowercase, collapse whitespace, trim. */
export function normalizeForDedup(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenSetOf(norm: string): Set<string> {
  return new Set(norm.split(' ').filter(Boolean));
}

/** Word-token Jaccard similarity in [0,1]. Two empty token sets are identical (1). */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const t of small) if (large.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Near-duplicate iff normalized texts are EQUAL, or their word-token Jaccard ≥ threshold. */
export function isNearDuplicateText(a: string, b: string, threshold = MEMORY_DEDUP_JACCARD_DEFAULT): boolean {
  const na = normalizeForDedup(a);
  const nb = normalizeForDedup(b);
  if (na === nb) return true;
  return jaccardSimilarity(tokenSetOf(na), tokenSetOf(nb)) >= threshold;
}

interface DedupNorm { norm: string; tokens: Set<string> }
function matchesNorm(prev: DedupNorm, norm: string, tokens: Set<string>, threshold: number): boolean {
  if (prev.norm === norm) return true; // exact-equal always collapses (threshold-independent)
  return jaccardSimilarity(prev.tokens, tokens) >= threshold;
}

/**
 * Collapse near-duplicate items, keeping the FIRST of each cluster (callers pass items in
 * relevance/priority order, so the best copy survives). Empty-text items are never collapsed.
 * Pure — SHARED by orient's admitRecallHits and the launch/claim buildLaunchMemoryBlock, so a
 * fix here lowers the budget waste on every recall surface at once. Returns the kept items
 * plus the indices (into the input) that were dropped, for per-item decision logging.
 */
export function collapseNearDuplicates<T>(
  items: readonly T[],
  getText: (item: T) => string,
  threshold: number = orientMemoryDedupThreshold(),
): { kept: T[]; droppedIndices: number[] } {
  const kept: T[] = [];
  const norms: DedupNorm[] = [];
  const droppedIndices: number[] = [];
  items.forEach((item, i) => {
    const text = getText(item) ?? '';
    if (text.length === 0) {
      kept.push(item);
      return;
    }
    const norm = normalizeForDedup(text);
    const tokens = tokenSetOf(norm);
    if (norms.some((p) => matchesNorm(p, norm, tokens, threshold))) {
      droppedIndices.push(i);
      return;
    }
    kept.push(item);
    norms.push({ norm, tokens });
  });
  return { kept, droppedIndices };
}

export interface AdmitRecallOpts<H> {
  /** The EI-9031 `degraded` marker from the recall response — REGIME-SCOPES the floor. */
  degraded?: boolean;
  /** Aggregate char budget; defaults to {@link orientMemoryBudgetChars}. */
  budgetChars?: number;
  /**
   * Caller-policy filter applied AFTER the floor and BEFORE the budget (orient passes the
   * queen-loop control withhold). Default: withhold nothing.
   */
  withhold?: (hits: H[]) => { kept: H[]; withheld: unknown[] };
  /**
   * P-008: word-token Jaccard threshold for the near-duplicate collapse. Defaults to
   * {@link orientMemoryDedupThreshold}. Exact-equal hits always collapse regardless.
   */
  dedupeThreshold?: number;
}

export interface AdmissionResult<H> {
  /** What the consumer ACTUALLY receives. The only number an alarm should read. */
  admitted: H[];
  /** Discarded by the relevance floor (degraded regime only). */
  filteredLowScore: number;
  /** Discarded by the caller-policy withhold. */
  withheld: number;
  /** Discarded by the P-008 near-duplicate collapse (the same fact under multiple ids). */
  collapsedDuplicates: number;
  /** Discarded by the aggregate char budget. */
  withheldBudget: number;
  /**
   * EI-10619 — what each gate DECIDED, as events. Returned rather than emitted, so this module
   * stays pure: a gate that had to `await` a telemetry write would be a gate whose decision depends
   * on the telemetry being up. The caller ships these (`recordGateDecisions`, fire-and-forget).
   *
   * Note which gate declares `discriminates`: ONLY the floor. The withhold and the budget may
   * legitimately never fire, and declaring that is what stops the detector from alarming on them
   * forever — see gates/decision.ts.
   */
  decisions: GateDecision[];
}

/**
 * Run the consumer-admission gates over raw recall hits, in the order a consumer applies them.
 * Every discard is COUNTED and returned — a gate that drops a hit silently is how a blackout
 * hides as health.
 */
export function admitRecallHits<H extends AdmissibleHit>(
  rawHits: readonly H[],
  opts: AdmitRecallOpts<H> = {},
): AdmissionResult<H> {
  const decisions: GateDecision[] = [];
  const subjectOf = (h: H): string | null => (typeof h.id === 'string' ? h.id : null);

  // Gate 1 — relevance floor, degraded regime ONLY (see MEMORY_SCORE_FLOOR).
  //
  // The floor only RUNS in the degraded regime, so it only DECIDES there. Emitting a healthy-regime
  // "pass" for a gate that was never consulted would be a lie in the decision log — and would mask
  // exactly the state the log exists to reveal (a floor that admits nothing when it does run).
  const floored: H[] = [];
  for (const h of rawHits) {
    if (!opts.degraded) {
      floored.push(h);
      continue;
    }
    const scored = typeof h.score === 'number';
    const pass = !scored || (h.score as number) >= MEMORY_SCORE_FLOOR; // no score ⇒ fail-open
    decisions.push({
      gate: 'orient.recall.relevance-floor',
      expect: 'discriminates', // it exists to SEPARATE noise from signal; one-sided ⇒ EI-10372
      verdict: pass ? 'pass' : 'reject',
      value: scored ? (h.score as number) : null,
      threshold: MEMORY_SCORE_FLOOR,
      subject: subjectOf(h),
    });
    if (pass) floored.push(h);
  }
  const filteredLowScore = rawHits.length - floored.length;

  // Gate 2 — caller policy (orient: queen-loop control items to a responsive caller).
  const { kept, withheld } = opts.withhold
    ? opts.withhold(floored)
    : { kept: floored, withheld: [] as unknown[] };
  const keptSet = new Set(kept);
  for (const h of floored) {
    decisions.push({
      gate: 'orient.recall.queen-loop-withhold',
      expect: 'guards', // most callers are not queen loops — never withholding is HEALTHY
      verdict: keptSet.has(h) ? 'pass' : 'reject',
      subject: subjectOf(h),
    });
  }

  // Gate 3 — aggregate char budget, relevance order, first hit always admitted.
  const budget = opts.budgetChars ?? orientMemoryBudgetChars();
  const admitted: H[] = [];
  let spentChars = 0;
  for (const h of kept) {
    const cost = (h.memory?.length ?? 0) + (typeof h.id === 'string' ? h.id.length : 8) + 24;
    const over = admitted.length > 0 && spentChars + cost > budget;
    decisions.push({
      gate: 'orient.recall.char-budget',
      expect: 'guards', // a fold under budget trims nothing — never firing is HEALTHY
      verdict: over ? 'reject' : 'pass',
      value: spentChars + cost, // the cost this hit WOULD bring the fold to
      threshold: Number.isFinite(budget) ? budget : null,
      subject: subjectOf(h),
    });
    if (over) break;
    admitted.push(h);
    spentChars += cost;
  }

  return {
    admitted,
    filteredLowScore,
    withheld: withheld.length,
    withheldBudget: kept.length - admitted.length,
    decisions,
  };
}
