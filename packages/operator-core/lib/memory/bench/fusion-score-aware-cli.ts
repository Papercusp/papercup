/**
 * P-031 — does SCORE-AWARE fusion beat rank-only RRF on @papercusp/search?
 *
 *   ./node_modules/.bin/tsx packages/operator-core/lib/memory/bench/fusion-score-aware-cli.ts
 *   (run fusion-score-aware-cache.ts first — it writes the vector cache)
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * `fusion-sweep-cli.ts` / `floor-sweep-cli.ts` next door evaluate the MEMORY
 * backend's mem0+claude-file fusion. Nothing evaluated `@papercusp/search`'s
 * RRF (`rrfCombine`, the bm25 + pgvector fusion behind search:semantic), which
 * is what P-031 is about. This is that instrument.
 *
 * ─── WHAT IS ACTUALLY IN QUESTION (narrower than the plan item assumed) ────
 * Within ONE ranker's list, score order ≡ rank order BY CONSTRUCTION — every
 * source emits `ORDER BY rank DESC` / `ORDER BY <col> <=> qVec` with `score`
 * set to that same quantity. So a per-candidate weight that is a monotone
 * function of that candidate's own score CANNOT reorder within a list; it can
 * only change how much each RANKER's votes weigh against the other's. That is
 * the only mechanism a score-aware variant can exploit here, and it is what
 * the arms below vary. (`rank-order ≡ score-order` is asserted as a property
 * test in fusion-score-aware.test.ts so this premise cannot silently rot.)
 *
 * ─── FAITHFULNESS ─────────────────────────────────────────────────────────
 * Both legs are the real thing, not a re-implementation:
 *   - lexical: PostgreSQL `ts_rank_cd(tsv, plainto_tsquery('english', q))`
 *     with the same `@@` admission and `ORDER BY rank DESC LIMIT` production
 *     uses (agent-tools/search/sources.ts).
 *   - vector: exact cosine over L2-normalised gemma@768 vectors — identical to
 *     pgvector's `1 - (v <=> q)` for normalised inputs — from the SAME
 *     embedder construction the 2026-08-03 bake-off (D-012) measured on.
 * Fusion itself calls the production `rrfCombine` for the baseline arm, so the
 * baseline cannot drift from what search:semantic actually runs.
 */
import fs from 'node:fs';
import path from 'node:path';

import { rrfCombine, RRF_K_DEFAULT, type RankedItem } from '@papercusp/rrf';
import pg from 'pg';

import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { EMBEDDING_FLOOR_GEMMA } from '../../search/prose-min-score';
import { loadProseGoldSetFixture } from './prose-gold-set';

const argOf = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
const MODEL = argOf('--model') ?? 'gemma768';

/**
 * The embeddings floor to apply, per model.
 *
 * gemma768 uses the SHIPPED constant (`EMBEDDING_FLOOR_GEMMA`, P-001) — never a
 * re-typed literal, so this instrument cannot drift from the path it measures.
 *
 * qwen3768 is NOT shipped and has no measured floor. Applying gemma's 0.45 to
 * it would be precisely the error `search/prose-min-score.ts` documents (cosine
 * offsets are a property of the MODEL), so the value here is derived by P-001's
 * OWN method — ~0.03 below the worst answerable top-1 observed for that model on
 * this gold set (qwen3@768: worst answerable top-1 .3885 → .36) — and is used
 * ONLY to give the qwen3 arm a comparable operating point. It is a bench
 * parameter, not a proposed production constant.
 */
const FLOORS: Record<string, number> = { gemma768: EMBEDDING_FLOOR_GEMMA, qwen3768: 0.36 };
const FLOOR = Number.parseFloat(argOf('--floor') ?? String(FLOORS[MODEL] ?? EMBEDDING_FLOOR_GEMMA));
const CACHE = process.env.FUSION_CACHE_PATH ?? `/tmp/p031-${MODEL}-prose-vectors.json`;
const SCHEMA = `bench_fusion_${process.pid}`;
/** Production over-fetch: SearchContext uses `limit * 3`. */
const LIMIT = 10;
const CANDIDATES = LIMIT * 3;
const MRR_CUTOFF = 10;
const ANSWERABLE = new Set(['lexical-gap', 'session-start-intent', 'exact-identifier']);

