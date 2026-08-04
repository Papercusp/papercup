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
import { runHybridSearch, type SearchHit } from '@papercusp/search';
import { SEARCH_SOURCES } from '../agent-tools/search/sources';
import { buildQueryEmbedder } from '../agent-tools/search/embedder';
import {
  CORPUS_BUDGET_CHARS,
  CORPUS_MAX_ITEMS,
  corpusQueryText,
  CORPUS_GRADED_QUERY_MAX_TERMS,
  renderCorpusBlock,
  selectCorpusLines,
  sessionIdOfHit,
  type CorpusDrop,
  type CorpusHit,
  type CorpusLine,
} from './corpus-recall';
// NOTE: `corpusTermDfLookup` is deliberately NOT imported here any more — see the
// D-066 revert note at the `effectiveQuery` assignment below. The DF table and its
// refresh routine stay live and populated; only this leg's use of DF as a pure
// rarity SELECTOR was unwired.

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
  /**
   * The CALLER'S coord ownerId (`su-xxxx…`). Every session in its
   * carry-respawn chain is dropped as echo — see
   * `SelectCorpusInput.excludeSessionIds` for why this is owner-wide and not
   * a single session id (EI-19460887729945170: the single-id form could never
   * match a real turn, because both injection ports pass an ownerId here while
   * hits carry native transcript uuids).
   */
  excludeOwnerId?: string | null;
  /** Handle refs already delivered to this agent. */
  knownRefs?: ReadonlySet<string>;
  maxItems?: number;
  budgetChars?: number;
  /** Test seam: skip the flag read (the caller already gated). */
  skipFlagCheck?: boolean;
  /**
   * Terms handed to the COVERAGE-GRADED cascade stage. Defaults to
   * {@link CORPUS_GRADED_QUERY_MAX_TERMS}. Exposed so a bench can measure both
   * arms in ONE process against the SAME corpus instant — the corpus is written
   * continuously by the fleet, so two runs minutes apart are not a paired
   * comparison, which is how P-018 shipped on a real-but-unrelated gain.
   */
  gradedMaxTerms?: number;
}

/**
 * WHY the leg ended where it did. `lines: []` alone is five different states
 * wearing one face, and the most dangerous of them — the wall-clock bound
 * expiring — is indistinguishable from the most benign, "the corpus genuinely
 * had nothing". EI-19460902984682209: that ambiguity is what let every first
 * injection in a fresh process return an empty block for its whole life
 * without anyone noticing.
 *
 * Only `'ok'` means the leg ran to completion, and even then `lines` may be
 * empty — that is the honest "nothing relevant".
 */
export type CorpusRecallOutcome =
  /** The leg ran to completion. `lines` may still be empty. */
  | 'ok'
  /** `corpusRecallTimeoutMs` expired. NOT evidence that the corpus is empty. */
  | 'timed-out'
  /** The kill-switch flag is off, or no in-scope source is registered. */
  | 'disabled'
  /** Nothing searchable in the input text. */
  | 'no-query'
  /** The leg threw (PG down, engine error). Best-effort, never rethrown. */
  | 'failed';

export interface CorpusRecallResult {
  /** The rendered markdown section, or null when nothing was admitted. */
  block: string | null;
  lines: CorpusLine[];
  dropped: CorpusDrop[];
  /** False ⇒ the search ran BM25-only (no query vector). */
  embedderAvailable: boolean;
  /** Candidates the engine returned, before pure-core selection. */
  candidateCount: number;
  /** Why the leg ended here — see `CorpusRecallOutcome`. Read this before
   *  concluding anything from an empty `lines`. */
  outcome: CorpusRecallOutcome;
}

const empty = (outcome: CorpusRecallOutcome): CorpusRecallResult => ({
  block: null,
  lines: [],
  dropped: [],
  embedderAvailable: false,
  candidateCount: 0,
  outcome,
});

type QueryEmbedder = (text: string) => Promise<number[]>;

/** Warm state for the query embedder. Module-scoped on purpose: the cost being
 *  avoided is per-PROCESS, not per-call. */
let warmEmbedder: QueryEmbedder | null = null;
let warmupInFlight: Promise<void> | null = null;

