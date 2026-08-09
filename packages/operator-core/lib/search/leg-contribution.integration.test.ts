/**
 * WHICH RANKER LEG CHANGES WHAT COMES BACK? — measured across the REAL query
 * population (plan semantic-search-fingerprint-coverage-2026-08-03, D-053/D-054/D-055).
 *
 * ┌ WHY THIS EXISTS ──────────────────────────────────────────────────────────┐
 * │ P-035 asks whether to ship a Postgres BM25 extension. That argument ran    │
 * │ for a week on ONE query — the single word `theory` — and D-041's own       │
 * │ conclusion says BM25 is irrelevant at |Q|=1. The decision was being        │
 * │ debated using evidence drawn exclusively from the one regime where the     │
 * │ thing under discussion is agreed not to matter.                            │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ── WHY THIS NEEDS NO GROUND TRUTH ──────────────────────────────────────────
 * Hand-graded relevance is the expensive part of an eval, and needing it is
 * what pinned this plan to a single query. But "does a leg CHANGE the page" is
 * a SET DIFFERENCE between two runs, and needs no grading at all — so it scales
 * to any number of queries.
 *
 * ⚠ INFLUENCE IS A CEILING, NEVER A VERDICT. This measures how much a leg
 * changes the page, which BOUNDS what any improvement to that leg could affect.
 * It CANNOT say the change is an improvement — that needs ground truth nobody
 * has here. Do not read a large influence as "this leg is good", nor a small
 * one as "this leg is bad".
 *
 * ── THREE CORRECTIONS THIS FILE ENCODES, EACH FROM A REAL ERROR ─────────────
 * 1. A COUNT IS NOT A SET (D-052, retracted the day it was written). Two
 *    configurations both scored 2/8 on Report 1 and were reported as "the
 *    lexical leg contributes nothing" — they had recalled DIFFERENT sessions.
 *    Everything below is a set operation and prints identities.
 * 2. A MEAN IS NOT A TYPICAL VALUE (D-055). Per-query churn is heavily
 *    right-skewed, and band means overstated the mid band 2.5x and the long
 *    band 5x. Every band summary below reports the MEDIAN and quartiles.
 * 3. A SILENT EXCLUSION IS A BIAS (this revision). 41% of queries degraded and
 *    were dropped, non-uniformly — worst (56%) in the band carrying the whole
 *    decision. Degradation is now RETRIED, and whatever still degrades is
 *    reported per band WITH ITS REASON, so the exclusion can never again be
 *    invisible.
 *
 * ── ONE KNOB PER COMPARISON ─────────────────────────────────────────────────
 * `mode:'embeddings'` does NOT merely drop the lexical leg: hybrid.ts gates the
 * 48h fresh-window candidate leg on `mode === 'hybrid'`, so switching modes
 * drops that too. Hence three arms, giving two ONE-knob comparisons:
 *
 *   PROD      hybrid,     recency + fresh window (what ships)
 *   NOFRESH   hybrid,     recency, fresh window off
 *   SEMANTIC  embeddings, recency, fresh window off
 *
 *   lexical-leg influence = NOFRESH vs SEMANTIC   (differ only by the lexical leg)
 *   fresh-leg influence   = PROD    vs NOFRESH    (differ only by the fresh leg)
 *
 * The `minScore` floor is NOT a hidden third knob, verified rather than
 * assumed: mode reaches the host policy, but that policy branches only on
 * `mode === 'fulltext'` (configure-search-defaults.ts), so 'hybrid' and
 * 'embeddings' resolve an identical floor.
 *
 * ⚠ DO NOT WRAP THE EMBEDDER to memoize it. The P-017 similarity floor is a
 * WeakMap lookup on the embedder FUNCTION INSTANCE, so any wrapper silently
 * disables the floor and changes the system under measurement
 * (EI-19484071702281877). Load is managed with retries, never a wrapper.
 */
import { describe, expect, it } from 'vitest';
import type { SearchHit } from '@papercusp/search';

/** The route's real page size (the desktop agents-pill sends limit=30). */
const HIT_LIMIT = 30;

/** Queries sampled per (band x surface) cell. Corpus-limited in practice. */
const PER_CELL = 20;

/** Attempts per search before a query is recorded as degraded. */
const MAX_ATTEMPTS = 3;

