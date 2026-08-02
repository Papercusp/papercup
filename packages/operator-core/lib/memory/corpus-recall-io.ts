/**
 * corpus-recall-io — the LIVE leg of the P-008 second retrieval corpus
 * (context-injection-audit-2026-07-28, built to D-037). The pure selection
 * core is ./corpus-recall; this file is only the fetch seam.
 *
 * RETRIEVAL IS REUSED, NOT REBUILT — this is P-010's reuse-first check,
 * discharged. `@papercusp/search` + `SEARCH_SOURCES` already own the SQL for
 * both corpora this item wants: `session_turn` (BM25 over `text_tsv` +
 * gemma@384 cosine over `text_embedding`, with the full filter bag) and
 * `work_item` (BM25 over `engineer_issues._search`). `runHybridSearch` already
 * supplies RRF fusion, a bounded query-embed, abort threading and
 * degrade-to-BM25 on a missing embedder. Hand-writing pgvector SQL here would
 * fork a registry whose stated purpose is that the SQL lives in exactly one
 * place.
 *
 * TWO DELIBERATE DIFFERENCES FROM THE mem0 INJECTION PATH:
 *
 *   • It does NOT call `noteMemoryFailure`. That latch drops the whole process
 *     into degraded mode so later turns skip the mem0 store entirely — correct
 *     for a hung embedder on the memory path, wrong here: this is a different
 *     subsystem, and a slow corpus search must never disable memory recall.
 *     The bound below is local and stateless.
 *
 *   • It uses the PROSE-surface embedder (`buildQueryEmbedder` already applies
 *     `proseSurfacePreference`, mapping a harrier preference → gemma), because
 *     these corpora store gemma@384 vectors. That is the same fact that makes
 *     this a separate leg rather than a fourth mem0 pool — see D-037.
 */

import { getOrgPg } from '@papercusp/db-org';
import { runHybridSearch } from '@papercusp/search';
import { SEARCH_SOURCES } from '../agent-tools/search/sources';
import { buildQueryEmbedder } from '../agent-tools/search/embedder';
import {
  CORPUS_BUDGET_CHARS,
  CORPUS_MAX_ITEMS,
  corpusQueryText,
  renderCorpusBlock,
  selectCorpusLines,
  type CorpusDrop,
  type CorpusHit,
  type CorpusLine,
} from './corpus-recall';

/** The two registered sources this leg reads. Anything else in SEARCH_SOURCES
 *  (escalations, brainstorm, decisions, coord_message, operator turns) is out
 *  of P-008's scope — widening this list is a plan decision, not an edit. */
const CORPUS_SOURCE_NAMES = ['session_turn', 'work_item'] as const;

/**
 * Wall-clock bound for the WHOLE corpus leg (search + embed). This rides the
 * pre-turn prompt build, so it must fail open fast: on timeout the turn simply
 * gets no pointer section. Deliberately tighter than the mem0 path's 5s
 * MEMORY_INJECT_TIMEOUT_MS — the mem0 block is the primary payload and worth
 * waiting for; this one is additive. Env-tunable; `<= 0` disables the bound.
 */
export function corpusRecallTimeoutMs(): number {
  const raw = Number(process.env.PAPERCUSP_MEMORY_CORPUS_TIMEOUT_MS);
  if (Number.isFinite(raw)) return raw > 0 ? raw : Number.POSITIVE_INFINITY;
  return 2_000;
}

/**
 * Acquisition + per-query budget for the gemma query embed. A COLD embedder
 * (sidecar spawn + ONNX pipeline load) can take 15–30s the first time; on this
 * path that must degrade to BM25-only rather than stall the turn, which is
 * exactly what a null embedder does inside `runHybridSearch`. BM25-only is a
 * genuinely useful degradation here and not a silent loss: the motivating
 * retrieval (find WI-6512 from its distinctive terms) is a lexical match.
 */
export function corpusEmbedBudgetMs(): number {
  const raw = Number(process.env.PAPERCUSP_MEMORY_CORPUS_EMBED_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 1_200;
}

export interface CorpusRecallInput {
  /** The retrieval query — the same effective text the mem0 leg searched with. */
  queryText: string;
  workspaceId: string;
  /** Harnesses in scope. Narrows WORK-ITEM hits only — see the note on
   *  `SelectCorpusInput.harnessSlugs` for why turns must not be slug-scoped. */
  harnessSlugs?: readonly string[];
  /** This session's id — its own turns are dropped as echo. */
  excludeSessionId?: string | null;
  /** Handle refs already delivered to this agent. */
  knownRefs?: ReadonlySet<string>;
  maxItems?: number;
  budgetChars?: number;
  /** Test seam: skip the flag read (the caller already gated). */
  skipFlagCheck?: boolean;
}

export interface CorpusRecallResult {
  /** The rendered markdown section, or null when nothing was admitted. */
  block: string | null;
  lines: CorpusLine[];
  dropped: CorpusDrop[];
  /** False ⇒ the search ran BM25-only (no query vector). */
  embedderAvailable: boolean;
  /** Candidates the engine returned, before pure-core selection. */
  candidateCount: number;
}

const EMPTY: CorpusRecallResult = {
  block: null,
  lines: [],
  dropped: [],
  embedderAvailable: false,
  candidateCount: 0,
};

/** Bound a promise without touching the shared memory-degradation latch. */
async function withBound<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (!Number.isFinite(ms)) return await p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // A losing search still settles; swallow it so it can never surface as an
    // unhandled rejection after we've already returned the fallback.
    void p.catch(() => {});
  }
}

