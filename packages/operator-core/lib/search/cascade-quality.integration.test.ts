/**
 * WI-37599 — is the two-stage lexical cascade's page influence GOOD?
 *
 * WHY THIS EXISTS. WI-37582 made the cascade the engine default. Two decisions
 * landed together and they cut opposite ways:
 *
 *   D-060  the cascade WORKS: the BM25-silent rate collapsed 30/50/70-90% -> 0-15%,
 *          stage 2 firing on 80/101 queries and appending ~3,883 rows.
 *   D-061  and it bought NOTHING measurable: on the one query family with ground
 *          truth (P-015 Report 1), recall@30 was byte-identical before and after.
 *   D-062  meanwhile the leg went from largely INERT (D-056: pages COMPLETELY
 *          UNCHANGED for 6/20 short, 10/20 mid, 15/20 long) to reshaping nearly
 *          every page (identical now 0-3/20; churn medians 7-13 of a 30-row page).
 *
 * A change that rewrites ~23-43% of every delivered page while its only
 * ground-truth measurement moves by exactly zero is a change doing a great deal
 * with no evidence that what it does is good. A mid/long PRECISION regression
 * would look exactly like this and nothing would catch it: P-015's evals are all
 * short-query, and leg-contribution measures INFLUENCE by construction — churn
 * is not correctness (D-056's own lesson). I shipped it; measuring it is mine.
 *
 * ── THE COMPARISON ────────────────────────────────────────────────────────────
 * One knob. Both arms are production hybrid with production recency; they differ
 * ONLY by `SearchContext.lexicalCascade`:
 *
 *   ON   hybrid, RECENCY_PROD, cascade default (what ships today)
 *   OFF  hybrid, RECENCY_PROD, lexicalCascade: false (what shipped before WI-37582)
 *
 * RECENCY_PROD, not the isolation baseline: the question is whether the page the
 * owner ACTUALLY RECEIVES got worse, and the fresh leg is identical in both arms,
 * so the difference stays attributable to the cascade alone.
 *
 *   INTRODUCED = ON \ OFF   (rows the cascade ADDED to the page)
 *   DISPLACED  = OFF \ ON   (rows it PUSHED OFF to make room)
 *
 * A trade is good if what arrived is at least as semantically close to the query
 * as what left. `SearchHit.rankerScores.embeddings` (P-001/WI-7505) is the
 * per-hit cosine, in real units, so the two sets are directly comparable.
 *
 * ── THE TRAP THIS HARNESS IS BUILT AROUND ────────────────────────────────────
 * `rankerScores` is populated from the POST-FLOOR list (`recordInput`,
 * hybrid.ts:422-437) and is documented ABSENT "for rankers that did not return
 * this hit". So the rows most likely to be missing an `embeddings` score are
 * exactly the LEXICAL-ONLY rows — i.e. precisely the rows the cascade
 * introduces.
 *
 * Comparing only the rows that HAVE a score would therefore restrict the
 * introduced set to the ones the semantic leg ALSO liked — the ones that were
 * already fine — and silently delete the suspect population from the numerator.
 * That is the identical error leg-contribution's own header records as "the
 * single largest error in the earlier numbers" (dropping the zeros overstated
 * the leg). A missing score is MISSING DATA, never a zero, and never a skip.
 *
 * Two mechanisms keep it honest:
 *
 *   1. A DEEP UNFLOORED PROBE recovers the number instead of conceding it.
 *      `mode:'embeddings'` + `minScore:false` (the documented seam at
 *      hybrid.ts:143) + a large limit re-ranks the same corpus by pure cosine
 *      with no floor, so a row the delivered page never scored still gets its
 *      real cosine. This is an INSTRUMENT, not a third arm: it never feeds the
 *      ON/OFF diff, it only looks up numbers for rows that diff produced.
 *
 *   2. COVERAGE IS REPORTED AS A HEADLINE, not a footnote. A row still absent
 *      from the probe's top-N is `beyond` — the semantic ranker places it below
 *      PROBE_LIMIT — which is a FINDING about that row, not an excuse to drop
 *      it. If introduced rows are systematically `beyond` while displaced rows
 *      are scored, that alone answers the question and the cosine medians below
 *      it are a footnote.
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

/**
 * Depth of the unfloored cosine probe. Large enough that a row landing OUTSIDE
 * it is genuinely deep in the semantic ranking rather than merely off the page,
 * so `beyond` carries information instead of just meaning "not in the top 30".
 */