/** Production recency (adv-session-search.ts defaults). */
const RECENCY_PROD = { halfLifeMs: 24 * 7 * 3_600_000, weight: 0.5, freshWindowMs: 48 * 3_600_000 } as const;
/** Same decay, fresh-window candidate leg OFF — the isolation baseline. */
const RECENCY_NO_FRESH = { ...RECENCY_PROD, freshWindowMs: 0 } as const;

type Band = 'short(1-2)' | 'mid(3-14)' | 'long(15+)';
/**
 * D-053: `memory:search` has a different caller mix (overwhelmingly agent
 * recall, median 15 terms) and must NOT be pooled with the owner-facing search
 * surfaces. It is sampled as its own stratum so it adds data without
 * contaminating the population the owner actually experiences.
 */
type Surface = 'owner-facing' | 'agent-recall';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const [{ runHybridSearch }, { SEARCH_SOURCES }, { buildQueryEmbedder }, { activeWorkspaceId }, { getOrgPg }] =
    await Promise.all([
      import('@papercusp/search'),
      import('../agent-tools/search/sources'),
      import('../agent-tools/search/embedder'),
      import('../workspace-registry'),
      import('@papercusp/db-org'),
    ]);

  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();

  /**
   * Sample REAL queries, never invented ones — inventing them would
   * re-introduce the sampling bias D-053 measured.
   *
   * Ordered by md5(query), NOT random(): a random sample draws a different set
   * every run, so two runs could never be compared and any change would be
   * unattributable.
   *
   * `calls` is carried so the report can state BOTH the per-query (unweighted)
   * and call-weighted views. D-054 quoted an unweighted measurement beside a
   * call-weighted traffic share, which is a unit mismatch.
   */
  const sampled = await sql<Array<{ query: string; terms: number; band: Band; surface: Surface; calls: number }>>`
    WITH q AS (
      SELECT trim(args_json->>'query') AS query,
             CASE WHEN tool_name = 'memory:search' THEN 'agent-recall' ELSE 'owner-facing' END AS surface,
             count(*)::int AS calls
        FROM harness_shared.tool_invocations
       WHERE tool_name IN ('search:fulltext', 'sessions:search', 'search:semantic', 'memory:search')
         AND args_json ? 'query'
         AND workspace_id = ${workspaceId}
         AND trim(coalesce(args_json->>'query', '')) <> ''
       GROUP BY 1, 2
    ),
    banded AS (
      SELECT query, surface, calls,
             array_length(regexp_split_to_array(query, '\\s+'), 1) AS terms
        FROM q
    ),
    labelled AS (
      SELECT query, surface, calls, terms,
             CASE WHEN terms <= 2 THEN 'short(1-2)'
                  WHEN terms <= 14 THEN 'mid(3-14)'
                  ELSE 'long(15+)' END AS band
        FROM banded
    ),
    ranked AS (
      SELECT query, surface, calls, terms, band,
             row_number() OVER (PARTITION BY band, surface ORDER BY md5(query)) AS rn
        FROM labelled
    )
    SELECT query, terms, band, surface, calls FROM ranked WHERE rn <= ${PER_CELL}
     ORDER BY surface, band, rn`;

  // `null`, not undefined: hybrid mode takes `embedder: Embedder | null`, and an
  // OMITTED embedder is a type hole rather than a documented degrade.
  // NEVER wrap this value — see the P-017 WeakMap warning in the header.
  const embedder = await buildQueryEmbedder({ acquireBudgetMs: 120_000 }).catch(() => null);
  const sources = SEARCH_SOURCES.filter((s) => s.name === 'session_turn');

  const once = async (query: string, mode: 'embeddings' | 'hybrid', recency: typeof RECENCY_PROD) => {
    const { results, legs } = await runHybridSearch(sources, {
      sql,
      query,
      workspaceId,
      scopeFilter: null,
      limit: HIT_LIMIT,
      mode,
      embedder,
      embedTimeoutMs: 60_000,
      recency,
      signal: new AbortController().signal,
      deferHighlight: true,
    });
    return { results: results as SearchHit[], legs };
  };

  /**
   * Retry a degraded search before giving up on the query.
   *
   * The prior revision dropped 41% of its sample this way, NON-UNIFORMLY (56%
   * in the band that carried the whole decision), which is a sampling bias
   * rather than missing data. The cause is this harness's own load: the query
   * embedder sits behind a rate governor with a concurrency limit and an
   * acquisition budget that resolves null on timeout, and firing every arm of
   * every query back-to-back saturates it. Backing off and retrying addresses
   * the cause; the surviving degradations are reported with their reason.
   */
  const search = async (query: string, mode: 'embeddings' | 'hybrid', recency: typeof RECENCY_PROD) => {
    let last: Awaited<ReturnType<typeof once>> | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      last = await once(query, mode, recency);
      if (!last.legs?.degraded) return { ...last, attempts: attempt };
      if (attempt < MAX_ATTEMPTS) await sleep(250 * attempt);
    }
    return { ...last!, attempts: MAX_ATTEMPTS };
  };

  return { search, sampled: sampled.map((r) => ({ ...r })) };
}

