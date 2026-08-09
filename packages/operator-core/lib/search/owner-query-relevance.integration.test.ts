/**
 * P-015 — the two OWNER-REPORTED queries, pinned as a relevance regression
 * (plan semantic-search-fingerprint-coverage-2026-08-03, decision D-031).
 *
 * ┌ WHY THIS IS AN EVAL AND NOT A UNIT TEST ──────────────────────────────────┐
 * │ A unit test proves the code runs. Both owner reports were about search    │
 * │ being WRONG while running perfectly, so only a graded measurement can     │
 * │ catch a regression in either.                                            │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ── Report 1: "theory" missed the theory-of-mind sessions ─────────── RECALL ─
 * ⚠ Measured with `recallAtK`, which lives in the harness rather than in
 * `metrics.ts` for a load-bearing reason: EVERY shipped metric scores only the
 * list handed to it. `ndcg` normalises against the ideal ordering OF THOSE SAME
 * GRADES, so a correctly-ordered page scores **1.0 whether it holds all the
 * relevant sessions or one of them**. Pinning this report with nDCG would
 * produce a guard that stays green through exactly the bug it exists to catch.
 *
 * ── Report 2: "knowledge pack" returned unrelated turns ─────────── PRECISION ─
 * The reported shape was exact and is therefore DERIVABLE, needing no human
 * grading: 8 of 16 cards came from the semantic leg alone and contained NEITHER
 * query word. `matchedBy === 'semantic'` + zero term overlap reproduces that
 * judgement mechanically.
 *
 * ── GROUND TRUTH IS DERIVED, AND PINNED BEHIND A CUTOFF ─────────────────────
 * Relevant sessions are computed from the corpus each run (a phrase scan), not
 * hand-authored, so they cannot rot as the corpus grows.
 *
 * ⚠ But the derivation has a self-reference hazard that MUST stay fixed: agent
 * sessions *discussing this eval* are themselves ingested into `session_turns`,
 * so the ground-truth set grows as a side effect of measuring it. It went 8 → 9
 * sessions during the work that produced this file, and one of the 9 WAS the
 * measuring session. Unbounded, that drifts the denominator upward and depresses
 * recall for reasons that have nothing to do with ranking. Hence GROUND_TRUTH_
 * CUTOFF: the relevant set is the sessions that existed when the owner reported
 * the bug, and it does not move.
 *
 * ── WHY IT SKIPS INSTEAD OF FAILING WHEN THERE IS NO CORPUS ─────────────────
 * This reads the LIVE operator store on purpose — the owner's bug lives in the
 * real corpus, and a seeded fixture would only reproduce the failure its author
 * already believed in. Ordinary integration tests here run against a FRESH,
 * EMPTY database (`createFreshPgDb`), where this eval has nothing to measure. A
 * vacuous run must never read as a pass, so it SKIPS LOUDLY with the reason
 * named. `assertRelevance` independently refuses a vacuous evaluation, so a
 * silent green is unreachable from either direction.
 */
import { describe, expect, it } from 'vitest';
import { assertRelevance, evaluateRelevance } from '@papercusp/search-core';
// The ENGINE's own hit type, deliberately not a local mirror of it: a
// hand-rolled shape drifts silently, and `hitProvenance` reads fields
// (`rankers`/`rankerScores`) a partial mirror makes optional — which is exactly
// how a provenance check degrades to always-false and reports zero pollution.
import type { SearchHit } from '@papercusp/search';

/**
 * Sessions that existed when the bug was reported. Pinned — see the
 * self-reference hazard above. Do NOT advance this to "pick up newer data":
 * newer data is precisely what must not enter the relevant set.
 */
const GROUND_TRUTH_CUTOFF = '2026-08-08T00:00:00Z';

/** The route's real page size (the desktop agents-pill sends limit=30). */
const HIT_LIMIT = 30;

