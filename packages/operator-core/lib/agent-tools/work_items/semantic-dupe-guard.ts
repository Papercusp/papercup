/**
 * semantic-dupe-guard — the P-008 dedup-on-create prescreen
 * (shared-embedding-sidecar-and-enrichment-2026-07-10).
 *
 * The 2026-07-10 bug-storm filed ~30 near-identical OPEN issues
 * (WI-3358..WI-3477) that the lexical mirror-guard (EI-316) could not catch:
 * each title was worded differently, so no id was embedded and no tsquery
 * matched. This guard embeds the NEW item's title+summary as a DOCUMENT (the
 * exact space + prompt the embed-backfill sweep stores the ledger in —
 * doc↔doc cosine, resolveBackfillEmbedder) and ranks it against OPEN items'
 * migration-551 vectors:
 *
 *   similarity ≥ hard (default 0.93) → the create is REFUSED
 *     (`duplicate_semantic`, force:true overrides — same contract as EI-316);
 *   similarity ≥ soft (default 0.85) → the create PROCEEDS, and the soft band is
 *     PERSISTED as similarity edges for the promoter (work-queue-admission-and-bulk-
 *     dedup-2026-08-24 D-010) rather than returned to the filer as an advisory. The
 *     hard band still ships as `similarOpen[]` on the REFUSAL, where it names the
 *     item the caller should work instead.
 *
 * FAIL-OPEN is the prime directive: a create must never be blocked by embedder
 * health. Any error, a missing migration, a dims mismatch (harrier@1024), or
 * the ~2.5s budget expiring all return null ("no verdict") and the create
 * proceeds silently. Under vitest the guard is inert unless deps are injected
 * (the real resolver lazy-loads an ONNX model — the WI-3792 load-scar class).
 *
 * Kill switch: PAPERCUSP_WI_SEMANTIC_DUPE=off. Threshold overrides:
 * PAPERCUSP_WI_DUPE_HARD / PAPERCUSP_WI_DUPE_SOFT (0..1]. Defaults chosen from
 * the gemma bake-off's rejection-margin geometry (P-006) — calibrate against
 * the backfilled dupe-storm rows before tightening.
 */
import { getOrgPg } from '@papercusp/db-org';
import { issuesScopeWorkspace } from '../../issues-engineer';
import { activeWorkspaceId } from '../../workspace-registry';
import { ALL_TERMINAL_STATUSES } from '../../work-item-blocking';
import { withIterativeScan } from '../search/hnsw-iterative-scan';

// The prose column width contract — ONE source, not a restated `384` (D-005 §5).
import { fitsProseColumns } from '../../search/prose-vector-dims';
/**
 * CALIBRATION — MEASURED 2026-08-12 (WI-38056, plan luna-audit-fixes-2026-08-12
 * D-002). Re-tune only against a fresh measurement; the numbers below are not
 * taste, and the previous defaults were wrong in BOTH directions.
 *
 * Population: 200 agent-filed (`filedByRole:'su'`), non-templated
 * `engineer_issues` from a 6-day window — templated watchdog filings ("Test
 * failing repeatedly: <path>", "Hive canary … breached") are excluded because
 * they legitimately have near-identical siblings and, left in, they inflate the
 * corpus baseline from 0.867 to 0.953 and make every threshold below look safe.
 *
 *   mean nearest-neighbour cosine in this corpus ....... 0.867
 *   six KNOWN duplicate pairs (close evidence names the
 *     survivor) score ................................. 0.861 – 0.892
 *   four flagged-but-DISTINCT pairs score .............. 0.857 – 0.868
 *
 * Those ranges OVERLAP — a distinct pair at 0.8677 outscores a real duplicate at
 * 0.8613 — so COSINE ALONE CANNOT SEPARATE DUPLICATES FROM DISTINCT FILINGS in
 * this corpus, at any cut. Two consequences, both load-bearing:
 *
 *  - SOFT was 0.85, i.e. BELOW the corpus mean: it flagged a "possible duplicate"
 *    on 126/200 = 63% of filings. An advisory that fires on two thirds of
 *    everything is noise, and it trains agents to skip the block entirely. 0.90
 *    fires on 42/200 = 21% and actually means "unusually similar for this corpus".
 *  - HARD stays 0.93 because it is the only defensible PURE-cosine refusal, but
 *    note what it cannot do: every one of the six known duplicates scores below
 *    it, so this threshold has never refused a real duplicate. DO NOT "fix" that
 *    by lowering HARD into the 0.86–0.89 overlap — that is where distinct
 *    filings live too, and it would refuse legitimate work at scale.
 *
 * The duplicates that actually cost the fleet (~12% of one 154-close drain) are
 * same-subsystem re-filings worded differently — semantically ordinary, but with
 * visibly similar TITLES. That is what CO_SIGNAL below is for.
 */
