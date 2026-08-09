/**
 * corpus-clarity-validity-cli.ts — P-019 / D-088 R5: does clarity PREDICT anything?
 *
 *   npx tsx packages/operator-core/lib/memory/bench/corpus-clarity-validity-cli.ts \
 *     --queries 400 [--seed 17] [--workspace papercusp-workspace] [--concurrency 4]
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `corpus-query-clarity-cli.ts` measured the DISTRIBUTION of clarity over real
 * traffic (19.7% traffic-weighted escalation). D-088 R5 states plainly that this
 * establishes nothing about VALIDITY: no measurement anywhere shows that a
 * low-clarity query actually retrieves worse. Until that is tested, "19.7% of
 * traffic is unfocused" must never be restated as "19.7% retrieves badly", and
 * `CORPUS_CLARITY_FOCUSED_BITS` is an arbitrary placeholder that every published
 * rate is silently quoted at.
 *
 * This probe pairs the PREDICTOR with the REAL leg's OUTCOME on the SAME query,
 * so the association can be measured instead of assumed.
 *
 * ─── THE PREDICTOR SIDE ──────────────────────────────────────────────────────
 *
 * `assessCorpusQueryClarity(text, { df, ndocs })` — ISSUED scope (the ≤2 terms
 * retrieval actually sees). Scoring the candidate POOL instead is a length meter
 * and returns 87.7% escalation against the same threshold on the same queries;
 * see the warning on `assessCorpusQueryClarity`. Do not "improve" this probe by
 * widening the scope.
 *
 * ─── THE OUTCOME SIDE, AND WHAT EACH NUMBER CAN AND CANNOT ESTABLISH ─────────
 *
 * Outcomes are LABEL-FREE. There is no gold set for this leg, and the one
 * tempting substitute is barred: a known-item set whose query is derived FROM
 * the target document makes the target match every query term BY CONSTRUCTION
 * (`corpus-leg-lexical-acceptance-cli.ts` refuses to report an MRR for exactly
 * this reason). Two outcomes are measured instead, and they answer DIFFERENT
 * questions — reading either alone gets the sign wrong:
 *
 *   FILL / ZERO-HIT  How many of the leg's 6 slots got filled; how often it
 *                    admits nothing at all. This is the leg's OPERATIONAL
 *                    failure mode.
 *
 *     ⚠⚠ FILL IS MECHANICALLY ANTI-CORRELATED WITH CLARITY, and that is not a
 *     finding — it is arithmetic. Stage 1 ANDs its lexemes (`plainto_tsquery`),
 *     so a query of two RARE terms matches FEW documents and can match none,
 *     while two COMMON terms match many. High clarity therefore BUYS zero-hits.
 *     A negative clarity→fill slope is the expected shape and is NOT evidence
 *     that the predictor's construct is wrong; a POSITIVE one would be the
 *     surprise. What fill does settle is the CASCADE'S question: if the queries
 *     that return nothing are the FOCUSED ones, then escalating `unfocused` is
 *     spending money on the queries that already work while ignoring the ones
 *     that fail — and the escalation trigger is pointed the wrong way round.
 *
 *   POST-RETRIEVAL CLARITY  KL divergence of the RETRIEVED set's language model
 *                    from the collection's, in bits, over the same attested-term
 *                    support and the same estimator as the predictor
 *                    (`SCS = Σ P(w|Q)·log2(P(w|Q)/P(w|C))` with `P(w|Q)` uniform
 *                    over query terms reduces to `avgIdf − log2(n)`; swap in
 *                    `P(w|R)` from the retrieved set and you have the
 *                    Cronen-Townsend et al. (2002) clarity that the pre-retrieval
 *                    SCS is an approximation OF).
 *
 *     This is the CONSTRUCT test: SCS's entire claim is that it cheaply predicts
 *     how concentrated the result distribution will be. If pre-retrieval SCS
 *     does not track post-retrieval clarity, the predictor fails on its own
 *     terms and no threshold can rescue it. It is not a relevance measure and
 *     must not be reported as one.
 *
 * ─── THE CONTROL ─────────────────────────────────────────────────────────────
 *
 * Every association is recomputed against a PERMUTED pairing — each query's
 * clarity against a DIFFERENT query's outcome. All of them must collapse to ≈0.
 * This falsifies "the harness manufactures the correlation" (shared sampling,
 * shared clamping, shared corpus instant), which no amount of care in the
 * measurement itself can rule out. It reuses the measured outcomes, so it costs
 * nothing.
 *
 * ⛔ THIS PROBE DOES NOT PICK A THRESHOLD, AND MUST NOT BE MADE TO.
 * `CORPUS_CLARITY_FOCUSED_BITS` is calibrated by a KNEE in the measured curve or
 * not at all. Choosing a percentile fits the constant to the sample; fitting to
 * the Coverage Illusion's 27.8% fits it to the number the work set out to
 * reproduce. Both produce a confident constant that encodes nothing.
 *
 * ⚠ PROXY POPULATION, inherited from the distribution probe and equally
 * non-negotiable: `memory_recall_stats` stores `query_sha256`, not the query
 * text (P-041), so the injected strings are unrecoverable. These are real
 * `speaker='user'` turns clamped to each surface's MEASURED median width, with
 * each prompt assigned a surface by the live traffic mix — so the sample is
 * traffic-weighted by construction and one retrieval covers one query.
 *
 * READ-ONLY. Writes nothing, seeds nothing, mutates no tree.
 */