type Setup = Awaited<ReturnType<typeof setup>>;
let ctx: Setup | null = null;
let skipReason: string | null = null;
try {
  ctx = await setup();
  if (ctx.sampled.length === 0) {
    skipReason =
      'no logged queries in tool_invocations — this is a FRESH/EMPTY corpus ' +
      '(the createFreshPgDb path), not a measurement';
  }
} catch (err) {
  skipReason = `live operator store unreachable: ${(err as Error).message}`;
}

const idsOf = (hits: SearchHit[]) => new Set(hits.map((h) => h.source_id));
const minus = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x));
const clip = (q: string, n = 40) => (q.length <= n ? q : `${q.slice(0, n - 1)}…`);
/** Nearest-rank percentile on an already-sorted ascending array. */
const pct = (sorted: number[], p: number) =>
  sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;

/** Median + quartiles + mean — D-055: never report a bare mean for this metric. */
function describeDist(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  const mean = s.reduce((t, v) => t + v, 0) / (s.length || 1);
  return {
    n: s.length,
    p25: pct(s, 0.25),
    median: pct(s, 0.5),
    p75: pct(s, 0.75),
    mean,
    sorted: s,
  };
}

const asPct = (v: number) => `${((v / HIT_LIMIT) * 100).toFixed(0)}%`;