/**
 * Acquire + prime the query embedder OFF the critical path, and resolve when
 * it is genuinely usable. Idempotent; safe to call on every request.
 *
 * ⚠ THE FIX FOR EI-19460902984682209 — read before "simplifying" this back
 * into an inline `await buildQueryEmbedder(...)` inside the leg.
 *
 * This leg's ENTIRE wall-clock bound is 2s (`corpusRecallTimeoutMs`). Measured
 * 2026-08-03 on this box, a cold embedder costs ~1374ms to ACQUIRE and a
 * further ~2222ms for its FIRST embed — ~3.6s, comfortably past the whole
 * budget. Awaiting acquisition inline spent 60%+ of the leg's deadline merely
 * DISCOVERING the embedder was not ready, leaving under 800ms for the ~1.2s
 * search it was supposed to be degrading to. So the leg timed out and returned
 * EMPTY — the one outcome indistinguishable from "nothing relevant" — on the
 * first call of every fresh process, for its whole life.
 *
 * The header of this file already promised the right behaviour ("a COLD
 * embedder ... must degrade to BM25-only rather than stall the turn"); the bug
 * was that the DISCOVERY was charged to the very budget the degradation exists
 * to protect. So a request uses the embedder only when it is ALREADY warm, and
 * otherwise runs BM25-only immediately and leaves the warmup to finish behind
 * it. Single-variable measurement, same 2s bound: cold call 2003ms/0 lines →
 * 1197ms/6 lines, and those 6 lines are byte-identical to the warm hybrid
 * result (this corpus's motivating retrieval is lexical — see
 * `corpusEmbedBudgetMs`).
 *
 * A failed acquisition never latches: `warmupInFlight` is cleared so a later
 * call retries, matching the rest of this file's fail-soft posture.
 */
export function warmCorpusEmbedder(): Promise<void> {
  const started = (warmupInFlight ??= (async () => {
    try {
      const built = (await buildQueryEmbedder({
        acquireBudgetMs: corpusEmbedBudgetMs(),
      })) as QueryEmbedder | null;
      if (!built) {
        warmupInFlight = null;
        return;
      }
      // Pay the cold ONNX/pipeline embed HERE rather than on a turn.
      await built('corpus recall embedder warmup');
      warmEmbedder = built;
    } catch {
      warmupInFlight = null;
    }
  })());
  return started;
}

/** Test seam: drop the process-wide warm state so a suite can exercise both
 *  the cold (BM25-only) and warm (hybrid) paths deterministically. */
export function resetCorpusEmbedderWarmup(): void {
  warmEmbedder = null;
  warmupInFlight = null;
}

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