import { getOrgPg } from '@papercusp/db-org';

import {
  assessCorpusQueryClarity,
  CORPUS_CLARITY_FOCUSED_BITS,
  clarityWarrantsEscalation,
  type QueryClarityVerdict,
} from '../corpus-query-clarity';
import { CORPUS_MAX_ITEMS, corpusTerms } from '../corpus-recall';
import { recallCorpusContext, warmCorpusEmbedder } from '../corpus-recall-io';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const QUERIES = Number(argValue('--queries') ?? 400);
const SEED = argValue('--seed') ?? '17';
const WORKSPACE = argValue('--workspace') ?? 'papercusp-workspace';
const CONCURRENCY = Math.max(1, Number(argValue('--concurrency') ?? 4));
/** Surfaces worth weighting. Anything rarer is noise at this sample size. */
const SURFACE_FLOOR_PCT = 1;

const VERDICTS: QueryClarityVerdict[] = [
  'keyed',
  'focused',
  'unfocused',
  'unretrievable',
  'unknown',
];

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`);
const f2 = (n: number | null): string => (n === null || !Number.isFinite(n) ? '—' : n.toFixed(2));

/** FNV-1a → [0,1). Deterministic surface assignment without pulling in a PRNG. */
function unitHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x100000000;
}

function mean(xs: readonly number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Average ranks, ties shared — required for Spearman on a series with many
 *  equal values (zero-fill is a huge tie group here, so mishandling ties would
 *  quietly bias every correlation toward zero). */
function averageRanks(xs: readonly number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]!.v === idx[i]!.v) j++;
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k]!.i] = shared;
    i = j + 1;
  }
  return ranks;
}

/**
 * Spearman ρ under B random pairings — the null distribution, NOT a single
 * control draw.
 *
 * ⚠ A SINGLE permutation is a sample of size ONE from this distribution, and at
 * these n its standard error is ≈1/√(n−1) — about 0.17 at n=36. Measured on the
 * N=40 smoke run, one draw returned a control ρ of −0.204 against a real ρ of
 * −0.107, i.e. the control was LARGER than the effect it was supposed to bound.
 * Read as a pass/fail that reads as "the harness manufactures the association";
 * read as a threshold it silently licences whatever the real column says. Only
 * the ensemble makes "≈0" a testable claim, and it also yields the exact
 * quantity the study needs — how often chance alone reaches the observed ρ.
 */
function permutationNull(
  x: readonly number[],
  y: readonly number[],
  observed: number,
  draws = 999,
): { mean: number; lo: number; hi: number; p: number } | null {
  if (x.length < 3) return null;
  const rhos: number[] = [];
  let atLeastAsExtreme = 0;
  for (let b = 0; b < draws; b++) {
    const r = spearman(x, permute(y, b + 1));
    if (r === null) continue;
    rhos.push(r);
    if (Math.abs(r) >= Math.abs(observed)) atLeastAsExtreme++;
  }
  if (rhos.length === 0) return null;
  rhos.sort((a, b) => a - b);
  const at = (q: number): number => rhos[Math.min(rhos.length - 1, Math.floor(q * rhos.length))]!;
  return {
    mean: mean(rhos)!,
    lo: at(0.025),
    hi: at(0.975),
    // +1 in both terms: the observed pairing is itself one of the possible
    // arrangements, so a p of exactly 0 is not attainable and must not be printed.
    p: (atLeastAsExtreme + 1) / (rhos.length + 1),
  };
}

/** Spearman ρ. `null` when either series is constant (ρ is undefined, NOT 0 —
 *  reporting 0 there would read as "measured no association"). */
function spearman(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length < 3) return null;
  const ra = averageRanks(a);
  const rb = averageRanks(b);
  const ma = mean(ra)!;
  const mb = mean(rb)!;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i++) {
    const x = ra[i]! - ma;
    const y = rb[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

/**
 * Deterministic Fisher-Yates over a seeded LCG — the CONTROL pairing.
 *
 * ⚠ Deliberately a full shuffle rather than a rotation. A rotation preserves the
 * series' ordering structure, so if sample position carried ANY signal the
 * control would inherit it and could mask a manufactured association — the one
 * thing this control exists to detect.
 */
function permute<T>(xs: readonly T[], seed = 1): T[] {
  const out = [...xs];
  let s = (Math.imul(seed, 0x9e3779b9) ^ 0x85ebca6b) >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Post-retrieval clarity in bits: KL(P(·|R) ‖ P(·|C)) over attested terms, using
 * the SAME estimator and the SAME attestation rule as the pre-retrieval
 * predictor (see `scoreCorpusQueryClarity` — unattested terms have `P(w|C) = 0`
 * and infinite KL, so they are excluded from the score and counted separately).
 * `null` when the retrieved set has no attested term at all.
 */
function postRetrievalClarity(
  texts: readonly string[],
  df: (t: string) => number,
  ndocs: number,
  minDf: number,
): { bits: number | null; attestedRatio: number | null } {
  const tf = new Map<string, number>();
  let total = 0;
  let attestedTotal = 0;
  for (const t of texts) {
    for (const term of corpusTerms(t)) {
      total++;
      if (df(term) >= minDf) {
        tf.set(term, (tf.get(term) ?? 0) + 1);
        attestedTotal++;
      }
    }
  }
  if (attestedTotal === 0) {
    return { bits: null, attestedRatio: total > 0 ? 0 : null };
  }
  let bits = 0;
  for (const [term, count] of tf) {
    const pr = count / attestedTotal;
    const pc = df(term) / ndocs;
    bits += pr * (Math.log(pr / pc) / Math.LN2);
  }
  return { bits, attestedRatio: attestedTotal / total };
}

/** The teaser sits between the `] ` label and the ` → ` resolve call. Scoring
 *  the whole rendered line would fold the handle boilerplate — present in EVERY
 *  line — into the retrieved language model, damping every divergence toward a
 *  shared constant. */
function teaserOf(line: string): string {
  const start = line.indexOf('] ');
  const end = line.lastIndexOf(' → ');
  if (start < 0) return line;
  return end > start ? line.slice(start + 2, end) : line.slice(start + 2);
}

interface SurfaceMix {
  surface: string;
  recalls: number;
  share: number;
  clampChars: number;
}

interface Sample {
  surface: string;
  chars: number;
  verdict: QueryClarityVerdict;
  scs: number | null;
  escalates: boolean;
  /** Lines the leg ADMITTED — what the agent actually sees. */
  admitted: number;
  /** Candidates the engine returned, before selection. */
  pool: number;
  outcome: string;
  postBits: number | null;
  postAttested: number | null;
  ms: number;
  embedder: boolean;
}

/** Run `fn` over `items` with bounded concurrency, preserving input order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

function bucketRow(label: string, rows: readonly Sample[], total: number): string {
  const zero = rows.filter((r) => r.admitted === 0).length;
  const full = rows.filter((r) => r.admitted >= CORPUS_MAX_ITEMS).length;
  const post = rows.map((r) => r.postBits).filter((b): b is number => b !== null);
  return (
    `| ${label} | ${rows.length} | ${pct(rows.length, total)} | ${pct(zero, rows.length)} | ` +
    `${f2(mean(rows.map((r) => r.admitted)))} | ${pct(full, rows.length)} | ` +
    `${f2(mean(rows.map((r) => r.pool)))} | ${f2(mean(post))} | ${post.length} |`
  );
}

async function main(): Promise<void> {
  const { sql } = getOrgPg();

  // ── The DF signal, read exactly as the leg's own lookup builds it. ──
  const dfRows = (await sql`
    SELECT term, df, ndocs FROM harness_shared.corpus_term_df WHERE workspace_id = ${WORKSPACE}
  `) as unknown as Array<{ term: string; df: number; ndocs: number }>;

  if (dfRows.length === 0) {
    console.log(
      `> ⚠ **SKIPPED — no \`corpus_term_df\` table for workspace ${WORKSPACE}.** ` +
        `Every verdict would be \`unknown\` by construction, so the association is ` +
        `unmeasurable, not absent.`,
    );
    return;
  }

  const dfMap = new Map<string, number>();
  for (const r of dfRows) dfMap.set(r.term, r.df);
  const ndocs = dfRows[0]!.ndocs;
  const df = (term: string): number => dfMap.get(term) ?? 0;
  const MIN_DF = 2; // CORPUS_QUERY_MIN_DF — the leg's own attestation floor.

  // ── The live surface mix. MEASURED: assuming it is the documented trap. ──
  const mixRows = (await sql`
    SELECT surface,
           count(*)::int AS recalls,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY query_chars)::int AS p50
      FROM harness_shared.memory_recall_stats
     WHERE query_chars IS NOT NULL
       AND created_at > now() - interval '7 days'
       AND (workspace_id = ${WORKSPACE} OR workspace_id IS NULL)
     GROUP BY surface
     ORDER BY recalls DESC
  `) as unknown as Array<{ surface: string; recalls: number; p50: number }>;

  const totalRecalls = mixRows.reduce((n, r) => n + r.recalls, 0);
  const kept = mixRows.filter((r) => (r.recalls / Math.max(totalRecalls, 1)) * 100 >= SURFACE_FLOOR_PCT);
  const keptRecalls = kept.reduce((n, r) => n + r.recalls, 0);
  const mix: SurfaceMix[] = kept.map((r) => ({
    surface: r.surface,
    recalls: r.recalls,
    share: r.recalls / Math.max(keptRecalls, 1),
    clampChars: r.p50,
  }));

  // ── The proxy population: identical sampling to the distribution probe, so
  //    the two runs describe the SAME population and their numbers compose. ──
  const turns = (await sql`
    SELECT text
      FROM harness_shared.session_turns
     WHERE (workspace_id = ${WORKSPACE} OR workspace_id = 'default')
       AND speaker = 'user'
       AND length(text) >= 40
     ORDER BY md5(source_kind || session_id || turn_idx::text || ${SEED})
     LIMIT ${QUERIES}
  `) as unknown as Array<{ text: string }>;

  console.log(`# P-019 / D-088 R5 — does query clarity PREDICT retrieval outcome?\n`);
  console.log(
    `workspace=${WORKSPACE} · df_terms=${dfRows.length.toLocaleString()} · ndocs=${ndocs.toLocaleString()} · ` +
      `sampled_prompts=${turns.length.toLocaleString()} · seed=${SEED} · ` +
      `focusedBits=${CORPUS_CLARITY_FOCUSED_BITS} · concurrency=${CONCURRENCY}\n`,
  );
  console.log(
    `⚠ PROXY POPULATION — real submitted prompts clamped to each surface's measured median width, ` +
      `surface-assigned by the live mix. \`memory_recall_stats\` stores query_sha256, not text (P-041), ` +
      `so these are not the exact injected strings.\n`,
  );
  if (CONCURRENCY > 1) {
    console.log(
      `⚠ concurrency=${CONCURRENCY}: the latency column is NOT comparable to production single-flight ` +
        `timings. It is reported only to show the leg ran inside its bound.\n`,
    );
  }

  // Assign each prompt a surface by the live share, deterministically.
  const assigned = turns.map((t) => {
    const u = unitHash(t.text + SEED);
    let acc = 0;
    let picked = mix[mix.length - 1]!;
    for (const m of mix) {
      acc += m.share;
      if (u < acc) {
        picked = m;
        break;
      }
    }
    return { text: t.text.slice(0, picked.clampChars), surface: picked.surface };
  });

  // ⚠ EI-19460902984682209: the leg uses the embedder ONLY when it is ALREADY
  // warm — a cold request degrades to BM25-only and leaves the warmup running
  // behind it, deliberately. So a bench that merely issues a throwaway query
  // does NOT warm the arm: measured on the N=40 smoke run, `embedderAvailable`
  // came back 0.0% for every one of 40 queries, i.e. the whole study would have
  // been a BM25-only arm silently labelled as the production leg. AWAIT the
  // acquisition explicitly, then report the achieved rate either way — a
  // BM25-only run is a legitimate arm, but it must be a STATED one.
  await warmCorpusEmbedder();

  const t0 = Date.now();
  const samples = await mapLimit(assigned, CONCURRENCY, async (a): Promise<Sample> => {
    const clarity = assessCorpusQueryClarity(a.text, { df, ndocs, minDf: MIN_DF });
    const started = Date.now();
    const res = await recallCorpusContext({
      queryText: a.text,
      workspaceId: WORKSPACE,
      skipFlagCheck: true,
    });
    const ms = Date.now() - started;
    const post = postRetrievalClarity(res.lines.map((l) => teaserOf(l.line)), df, ndocs, MIN_DF);
    return {
      surface: a.surface,
      chars: a.text.length,
      verdict: clarity.verdict,
      scs: clarity.scs,
      escalates: clarityWarrantsEscalation(clarity.verdict),
      admitted: res.lines.length,
      pool: res.candidateCount,
      outcome: res.outcome,
      postBits: post.bits,
      postAttested: post.attestedRatio,
      ms,
      embedder: res.embedderAvailable,
    };
  });
  const elapsedS = ((Date.now() - t0) / 1000).toFixed(0);

  const n = samples.length;
  const okSamples = samples.filter((s) => s.outcome === 'ok');
  const embedderRate = samples.filter((s) => s.embedder).length;
  const timedOut = samples.filter((s) => s.outcome === 'timed-out').length;
  const failed = samples.filter((s) => s.outcome === 'failed').length;

  console.log(`## Run health\n`);
  console.log(
    `| queries | ran to completion | timed-out | failed | embedder available | wall |\n` +
      `|---:|---:|---:|---:|---:|---:|\n` +
      `| ${n} | ${pct(okSamples.length, n)} | ${timedOut} | ${failed} | ${pct(embedderRate, n)} | ${elapsedS}s |`,
  );
  console.log(
    embedderRate === n
      ? `\nARM: **hybrid** (BM25 + vector) — the production shape.`
      : embedderRate === 0
        ? `\n⚠ ARM: **BM25-only** — the embedder never warmed in this process, so this measures the ` +
          `leg's DEGRADED path, not the production hybrid one. Every number below is scoped to that arm.`
        : `\n⚠ ARM: **MIXED** — ${pct(embedderRate, n)} of queries ran hybrid and the rest BM25-only, so ` +
          `the sample spans two retrieval systems. Treat every association as confounded and re-run.`,
  );
  if (timedOut + failed > 0) {
    console.log(
      `\n⚠ ${timedOut + failed} query(s) did not run to completion. A \`timed-out\` leg returns an ` +
        `EMPTY \`lines\` that is indistinguishable from "the corpus had nothing" — those rows are ` +
        `EXCLUDED from every association below rather than scored as zero-fill.`,
    );
  }

  // Everything downstream uses only the rows that actually ran.
  const rows = okSamples;

  console.log(`\n## Outcome by clarity verdict\n`);
  console.log(
    `| verdict | n | share | zero-hit | mean admitted | full (6/6) | mean pool | mean post-clarity (bits) | scored |`,
  );
  console.log(`|---|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const v of VERDICTS) {
    const bucket = rows.filter((r) => r.verdict === v);
    if (bucket.length === 0) continue;
    console.log(bucketRow(`\`${v}\``, bucket, rows.length));
  }
  const escalating = rows.filter((r) => r.escalates);
  const notEscalating = rows.filter((r) => !r.escalates);
  console.log(bucketRow(`**would escalate**`, escalating, rows.length));
  console.log(bucketRow(`**would not**`, notEscalating, rows.length));

  // ── The curve. Deciles of SCS among rows that HAVE an SCS (keyed/unknown/
  //    unretrievable have none by construction and must not be folded in as 0). ──
  const scored = rows.filter((r): r is Sample & { scs: number } => r.scs !== null);
  console.log(`\n## The curve — outcome by SCS decile (rows with a computable SCS: ${scored.length})\n`);
  const byScs = [...scored].sort((a, b) => a.scs - b.scs);
  const DECILES = 10;
  console.log(`| decile | SCS range (bits) | n | zero-hit | mean admitted | mean pool | mean post-clarity |`);
  console.log(`|---:|---|---:|---:|---:|---:|---:|`);
  for (let d = 0; d < DECILES; d++) {
    const lo = Math.floor((d * byScs.length) / DECILES);
    const hi = Math.floor(((d + 1) * byScs.length) / DECILES);
    const bucket = byScs.slice(lo, hi);
    if (bucket.length === 0) continue;
    const post = bucket.map((r) => r.postBits).filter((b): b is number => b !== null);
    const zero = bucket.filter((r) => r.admitted === 0).length;
    console.log(
      `| ${d + 1} | ${f2(bucket[0]!.scs)}–${f2(bucket[bucket.length - 1]!.scs)} | ${bucket.length} | ` +
        `${pct(zero, bucket.length)} | ${f2(mean(bucket.map((r) => r.admitted)))} | ` +
        `${f2(mean(bucket.map((r) => r.pool)))} | ${f2(mean(post))} |`,
    );
  }

  // ── Associations + the permutation control. ──
  const scs = scored.map((r) => r.scs);
  const admitted = scored.map((r) => r.admitted);
  const pool = scored.map((r) => r.pool);
  const withPost = scored.filter((r): r is Sample & { scs: number; postBits: number } => r.postBits !== null);

  const pairings: Array<[string, readonly number[], readonly number[]]> = [
    ['SCS → admitted lines', scs, admitted],
    ['SCS → candidate pool', scs, pool],
    [
      'SCS → post-retrieval clarity',
      withPost.map((r) => r.scs),
      withPost.map((r) => r.postBits),
    ],
  ];

  const DRAWS = 999;
  console.log(`\n## Association (Spearman ρ) against the permutation null (${DRAWS} draws)\n`);
  console.log(`| pairing | n | ρ observed | null mean | null 95% band | p |`);
  console.log(`|---|---:|---:|---:|---|---:|`);
  for (const [label, xs, ys] of pairings) {
    const observed = spearman(xs, ys);
    if (observed === null) {
      console.log(`| ${label} | ${xs.length} | — (series constant) | — | — | — |`);
      continue;
    }
    const nul = permutationNull(xs, ys, observed, DRAWS);
    console.log(
      `| ${label} | ${xs.length} | **${observed.toFixed(3)}** | ${nul ? nul.mean.toFixed(3) : '—'} | ` +
        `${nul ? `${nul.lo.toFixed(3)} … ${nul.hi.toFixed(3)}` : '—'} | ${nul ? nul.p.toFixed(3) : '—'} |`,
    );
  }
  console.log(
    `\nThe null mean must be ≈0 and the observed ρ must sit OUTSIDE the 95% band to mean anything. ` +
      `A ρ inside the band is chance — report it as "no association measured", never as a weak one. ` +
      `This control exists because shared sampling, shared clamping and one corpus instant can ` +
      `manufacture an association that no care in the measurement itself would reveal.`,
  );

  console.log(
    `\n⛔ NO THRESHOLD IS PROPOSED HERE. \`CORPUS_CLARITY_FOCUSED_BITS\` moves only on a KNEE in the ` +
      `decile curve above. Picking a percentile fits the constant to this sample; fitting to the ` +
      `Coverage Illusion's 27.8% fits it to the number the work set out to reproduce.`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