/**
 * MEASURED FLOORS (2026-08-08, D-031) — SHRINK-ONLY, i.e. ratchet these UP as
 * first-stage ranking improves; never down to make a red go away.
 *
 * `theory` recall@30 stands at 2/9 ≈ 0.222 and that is a REAL, OPEN BUG, not a
 * target: 8 of the 9 sessions are retrieved by depth 300 but rank 65–170, so
 * the top-30 cut misses them. Note what that shape means: the sessions are
 * ALREADY ADMITTED and merely ordered too low, so a fix must REORDER what is
 * retrieved. Narrowing the candidate set cannot help.
 *
 * ⚠ THE TWO FIXES THIS COMMENT USED TO NAME ARE BOTH DEAD. Do not pursue
 * either, and do not re-open them by citing D-031 (which raised both to high
 * on a premise since refuted):
 *   • P-014 (length normalisation) — DROPPED BY MEASUREMENT (D-032). Every
 *     `ts_rank_cd` call site omits the normalisation argument, so there is no
 *     document-length term to tune in the first place.
 *   • P-011 (phrase-awareness) — a STRUCTURAL NO-OP for this report (D-040),
 *     proven rather than measured: the query below is the SINGLE WORD `theory`,
 *     and `phraseto_tsquery('english','theory')` is byte-identical to
 *     `plainto_tsquery('english','theory')` — both emit `'theori'`. Identical
 *     tsquery ⇒ identical candidates ⇒ identical scores ⇒ identical fusion. A
 *     one-word query has no phrase structure to exploit, so no amount of
 *     tuning can rescue it here.
 *
 * The one live route is true term-frequency-aware (BM25) scoring, which PG
 * cannot supply natively — P-035, an owner-gated packaging decision. This floor
 * exists to stop the bug getting WORSE until that ruling lands.
 */
const THEORY_RECALL_FLOOR = 2 / 9;
/** Report 2's fix: pollution is at ZERO and must stay there. */
const KNOWLEDGE_PACK_ACCESSORY_CEILING = 0;

/** Everything this eval needs from the live store + engine, or a skip reason. */
async function setup() {
  const [{ runHybridSearch, hitProvenance }, { SEARCH_SOURCES }, { buildQueryEmbedder }, { parseTurnRef }, { activeWorkspaceId }, { getOrgPg }] =
    await Promise.all([
      import('@papercusp/search'),
      import('../agent-tools/search/sources'),
      import('../agent-tools/search/embedder'),
      import('../agent-tools/sessions/_shared'),
      import('../workspace-registry'),
      import('@papercusp/db-org'),
    ]);
  const { rerankPageHead } = await import('../agent-tools/search/rerank');

  const { sql } = getOrgPg();
  const truth = await sql<Array<{ session_id: string }>>`
    SELECT DISTINCT session_id
      FROM harness_shared.session_turns
     WHERE text ILIKE '%theory of mind%'
       AND ts < ${GROUND_TRUTH_CUTOFF}::timestamptz`;
  const tomSessions = truth.map((r) => r.session_id);

  const sources = SEARCH_SOURCES.filter((s) => s.name === 'session_turn');
  // `null`, not undefined: hybrid mode takes `embedder: Embedder | null`, and an
  // OMITTED embedder is a type hole rather than a documented degrade. A null one
  // degrades the engine to BM25-only, which `skipIfDegraded` then refuses to
  // certify a hybrid-measured floor against.
  const embedder = await buildQueryEmbedder({ acquireBudgetMs: 30_000 }).catch(() => null);

  // The route's defaults (adv-session-search.ts), stated ONCE. A diagnostic
  // below varies a single knob against this; re-declaring the whole shape per
  // variant is how a "control" silently stops being the control.
  const PROD_RECENCY = {
    halfLifeMs: 24 * 7 * 3_600_000,
    weight: 0.5,
    freshWindowMs: 48 * 3_600_000,
  } as const;

  const search = async (
    query: string,
    override: {
      recency?: { halfLifeMs: number; weight: number; freshWindowMs: number } | false;
      groupBy?: (hit: SearchHit) => string | null;
    } = {},
  ) => {
    const { results, legs, totalGroups } = await runHybridSearch(sources, {
      sql,
      query,
      workspaceId: activeWorkspaceId(),
      scopeFilter: null,
      limit: HIT_LIMIT,
      mode: 'hybrid',
      embedder,
      embedTimeoutMs: 30_000,
      // Measure what the owner actually experiences, not a cleaner
      // configuration than production. `'recency' in override` (not `??`)
      // because `false` is a MEANINGFUL value here — it means "force
      // pure-relevance", which `??` would silently discard back to the default.
      recency: 'recency' in override ? override.recency : PROD_RECENCY,
      ...(override.groupBy ? { groupBy: override.groupBy } : {}),
      signal: new AbortController().signal,
      deferHighlight: true,
    });
    return { results: results as SearchHit[], legs, totalGroups };
  };

  const sessionOf = (h: SearchHit) => parseTurnRef(h.source_id)?.sessionId ?? h.source_id;
  return { search, rerankPageHead, sessionOf, hitProvenance, tomSessions, PROD_RECENCY };
}