const DEFAULT_HARD = 0.93;
const DEFAULT_SOFT = 0.9;
/**
 * The co-signal refusal: cosine in the ordinary band is not evidence, but cosine
 * AND a similar title together are. Measured on the same 200-item population,
 * `cosine >= 0.86 AND pg_trgm title similarity >= 0.45` fires on 14/200 = 7% of
 * filings, catches 4 of the 6 known duplicate pairs (their title similarities:
 * 0.509, 0.514, 0.521, 0.551), and fires on NONE of the four flagged-but-distinct
 * pairs (whose title similarities top out at 0.210).
 *
 * Recall is deliberately traded for precision. A false refusal blocks real work
 * and teaches agents to pass `force: true` reflexively, which would destroy the
 * gate for the cases it exists to catch.
 *
 * The title metric is pg_trgm `similarity()`, computed in SQL beside the cosine
 * (see queryCandidatesReal) — NOT a hand-rolled word-overlap score. The 0.45 cut
 * was calibrated against pg_trgm specifically and does not transfer to another
 * metric.
 */
const CO_SIGNAL_MIN_COSINE = 0.86;
const CO_SIGNAL_MIN_TITLE = 0.45;
/** Whole-prescreen budget (embed + both queries). A warm sidecar answers in
 *  ~10ms; a cold in-process model load (~2.8s) simply forfeits THIS create's
 *  verdict while the model warms for the next one. */
const BUDGET_MS = 2500;
/** Top-k per family ("top-3 vs OPEN items"); the single base-table query
 *  takes 2× since it spans both families. */
const TOP_K = 3;

export interface SemanticDupeCandidate {
  id: string;
  title: string;
  state: string;
  harness: string | null;
  /** Cosine similarity (1 − pgvector `<=>` distance) in the active space, OR — when
   *  `source: 'lexical-recent'` — a Jaccard word-overlap score (recent-lexical-dupe-guard,
   *  EI-9940). Both are 0..1; the `source` tag disambiguates which. */
  similarity: number;
  /** Which prescreen produced this candidate. Unset = the original embedding-based
   *  P-008 guard (kept optional so no existing caller/test needs to change).
   *  'lexical-fulltext' = EI-19298062354262754's reuse of improvements:capture's
   *  own full-text search-first dedup (fulltext-lexical-dupe-guard.ts). */
  source?: 'lexical-recent' | 'lexical-fulltext';
  /** pg_trgm `similarity()` between the new title and this candidate's, 0..1.
   *  Undefined when the caller's `queryCandidates` seam does not supply it —
   *  the co-signal promotion then simply does not apply (fail-open). */
  titleSimilarity?: number;
}

export interface SemanticDupeResult {
  /** ≥ hard threshold — refuse the create unless force:true. */
  hard: SemanticDupeCandidate[];
  /** ≥ soft, < hard — create proceeds; persisted to `dedup_edges` for the promoter
   *  (D-010), not returned to the filing agent. */
  soft: SemanticDupeCandidate[];
  thresholds: { hard: number; soft: number };
}

/** Injectable seams (tests + any future non-backfill space). */
export interface SemanticDupeDeps {
  resolveEmbedder: () => Promise<
    | { mode: string; dims: number; embed: (t: string) => Promise<number[]> }
    | { mode: 'disabled'; reason?: string }
    | null
  >;
  /** `title` is the NEW item's title, passed so the query can score pg_trgm title
   *  similarity in SQL alongside the cosine. Optional 4th arg: existing seams that
   *  ignore it keep working, they just forfeit the co-signal promotion. */
  queryCandidates: (vec: number[], mode: string, harness?: string, title?: string) => Promise<SemanticDupeCandidate[]>;
}

function threshold(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : dflt;
}

export function dupeThresholds(): { hard: number; soft: number } {
  return {
    hard: threshold(process.env.PAPERCUSP_WI_DUPE_HARD, DEFAULT_HARD),
    soft: threshold(process.env.PAPERCUSP_WI_DUPE_SOFT, DEFAULT_SOFT),
  };
}

/** Resolve-null on timeout, never reject — the budget IS the fail-open. */
function withBudget<T>(ms: number, p: Promise<T | null>): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    (t as unknown as { unref?: () => void }).unref?.();
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(null); },
    );
  });
}