/** Is the corpus leg enabled? Default ON — a finished, tested retrieval leg
 *  that ships dark is dead code. OFF is the clean kill-switch. */
async function corpusRecallEnabled(): Promise<boolean> {
  try {
    const { FLAGS } = await import('@papercusp/flags');
    const { getFlag } = await import('@papercusp/flags/server');
    return await getFlag(FLAGS.MEMORY_CORPUS_RECALL, 'memory-corpus-recall');
  } catch {
    // A flags hiccup must not silently disable a default-ON feature.
    return true;
  }
}

/**
 * Run the corpus leg and return its rendered pointer section.
 *
 * Best-effort in exactly the way the rest of the injection path is: any
 * failure — PG down, embedder missing, search throwing, flag read failing —
 * returns an empty result and the caller's prompt is unaffected. Never throws.
 */
export async function recallCorpusContext(
  input: CorpusRecallInput,
): Promise<CorpusRecallResult> {
  const rawText = input.queryText?.trim() ?? '';
  if (!rawText) return EMPTY;
  // The engine ANDs every lexeme (plainto_tsquery) and the injected text is the
  // raw prompt envelope — median 1000 chars at turn-start — so the raw text
  // must NEVER reach the engine. See corpusQueryText for the measurements.
  const queryText = corpusQueryText(rawText);
  if (!queryText) return EMPTY;
  if (!input.skipFlagCheck && !(await corpusRecallEnabled())) return EMPTY;

  const maxItems = input.maxItems ?? CORPUS_MAX_ITEMS;
  const sources = SEARCH_SOURCES.filter((s) =>
    (CORPUS_SOURCE_NAMES as readonly string[]).includes(s.name),
  );
  if (sources.length === 0) return EMPTY;

  try {
    const { sql } = getOrgPg();
    const embedBudget = corpusEmbedBudgetMs();
    const run = (async () => {
      const embedder = await buildQueryEmbedder({ acquireBudgetMs: embedBudget });
      return await runHybridSearch(sources, {
        sql,
        query: queryText,
        workspaceId: input.workspaceId,
        // MUST stay null: 99.993% of session turns carry harness_slug IS NULL,
        // so a slug scopeFilter would make this leg structurally empty while
        // looking healthy. Work-item scoping happens in the pure core instead.
        scopeFilter: null,
        // Over-fetch: the pure core drops self-session echoes, out-of-scope
        // work-items, no-overlap hits and duplicate refs before the cap.
        limit: Math.max(maxItems * 4, 8),
        mode: 'hybrid',
        embedder,
        embedTimeoutMs: embedBudget,
        // Highlights ARE used — the teaser and the relevance guard both read the
        // match fragment rather than the body lead. Deferring means the engine
        // hydrates them for the final top-N only, instead of paying ts_headline
        // across the whole limit*3 over-fetch pool.
        deferHighlight: true,
      });
    })();

    const fused = await withBound(run, corpusRecallTimeoutMs(), null);
    if (!fused) return EMPTY;

    const hits: CorpusHit[] = fused.results.map((r) => ({
      source: r.source,
      sourceId: r.source_id,
      scope: r.scope ?? null,
      excerpt: r.excerpt ?? '',
      highlight: r.highlight ?? null,
      score: r.score,
      ts: r.ts ?? null,
      rankers: r.rankers,
    }));

    const { lines, dropped } = selectCorpusLines({
      hits,
      queryText,
      excludeSessionId: input.excludeSessionId ?? null,
      harnessSlugs: input.harnessSlugs ?? [],
      knownRefs: input.knownRefs,
      maxItems,
      budgetChars: input.budgetChars ?? CORPUS_BUDGET_CHARS,
    });

    return {
      block: renderCorpusBlock(lines),
      lines,
      dropped,
      embedderAvailable: fused.embedderAvailable,
      candidateCount: hits.length,
    };
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[memory-corpus-recall] failed:', (err as Error).message);
    }
    return EMPTY;
  }
}