const PROBE_LIMIT = 200;

/** Queries sampled per (band x surface) cell. Corpus-limited in practice. */
const PER_CELL = 20;

/** Attempts per search before a query is recorded as degraded. */
const MAX_ATTEMPTS = 3;

/** Production recency (adv-session-search.ts defaults). */
const RECENCY_PROD = { halfLifeMs: 24 * 7 * 3_600_000, weight: 0.5, freshWindowMs: 48 * 3_600_000 } as const;

type Band = 'short(1-2)' | 'mid(3-14)' | 'long(15+)';
type Surface = 'owner-facing' | 'agent-recall';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The one knob, plus the probe's instrument settings. */
type Arm =
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'probe' };

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
   * The SAME deterministic sample leg-contribution uses — real logged queries,
   * ordered by md5(query) rather than random() so two runs are comparable and a
   * change is attributable. Inventing queries would re-introduce the sampling
   * bias D-053 measured.
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

  // `null`, not undefined: hybrid mode takes `Embedder | null`, and an OMITTED
  // embedder is a type hole rather than a documented degrade.
  // NEVER wrap this value — see the P-017 WeakMap warning in the header.
  const embedder = await buildQueryEmbedder({ acquireBudgetMs: 120_000 }).catch(() => null);
  const sources = SEARCH_SOURCES.filter((s) => s.name === 'session_turn');

  const once = async (query: string, arm: Arm) => {
    const { results, legs } = await runHybridSearch(sources, {
      sql,
      query,
      workspaceId,
      scopeFilter: null,
      limit: arm.kind === 'probe' ? PROBE_LIMIT : HIT_LIMIT,
      mode: arm.kind === 'probe' ? 'embeddings' : 'hybrid',
      embedder,
      embedTimeoutMs: 60_000,
      recency: RECENCY_PROD,
      signal: new AbortController().signal,
      deferHighlight: true,
      // The one knob under test.
      ...(arm.kind === 'off' ? { lexicalCascade: false } : {}),
      // Instrument only: the floor drops rows BEFORE their native scores are
      // recorded, so an unfloored probe is the only way to read the cosine of a
      // row the delivered page declined to score.
      ...(arm.kind === 'probe' ? { minScore: false as const } : {}),
    });
    return { results: results as SearchHit[], legs };
  };

  /**
   * Retry on an unusable SEMANTIC leg — never on `legs.degraded`.
   *
   * `degraded` is a UNION of seven reasons (legs.ts:204), one of which is "the
   * lexical leg contributed zero". On the OFF arm that is the EXPECTED state for
   * a large share of mid/long queries, so retrying on `degraded` would burn
   * MAX_ATTEMPTS on every query the cascade exists to help — tripling this
   * harness's own load against the rate governor for no information, and biasing
   * the sample toward whatever survives it (the 41% non-uniform drop
   * leg-contribution's header records).
   *
   * The only genuine confound is an intermittent embed failure, which makes the
   * two arms different CONFIGURATIONS rather than different pages. Test exactly
   * that, structurally, and nothing else.
   */
  const search = async (query: string, arm: Arm) => {
    let last: Awaited<ReturnType<typeof once>> | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      last = await once(query, arm);
      if ((last.legs?.semantic.candidates ?? 0) > 0) return { ...last, attempts: attempt };
      if (attempt < MAX_ATTEMPTS) await sleep(250 * attempt);
    }
    return { ...last!, attempts: MAX_ATTEMPTS };
  };

  return { search, sql, sampled: sampled.map((r) => ({ ...r })) };
}