export async function queryCandidatesReal(vec: number[], mode: string, harness?: string, title?: string): Promise<SemanticDupeCandidate[]> {
  const { sql } = getOrgPg();
  const vecLit = `[${vec.join(',')}]`;
  // ONE query covers BOTH families: migration 374 unified issues + features
  // into harness_shared.work_items (the compat views project from it), and
  // migration 551's embedding columns live on that base. `status` holds the
  // family's own vocabulary, so "open" = not in the cross-family terminal set.
  // Issue rows live in the coord workspace, feature rows in the project one —
  // admit both.
  const terminal = [...ALL_TERMINAL_STATUSES];
  const workspaces = [...new Set([issuesScopeWorkspace(), activeWorkspaceId()])];
  const rows = await withIterativeScan(sql, (scanSql) => scanSql<Array<{ id: string; title: string; state: string; harness_slug: string; similarity: number; title_similarity: number | null }>>`
    SELECT feature_id AS id, COALESCE(title, '') AS title, COALESCE(status, 'todo') AS state, harness_slug,
           1 - (embedding <=> ${vecLit}::vector) AS similarity,
           -- Scored HERE, in pg_trgm, because the co-signal threshold was
           -- calibrated against pg_trgm similarity() and does not transfer to a
           -- hand-rolled word-overlap score.
           ${title ? scanSql`similarity(COALESCE(title, ''), ${title})` : scanSql`NULL::real`} AS title_similarity
      FROM harness_shared.work_items
     WHERE workspace_id = ANY(${workspaces}::text[])
       AND embedding IS NOT NULL
       AND embedding_mode = ${mode}
       AND (status IS NULL OR NOT (status = ANY(${terminal}::text[])))
       AND ${harness ? scanSql`harness_slug = ${harness}` : scanSql`TRUE`}
     ORDER BY embedding <=> ${vecLit}::vector
     LIMIT ${TOP_K * 2}`);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    state: r.state,
    harness: r.harness_slug || null,
    similarity: Number(r.similarity),
    ...(r.title_similarity === null || r.title_similarity === undefined
      ? {}
      : { titleSimilarity: Number(r.title_similarity) }),
  }));
}

const realDeps: SemanticDupeDeps = {
  // The DOCUMENT-side resolver the backfill sweep stores with — the one seam
  // that guarantees the new item and the stored ledger share space AND prompt.
  resolveEmbedder: async () => (await import('../../search/embed-backfill')).resolveBackfillEmbedder(),
  queryCandidates: queryCandidatesReal,
};

async function classify(d: SemanticDupeDeps, input: { title: string; summary?: string; harness?: string }): Promise<SemanticDupeResult | null> {
  const resolved = await d.resolveEmbedder();
  if (!resolved || resolved.mode === 'disabled' || !('embed' in resolved)) return null;
  if (!fitsProseColumns(resolved.dims)) return null; // dims-ineligible for the prose columns (harrier@1024, local@384) — no verdict possible
  // Mirror the stored shape exactly (TARGETS bodySql: title || '\n' || left(body, 2000)).
  const vec = await resolved.embed(`${input.title}\n${(input.summary ?? '').slice(0, 2000)}`);
  if (!fitsProseColumns(vec.length)) return null;
  const candidates = await d.queryCandidates(vec, resolved.mode, input.harness, input.title);
  const t = dupeThresholds();
  const sorted = [...candidates].sort((a, b) => b.similarity - a.similarity);
  // The co-signal (see CO_SIGNAL_* above): an ordinary cosine plus a genuinely
  // similar TITLE is the shape the fleet's real duplicates take. Cosine alone in
  // this band is the corpus average and means nothing, so neither half refuses
  // on its own. A candidate whose seam supplied no titleSimilarity is unaffected.
  const isCoSignalDupe = (c: SemanticDupeCandidate): boolean =>
    c.similarity >= CO_SIGNAL_MIN_COSINE &&
    typeof c.titleSimilarity === 'number' &&
    c.titleSimilarity >= CO_SIGNAL_MIN_TITLE;
  const isHard = (c: SemanticDupeCandidate): boolean => c.similarity >= t.hard || isCoSignalDupe(c);
  return {
    hard: sorted.filter(isHard),
    soft: sorted.filter((c) => !isHard(c) && c.similarity >= t.soft),
    thresholds: t,
  };
}

/**
 * Prescreen a new work-item against OPEN items by cosine similarity.
 * Returns null for "no verdict" (disabled, unavailable, timed out, errored) —
 * the caller MUST treat null as "proceed with the create".
 */
export async function findSemanticDupes(
  input: { title: string; summary?: string; harness?: string },
  deps?: SemanticDupeDeps,
): Promise<SemanticDupeResult | null> {
  if (process.env.PAPERCUSP_WI_SEMANTIC_DUPE === 'off') return null;
  // Inert under vitest unless a test injects deps: the real resolver
  // lazy-loads an ONNX model, which unrelated tool tests must never pay.
  if (process.env.VITEST && !deps) return null;
  try {
    return await withBudget(BUDGET_MS, classify(deps ?? realDeps, input));
  } catch {
    return null;
  }
}