/** Engine rows → the pure core's hit shape. */
function toCorpusHits(fused: { results: readonly SearchHit[] }): CorpusHit[] {
  return fused.results.map((r) => ({
    source: r.source,
    sourceId: r.source_id,
    scope: r.scope ?? null,
    excerpt: r.excerpt ?? '',
    highlight: r.highlight ?? null,
    score: r.score,
    ts: r.ts ?? null,
    rankers: r.rankers,
  }));
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
  if (!rawText) return empty('no-query');
  // The engine ANDs every lexeme (plainto_tsquery) and the injected text is the
  // raw prompt envelope — median 1000 chars at turn-start — so the raw text
  // must NEVER reach the engine. See corpusQueryText for the measurements.
  //
  // Derived TWICE on purpose. This first pass is the length-ordered form, used
  // only for the "nothing searchable at all" early-out below — it needs no
  // database, so the cheap exit stays cheap. The BANDED form (P-018/D-064)
  // needs a DF lookup and is derived inside the try, where `sql` exists.
  const queryText = corpusQueryText(rawText);
  if (!queryText) return empty('no-query');
  if (!input.skipFlagCheck && !(await corpusRecallEnabled())) return empty('disabled');

  const maxItems = input.maxItems ?? CORPUS_MAX_ITEMS;
  const gradedMaxTerms = input.gradedMaxTerms ?? CORPUS_GRADED_QUERY_MAX_TERMS;
  const sources = SEARCH_SOURCES.filter((s) =>
    (CORPUS_SOURCE_NAMES as readonly string[]).includes(s.name),
  );
  // Nothing registered to read — the leg is off by configuration, not empty.
  if (sources.length === 0) return empty('disabled');

  const budgetChars = input.budgetChars ?? CORPUS_BUDGET_CHARS;

  try {
    const { sql } = getOrgPg();
    const embedBudget = corpusEmbedBudgetMs();
    const run = (async () => {
      // ⛔ BANDED term selection (P-018 / D-064) IS UNWIRED — it was MEASURED WORSE
      // and reverted the same day (D-066). Do not re-wire it without reading that
      // decision; the shape of the mistake is subtle and it looked like a win.
      //
      // WHAT WAS SHIPPED: pick the RAREST terms the corpus actually attests
      // (df >= 2), instead of the two longest. It raised admitted lines/query
      // 4.28 -> 4.73 (+0.46), which is why it read as a win.
      //
      // WHAT THE ACCEPTANCE CASE SAID: on the WI-6512 known-item replay, run
      // through THIS leg with both arms back-to-back against the same live
      // corpus, answer-bearing batches went 2/7 (length) -> 0/7 (banded).
      // More lines, and none of them the answer. The two metrics moved in
      // OPPOSITE directions, so the line count alone could never have caught it.
      //
      // WHY: the band fixed UNRETRIEVABLE (df<2 hapaxes match nothing) and left
      // IRRELEVANT untouched. Inside the attested band, "rarest" still means
      // "most incidental" — it chose `pretty` out of pg_size_pretty, `buffers`
      // out of EXPLAIN BUFFERS, `speaker` out of a column list, `components` out
      // of a path. Those DO match documents, which is exactly why the line count
      // rose; they just match the wrong ones. Rarity is a WEIGHT for documents
      // that already matched, never a SELECTOR for the query.
      //
      // The DF signal, its table and its refresh routine are all kept: the
      // redesign needs the signal, just not as a pure rarity ranker.
      const effectiveQuery = queryText;
      // Already-warm ONLY — never await acquisition here. See
      // `warmCorpusEmbedder` for the measurements behind that
      // (EI-19460902984682209); a cold process runs BM25-only and warms behind
      // this request instead of timing the whole leg out.
      const built = warmEmbedder;
      if (!built) void warmCorpusEmbedder();
      // The cascade can run the engine TWICE on the same query text, and the
      // query vector depends only on that text — memoise so the second stage
      // reuses the first stage's embedding instead of paying for it again.
      let embedP: Promise<number[]> | null = null;
      const embedder = built
        ? (t: string) => (embedP ??= built(t))
        : built;

      // Stage 2's query is derived SEPARATELY from stage 1's — see
      // CORPUS_GRADED_QUERY_MAX_TERMS. Stage 1 ANDs, so two terms is a
      // selectivity floor it cannot exceed; stage 2 grades by coverage, so the
      // same cap leaves it nearly nothing to rank with. Falls back to the
      // stage-1 text if the wider derivation yields nothing.
      const gradedQuery = corpusQueryText(rawText, gradedMaxTerms) || effectiveQuery;

      const search = (lexicalMode: 'and' | 'coverage-graded', queryFor: string) =>
        runHybridSearch(sources, {
          sql,
          query: queryFor,
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
          lexicalMode,
        });

      // Which of these hits' sessions belong to the CALLER (EI-19460887729945170)?
      //
      // Resolved from the candidates rather than from the owner, deliberately:
      // "every session this owner has ever had" grows without bound over a long
      // life, while the candidate pool is `limit` rows by construction — so this
      // stays one indexed lookup of ~24 ids no matter how long the agent has been
      // running. Memoised across the cascade's two stages so stage 2 only asks
      // about ids stage 1 did not already settle.
      //
      // Fail-soft, like every other step on this path: a lookup that throws
      // yields no exclusions, which is exactly today's behaviour — never a
      // broken leg.
      const ownSession = new Map<string, boolean>();
      const ownSessionIdsAmong = async (hits: readonly CorpusHit[]): Promise<Set<string>> => {
        const owner = input.excludeOwnerId?.trim();
        const mine = new Set<string>();
        if (!owner) return mine;
        const unknown: string[] = [];
        for (const hit of hits) {
          const sid = sessionIdOfHit(hit);
          if (!sid) continue;
          const cached = ownSession.get(sid);
          if (cached === undefined) unknown.push(sid);
          else if (cached) mine.add(sid);
        }
        if (unknown.length === 0) return mine;
        try {
          const rows = (await sql`
            SELECT DISTINCT session_id
              FROM harness_shared.session_turns
             WHERE owner = ${owner}
               AND session_id = ANY(${unknown}::text[])
          `) as unknown as Array<{ session_id: string }>;
          const owned = new Set(rows.map((r) => r.session_id));
          for (const sid of unknown) ownSession.set(sid, owned.has(sid));
          for (const sid of owned) mine.add(sid);
        } catch {
          /* no exclusion beats a dead leg */
        }
        return mine;
      };

      const select = async (
        hits: CorpusHit[],
        opts: { maxItems: number; budgetChars: number; knownRefs: ReadonlySet<string> },
      ) =>
        selectCorpusLines({
          hits,
          // MUST be the query the engine actually ran. `selectCorpusLines`
          // applies a term-overlap guard, so judging hits against a query that
          // was never issued would drop rows the banded query legitimately
          // retrieved as `no-term-overlap`.
          queryText: effectiveQuery,
          excludeSessionIds: await ownSessionIdsAmong(hits),
          harnessSlugs: input.harnessSlugs ?? [],
          knownRefs: opts.knownRefs,
          maxItems: opts.maxItems,
          budgetChars: opts.budgetChars,
        });

      // ── Stage 1: today's AND query, unchanged. ──
      const andFused = await search('and', effectiveQuery);
      const andHits = toCorpusHits(andFused);
      const known = input.knownRefs ?? new Set<string>();
      const stage1 = await select(andHits, { maxItems, budgetChars, knownRefs: known });

      // ── Stage 2 (P-017 / D-062 R2): relax ONLY when stage 1 under-fills. ──
      //
      // ⚠ THE TWO-STAGE SHAPE IS LOAD-BEARING — a single coverage-graded query
      // is NOT a no-op-or-better substitute for it, and the obvious "it is a
      // strict superset, so one query suffices" argument is FALSE at this level.
      // `graded ⊇ and` holds per-source in SQL, but this leg merges two sources
      // and then applies an overlap guard, a 6-item cap and an 1800-char budget
      // over a REORDERED walk — so grading alone evicts lines the AND query used
      // to admit. Measured live over 120 real turns: 180 admitted lines lost
      // across 79/120 queries, 18 of them the control's top-1, while the mean
      // admitted count stayed FLAT at 4.33. It was a swap, not an addition.
      //
      // Running stage 2 against the REMAINING cap and budget, with stage 1's
      // refs already marked known, makes the result additive by construction:
      // stage 1's lines are computed first and never revisited, so the admitted
      // set can only grow. `bench/corpus-leg-lexical-acceptance-cli.ts` asserts
      // exactly that (admitted-containment violations must be 0).
      if (stage1.lines.length >= maxItems) {
        return { lines: stage1.lines, dropped: stage1.dropped, fused: andFused, count: andHits.length };
      }

      const spent = stage1.lines.reduce((n, l) => n + l.line.length, 0);
      const gradedFused = await search('coverage-graded', gradedQuery);
      const seen = new Set(andHits.map((h) => `${h.source}:${h.sourceId}`));
      const gradedOnly = toCorpusHits(gradedFused).filter(
        (h) => !seen.has(`${h.source}:${h.sourceId}`),
      );
      const stage2 = await select(gradedOnly, {
        maxItems: maxItems - stage1.lines.length,
        budgetChars: budgetChars - spent,
        knownRefs: new Set([...known, ...stage1.lines.map((l) => l.handle.ref)]),
      });

      return {
        lines: [...stage1.lines, ...stage2.lines],
        dropped: [...stage1.dropped, ...stage2.dropped],
        fused: gradedFused,
        count: andHits.length + gradedOnly.length,
      };
    })();

    const out = await withBound(run, corpusRecallTimeoutMs(), null);
    // The bound expired. This is NOT "the corpus had nothing" — say so, so a
    // caller (and any benchmark) can tell the two apart (EI-19460902984682209).
    if (!out) return empty('timed-out');

    return {
      block: renderCorpusBlock(out.lines),
      lines: out.lines,
      dropped: out.dropped,
      embedderAvailable: out.fused.embedderAvailable,
      candidateCount: out.count,
      outcome: 'ok',
    };
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[memory-corpus-recall] failed:', (err as Error).message);
    }
    return empty('failed');
  }
}
