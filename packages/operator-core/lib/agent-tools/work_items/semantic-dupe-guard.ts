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
 * migration-548 vectors:
 *
 *   similarity ≥ hard (default 0.93) → the create is REFUSED
 *     (`duplicate_semantic`, force:true overrides — same contract as EI-316);
 *   similarity ≥ soft (default 0.85) → the create PROCEEDS with an advisory
 *     `similarOpen[]` on the result.
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
import { harnessScope, harnessOfScope } from '../../work-item-scope';
import { activeWorkspaceId } from '../../workspace-registry';
import { ISSUE_TERMINAL_STATUSES } from '../../work-item-blocking';
import { TERMINAL_STATUSES } from '../../dbos/frontier-readiness';

/** Width of the migration-548 embedding columns (= embed-backfill's EMBEDDER_DIM). */
const EMBED_DIM = 384;
const DEFAULT_HARD = 0.93;
const DEFAULT_SOFT = 0.85;
/** Whole-prescreen budget (embed + both queries). A warm sidecar answers in
 *  ~10ms; a cold in-process model load (~2.8s) simply forfeits THIS create's
 *  verdict while the model warms for the next one. */
const BUDGET_MS = 2500;
/** Top-k per kind-table — the checkpoint's "top-3 vs OPEN items". */
const TOP_K = 3;

export interface SemanticDupeCandidate {
  id: string;
  title: string;
  state: string;
  harness: string | null;
  /** Cosine similarity (1 − pgvector `<=>` distance) in the active space. */
  similarity: number;
}

export interface SemanticDupeResult {
  /** ≥ hard threshold — refuse the create unless force:true. */
  hard: SemanticDupeCandidate[];
  /** ≥ soft, < hard — create proceeds, surfaced as advisory `similarOpen`. */
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
  queryCandidates: (vec: number[], mode: string, harness?: string) => Promise<SemanticDupeCandidate[]>;
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

async function queryCandidatesReal(vec: number[], mode: string, harness?: string): Promise<SemanticDupeCandidate[]> {
  const { sql } = getOrgPg();
  const vecLit = `[${vec.join(',')}]`;
  const issueTerminal = [...ISSUE_TERMINAL_STATUSES];
  const featureTerminal = [...TERMINAL_STATUSES];
  const issues = await sql<Array<{ id: string; title: string; state: string; scope: string; similarity: number }>>`
    SELECT issue_id AS id, COALESCE(title, '') AS title, state, scope,
           1 - (embedding <=> ${vecLit}::vector) AS similarity
      FROM harness_shared.engineer_issues
     WHERE workspace_id = ${issuesScopeWorkspace()}
       AND embedding IS NOT NULL
       AND embedding_mode = ${mode}
       AND NOT (state = ANY(${issueTerminal}::text[]))
       AND ${harness ? sql`scope = ${harnessScope(harness)}` : sql`TRUE`}
     ORDER BY embedding <=> ${vecLit}::vector
     LIMIT ${TOP_K}`;
  const features = await sql<Array<{ id: string; title: string; state: string; harness_slug: string; similarity: number }>>`
    SELECT feature_id AS id, COALESCE(title, '') AS title, COALESCE(status, 'todo') AS state, harness_slug,
           1 - (embedding <=> ${vecLit}::vector) AS similarity
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${activeWorkspaceId()}
       AND embedding IS NOT NULL
       AND embedding_mode = ${mode}
       AND (status IS NULL OR NOT (status = ANY(${featureTerminal}::text[])))
       AND ${harness ? sql`harness_slug = ${harness}` : sql`TRUE`}
     ORDER BY embedding <=> ${vecLit}::vector
     LIMIT ${TOP_K}`;
  return [
    ...issues.map((r) => ({
      id: r.id, title: r.title, state: r.state,
      harness: harnessOfScope(r.scope), similarity: Number(r.similarity),
    })),
    ...features.map((r) => ({
      id: r.id, title: r.title, state: r.state,
      harness: r.harness_slug, similarity: Number(r.similarity),
    })),
  ];
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
  if (resolved.dims !== EMBED_DIM) return null; // harrier@1024 — no vector(384) verdict possible
  // Mirror the stored shape exactly (TARGETS bodySql: title || '\n' || left(body, 2000)).
  const vec = await resolved.embed(`${input.title}\n${(input.summary ?? '').slice(0, 2000)}`);
  if (vec.length !== EMBED_DIM) return null;
  const candidates = await d.queryCandidates(vec, resolved.mode, input.harness);
  const t = dupeThresholds();
  const sorted = [...candidates].sort((a, b) => b.similarity - a.similarity);
  return {
    hard: sorted.filter((c) => c.similarity >= t.hard),
    soft: sorted.filter((c) => c.similarity >= t.soft && c.similarity < t.hard),
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