/**
 * SPLIT `beyond` INTO ITS TWO OPPOSITE-MEANING POPULATIONS.
 *
 * A row the semantic probe never returned is one of two completely different
 * things, and reporting them as one number would answer the question backwards:
 *
 *   DEEP        the row HAS a vector (its own, or a chunk's) and the ranker
 *               still did not surface it => genuinely semantically distant =>
 *               evidence the cascade is degrading the page.
 *   UNEMBEDDED  the row has NO vector at all. `sources.ts` gates BOTH semantic
 *               legs on `text_embedding IS NOT NULL` / `c.embedding IS NOT NULL`
 *               (:760, :783), so the semantic ranker CANNOT return it at any
 *               depth, with any floor, ever. Its absence says nothing about
 *               relevance — and the lexical leg is then the ONLY path by which
 *               it can EVER reach a page, which makes the cascade the opposite
 *               of a regression for that row.
 *
 * 14.3% of `session_turns` carried no vector when this was written (50,407 of
 * 352,500 — measured, not assumed), so this is a live population, not a corner.
 *
 * `source_id` is `<source_kind>:<session_id>:<turn_idx>` (sources.ts:694/:814);
 * session ids are uuids and contain no colon, so split_part is exact.
 */
async function classifyBeyond(
  sql: Setup['sql'],
  ids: string[],
): Promise<Map<string, 'deep' | 'unembedded'>> {
  const out = new Map<string, 'deep' | 'unembedded'>();
  if (ids.length === 0) return out;
  const rows = await sql<Array<{ sid: string; has_vec: boolean }>>`
    WITH ids AS (SELECT unnest(${ids}::text[]) AS sid),
    p AS (
      SELECT sid,
             split_part(sid, ':', 1) AS source_kind,
             split_part(sid, ':', 2) AS session_id,
             NULLIF(split_part(sid, ':', 3), '')::int AS turn_idx
        FROM ids
    )
    SELECT p.sid,
           (t.text_embedding IS NOT NULL
            OR EXISTS (SELECT 1 FROM harness_shared.session_turn_chunks c
                        WHERE c.source_kind = p.source_kind
                          AND c.session_id  = p.session_id
                          AND c.turn_idx    = p.turn_idx
                          AND c.embedding IS NOT NULL)) AS has_vec
      FROM p
      LEFT JOIN harness_shared.session_turns t
        ON t.source_kind = p.source_kind
       AND t.session_id  = p.session_id
       AND t.turn_idx    = p.turn_idx`;
  for (const r of rows) out.set(r.sid, r.has_vec ? 'deep' : 'unembedded');
  return out;
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
  return { n: s.length, p25: pct(s, 0.25), median: pct(s, 0.5), p75: pct(s, 0.75), mean };
}

const f3 = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : 'n/a');
const rate = (num: number, den: number) => (den === 0 ? 'n/a' : `${((num / den) * 100).toFixed(0)}%`);

/** Where a row's cosine came from — provenance, so coverage is never inferred. */
type CosSource = 'page' | 'probe' | 'beyond';

