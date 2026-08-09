/**
 * DOES THE LEXICAL LEG CHANGE WHAT COMES BACK? — measured across the REAL
 * query population (plan semantic-search-fingerprint-coverage-2026-08-03, D-053).
 *
 * ┌ WHY THIS EXISTS ──────────────────────────────────────────────────────────┐
 * │ P-035 asks whether to ship a Postgres BM25 extension. That argument has    │
 * │ been conducted entirely on ONE query — the single word `theory` — and      │
 * │ D-041's own conclusion says BM25 is irrelevant at |Q|=1. So the decision   │
 * │ has been debated using evidence drawn exclusively from the one regime      │
 * │ where the thing under discussion is agreed not to matter.                  │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ── WHY THIS NEEDS NO GROUND TRUTH ──────────────────────────────────────────
 * Hand-graded relevance is the expensive part of an eval, and needing it is
 * exactly what pinned this plan to a single query for a week. But P-035's real
 * question is not "are the results GOOD", it is "does the lexical leg CHANGE
 * anything" — and that is a SET DIFFERENCE between a hybrid run and an
 * embeddings-only run. No human grading is required to answer it.
 *
 * If removing the lexical leg barely changes the page across a real sample,
 * then a better lexical ranker cannot matter much either, whatever its
 * benchmark scores. If it changes the page a lot, BM25 quality is load-bearing
 * and P-035 deserves real consideration. Either way the answer is measured
 * rather than argued.
 *
 * ── A COUNT IS NOT A SET (D-052, retracted the same day it was written) ─────
 * This harness compares SETS, never counts, because counts have already
 * produced a false conclusion on this exact plan: two configurations both
 * scored 2/8 on Report 1 and were reported as "the lexical leg contributes
 * nothing", when in fact they recalled DIFFERENT sessions — the leg added one
 * and displaced another. Equal counts, opposite meaning. Every metric below is
 * therefore a set operation, and the per-query rows print identities.
 *
 * ── THE ONE KNOB RULE ───────────────────────────────────────────────────────
 * `mode:'embeddings'` does NOT merely drop the lexical leg: hybrid.ts gates the
 * 48h fresh-window candidate leg on `mode === 'hybrid'`, so switching modes
 * silently drops that too. Both arms therefore run with recency ON but
 * `freshWindowMs: 0`, which neutralises the fresh leg on BOTH sides and leaves
 * the lexical leg as the only difference. Without this pairing the comparison
 * is two knobs reported as one.
 *
 * The `minScore` floor is NOT a third knob, and this was verified rather than
 * assumed: mode reaches the host policy, but that policy branches only on
 * `mode === 'fulltext'` (configure-search-defaults.ts), so 'hybrid' and
 * 'embeddings' resolve an identical floor.
 *
 * ── IT REPORTS; IT DOES NOT GATE QUALITY ────────────────────────────────────
 * There is no ground truth for a sampled query, so any quality floor here would
 * be invented. Inventing floors is the failure mode this plan keeps repeating,
 * so the only assertions are (a) non-vacuity — a run that measured nothing must
 * never read as a pass — and (b) the determinism control below.
 */
import { describe, expect, it } from 'vitest';
import type { SearchHit } from '@papercusp/search';

/** The route's real page size (the desktop agents-pill sends limit=30). */
const HIT_LIMIT = 30;

/**
 * Queries sampled per length band. Deterministic — see the md5 ordering.
 *
 * Sized against the failure this harness exists to correct: the plan drew a
 * week of conclusions from ONE query, so replacing that with four per band
 * would be the same mistake with a bigger number. The whole run costs a few
 * seconds, so the sample is bounded by how many DISTINCT queries the corpus
 * actually holds in each band, not by runtime.
 */
const PER_BAND = 25;

/**
 * Production recency with the fresh-window leg NEUTRALISED — applied to BOTH
 * arms. See "THE ONE KNOB RULE" above; this is not a tuning choice, it is what
 * makes the two arms differ by the lexical leg alone.
 */
const RECENCY_NO_FRESH = {
  halfLifeMs: 24 * 7 * 3_600_000,
  weight: 0.5,
  freshWindowMs: 0,
} as const;

type Band = 'short(1-2)' | 'mid(3-14)' | 'long(15+)';

