/**
 * Loop-wake recipe splice (compaction-continuity-hardening-2026-07-07 P-005c).
 *
 * Recipes exist but are only surfaced at orient — never at the moment of need.
 * A SHORT-form loop wake (P-001b) is exactly that moment: the agent is about to
 * execute its checkpoint's next action, and a recipe that already does it saves
 * the hand-rolled loop. This module finds the ONE recipe worth naming and
 * renders the one-liner the short wake form splices in.
 *
 * The match uses the RAW pgvector cosine (1 − distance) against
 * `harness_shared.code_recipes.embedding` — an ABSOLUTE 0..1 score a floor can
 * gate on. Deliberately NOT searchSimilarRecipes: its blended similarity is
 * normalized against the result set's own max, so a text-only query's top hit
 * is pinned at exactly 0.5 regardless of how unrelated it is — useless as a
 * floor. No embedder (quota exhausted / local model missing) ⇒ no splice;
 * the whole path is fail-soft and time-bounded (the fire path must not stall).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

/** Absolute cosine floor a hit must clear to be worth a wake line — below it
 *  the "match" is topical noise that trains agents to ignore the splice. */
export const LOOP_WAKE_RECIPE_SIM_FLOOR = 0.6;
/** The fire path budget for the whole lookup (embed + query). */
export const LOOP_WAKE_RECIPE_TIMEOUT_MS = 2500;
/** Query text cap — embedders truncate long inputs anyway; the checkpoint's
 *  next-action head carries the signal. */
const QUERY_CAP = 400;
const TITLE_CAP = 90;

export interface WakeRecipeHit {
  id: string;
  title: string;
  runCount: number;
  /** Raw cosine similarity (1 − pgvector distance), 0..1. */
  sim: number;
}

/**
 * The recipe-search query for this wake: the checkpoint's `## Next action`
 * section (the thing the agent is about to do), else the checkpoint head,
 * else the kickoff's first non-empty line.
 */
export function extractWakeRecipeQuery(
  checkpoint: string | null | undefined,
  kickoff: string,
): string {
  const note = (checkpoint ?? '').trim();
  if (note) {
    const m = /##\s*Next action\s*\n+([\s\S]*?)(?=\n##\s|$)/i.exec(note);
    const next = m?.[1]?.trim();
    if (next) return next.slice(0, QUERY_CAP);
    return note.slice(0, QUERY_CAP);
  }
  const firstLine = kickoff.split('\n').find((l) => l.trim().length > 0) ?? kickoff;
  return firstLine.trim().slice(0, QUERY_CAP);
}

/** The one-liner the short wake form splices (id + runCount, per the P-005 spec). */
export function renderWakeRecipeLine(hit: WakeRecipeHit): string {
  const title = hit.title.length > TITLE_CAP ? `${hit.title.slice(0, TITLE_CAP)}…` : hit.title;
  return (
    `Recipe on point (cosine ${hit.sim.toFixed(2)}): recipes:run { id: '${hit.id}' } — ` +
    `"${title}" (run ${hit.runCount}×). Reuse it over hand-rolling the same steps ` +
    '(recipes:get to inspect first).'
  );
}

export interface FindTopRecipeDeps {
  sql?: Sql;
  /** Test seam; `null` = no embedder available (skip), undefined = build the real one. */
  embedder?: ((text: string) => Promise<number[]>) | null;
  timeoutMs?: number;
}

/**
 * The single best active recipe for `query`, or null when nothing clears the
 * floor / no embedder / any failure / the time budget expires. ≤1-tool recipes
 * are excluded (the established low-value gate, recipes-reuse-activation P-004).
 */
export async function findTopRecipeForWake(
  query: string,
  deps: FindTopRecipeDeps = {},
): Promise<WakeRecipeHit | null> {
  const q = query.trim().slice(0, QUERY_CAP);
  if (!q) return null;
  const timeoutMs = deps.timeoutMs ?? LOOP_WAKE_RECIPE_TIMEOUT_MS;

  const lookup = async (): Promise<WakeRecipeHit | null> => {
    const embedder =
      deps.embedder !== undefined
        ? deps.embedder
        : await (await import('../../agent-tools/search/embedder'))
            .buildQueryEmbedder()
            .catch(() => null);
    if (!embedder) return null;
    const vec = await embedder(q);
    if (!Array.isArray(vec) || vec.length === 0) return null;
    const qVec = `[${vec.join(',')}]`;
    const sql = deps.sql ?? getOrgPg().sql;
    const rows = (await sql`
      SELECT id, title, run_count, 1 - (embedding <=> ${qVec}::vector) AS sim
        FROM harness_shared.code_recipes
       WHERE status = 'active'
         AND embedding IS NOT NULL
         AND COALESCE(array_length(tools_used, 1), 0) >= 2
    ORDER BY embedding <=> ${qVec}::vector
       LIMIT 1
    `) as unknown as Array<{ id: string; title: string; run_count: number | string; sim: number | string }>;
    const top = rows[0];
    if (!top) return null;
    const sim = Number(top.sim);
    if (!Number.isFinite(sim) || sim < LOOP_WAKE_RECIPE_SIM_FLOOR) return null;
    const runCount = typeof top.run_count === 'number' ? top.run_count : parseInt(top.run_count, 10) || 0;
    return { id: top.id, title: top.title, runCount, sim };
  };

  try {
    return await Promise.race([
      lookup(),
      new Promise<null>((resolve) => {
        const t = setTimeout(resolve, timeoutMs, null);
        t.unref?.();
      }),
    ]);
  } catch {
    return null;
  }
}