describe.skipIf(skipReason !== null)('ranker-leg influence across the real query population', () => {
  /**
   * THE CONTROL, and it runs FIRST because everything else is meaningless
   * without it. The whole harness reads a difference between two runs as
   * evidence about a leg. That inference is only valid if two runs of the SAME
   * configuration agree.
   *
   * Not a hypothetical worry here: D-043 measured session rollup as doubling
   * Report-1 recall and D-044 measured it at exactly zero, because the two ran
   * on different apparatus. A control this cheap would have caught it.
   *
   * The prior revision tested ONE query from ONE band. This tests one per band,
   * because determinism is not obviously band-independent — a short query draws
   * on a far larger and more tied candidate pool, which is exactly where an
   * unstable tie-break would show up.
   */
  it('CONTROL: identical config returns an IDENTICAL set, in every band (else all diffs below are noise)', async () => {
    const { search, sampled } = ctx!;
    const checked: string[] = [];
    for (const band of ['short(1-2)', 'mid(3-14)', 'long(15+)'] as Band[]) {
      const probe = sampled.find((s) => s.band === band);
      if (!probe) continue;
      const a = await search(probe.query, 'hybrid', RECENCY_PROD);
      const b = await search(probe.query, 'hybrid', RECENCY_PROD);
      if (a.legs?.degraded || b.legs?.degraded) {
        checked.push(`${band}: UNVERIFIED (degraded after ${MAX_ATTEMPTS} attempts)`);
        continue;
      }
      const [setA, setB] = [idsOf(a.results), idsOf(b.results)];
      expect(setA.size, `${band}: the probe returned nothing, so it proves nothing`).toBeGreaterThan(0);
      expect(
        minus(setA, setB).length + minus(setB, setA).length,
        `${band}: two identical hybrid runs of "${clip(probe.query)}" DISAGREED — the engine is ` +
          'nondeterministic at this page size, so no difference below can be attributed to a leg.',
      ).toBe(0);
      checked.push(`${band}: deterministic over ${setA.size} hits`);
    }
    console.log(`[D-053] determinism control — ${checked.join(' | ')}`);
    expect(checked.length, 'no band could be probed at all').toBeGreaterThan(0);
  }, 300_000);

  it('measures lexical-leg and fresh-leg influence per band and surface', async () => {
    const { search, sampled } = ctx!;
    type Cell = {
      lexical: number[];
      fresh: number[];
      lexIdentical: number;
      callsWeighted: number;
      callsTotal: number;
      degraded: number;
      reasons: Set<string>;
    };
    const cells = new Map<string, Cell>();
    const cellOf = (k: string) => {
      let c = cells.get(k);
      if (!c) {
        c = { lexical: [], fresh: [], lexIdentical: 0, callsWeighted: 0, callsTotal: 0, degraded: 0, reasons: new Set() };
        cells.set(k, c);
      }
      return c;
    };

    for (const { query, band, surface, calls } of sampled) {
      const key = `${surface} ${band}`;
      const cell = cellOf(key);
      cell.callsTotal += calls;

      const prod = await search(query, 'hybrid', RECENCY_PROD);
      const noFresh = await search(query, 'hybrid', RECENCY_NO_FRESH);
      const semantic = await search(query, 'embeddings', RECENCY_NO_FRESH);

      const bad = [prod, noFresh, semantic].find((r) => r.legs?.degraded);
      if (bad) {
        // A surviving degradation is DATA, not silence: it is counted and its
        // reason retained, so the exclusion is visible in the report.
        cell.degraded += 1;
        cell.reasons.add(bad.legs?.warning ?? 'unknown');
        continue;
      }

      const [p, nf, se] = [idsOf(prod.results), idsOf(noFresh.results), idsOf(semantic.results)];
      const lexicalChurn = minus(nf, se).length; // one knob: the lexical leg
      const freshChurn = minus(p, nf).length; // one knob: the fresh-window leg

      cell.lexical.push(lexicalChurn);
      cell.fresh.push(freshChurn);
      if (lexicalChurn === 0) cell.lexIdentical += 1;
      if (lexicalChurn > 0) cell.callsWeighted += calls;
    }

    const lines: string[] = [];
    for (const [key, c] of [...cells.entries()].sort()) {
      const lex = describeDist(c.lexical);
      const fresh = describeDist(c.fresh);
      const attempted = lex.n + c.degraded;
      lines.push(
        `  ${key.padEnd(26)} n=${String(lex.n).padStart(3)} of ${String(attempted).padStart(3)} attempted` +
          ` (${c.degraded} degraded${c.degraded ? ` — ${[...c.reasons].join('; ').slice(0, 80)}` : ''})\n` +
          `      LEXICAL leg churn   median ${lex.median} (${asPct(lex.median)})  ` +
          `p25 ${lex.p25} / p75 ${lex.p75}  mean ${lex.mean.toFixed(1)}  ` +
          `| ${c.lexIdentical}/${lex.n} pages IDENTICAL without it\n` +
          `      FRESH-window churn  median ${fresh.median} (${asPct(fresh.median)})  ` +
          `p25 ${fresh.p25} / p75 ${fresh.p75}  mean ${fresh.mean.toFixed(1)}\n` +
          `      raw lexical churn: [${lex.sorted.join(' ')}]`,
      );
    }

    // console.LOG, not warn: `vitest-fail-on-console` fails a test on an
    // unexpected warn/error. A deliberate report is not noise.
    console.log(
      `[D-053] ranker-leg influence (k=${HIT_LIMIT}, ${MAX_ATTEMPTS} attempts per search):\n${lines.join('\n')}\n\n` +
        'READ THIS AS:\n' +
        '  • MEDIAN is the typical query; the mean is printed only so a skew is visible (D-055).\n' +
        '  • LEXICAL churn = rows that change when the lexical leg is removed, holding the\n' +
        '    fresh-window leg off in BOTH arms. FRESH churn = rows that change when the\n' +
        '    fresh-window leg is added to production. Each is a ONE-knob comparison.\n' +
        '  • This is INFLUENCE, a CEILING on what improving that leg could affect. It is NOT\n' +
        '    correctness — there is no ground truth here, so it cannot say better or worse.\n' +
        '  • "degraded" rows are EXCLUDED and counted. A band with many is a band whose\n' +
        '    numbers are drawn from a biased subset — read n, not just the median.',
    );

    const measured = [...cells.values()].reduce((n, c) => n + c.lexical.length, 0);
    expect(measured, 'every sampled query degraded — this run measured nothing').toBeGreaterThan(0);
  }, 1_800_000);
});
