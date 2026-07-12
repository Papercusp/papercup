/**
 * recent-lexical-dupe-guard — a cheap, embedding-INDEPENDENT complement to the P-008
 * semantic-dupe-guard (EI-9940, filed off the 2026-07-12 WI-4241/WI-4242 incident).
 *
 * The WI-4242 case: L1 reported a create failure, self-resolved it a minute later as
 * WI-4241, but the leader (working off the stale failure report) created a duplicate
 * WI-4242 five minutes on. semantic-dupe-guard's query filters `embedding IS NOT NULL`
 * — the embed-backfill sweep that populates it is ASYNC, so a row created moments ago
 * (like WI-4241 at create time) is *structurally invisible* to that guard regardless of
 * threshold tuning. This guard closes exactly that gap: instead of cosine similarity
 * over vectors, it does word-overlap (Jaccard) over RECENTLY-created OPEN titles in the
 * same harness — no embedding required, so it has no indexing lag.
 *
 * STRICTLY ADVISORY — unlike the semantic guard's hard band, this NEVER refuses a
 * create (word-overlap on this repo's long, jargon-dense titles is too coarse a signal
 * to safely block on; two genuinely distinct items routinely share "WI-4070" / "p2p" /
 * "tower" tokens). A match is only ever surfaced via the same `similarOpen` advisory
 * field the semantic guard uses, tagged `source: 'lexical-recent'`.
 *
 * FAIL-OPEN, same contract as semantic-dupe-guard: any DB error, timeout, or the kill
 * switch returns null ("no verdict") — the caller proceeds silently. Kill switch:
 * PAPERCUSP_WI_RECENT_DUPE=off. Overrides: PAPERCUSP_WI_RECENT_DUPE_WINDOW_MIN (default
 * 10), PAPERCUSP_WI_RECENT_DUPE_THRESHOLD (default 0.5, Jaccard 0..1).
 */
import { getOrgPg } from '@papercusp/db-org';
import { issuesScopeWorkspace } from '../../issues-engineer';
import { activeWorkspaceId } from '../../workspace-registry';
import { ALL_TERMINAL_STATUSES } from '../../work-item-blocking';
import type { SemanticDupeCandidate } from './semantic-dupe-guard';

const DEFAULT_WINDOW_MIN = 10;
const DEFAULT_THRESHOLD = 0.5;
/** Cheap single indexed query — generous but bounded, mirrors semantic-dupe-guard's BUDGET_MS. */
const BUDGET_MS = 1500;
/** Cap the candidate scan so a busy harness never pays an unbounded comparison cost. */
const CANDIDATE_LIMIT = 50;
/** Surface at most this many advisory matches. */
const TOP_K = 3;
/** Tokens shorter than this, or in this domain-generic stopword set, don't count toward
 *  overlap — otherwise two unrelated titles that both happen to say "the fix for the"
 *  would look similar. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are',
  'this', 'that', 'it', 'its', 'be', 'as', 'at', 'by', 'from', 'into', 'via', 'not',
  'no', 'do', 'does', 'did', 'has', 'have', 'had', 'was', 'were', 'will', 'would',
]);

export interface RecentDupeCandidateRow {
  id: string;
  title: string;
  state: string;
  harness: string | null;
}

/** Injectable seam (tests + any future non-work_items space). */
export interface RecentLexicalDupeDeps {
  queryRecentOpenItems: (windowMin: number, harness?: string) => Promise<RecentDupeCandidateRow[]>;
}

function threshold(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : dflt;
}

function windowMinutes(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export function recentDupeConfig(): { windowMin: number; threshold: number } {
  return {
    windowMin: windowMinutes(process.env.PAPERCUSP_WI_RECENT_DUPE_WINDOW_MIN, DEFAULT_WINDOW_MIN),
    threshold: threshold(process.env.PAPERCUSP_WI_RECENT_DUPE_THRESHOLD, DEFAULT_THRESHOLD),
  };
}

/** Normalize a title into a comparable token set: lowercase, strip punctuation, drop
 *  short/stopword tokens. Exported for tests. */
export function titleTokens(title: string): Set<string> {
  const words = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean);
  return new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w)));
}

/** Jaccard similarity over two token sets: |intersection| / |union|. 0 when either is empty. */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Resolve-null on timeout, never reject — the budget IS the fail-open (mirrors
 *  semantic-dupe-guard's withBudget). */
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

async function queryRecentOpenItemsReal(windowMin: number, harness?: string): Promise<RecentDupeCandidateRow[]> {
  const { sql } = getOrgPg();
  const terminal = [...ALL_TERMINAL_STATUSES];
  const workspaces = [...new Set([issuesScopeWorkspace(), activeWorkspaceId()])];
  const rows = await sql<Array<{ id: string; title: string; state: string; harness_slug: string }>>`
    SELECT feature_id AS id, COALESCE(title, '') AS title, COALESCE(status, 'todo') AS state, harness_slug
      FROM harness_shared.work_items
     WHERE workspace_id = ANY(${workspaces}::text[])
       AND created_ts >= now() - (${windowMin} || ' minutes')::interval
       AND (status IS NULL OR NOT (status = ANY(${terminal}::text[])))
       AND ${harness ? sql`harness_slug = ${harness}` : sql`TRUE`}
     ORDER BY created_ts DESC
     LIMIT ${CANDIDATE_LIMIT}`;
  return rows.map((r) => ({ id: r.id, title: r.title, state: r.state, harness: r.harness_slug || null }));
}

const realDeps: RecentLexicalDupeDeps = { queryRecentOpenItems: queryRecentOpenItemsReal };

async function classify(
  d: RecentLexicalDupeDeps,
  input: { title: string; harness?: string; excludeId?: string },
): Promise<SemanticDupeCandidate[]> {
  const cfg = recentDupeConfig();
  const rows = await d.queryRecentOpenItems(cfg.windowMin, input.harness);
  const newTokens = titleTokens(input.title);
  const scored = rows
    .filter((r) => r.id !== input.excludeId)
    .map((r) => ({ ...r, similarity: jaccardSimilarity(newTokens, titleTokens(r.title)) }))
    .filter((r) => r.similarity >= cfg.threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, TOP_K);
  return scored.map((r) => ({
    id: r.id,
    title: r.title,
    state: r.state,
    harness: r.harness,
    similarity: r.similarity,
    source: 'lexical-recent' as const,
  }));
}

/**
 * Prescreen a new work-item's title against OPEN items created within the last
 * `windowMin` minutes in the same harness, by word-overlap (no embedding needed).
 * Returns [] for "screened, no dupes" and null for "no verdict" (disabled,
 * timed out, errored) — the caller MUST treat null the same as [] (proceed; this
 * is advisory-only and NEVER blocks a create).
 */
export async function findRecentLexicalDupes(
  input: { title: string; harness?: string; excludeId?: string },
  deps?: RecentLexicalDupeDeps,
): Promise<SemanticDupeCandidate[] | null> {
  if (process.env.PAPERCUSP_WI_RECENT_DUPE === 'off') return null;
  // Inert under vitest unless a test injects deps — mirrors semantic-dupe-guard so
  // unrelated tool tests never pay a real DB round-trip.
  if (process.env.VITEST && !deps) return null;
  try {
    return await withBudget(BUDGET_MS, classify(deps ?? realDeps, input));
  } catch {
    return null;
  }
}