/**
 * Refuse to certify a relevance floor measured on a DEGRADED engine.
 *
 * Both floors below were measured with both legs live. If the query embedder is
 * unavailable in this process the engine silently degrades to BM25-only — which
 * is correct behaviour for a search, and fatal for an eval: it would compare a
 * keyword-only ranking against a hybrid floor and report the verdict as if the
 * systems were the same. That is the identical trap D-031 caught on the other
 * side, where a precision of 1.0 could have meant "well-floored semantic leg" or
 * "semantic leg returned nothing" — the leg report is what separates them.
 *
 * A degraded run is therefore neither a pass nor a fail: it measured a different
 * system, so it SKIPS and says so.
 */
function skipIfDegraded(legs: { degraded?: boolean; warning?: string | null } | undefined, t: { skip: (note?: string) => void }): boolean {
  if (!legs?.degraded) return false;
  const why = `engine DEGRADED (${legs.warning ?? 'a ranker leg did not run'}) — floors were measured with both legs live, so this run measured a different system`;
  console.warn(`[P-015] ${why}`);
  t.skip(why);
  return true;
}

type Setup = Awaited<ReturnType<typeof setup>>;
let ctx: Setup | null = null;
let skipReason: string | null = null;
try {
  ctx = await setup();
  if (ctx.tomSessions.length === 0) {
    skipReason =
      `no ground truth: zero sessions before ${GROUND_TRUTH_CUTOFF} contain the phrase — ` +
      'this is a FRESH/EMPTY corpus (the createFreshPgDb path), not a relevance result';
  }
} catch (err) {
  skipReason = `live operator store unreachable: ${(err as Error).message}`;
}