describe.skipIf(skipReason !== null)('two-stage lexical cascade — page QUALITY, not just influence', () => {
  /**
   * THE CONTROL, first, because every number below is a difference between two
   * runs and that inference is void if two runs of the SAME configuration
   * disagree. D-043 and D-044 measured the same thing as "doubles recall" and
   * "exactly zero" because they ran on different apparatus; a control this cheap
   * would have caught it.
   */
  it('CONTROL: identical config returns an IDENTICAL set, in every band (else all diffs below are noise)', async () => {
    const { search, sampled } = ctx!;
    const checked: string[] = [];
    for (const band of ['short(1-2)', 'mid(3-14)', 'long(15+)'] as Band[]) {
      const probe = sampled.find((s) => s.band === band);
      if (!probe) continue;
      const a = await search(probe.query, { kind: 'on' });
      const b = await search(probe.query, { kind: 'on' });
      // Only a semantic leg that differed BETWEEN the two runs is a genuine
      // confound; a query where the lexical leg is empty is still perfectly
      // determinism-testable. (leg-contribution's third `degraded` trap.)
      if ((a.legs?.semantic.candidates ?? 0) === 0 || (b.legs?.semantic.candidates ?? 0) === 0) {
        checked.push(`${band}: UNVERIFIED (semantic leg empty in one/both runs — not comparable)`);
        continue;
      }
      const [setA, setB] = [idsOf(a.results), idsOf(b.results)];
      expect(setA.size, `${band}: the probe returned nothing, so it proves nothing`).toBeGreaterThan(0);
      expect(
        minus(setA, setB).length + minus(setB, setA).length,
        `${band}: two identical cascade-ON runs of "${clip(probe.query)}" DISAGREED — the engine is ` +
          'nondeterministic at this page size, so no trade below can be attributed to the cascade.',
      ).toBe(0);
      checked.push(`${band}: deterministic over ${setA.size} hits`);
    }
    console.log(`[WI-37599] determinism control — ${checked.join(' | ')}`);
    expect(checked.length, 'no band could be probed at all').toBeGreaterThan(0);
  }, 300_000);

  /**
   * THE INSTRUMENT CONTROL, and it is not optional.
   *
   * The report below leans on a `BEYOND` count — "the unfloored semantic ranker
   * places this row below PROBE_LIMIT" — and reads a high one as a FINDING about
   * the cascade. That reading is only valid if the probe can recover a score at
   * all. A probe that returns nothing, or returns rows carrying no
   * `rankerScores.embeddings`, produces BEYOND = 100% for every row ever passed
   * to it, which is indistinguishable from "the cascade introduces semantically
   * distant rows" while being a statement about the harness instead.
   *
   * That failure would be silent and would read as a strong result — the exact
   * shape of a measurement that is well-formed, confident, and wrong. So the
   * instrument is falsified explicitly, not assumed to work because the numbers
   * look plausible.
   */
  it('INSTRUMENT CONTROL: the deep unfloored probe really recovers cosines (else every BEYOND is an artifact)', async () => {
    const { search, sampled } = ctx!;
    const pick = sampled.find((s) => s.band === 'mid(3-14)') ?? sampled[0]!;
    const probe = await search(pick.query, { kind: 'probe' });
    const scored = probe.results.filter((h) => typeof h.rankerScores?.embeddings === 'number');
    const cos = scored.map((h) => h.rankerScores!.embeddings!).sort((a, b) => b - a);
    console.log(
      `[WI-37599] instrument control on "${clip(pick.query)}" — probe depth ${PROBE_LIMIT}: ` +
        `${probe.results.length} rows returned, ${scored.length} carry rankerScores.embeddings ` +
        `(semantic leg candidates=${probe.legs?.semantic.candidates ?? 0}); ` +
        `cosine range ${f3(cos[cos.length - 1] ?? NaN)}..${f3(cos[0] ?? NaN)}`,
    );
    expect(
      probe.results.length,
      `the deep probe returned ${probe.results.length} rows — it is not reaching past the page, ` +
        'so every BEYOND count is an instrument artifact rather than a finding',
    ).toBeGreaterThan(HIT_LIMIT);
    expect(
      scored.length,
      'the probe returned rows but NONE carry a cosine — it cannot recover a score, ' +
        'so BEYOND means "the probe is broken", not "the semantic ranker places this row deep"',
    ).toBeGreaterThan(0);
  }, 300_000);

  it('compares the cosine of INTRODUCED vs DISPLACED rows, per band and surface', async () => {
    const { search, sampled } = ctx!;
    type Cell = {
      /** Cosine of every row the cascade ADDED, where recoverable. */
      introduced: number[];
      /** Cosine of every row the cascade PUSHED OFF, where recoverable. */
      displaced: number[];
      /** Provenance counts — coverage is a headline, never inferred. */
      introducedBy: Record<CosSource, number>;
      displacedBy: Record<CosSource, number>;
      /** BEYOND ids, kept so they can be split deep-vs-unembedded after the run. */
      introducedBeyond: string[];
      displacedBeyond: string[];
      /** Per-query trade size, so a median cosine is read against how much moved. */
      tradeSize: number[];
      queriesTraded: number;
      queriesMeasured: number;
      unmeasurable: number;
      stage2Fired: number;
      stage2Added: number;
      reasons: Set<string>;
    };
    const cells = new Map<string, Cell>();
    const cellOf = (k: string) => {
      let c = cells.get(k);
      if (!c) {
        c = {
          introduced: [], displaced: [],
          introducedBy: { page: 0, probe: 0, beyond: 0 },
          displacedBy: { page: 0, probe: 0, beyond: 0 },
          introducedBeyond: [], displacedBeyond: [],
          tradeSize: [], queriesTraded: 0, queriesMeasured: 0, unmeasurable: 0,
          stage2Fired: 0, stage2Added: 0, reasons: new Set(),
        };
        cells.set(k, c);
      }
      return c;
    };

    for (const { query, band, surface } of sampled) {
      const cell = cellOf(`${surface} ${band}`);

      const on = await search(query, { kind: 'on' });
      const off = await search(query, { kind: 'off' });

      // STRUCTURAL predicate — "are the two arms comparable?" — never a match on
      // warning prose, which drifts with wording.
      if (on.results.length === 0 || off.results.length === 0) {
        cell.unmeasurable += 1;
        cell.reasons.add(on.legs?.warning ?? off.legs?.warning ?? 'unknown');
        continue;
      }
      cell.queriesMeasured += 1;

      const lexLeg = on.legs?.lexical;
      if (lexLeg && lexLeg.stage2Added > 0) {
        cell.stage2Fired += 1;
        cell.stage2Added += lexLeg.stage2Added;
      }

      const [onIds, offIds] = [idsOf(on.results), idsOf(off.results)];
      const introduced = minus(onIds, offIds);
      const displaced = minus(offIds, onIds);
      cell.tradeSize.push(introduced.length);
      // A query whose page did not move contributes a REAL zero to trade size
      // and simply has no rows to score. It is measured, never skipped.
      if (introduced.length === 0 && displaced.length === 0) continue;
      cell.queriesTraded += 1;

      // The cosine each DELIVERED page already knows.
      const onCos = new Map(on.results.map((h) => [h.source_id, h.rankerScores?.embeddings]));
      const offCos = new Map(off.results.map((h) => [h.source_id, h.rankerScores?.embeddings]));

      // Recover the rest from one unfloored deep probe — fired ONLY when the
      // pages left something unscored, so a query whose rows are all scored
      // costs nothing extra.
      const needsProbe =
        introduced.some((id) => onCos.get(id) === undefined) ||
        displaced.some((id) => offCos.get(id) === undefined);
      const probeCos = new Map<string, number | undefined>();
      if (needsProbe) {
        const probe = await search(query, { kind: 'probe' });
        for (const h of probe.results) probeCos.set(h.source_id, h.rankerScores?.embeddings);
      }

      const resolve = (id: string, pageCos: Map<string, number | undefined>): [number | null, CosSource] => {
        const onPage = pageCos.get(id);
        if (typeof onPage === 'number') return [onPage, 'page'];
        const deep = probeCos.get(id);
        if (typeof deep === 'number') return [deep, 'probe'];
        // Not in the unfloored semantic top-PROBE_LIMIT at all. This is a
        // FINDING about the row (the semantic ranker places it very deep), not
        // a licence to drop it — so it is counted, and deliberately contributes
        // NO number, because inventing one (0, or the floor) would fabricate data.
        return [null, 'beyond'];
      };

      for (const id of introduced) {
        const [cos, src] = resolve(id, onCos);
        cell.introducedBy[src] += 1;
        if (cos !== null) cell.introduced.push(cos);
      }
      for (const id of displaced) {
        const [cos, src] = resolve(id, offCos);
        cell.displacedBy[src] += 1;
        if (cos !== null) cell.displaced.push(cos);
      }
    }

    const lines: string[] = [];
    let totalIntroduced = 0;
    let totalDisplaced = 0;
    for (const [key, c] of [...cells.entries()].sort()) {
      const ins = describeDist(c.introduced);
      const dis = describeDist(c.displaced);
      const trade = describeDist(c.tradeSize);
      const inTotal = c.introducedBy.page + c.introducedBy.probe + c.introducedBy.beyond;
      const disTotal = c.displacedBy.page + c.displacedBy.probe + c.displacedBy.beyond;
      totalIntroduced += inTotal;
      totalDisplaced += disTotal;
      const delta = ins.n > 0 && dis.n > 0 ? ins.median - dis.median : NaN;
      lines.push(
        `  ${key.padEnd(26)} ${c.queriesMeasured} measured (${c.unmeasurable} unmeasurable` +
          `${c.unmeasurable ? `: ${[...c.reasons].join('; ').slice(0, 60)}` : ''}), ` +
          `${c.queriesTraded} traded at least one row\n` +
          `      CASCADE stage 2 fired for ${c.stage2Fired}/${c.queriesMeasured} queries, appending ${c.stage2Added} rows\n` +
          `      TRADE SIZE per query   median ${trade.median} of ${HIT_LIMIT} rows  p25 ${trade.p25} / p75 ${trade.p75}\n` +
          `      INTRODUCED n=${inTotal}  cosine median ${f3(ins.median)}  p25 ${f3(ins.p25)} / p75 ${f3(ins.p75)}  ` +
          `[scored on page ${rate(c.introducedBy.page, inTotal)}, recovered by probe ${rate(c.introducedBy.probe, inTotal)}, ` +
          `BEYOND top-${PROBE_LIMIT} ${rate(c.introducedBy.beyond, inTotal)}]\n` +
          `      DISPLACED  n=${disTotal}  cosine median ${f3(dis.median)}  p25 ${f3(dis.p25)} / p75 ${f3(dis.p75)}  ` +
          `[scored on page ${rate(c.displacedBy.page, disTotal)}, recovered by probe ${rate(c.displacedBy.probe, disTotal)}, ` +
          `BEYOND top-${PROBE_LIMIT} ${rate(c.displacedBy.beyond, disTotal)}]\n` +
          `      VERDICT INPUT: median(introduced) - median(displaced) = ${f3(delta)}` +
          ` over ${ins.n} vs ${dis.n} scored rows`,
      );
    }

    // console.LOG, not warn: `vitest-fail-on-console` fails a test on an
    // unexpected warn/error. A deliberate report is not noise.
    console.log(
      `[WI-37599] cascade page-quality (k=${HIT_LIMIT}, probe depth ${PROBE_LIMIT}, ` +
        `${MAX_ATTEMPTS} attempts per search):\n${lines.join('\n')}\n\n` +
        'READ THIS AS — the reading was fixed BEFORE the numbers were seen:\n' +
        '  • INTRODUCED cosine systematically LOWER than DISPLACED => the widening is\n' +
        '    DEGRADING pages. Trigger tuning becomes urgent and a partial revert is on\n' +
        '    the table.\n' +
        '  • INTRODUCED ~= DISPLACED => neutral churn: it buys recall without hurting\n' +
        '    quality, and the (still unmeasured) latency cost decides the trigger.\n' +
        '  • INTRODUCED HIGHER => the widening genuinely improves pages; leave the\n' +
        '    trigger alone and say so.\n' +
        '  • READ COVERAGE FIRST. The cosine medians are CONDITIONAL on the rows that\n' +
        '    could be scored. `rankerScores` is populated post-floor and is absent for\n' +
        '    rankers that did not return a hit, so the rows most likely to lack one are\n' +
        '    exactly the lexical-only rows the cascade introduces. A high BEYOND rate on\n' +
        '    INTRODUCED with a low one on DISPLACED IS the finding — the cascade would be\n' +
        '    trading semantically-ranked rows for rows the semantic ranker puts below\n' +
        `    rank ${PROBE_LIMIT} — and it makes the medians beside it a footnote, because\n` +
        '    those medians then describe only the introduced rows that were already fine.\n' +
        '  • A BEYOND row contributes NO number. Scoring it 0, or at the floor, would\n' +
        '    fabricate data; counting it is what keeps the median honest.\n' +
        '  • MEDIAN + quartiles, never a bare mean (D-055 was retracted for exactly that).\n' +
        '  • This is a two-arm SET DIFFERENCE, so it needs no ground truth and scales to\n' +
        '    the whole query population — the method that broke the one-query trap.',
    );

    expect(
      totalIntroduced + totalDisplaced,
      'the cascade traded no rows at all across the entire sample — nothing was measured',
    ).toBeGreaterThan(0);
  }, 1_800_000);
});