const log = (m: string): void => console.log(new Date().toISOString().slice(11, 19), m);

interface Cache {
  model: string;
  corpusKeys: string[];
  corpusTexts: string[];
  docVecs: number[][];
  queryVecs: number[][];
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** clamp((x-lo)/(hi-lo), 0, 1) — the shape every calibration below uses. */
function ramp(x: number, lo: number, hi: number): number {
  if (!(hi > lo)) return 1;
  return Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
}

type Leg = { name: string; list: Array<RankedItem<string>> };

/**
 * The fusion arms. Each returns fused keys, best-first.
 *
 * `rrf` is the production baseline (calls rrfCombine itself). Every other arm
 * is a candidate score-aware variant; they differ ONLY in the weight applied
 * to a ranker's `1/(k+rank)` contribution.
 */
interface Arm {
  label: string;
  fuse: (legs: Leg[]) => string[];
}

/** Generic weighted-RRF driver: `weight(legName, score, leg) · 1/(k+rank)`. */
function weightedRrf(
  legs: Leg[],
  weight: (legName: string, score: number, leg: Leg) => number,
): string[] {
  const acc = new Map<string, number>();
  for (const leg of legs) {
    leg.list.forEach((entry, idx) => {
      const w = weight(leg.name, entry.score, leg);
      const contrib = (w * 1) / (RRF_K_DEFAULT + idx + 1);
      acc.set(entry.key, (acc.get(entry.key) ?? 0) + contrib);
    });
  }
  return [...acc.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

/**
 * Per-ranker score→weight calibrations.
 *
 * embeddings: the floor (0.45) is where P-001 already cuts, and .75 is just
 * above the highest top-1 cosine observed across the whole gold set (.7553).
 * So this ramp is the CONTINUOUS generalisation of the step function P-001
 * shipped — which is precisely the comparison P-031 reduces to.
 *
 * bm25: `ts_rank_cd` is unbounded, so an absolute ramp has no defensible
 * constant. Normalise within the query's own list instead (max-relative).
 */
const EMB_LO = FLOOR;
/** Top of the ramp: just above the highest top-1 cosine observed for the model
 *  across the whole gold set (gemma@768 .7553, qwen3@768 .7810). */
const EMB_HI = Number.parseFloat(argOf('--rampHi') ?? (MODEL === 'qwen3768' ? '0.78' : '0.75'));

const ARMS: Arm[] = [
  {
    label: 'A rrf (production baseline)',
    fuse: (legs) => rrfCombine(legs.map((l) => ({ name: l.name, list: l.list }))).map((f) => f.row),
  },
  {
    label: 'B per-candidate absolute score weight',
    fuse: (legs) =>
      weightedRrf(legs, (name, score) =>
        name === 'embeddings' ? ramp(score, EMB_LO, EMB_HI) : 1,
      ),
  },
  {
    label: 'C per-candidate, both legs (bm25 max-normalised)',
    fuse: (legs) =>
      weightedRrf(legs, (name, score, leg) => {
        if (name === 'embeddings') return ramp(score, EMB_LO, EMB_HI);
        const max = leg.list[0]?.score ?? 1;
        return max > 0 ? score / max : 1;
      }),
  },
  {
    label: 'D list-confidence (whole leg scaled by its top score)',
    fuse: (legs) =>
      weightedRrf(legs, (name, _score, leg) => {
        if (name !== 'embeddings') return 1;
        const top = leg.list[0]?.score ?? 0;
        return ramp(top, EMB_LO, EMB_HI);
      }),
  },
  {
    label: 'E convex blend 0.5·normScore + 0.5·rrf',
    fuse: (legs) => {
      const acc = new Map<string, number>();
      for (const leg of legs) {
        const max = leg.list[0]?.score ?? 1;
        leg.list.forEach((entry, idx) => {
          const norm =
            leg.name === 'embeddings' ? ramp(entry.score, EMB_LO, EMB_HI) : max > 0 ? entry.score / max : 0;
          const rrf = 1 / (RRF_K_DEFAULT + idx + 1);
          // rrf values live at ~1/61; rescale so the blend is not degenerate.
          acc.set(entry.key, (acc.get(entry.key) ?? 0) + 0.5 * norm + 0.5 * (rrf * RRF_K_DEFAULT));
        });
      }
      return [...acc.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    },
  },
  // Single-leg references — the ceiling/floor each fusion arm sits between.
  { label: 'R bm25 only', fuse: (legs) => (legs.find((l) => l.name === 'bm25')?.list ?? []).map((e) => e.key) },
  {
    label: 'R embeddings only',
    fuse: (legs) => (legs.find((l) => l.name === 'embeddings')?.list ?? []).map((e) => e.key),
  },
];

/** Paired bootstrap CI on the mean per-query difference (arm − baseline). */
function pairedBootstrap(diffs: number[], iters = 10000): { mean: number; lo: number; hi: number } {
  const n = diffs.length;
  const mean = diffs.reduce((s, x) => s + x, 0) / n;
  const means: number[] = [];
  // Deterministic PRNG so a re-run reproduces the interval exactly.
  let seed = 20260803;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let b = 0; b < iters; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += diffs[Math.floor(rnd() * n)]!;
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return { mean, lo: means[Math.floor(0.025 * iters)]!, hi: means[Math.floor(0.975 * iters)]! };
}

const cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')) as Cache;
const gold = loadProseGoldSetFixture();
log(`cache model=${cache.model} docs=${cache.corpusKeys.length} queries=${gold.queries.length}`);
if (cache.queryVecs.length !== gold.queries.length) {
  throw new Error(`cache/gold mismatch: ${cache.queryVecs.length} vs ${gold.queries.length}`);
}

const client = new pg.Client({ connectionString: getHarnessAdminUrl() });
await client.connect();

try {
  log(`creating ${SCHEMA} and loading ${cache.corpusKeys.length} docs…`);
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await client.query(
    `CREATE TABLE ${SCHEMA}.docs (
       key text PRIMARY KEY,
       body text NOT NULL,
       body_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED
     )`,
  );
  // Batch insert.
  const B = 200;
  for (let i = 0; i < cache.corpusKeys.length; i += B) {
    const keys = cache.corpusKeys.slice(i, i + B);
    const texts = cache.corpusTexts.slice(i, i + B);
    const values = keys.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`).join(',');
    const params = keys.flatMap((k, j) => [k, texts[j]!]);
    await client.query(`INSERT INTO ${SCHEMA}.docs (key, body) VALUES ${values}`, params);
  }
  await client.query(`CREATE INDEX ON ${SCHEMA}.docs USING GIN (body_tsv)`);
  log('corpus loaded + indexed');

  const keyIndex = new Map(cache.corpusKeys.map((k, i) => [k, i]));
  void keyIndex;

  // Per-arm per-query reciprocal rank, and the hard-negative top-1 behaviour.
  const rrByArm = new Map<string, number[]>();
  for (const a of ARMS) rrByArm.set(a.label, []);
  let answerableN = 0;

  for (let qi = 0; qi < gold.queries.length; qi++) {
    const q = gold.queries[qi]!;
    if (!ANSWERABLE.has(q.class)) continue;
    answerableN++;

    // --- lexical leg: real ts_rank_cd, production's admission + ordering ---
    const bm = await client.query<{ key: string; rank: number }>(
      `SELECT key, ts_rank_cd(body_tsv, plainto_tsquery('english', $1)) AS rank
         FROM ${SCHEMA}.docs
        WHERE body_tsv @@ plainto_tsquery('english', $1)
        ORDER BY rank DESC LIMIT $2`,
      [q.query, CANDIDATES],
    );
    const bm25: Array<RankedItem<string>> = bm.rows.map((r) => ({
      key: r.key,
      score: Number(r.rank),
      row: r.key,
    }));

    // --- vector leg: exact cosine, then the SHIPPED P-001 floor ---
    const qv = cache.queryVecs[qi]!;
    const sims = cache.docVecs
      .map((dv, di) => ({ key: cache.corpusKeys[di]!, score: dot(qv, dv) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, CANDIDATES)
      .filter((c) => c.score >= FLOOR);
    const embeddings: Array<RankedItem<string>> = sims.map((c) => ({
      key: c.key,
      score: c.score,
      row: c.key,
    }));

    const legs: Leg[] = [
      { name: 'bm25', list: bm25 },
      { name: 'embeddings', list: embeddings },
    ];

    const expected = new Set(q.expected);
    for (const arm of ARMS) {
      const fused = arm.fuse(legs);
      let rr = 0;
      for (let r = 0; r < Math.min(fused.length, MRR_CUTOFF); r++) {
        if (expected.has(fused[r]!)) {
          rr = 1 / (r + 1);
          break;
        }
      }
      rrByArm.get(arm.label)!.push(rr);
    }
    if (answerableN % 20 === 0) log(`  ${answerableN} answerable queries replayed`);
  }

  log(`replayed ${answerableN} answerable queries across ${ARMS.length} arms`);

  const baseline = ARMS[0]!.label;
  const base = rrByArm.get(baseline)!;
  const mean = (a: number[]): number => a.reduce((s, x) => s + x, 0) / a.length;

  const rows: string[] = [];
  rows.push('| arm | MRR@10 | Δ vs baseline | 95% CI (paired bootstrap) | verdict |');
  rows.push('| --- | --- | --- | --- | --- |');
  for (const arm of ARMS) {
    const v = rrByArm.get(arm.label)!;
    if (arm.label === baseline) {
      rows.push(`| ${arm.label} | ${mean(v).toFixed(4)} | — | — | baseline |`);
      continue;
    }
    const diffs = v.map((x, i) => x - base[i]!);
    const { mean: d, lo, hi } = pairedBootstrap(diffs);
    const changed = diffs.filter((x) => x !== 0).length;
    const verdict = lo > 0 ? 'BETTER' : hi < 0 ? 'WORSE' : changed === 0 ? 'IDENTICAL' : 'no difference';
    rows.push(
      `| ${arm.label} | ${mean(v).toFixed(4)} | ${d >= 0 ? '+' : ''}${d.toFixed(4)} | [${lo.toFixed(4)}, ${hi.toFixed(4)}] | ${verdict} (${changed}/${v.length} queries changed) |`,
    );
  }

  const md =
    `# P-031 score-aware fusion vs rank-only RRF — ${new Date().toISOString()}\n\n` +
    `corpus ${cache.corpusKeys.length} docs · ${answerableN} answerable gold queries · ` +
    `${cache.model} · embeddings floor ${FLOOR}` +
    `${MODEL === 'gemma768' ? ' (P-001, SHIPPED)' : ' (derived by P-001 method, bench-only)'} · ` +
    `ramp [${EMB_LO}, ${EMB_HI}] · k=${RRF_K_DEFAULT}\n\n` +
    rows.join('\n') +
    '\n';
  console.log('\n' + md);

  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '..');
  const dir = path.join(repoRoot, '.papercusp', 'bench-reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, `fusion-score-aware-${MODEL}-${stamp}.md`), md, 'utf8');
  fs.writeFileSync(
    path.join(dir, `fusion-score-aware-${MODEL}-${stamp}.json`),
    JSON.stringify(
      { model: cache.model, floor: FLOOR, rampHi: EMB_HI, answerableN, perArm: Object.fromEntries(rrByArm) },
      null,
      2,
    ),
    'utf8',
  );
  log(`wrote .papercusp/bench-reports/fusion-score-aware-${MODEL}-${stamp}.{md,json}`);
} finally {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.end();
}
process.exit(0);