describe.skipIf(skipReason !== null)('P-015 — owner-reported query relevance (live corpus)', () => {
  it(
    'Report 1: "theory" surfaces the theory-of-mind sessions (RECALL — shrink-only floor)',
    async (t) => {
      const { search, sessionOf, tomSessions } = ctx!;
      const { results: ranked, legs } = await search('theory');
      if (skipIfDegraded(legs, t)) return;
      const out = evaluateRelevance({
        ranked,
        grade: (h) => (tomSessions.includes(sessionOf(h)) ? 3 : 0),
        k: HIT_LIMIT,
        groundTruth: { ids: tomSessions, idOf: sessionOf },
      });

      // A vacuous run is a failure, never a pass — see the header.
      expect(out.coverage).toBe('complete');

      const verdict = assertRelevance(out, { minRecallAtK: THEORY_RECALL_FLOOR });
      expect(
        verdict.ok,
        `recall@${HIT_LIMIT}=${out.recallAtK?.toFixed(3)} over ${tomSessions.length} pinned sessions. ` +
          `${verdict.failures.join(' | ')}\n` +
          'This floor is SHRINK-ONLY. A red here means first-stage ranking got WORSE — ' +
          'see D-031: the sessions ARE retrieved (8/9 by depth 300) but rank 65-170, so the ' +
          'fix must REORDER what is already admitted; more reranking depth will not help.\n' +
          'Do NOT reach for P-014 or P-011 — both are dead ends and both were once named here: ' +
          'P-014 (length normalisation) is dropped by measurement (D-032, no normalisation arg ' +
          'is passed to ts_rank_cd anywhere), and P-011 (phrase-awareness) is a proven no-op for ' +
          'this query (D-040 — "theory" is one word, so phraseto_tsquery and plainto_tsquery ' +
          'both emit \'theori\'). The only live route is BM25 via a PG extension: P-035, owner-gated.',
      ).toBe(true);
    },
    120_000,
  );

  /**
   * WHERE IN THE PIPELINE IS REPORT 1 LOST? (P-036)
   *
   * Report 1's floor is a single number, so a red says the ranking got worse
   * without saying WHICH STAGE made it worse — and the plan then spends its
   * effort on whichever stage the last agent happened to suspect. Every dead
   * direction on this plan (D-032/D-036/D-040/D-041) was killed by a
   * measurement someone eventually ran; this runs the ones that are cheap to
   * run EVERY time, so the next red arrives already triaged.
   *
   * It varies ONE knob at a time against the production control and REPORTS.
   * Deliberately not a second floor: two assertions over one measurement would
   * red twice for one cause, and the pinned floor above is the guard.
   */
  it(
    'DIAGNOSTIC: which ranking stage loses the theory-of-mind sessions (reports, does not gate)',
    async (t) => {
      const { search, sessionOf, tomSessions, PROD_RECENCY } = ctx!;
      const bySession = (h: SearchHit) => sessionOf(h);
      const found = (ranked: SearchHit[]) =>
        new Set(ranked.map(sessionOf).filter((s) => tomSessions.includes(s))).size;

      const variants: Array<[string, Parameters<typeof search>[1]]> = [
        ['production (control)', {}],
        // Isolates the 48h fresh-window LEG from the recency re-rank: same
        // decay, but no extra RRF input. A session with no turn in the window
        // cannot earn that leg's vote at all, so it is the one knob that can
        // deny a candidate points rather than merely reweight it.
        ['no fresh-window leg', { recency: { ...PROD_RECENCY, freshWindowMs: 0 } }],
        ['no recency at all', { recency: false }],
        ['+ session dedup', { groupBy: bySession }],
        ['no recency + session dedup', { recency: false, groupBy: bySession }],
      ];

      const rows: string[] = [];
      for (const [label, override] of variants) {
        const { results, legs, totalGroups } = await search('theory', override);
        if (skipIfDegraded(legs, t)) return;
        const distinct = new Set(results.map(sessionOf)).size;
        rows.push(
          `  ${label.padEnd(28)} recall ${found(results)}/${tomSessions.length}` +
            `  page ${results.length} rows / ${distinct} distinct sessions` +
            (totalGroups === undefined ? '' : ` (pool held ${totalGroups})`),
        );
      }
      console.warn(`[P-015] Report-1 stage isolation (k=${HIT_LIMIT}):\n${rows.join('\n')}`);

      // The one PROPERTY worth asserting here, because it is what the rollup
      // claims to do and it cannot be true by accident: with a session groupBy,
      // every row on the page is a distinct session.
      const { results: deduped } = await search('theory', { groupBy: bySession });
      expect(new Set(deduped.map(sessionOf)).size).toBe(deduped.length);
    },
    180_000,
  );

  it(
    'Report 2: "knowledge pack" returns no semantic-only hit lacking both query terms (PRECISION)',
    async (t) => {
      const { search, hitProvenance } = ctx!;
      const { results: ranked, legs } = await search('knowledge pack');
      if (skipIfDegraded(legs, t)) return;
      const hasTerm = (h: SearchHit) => {
        const t = `${h.excerpt ?? ''} ${h.highlight ?? ''}`.toLowerCase();
        return t.includes('knowledge') || t.includes('pack');
      };
      // The reported pollution shape, reproduced mechanically: matched by the
      // vector leg ALONE and containing neither query word.
      const isPollution = (h: SearchHit) => hitProvenance(h).matchedBy === 'semantic' && !hasTerm(h);

      const out = evaluateRelevance({
        ranked,
        grade: (h) => (isPollution(h) ? 0 : hasTerm(h) ? 3 : 1),
        k: HIT_LIMIT,
      });
      expect(out.coverage).toBe('complete');

      const verdict = assertRelevance(out, {
        maxAccessoryAtK: KNOWLEDGE_PACK_ACCESSORY_CEILING,
      });
      expect(
        verdict.ok,
        `${ranked.filter(isPollution).length} polluting card(s) of ${ranked.length}. ` +
          `${verdict.failures.join(' | ')}\n` +
          'The owner saw 8 of 16. D-031 measured 0 — a regression here means the ' +
          'P-017 similarity floor stopped holding on this corpus.',
      ).toBe(true);
    },
    120_000,
  );
});

// A skip must be VISIBLE, never silent — the whole failure mode this guards.
describe.runIf(skipReason !== null)('P-015 — owner-query relevance SKIPPED', () => {
  it('reports why it could not measure (this is not a pass)', () => {
    console.warn(`[P-015] owner-query relevance eval SKIPPED — ${skipReason}`);
    expect(skipReason).toBeTruthy();
  });
});