/** Everything this harness needs from the live store + engine. */
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
   * re-introduce the very sampling bias D-053 measured.
   *
   * Restricted to the two OWNER-FACING search surfaces: `memory:search` is a
   * different surface with a different caller mix (overwhelmingly agent recall,
   * median 15 terms) and pooling it would swamp the sample.
   *
   * Ordered by md5(query), NOT random(): a random sample would draw a different
   * query set on every run, so two runs could never be compared and any change
   * would be unattributable.
   */
  const sampled = await sql<Array<{ query: string; terms: number; band: Band }>>`
    WITH q AS (
      SELECT DISTINCT trim(args_json->>'query') AS query
        FROM harness_shared.tool_invocations
       WHERE tool_name IN ('search:fulltext', 'sessions:search')
         AND args_json ? 'query'
         AND workspace_id = ${workspaceId}
         AND trim(coalesce(args_json->>'query', '')) <> ''
    ),
    banded AS (
      SELECT query,
             array_length(regexp_split_to_array(query, '\\s+'), 1) AS terms,
             CASE
               WHEN array_length(regexp_split_to_array(query, '\\s+'), 1) <= 2 THEN 'short(1-2)'
               WHEN array_length(regexp_split_to_array(query, '\\s+'), 1) <= 14 THEN 'mid(3-14)'
               ELSE 'long(15+)'
             END AS band
        FROM q
    ),
    ranked AS (
      SELECT query, terms, band,
             row_number() OVER (PARTITION BY band ORDER BY md5(query)) AS rn
        FROM banded
    )
    SELECT query, terms, band FROM ranked WHERE rn <= ${PER_BAND} ORDER BY band, rn`;

  // `null`, not undefined: hybrid mode takes `embedder: Embedder | null`, and an
  // OMITTED embedder is a type hole rather than a documented degrade.
  const embedder = await buildQueryEmbedder({ acquireBudgetMs: 30_000 }).catch(() => null);
  const sources = SEARCH_SOURCES.filter((s) => s.name === 'session_turn');

  const search = async (query: string, mode: 'embeddings' | 'hybrid') => {
    const { results, legs } = await runHybridSearch(sources, {
      sql,
      query,
      workspaceId,
      scopeFilter: null,
      limit: HIT_LIMIT,
      mode,
      embedder,
      embedTimeoutMs: 30_000,
      recency: RECENCY_NO_FRESH,
      signal: new AbortController().signal,
      deferHighlight: true,
    });
    return { results: results as SearchHit[], legs };
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
      'no logged queries in tool_invocations for the owner-facing search surfaces — ' +
      'this is a FRESH/EMPTY corpus (the createFreshPgDb path), not a measurement';
  }
} catch (err) {
  skipReason = `live operator store unreachable: ${(err as Error).message}`;
}

const idsOf = (hits: SearchHit[]) => new Set(hits.map((h) => h.source_id));
const minus = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x));
const clip = (q: string, n = 46) => (q.length <= n ? q : `${q.slice(0, n - 1)}…`);

describe.skipIf(skipReason !== null)('lexical-leg contribution across the real query population', () => {
  /**
   * THE CONTROL, and it runs FIRST because everything else is meaningless
   * without it. The whole harness reads a difference between two runs as
   * evidence about the lexical leg. That inference is only valid if two runs of
   * the SAME configuration agree — otherwise a between-arm difference is
   * indistinguishable from run-to-run nondeterminism.
   *
   * This is not a hypothetical worry on this plan: D-043 measured session
   * rollup as doubling Report-1 recall and D-044 measured it at exactly zero,
   * because the two were measured on different apparatus. A control this cheap
   * would have caught it.
   */
  it('CONTROL: the same query in the same mode returns an IDENTICAL set (else every diff below is noise)', async () => {
    const { search, sampled } = ctx!;
    const probe = sampled[0]!;
    const a = await search(probe.query, 'hybrid');
    const b = await search(probe.query, 'hybrid');
    if (a.legs?.degraded || b.legs?.degraded) {
      // A degraded run measured a different system; it cannot certify determinism.
      console.log(`[leg-contribution] CONTROL skipped — engine degraded: ${a.legs?.warning ?? b.legs?.warning}`);
      return;
    }
    const [setA, setB] = [idsOf(a.results), idsOf(b.results)];
    expect(setA.size, 'the probe query returned nothing, so the control proves nothing').toBeGreaterThan(0);
    expect(
      minus(setA, setB).length + minus(setB, setA).length,
      `two identical hybrid runs of "${clip(probe.query)}" disagreed — the engine is ` +
        'nondeterministic at this page size, so a hybrid-vs-embeddings difference cannot be ' +
        'attributed to the lexical leg. Fix this before reading any row below.',
    ).toBe(0);
  }, 120_000);

  it('reports what the lexical leg adds and displaces, per query and per band', async () => {
    const { search, sampled } = ctx!;
    const rows: string[] = [];
    const perBand = new Map<Band, { queries: number; added: number; displaced: number; identical: number }>();

    for (const { query, terms, band } of sampled) {
      const hybrid = await search(query, 'hybrid');
      const semantic = await search(query, 'embeddings');
      if (hybrid.legs?.degraded || semantic.legs?.degraded) {
        rows.push(`  ${band} t=${terms} "${clip(query)}" SKIPPED — engine degraded`);
        continue;
      }

      const h = idsOf(hybrid.results);
      const s = idsOf(semantic.results);
      const added = minus(h, s); // present only WITH the lexical leg
      const displaced = minus(s, h); // pushed off the page BY the lexical leg
      const overlap = h.size + s.size === 0 ? 0 : [...h].filter((x) => s.has(x)).length;
      const union = new Set([...h, ...s]).size;

      // Attribution from the engine's own pre-fusion scores, where it populated
      // them. `rankerScores` is OPTIONAL and per-hit — read it, never assume a
      // key is present (a missing key means that ranker did not return the hit,
      // NOT that it scored zero).
      const lexicalOnly = hybrid.results.filter((hit) => {
        const rs = hit.rankerScores;
        if (!rs) return false;
        const keys = Object.keys(rs);
        return keys.some((k) => k.startsWith('lexical')) && !keys.some((k) => k.startsWith('embed'));
      }).length;

      const agg = perBand.get(band) ?? { queries: 0, added: 0, displaced: 0, identical: 0 };
      agg.queries += 1;
      agg.added += added.length;
      agg.displaced += displaced.length;
      if (added.length === 0 && displaced.length === 0) agg.identical += 1;
      perBand.set(band, agg);

      rows.push(
        `  ${band.padEnd(11)} t=${String(terms).padStart(2)} "${clip(query)}"\n` +
          `      hybrid ${h.size} / semantic-only ${s.size} / overlap ${overlap} of ${union}` +
          `  → +${added.length} added, -${displaced.length} displaced by the lexical leg` +
          `  (lexical-only hits in hybrid page: ${lexicalOnly})`,
      );
    }

    const summary = [...perBand.entries()].map(
      ([band, a]) =>
        `  ${band.padEnd(11)} ${a.queries} queries — ${a.added} added, ${a.displaced} displaced, ` +
        `${a.identical}/${a.queries} pages IDENTICAL with and without the lexical leg`,
    );

    // console.LOG, not warn: `vitest-fail-on-console` fails a test on an
    // unexpected warn/error, and its escape hatch is an infrastructure-NOISE
    // allowlist. A deliberate report is not noise.
    console.log(
      `[D-053] lexical-leg contribution (k=${HIT_LIMIT}, recency on, fresh-window neutralised in BOTH arms):\n` +
        `${rows.join('\n')}\n\nBY BAND:\n${summary.join('\n')}\n\n` +
        'READ THIS AS: "pages IDENTICAL" counts queries where removing the lexical leg changed\n' +
        'NOTHING. A band that is mostly identical is a band where BM25 quality cannot matter,\n' +
        'whatever a ranker benchmark says. A band with high added/displaced is one where it can.\n' +
        'This measures INFLUENCE, not correctness — there is no ground truth here, so it cannot\n' +
        'say whether what the lexical leg adds is BETTER, only that it is DIFFERENT.',
    );

    // Non-vacuity: a run that measured nothing must never read as a pass. This
    // is the same guard the P-015 eval carries, for the same reason.
    const measured = [...perBand.values()].reduce((n, a) => n + a.queries, 0);
    expect(measured, 'every sampled query degraded — this run measured nothing').toBeGreaterThan(0);
  }, 600_000);
});
